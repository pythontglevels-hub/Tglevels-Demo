'use strict';

const path = require('path');
const fs = require('fs');
const express = require('express');
const zlib = require('zlib');

const historical = require('./historical');
const { SyntheticMarket, generate, normalizeOptions } = require('./synthetic');
const { getStrategy, computeStats, describe, DEMO_EXIT } = require('./strategies');

const PORT = Number(process.env.PORT) || 3000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const TV_LIBRARY_DIR = path.join(PUBLIC_DIR, 'charting_library');
const MAX_LIVE_STREAMS = Number(process.env.MAX_LIVE_STREAMS) || 50;
const LIVE_WINDOW = 2000; // bars kept in live mode before trimming to LIVE_KEEP
const LIVE_KEEP = 1500;
const LIVE_WARMUP = 300;
const LIVE_MAX_START = 4000; // resume fast-forwards at most this far

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

// ── Data sources ──────────────────────────────────────────────────────

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
  if (query.source === 'synthetic') {
    const market = syntheticMarket(query);
    return { candles: market.candles, label: syntheticLabel(market.describe()) };
  }
  const d = historical.load(String(query.dataset || ''));
  return {
    candles: d.candles,
    label: { source: 'historical', simulated: false, dataset: d.id, name: d.name, timeframe: d.timeframe },
  };
}

function syntheticLabel(meta) {
  return { source: 'synthetic', simulated: true, timeframe: '5m', ...meta };
}

function analysis(strategy, { signals, trades }, label) {
  return { signals, trades, stats: { ...computeStats(trades), ...label, exitRule: strategy.exitRule } };
}

// ── API ───────────────────────────────────────────────────────────────

const api = express.Router();

api.get('/config', (req, res) => {
  res.json({
    // On Vercel the page's static files aren't visible to this function, so
    // the browser finds out itself (it says so if the library is missing).
    advancedCharts: !!process.env.VERCEL || fs.existsSync(path.join(TV_LIBRARY_DIR, 'charting_library.standalone.js')),
    strategies: describe(),
    demoExit: DEMO_EXIT,
    datasets: historical.list(),
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
  res.json({ upTo, ...analysis(strategy, strategy.run(candles.slice(0, upTo + 1)), label) });
});

// Synthetic live mode over Server-Sent Events. Each client gets its own
// generator. Every candle is sent as a few forming updates ("tick") and
// then a closed candle with the strategy's view of it ("bar").
let liveStreams = 0;
api.get('/live', (req, res) => {
  if (liveStreams >= MAX_LIVE_STREAMS) return res.status(503).json({ error: 'Too many live sessions, try again shortly.' });
  const opts = normalizeOptions(req.query);
  const strategy = getStrategy(opts.strategy);
  const msPerCandle = Math.min(5000, Math.max(200, Number(req.query.msPerCandle) || 1000));
  const market = new SyntheticMarket(opts);
  // The generator is deterministic for a seed, so a paused client resumes
  // by asking for the same market fast-forwarded to where it stopped.
  const startAt = Math.min(LIVE_MAX_START, Math.max(LIVE_WARMUP, Math.trunc(Number(req.query.startAt)) || LIVE_WARMUP));
  const nextLiveCandle = () => {
    const out = market.step();
    const trimmed = market.candles.length > LIVE_WINDOW && market.trim(LIVE_KEEP);
    return { ...out, trimmed };
  };
  for (let i = 0; i < startAt; i++) nextLiveCandle();

  liveStreams++;
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);

  const snapshot = () => {
    const result = market.analyze();
    const label = syntheticLabel(market.describe());
    send('snapshot', { label, candles: market.candles, overlays: result.overlays, ...analysis(strategy, result, label) });
  };
  snapshot();

  const TICKS = 4;
  let tick = 0;
  let pending = null;
  const timer = setInterval(() => {
    if (tick === 0) pending = nextLiveCandle(); // candle is generated now, revealed over TICKS updates
    tick++;
    const { candle, path: p } = pending;
    if (tick < TICKS) {
      const seen = p.slice(0, Math.round((p.length - 1) * (tick / TICKS)) + 1);
      send('tick', { time: candle.time, open: seen[0], high: Math.max(...seen), low: Math.min(...seen), close: seen.at(-1) });
      return;
    }
    tick = 0;
    if (pending.trimmed) return snapshot();
    const label = syntheticLabel(market.describe());
    const result = market.analyze();
    send('bar', {
      label,
      candle,
      overlayPoints: result.overlays.map((o) => ({ id: o.id, value: o.values.at(-1) })),
      ...analysis(strategy, result, label),
    });
  }, msPerCandle / TICKS);

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
