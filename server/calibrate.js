'use strict';

/**
 * Turns a historical dataset into a handful of numbers that shape a
 * synthetic market: price level, volatility per minute, overnight gap
 * size and volume per minute. The real candles themselves are never sent
 * to the browser. Only these summary numbers reach the generator, which
 * then draws its own random path, dated 2030 onwards.
 */

const historical = require('./historical');
const { IST_OFFSET_MS } = require('./time');

const cache = new Map(); // dataset id -> { candles (identity), profile }

const minutesOf = (tf) => {
  const m = /^(\d+)(m|h)$/.exec(tf || '');
  if (!m) return null;
  return Number(m[1]) * (m[2] === 'h' ? 60 : 1);
};

// "ADANIPORTS_15min" -> "ADANIPORTS": the model makes its own timeframes.
const displayName = (name) => name.replace(/[\s_-]*\d+\s*(min|mins|minute|minutes|m|h|hr|hour)$/i, '') || name;

const istDay = (ms) => Math.floor((ms + IST_OFFSET_MS) / 86400000);

function std(values) {
  if (values.length < 2) return 0;
  // Drop the most extreme 0.5% each side so one bad print can't dominate.
  const v = values.slice().sort((a, b) => a - b);
  const cut = Math.floor(v.length * 0.005);
  const kept = v.slice(cut, v.length - cut);
  const mean = kept.reduce((s, x) => s + x, 0) / kept.length;
  return Math.sqrt(kept.reduce((s, x) => s + (x - mean) ** 2, 0) / (kept.length - 1));
}

function profileFor(id) {
  const d = historical.load(id);
  const hit = cache.get(id);
  if (hit && hit.candles === d.candles) return hit.profile;

  const minutes = minutesOf(d.timeframe);
  if (!minutes || minutes > 60) {
    throw Object.assign(new Error(`"${d.name}" has ${d.timeframe} candles. Market models need intraday data (1 minute to 1 hour).`), { status: 400 });
  }
  const c = d.candles;
  const intraday = [];
  const gaps = [];
  let volume = 0;
  let volumeBars = 0;
  for (let i = 1; i < c.length; i++) {
    const r = Math.log(c[i].close / c[i - 1].close);
    if (istDay(c[i].time) === istDay(c[i - 1].time)) intraday.push(r);
    else gaps.push(Math.log(c[i].open / c[i - 1].close));
    if (c[i].volume > 0) { volume += c[i].volume; volumeBars++; }
  }
  const barSigma = std(intraday);
  const profile = {
    id: d.id,
    name: displayName(d.name),
    startPrice: Math.round(c.at(-1).close * 100) / 100,
    sigmaPerMinute: barSigma / Math.sqrt(minutes),
    gapSigma: std(gaps),
    volumePerMinute: volumeBars ? volume / volumeBars / minutes : null,
  };
  cache.set(id, { candles: d.candles, profile });
  return profile;
}

/** Market models offered in the UI: a generic one plus one per usable dataset. */
function listProfiles() {
  return historical.list()
    .filter((d) => !d.error && minutesOf(d.timeframe) && minutesOf(d.timeframe) <= 60)
    .map((d) => ({ id: d.id, name: displayName(d.name) }));
}

module.exports = { profileFor, listProfiles, minutesOf };
