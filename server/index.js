'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const zlib = require('zlib');

const { listProfiles } = require('./calibrate');
const { SyntheticMarket, generate, normalizeOptions, TIMEFRAMES, DEFAULT_TIMEFRAME } = require('./synthetic');
const { getStrategy, computeStats, describe } = require('./strategies');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const TV_LIBRARY_DIR = path.join(PUBLIC_DIR, 'charting_library');
const MAX_LIVE_STREAMS = Number(process.env.MAX_LIVE_STREAMS) || 50;
const LIVE_WINDOW = 2000; // bars kept in live mode before trimming to LIVE_KEEP
const LIVE_KEEP = 1500;
const LIVE_WARMUP = 300;
const LIVE_MAX_START = Number(process.env.LIVE_MAX_START) || 20000; // resume fast-forwards at most this far
const LIVE_SPEEDS = [1, 2, 5, 10, 30, 60, 300]; // × real time
const LIVE_MIN_MS_PER_CANDLE = 300;

const app = express();
// Gzip responses. Long candle files are several MB of JSON, and Vercel
// refuses function responses over 4.5 MB. The live stream is left alone.
// (The live stream doesn't use res.json, so it's never touched.)
app.use((req, res, next) => {
  if (!/\bgzip\b/.test(req.get('Accept-Encoding') || '')) return next();
  res.json = (body) => {
    const raw = Buffer.from(JSON.stringify(body));
    res.set('Content-Type', 'application/json; charset=utf-8').vary('Accept-Encoding');
    if (raw.length < 2048) return res.send(raw);
    return res.set('Content-Encoding', 'gzip').send(zlib.gzipSync(raw, { level: 6 }));
  };
  next();
});
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Referrer-Policy', 'same-origin');
  next();
});

// ── Data source ───────────────────────────────────────────────────────
// Every candle the site shows is synthetic. Historical datasets in
// data/historical/ are only read on the server to calibrate the market
// model (price level, volatility, gaps, volume); they are never sent to
// the browser.

// Generating a steered synthetic series re-runs the strategy every bar,
// so keep the last few series around for playback stepping.
const syntheticCache = new Map();
function syntheticMarket(query) {
  const opts = normalizeOptions(query);
  // Without steering the candles don't depend on the strategy.
  const key = JSON.stringify({ ...opts, strategy: opts.steer ? opts.strategy : null });
  let market = syntheticCache.get(key);
  if (!market) {
    market = generate(opts);
    syntheticCache.set(key, market);
    if (syntheticCache.size > 12) syntheticCache.delete(syntheticCache.keys().next().value);
  }
  return market;
}

function loadSource(query) {
  const market = syntheticMarket(query);
  return { candles: market.candles, label: syntheticLabel(market.describe()) };
}

function syntheticLabel(meta) {
  return { source: 'synthetic', simulated: true, ...meta };
}

function analysis({ signals, trades }, label) {
  return { signals, trades, stats: { ...computeStats(trades), ...label } };
}

// ── API ───────────────────────────────────────────────────────────────

const api = express.Router();

api.get('/config', (req, res) => {
  res.json({
    // On Vercel the page's static files aren't visible to this function, so
    // the browser finds out itself (it says so if the library is missing).
    advancedCharts: !!process.env.VERCEL || fs.existsSync(path.join(TV_LIBRARY_DIR, 'charting_library.standalone.js')),
    strategies: describe(),
    profiles: listProfiles(),
    timeframes: Object.keys(TIMEFRAMES),
    defaultTimeframe: DEFAULT_TIMEFRAME,
    liveSpeeds: LIVE_SPEEDS,
  });
});

// Full candle series plus indicator lines. The lines are causal, so the
// client can show a prefix of them during playback.
api.get('/candles', (req, res) => {
  const strategy = getStrategy(req.query.strategy);
  const { candles, label } = loadSource(req.query);
  // Two decimals is plenty for drawing and halves the payload on long files.
  const overlays = strategy.run(candles).overlays.map((o) => ({ ...o, values: o.values.map((v) => (v == null ? null : Math.round(v * 100) / 100)) }));
  res.json({ label, candles, overlays });
});

// Signals and trades, computed only from candles[0..upTo]. This is what
// playback calls on every step: the strategy never sees later candles.
api.get('/analyze', (req, res) => {
  const strategy = getStrategy(req.query.strategy);
  const { candles, label } = loadSource(req.query);
  const last = candles.length - 1;
  const upTo = req.query.upTo === undefined ? last : Math.max(0, Math.min(last, Math.trunc(Number(req.query.upTo)) || 0));
  res.json({ upTo, ...analysis(strategy.run(candles.slice(0, upTo + 1)), label) });
});

// Synthetic live mode over Server-Sent Events. Each client gets its own
// generator. A candle takes its real duration divided by `speed` (1 =
// real time: a 1-minute candle forms over a minute). While it forms, the
// price moves in small ticks along a path through the generator's
// sub-steps, so the candle grows the way a real one does. When it closes,
// a "bar" event carries the closed candle and the strategy's view of it.
let liveStreams = 0;
api.get('/live', (req, res) => {
  if (liveStreams >= MAX_LIVE_STREAMS) return res.status(503).json({ error: 'Too many live sessions, try again shortly.' });
  const opts = normalizeOptions(req.query);
  const strategy = getStrategy(opts.strategy);
  const market = new SyntheticMarket(opts);
  const speed = LIVE_SPEEDS.includes(Number(req.query.speed)) ? Number(req.query.speed) : 1;
  const msPerCandle = Math.max(LIVE_MIN_MS_PER_CANDLE, (market.barMinutes * 60000) / speed);
  const tickMs = Math.min(1000, Math.max(250, msPerCandle / 40));
  const ticksPerCandle = Math.max(1, Math.round(msPerCandle / tickMs));
  // The generator is deterministic for a seed, so a paused client resumes
  // by asking for the same market fast-forwarded to where it stopped, and
  // `startFrac` picks the forming candle up part of the way through.
  const startAt = Math.min(LIVE_MAX_START, Math.max(LIVE_WARMUP, Math.trunc(Number(req.query.startAt)) || LIVE_WARMUP));
  const startFrac = Math.min(0.95, Math.max(0, Number(req.query.startFrac) || 0));
  let trimmed = false;
  const nextLiveCandle = () => {
    const out = market.step();
    if (market.candles.length > LIVE_WINDOW && market.trim(LIVE_KEEP)) trimmed = true;
    return { ...out, ticks: tickPath(out, ticksPerCandle, opts.seed, market.generated) };
  };
  for (let i = 0; i < startAt; i++) nextLiveCandle();
  trimmed = false;

  liveStreams++;
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const snapshot = () => {
    const result = market.analyze();
    const label = syntheticLabel(market.describe());
    send('snapshot', { label, speed, msPerCandle, candles: market.candles, overlays: result.overlays, ...analysis(result, label) });
  };
  snapshot();

  // The forming candle is generated up front, then revealed tick by tick.
  let pending = nextLiveCandle();
  let tick = Math.min(ticksPerCandle - 1, Math.floor(startFrac * ticksPerCandle));
  const timer = setInterval(() => {
    tick++;
    const { candle, ticks } = pending;
    if (tick < ticksPerCandle) {
      const seen = ticks.slice(0, tick + 1);
      send('tick', {
        time: candle.time, open: candle.open, high: Math.max(...seen), low: Math.min(...seen), close: seen.at(-1),
        volume: Math.round(candle.volume * (tick / ticksPerCandle)), frac: tick / ticksPerCandle,
      });
      return;
    }
    if (trimmed) {
      trimmed = false;
      snapshot();
    } else {
      const label = syntheticLabel(market.describe());
      const result = market.analyze();
      send('bar', {
        label,
        candle,
        overlayPoints: result.overlays.map((o) => ({ id: o.id, value: o.values.at(-1) })),
        ...analysis(result, label),
      });
    }
    pending = nextLiveCandle();
    tick = 0;
    send('tick', { time: pending.candle.time, open: pending.candle.open, high: pending.candle.open, low: pending.candle.open, close: pending.candle.open, volume: 0, frac: 0 });
  }, tickMs);

  const keepAlive = setInterval(() => res.write(': ping\n\n'), 15000);
  // Hosts like Vercel cut a function off after a few minutes. End the stream
  // cleanly before that; the browser reconnects and carries on (seeded).
  const endAfter = Number(process.env.LIVE_MAX_SECONDS || (process.env.VERCEL ? 270 : 0)) * 1000;
  const ender = endAfter ? setTimeout(() => res.end(), endAfter) : null;
  req.on('close', () => {
    clearTimeout(ender);
    clearInterval(timer);
    clearInterval(keepAlive);
    liveStreams--;
  });
});

/**
 * Prices for each tick of a forming candle: ticks[0] is the open and the
 * last one is the close. Between the generator's sub-step prices the
 * ticks follow a Brownian bridge (random wiggles that still pass through
 * each sub-step), kept inside the candle's final high and low. The noise
 * is seeded per candle, so a resumed stream replays the same ticks.
 */
function tickPath({ candle, path: points }, n, seed, index) {
  const rng = mulberry32((seed ^ Math.imul(index, 0x9e3779b1)) >>> 0);
  const segs = points.length - 1;
  const moves = [];
  for (let k = 0; k < segs; k++) moves.push(Math.abs(points[k + 1] - points[k]));
  const wiggle = moves.reduce((a, b) => a + b, 0) / segs || 0.05;
  const step = candle.open >= 50 ? 0.05 : 0.01; // price tick, as the generator uses
  const out = [candle.open];
  for (let j = 1; j < n; j++) {
    const pos = (j / n) * segs;
    const k = Math.min(segs - 1, Math.floor(pos));
    const t = pos - k;
    const base = points[k] + (points[k + 1] - points[k]) * t;
    const noise = gaussian(rng) * wiggle * 0.6 * Math.sqrt(t * (1 - t));
    const price = Math.min(candle.high, Math.max(candle.low, base + noise));
    out.push(Math.round(Math.round(price / step) * step * 100) / 100);
  }
  if (n > 1) out.push(candle.close);
  else out[0] = candle.close;
  // Make sure the forming candle reaches the final high and low before it closes.
  const hiAt = points.indexOf(Math.max(...points));
  const loAt = points.indexOf(Math.min(...points));
  const place = (at, v) => { const j = Math.min(out.length - 2, Math.max(1, Math.round((at / segs) * n))); if (j >= 1 && j < out.length - 1) out[j] = v; };
  if (out.length > 3) { place(hiAt, candle.high); place(loAt, candle.low); }
  return out;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rng) {
  const u = 1 - rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng());
}

app.use('/api', api);
app.use('/vendor', express.static(path.join(path.dirname(require.resolve('lightweight-charts/package.json')), 'dist'), { maxAge: '7d' }));
// TradingView's library only changes when you copy in a new version.
app.use('/charting_library', express.static(TV_LIBRARY_DIR, { maxAge: '7d' }));
// The site's own files: browsers check for a newer copy on every load (a
// cheap 304 when nothing changed), so an update is never mixed with stale
// cached files.
app.use(express.static(PUBLIC_DIR, { setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'Internal error' : err.message });
});

if (require.main === module) {
  app.listen(PORT, () => console.log(`Strategy demo on http://localhost:${PORT}`));
}

module.exports = app;
