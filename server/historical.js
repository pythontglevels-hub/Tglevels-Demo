'use strict';

/**
 * Historical datasets: one CSV file per dataset in data/historical/.
 *
 *   time,open,high,low,close,volume
 *   2024-01-02T09:15:00+05:30,21700.5,21745.1,21690.0,21730.2,123456
 *
 * The time column may be called time, datetime, date or timestamp. Values
 * may be ISO 8601, "YYYY-MM-DD HH:MM[:SS]", "DD-MM-YYYY HH:MM" (or with /),
 * or epoch seconds/ms. Times without a zone are read as IST (override with
 * HISTORICAL_TZ, e.g. "+00:00"). `volume` is optional.
 * Use scripts/export-from-db.js to produce these from the dashboard's
 * candles table. The demo never connects to the dashboard database at
 * runtime, so the public site has no path to production data.
 */

const fs = require('fs');
const path = require('path');

const DIR = process.env.HISTORICAL_DIR || path.join(__dirname, '..', 'data', 'historical');
const cache = new Map(); // id -> { mtimeMs, dataset }

const TZ = process.env.HISTORICAL_TZ || '+05:30';
const TIME_COLUMNS = ['time', 'datetime', 'date', 'timestamp', 'date_time'];

function parseTime(raw) {
  let s = raw.trim().replace(/^"|"$/g, '');
  if (/^\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    return n < 1e11 ? n * 1000 : n; // seconds or ms
  }
  // DD-MM-YYYY or DD/MM/YYYY -> YYYY-MM-DD
  s = s.replace(/^(\d{2})[-/](\d{2})[-/](\d{4})/, '$3-$2-$1');
  const m = s.match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2})(:\d{2}(?:\.\d+)?)?)?$/);
  // No zone given: the exchange's local time.
  if (m) s = `${m[1]}T${m[2] || '00:00'}${m[3] || ':00'}${TZ}`;
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new Error(`bad time "${raw}"`);
  return t;
}

function parseCsv(text, file) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  const header = lines.shift().replace(/^\uFEFF/, '').toLowerCase().split(',').map((h) => h.trim().replace(/^"|"$/g, ''));
  const col = (name) => header.indexOf(name);
  const idx = { time: header.findIndex((h) => TIME_COLUMNS.includes(h)), open: col('open'), high: col('high'), low: col('low'), close: col('close'), volume: col('volume') };
  for (const k of ['time', 'open', 'high', 'low', 'close']) {
    if (idx[k] < 0) throw new Error(`${file}: missing "${k === 'time' ? 'time (or datetime)' : k}" column`);
  }
  const fixed = [];
  const candles = lines.map((line, n) => {
    const f = line.split(',');
    let time;
    try { time = parseTime(f[idx.time] ?? ''); } catch (err) { throw new Error(`${file}: ${err.message} on line ${n + 2}`); }
    const c = {
      time,
      open: Number(f[idx.open]), high: Number(f[idx.high]), low: Number(f[idx.low]), close: Number(f[idx.close]),
      volume: idx.volume >= 0 ? Number(f[idx.volume]) || 0 : 0,
    };
    if (![c.open, c.high, c.low, c.close].every(Number.isFinite)) throw new Error(`${file}: bad number on line ${n + 2}`);
    // Exported data sometimes has a high/low a tick inside the open/close
    // (rounding). Widen the range so the candle is drawable, and count it.
    const hi = Math.max(c.high, c.open, c.close);
    const lo = Math.min(c.low, c.open, c.close);
    if (hi !== c.high || lo !== c.low) { fixed.push(c.time); c.high = hi; c.low = lo; }
    return c;
  });
  candles.sort((a, b) => a.time - b.time);
  const out = candles.filter((c, i) => i === 0 || c.time !== candles[i - 1].time);
  out.fixed = fixed;
  return out;
}

function inferTimeframe(candles) {
  if (candles.length < 3) return 'unknown';
  const gaps = [];
  for (let i = 1; i < Math.min(candles.length, 200); i++) gaps.push(candles[i].time - candles[i - 1].time);
  gaps.sort((a, b) => a - b);
  const min = gaps[Math.floor(gaps.length / 2)] / 60000;
  if (min >= 1440) return '1D';
  if (min >= 60) return `${Math.round(min / 60)}h`;
  return `${Math.round(min)}m`;
}

function listIds() {
  if (!fs.existsSync(DIR)) return [];
  return fs.readdirSync(DIR).filter((f) => f.toLowerCase().endsWith('.csv') && !f.startsWith('.')).map((f) => f.slice(0, -4)).sort();
}

function load(id) {
  if (!listIds().includes(id)) throw Object.assign(new Error(`Unknown dataset "${id}"`), { status: 404 });
  const file = path.join(DIR, `${id}.csv`);
  const { mtimeMs } = fs.statSync(file);
  const hit = cache.get(id);
  if (hit && hit.mtimeMs === mtimeMs) return hit.dataset;
  const candles = parseCsv(fs.readFileSync(file, 'utf8'), `${id}.csv`);
  const dataset = { id, name: id.replace(/[_-]+/g, ' '), timeframe: inferTimeframe(candles), candles };
  cache.set(id, { mtimeMs, dataset });
  return dataset;
}

// ── Checking a file before it goes live (used by scripts/add-data.js) ──

const MIN_CANDLES = 50;
const istLabel = (ms) => new Date(ms + 330 * 60000).toISOString().slice(0, 16).replace('T', ' ');

/** Parses CSV text and returns a summary, or throws with a readable reason. */
function inspect(text, id = 'upload') {
  let candles;
  try {
    candles = parseCsv(text, `${id}.csv`);
  } catch (err) {
    throw Object.assign(err, { status: 400 });
  }
  if (candles.length < MIN_CANDLES) {
    throw Object.assign(new Error(`Only ${candles.length} candles. A dataset needs at least ${MIN_CANDLES}.`), { status: 400 });
  }
  const bad = candles.find((c) => c.low <= 0);
  if (bad) throw Object.assign(new Error(`Candle at ${istLabel(bad.time)} IST has a price of zero or below.`), { status: 400 });
  const warnings = [];
  if (candles.fixed.length) {
    warnings.push(`${candles.fixed.length} candle(s) had a high/low inside the open/close (e.g. ${istLabel(candles.fixed[0])} IST). The range was widened to fit; usually a rounding issue in the export.`);
  }
  return {
    warnings,
    bars: candles.length, timeframe: inferTimeframe(candles),
    from: candles[0].time, to: candles.at(-1).time,
    first: candles[0], last: candles.at(-1),
  };
}

function list() {
  return listIds().map((id) => {
    try {
      const d = load(id);
      return { id, name: d.name, timeframe: d.timeframe, bars: d.candles.length, from: d.candles[0]?.time, to: d.candles.at(-1)?.time };
    } catch (err) {
      return { id, name: id, error: err.message };
    }
  });
}

module.exports = { list, load, parseCsv, inspect, DIR };
