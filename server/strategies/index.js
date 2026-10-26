'use strict';

/**
 * Demo strategy registry.
 *
 * Wraps the three engines copied from the dashboard into one shape the
 * demo can draw and score:
 *
 *   run(candles) -> {
 *     signals:  [{ index, confirmedIndex, time, type, side, kind, price, text }],
 *     trades:   [{ type, side, entryIndex, entryPrice, stop, target,
 *                  exitIndex, exitPrice, exitReason, outcome, r }],
 *     overlays: [{ id, title, color, values: [number|null per candle] }],
 *   }
 *
 * `kind` is "entry" (a tradeable signal), "exit", or "info" (a setup stage
 * worth showing but not traded). Candles are { time (epoch ms), open, high,
 * low, close, volume }, oldest first.
 *
 * Every engine here only uses bars up to and including bar i to decide
 * what happens on bar i, so running on candles[0..n] gives the same
 * answer for those bars as running on the full series. Playback relies on
 * that (see test/noLookahead.test.js).
 */

const { PinakaDetectors } = require('./pinakaEngine');
const { CeilingBreakRetestScanner, DEFAULT_CONFIG: CEILING_CONFIG } = require('./ceilingEngine');
const { runStrategyForSeries, PARAMS: HL_PARAMS } = require('./higherLowEngine');
const { atr } = require('./indicators');
const { istDate, istClock } = require('../time');

// ── Demo exit rule ─────────────────────────────────────────────────────
// Pinaka and Ceiling Break are signal detectors in the dashboard: they say
// where a setup fires, not where it exits. To show a win rate the demo
// scores every entry the same simple way. This is NOT part of either
// strategy and is labelled as such in the UI.
const DEMO_EXIT = { atrLen: 14, stopAtr: 1.0, targetAtr: 1.5, maxBars: 30 };

function scoreWithDemoExit(candles, entries) {
  const atrArr = atr(candles, DEMO_EXIT.atrLen);
  const last = candles.length - 1;
  return entries.map((s) => {
    const i = s.index;
    const a = atrArr[i] ?? (candles[i].high - candles[i].low);
    const dir = s.side === 'long' ? 1 : -1;
    const entryPrice = candles[i].close;
    const stop = entryPrice - dir * DEMO_EXIT.stopAtr * a;
    const target = entryPrice + dir * DEMO_EXIT.targetAtr * a;
    const trade = {
      type: s.type, side: s.side, entryIndex: i, entryTime: s.time, entryPrice,
      stop, target, risk: Math.abs(entryPrice - stop),
      exitIndex: null, exitPrice: null, exitReason: null,
    };
    for (let j = i + 1; j <= last; j++) {
      const c = candles[j];
      const hitStop = dir > 0 ? c.low <= stop : c.high >= stop;
      const hitTarget = dir > 0 ? c.high >= target : c.low <= target;
      // Both inside one candle: we can't know which came first, so count
      // it as a stop (the conservative choice).
      if (hitStop) { close(trade, j, stop, 'Stop'); break; }
      if (hitTarget) { close(trade, j, target, 'Target'); break; }
      if (j - i >= DEMO_EXIT.maxBars) { close(trade, j, c.close, 'Time'); break; }
    }
    return finishTrade(trade, candles);
  });
}

function close(trade, j, price, reason) {
  trade.exitIndex = j; trade.exitPrice = price; trade.exitReason = reason;
}

function finishTrade(trade, candles) {
  const dir = trade.side === 'long' ? 1 : -1;
  if (trade.exitIndex == null) {
    trade.outcome = 'open';
    trade.r = null;
  } else {
    trade.exitTime = candles[trade.exitIndex].time;
    trade.r = (dir * (trade.exitPrice - trade.entryPrice)) / trade.risk;
    trade.outcome = trade.r > 0 ? 'win' : 'loss';
  }
  return trade;
}

function exitSignals(trades, candles) {
  return trades
    .filter((t) => t.exitIndex != null)
    .map((t) => ({
      index: t.exitIndex, confirmedIndex: t.exitIndex, time: candles[t.exitIndex].time,
      type: 'EXIT', side: t.side, kind: 'exit', price: t.exitPrice,
      text: `${t.type} exit (${t.exitReason}) ${t.r >= 0 ? '+' : ''}${t.r.toFixed(2)}R`,
      outcome: t.outcome,
    }));
}

const byIndex = (a, b) => a.index - b.index;

// ── Pinaka ─────────────────────────────────────────────────────────────
const PINAKA_TEXT = {
  A1: 'A1 long: pullback below EMA-low inside an advance, then a full green candle reclaims it',
  A2: 'A2 long: reversal from a depressed low, full green candle closes above EMA-high below VWAP',
  B: 'B short: extended top above the band, red trigger candle after a "flying" candle',
  B2: 'B2 short: green poke above the upper band fails with a red engulfing close back inside',
  A1x: 'A1 shape, but filtered out (reference only)',
  A2x: 'A2 shape above VWAP centre (reference only)',
};

function runPinaka(candles) {
  const { signals: raw, series } = new PinakaDetectors({}).run(candles);
  const signals = raw.map((s) => ({
    index: s.index, confirmedIndex: s.index, time: s.time, type: s.type,
    side: s.side, kind: s.side ? 'entry' : 'info', price: s.close,
    text: PINAKA_TEXT[s.type] + (s.reason ? ` [${s.reason}]` : ''),
  }));
  const trades = scoreWithDemoExit(candles, signals.filter((s) => s.kind === 'entry'));
  const col = (k) => series.map((p) => (Number.isFinite(p[k]) ? p[k] : null));
  return {
    signals: signals.concat(exitSignals(trades, candles)).sort(byIndex),
    trades,
    overlays: [
      { id: 'vwap', title: 'VWAP (yearly)', color: '#f59e0b', values: col('vwap') },
      { id: 'bandUp', title: 'Upper band', color: '#a78bfa', values: col('bandUp') },
      { id: 'bandDn', title: 'Lower band', color: '#a78bfa', values: col('bandDn') },
      { id: 'emaHigh', title: 'EMA9 high', color: '#38bdf8', values: col('emaHigh') },
      { id: 'emaLow', title: 'EMA9 low', color: '#0ea5e9', values: col('emaLow') },
    ],
  };
}

// ── Ceiling Break & Retest ─────────────────────────────────────────────
const CEILING_TEXT = {
  CEILING_BROKEN: 'Close broke above a ceiling built from clustered pivot highs',
  RETEST: 'Price came back to test the broken ceiling',
  FAILED_RETEST: 'The ceiling gave way, setup cancelled',
  NO_RETEST: 'Price ran away without a retest, setup closed',
  HIGHER_LOW: 'Entry: after the retest, price holds a higher low and closes back above the ceiling',
};

function runCeiling(candles) {
  const { events, series } = new CeilingBreakRetestScanner({}).run(candles);
  const signals = events.map((e) => {
    // Events tied to a confirmed pivot low are only known pivotLen bars later.
    const fromPivot = e.reason === 'Watching for Higher Low' || e.reason === 'Ceiling gave way';
    const entry = e.type === 'HIGHER_LOW';
    return {
      index: e.barIndex,
      confirmedIndex: fromPivot ? e.barIndex + CEILING_CONFIG.pivotLen : e.barIndex,
      time: e.time, type: e.type, side: entry ? 'long' : null,
      kind: entry ? 'entry' : 'info', price: entry ? candles[e.barIndex].close : e.price,
      text: `${CEILING_TEXT[e.type]}${e.reason ? ` (${e.reason})` : ''}, ceiling ${e.ceiling.toFixed(2)}`,
    };
  });
  const trades = scoreWithDemoExit(candles, signals.filter((s) => s.kind === 'entry'));
  const ceil = series.map((p) => (Number.isFinite(p.activeCeiling) ? p.activeCeiling : null));
  return {
    signals: signals.concat(exitSignals(trades, candles)).sort(byIndex),
    trades,
    overlays: [{ id: 'ceiling', title: 'Active ceiling', color: '#f43f5e', values: ceil }],
  };
}

// ── P1/P2 Higher-Low (backtest strategy) ───────────────────────────────
function runHigherLow(candles) {
  // The engine reads bars[i].date / bars[i].time as IST session strings.
  const bars = candles.map((c) => ({
    ...c, volume: c.volume ?? 0, date: istDate(c.time), time: istClock(c.time),
  }));
  const { indicators, trades: raw } = runStrategyForSeries(bars, HL_PARAMS);
  const signals = [];
  const trades = raw.map(({ entry, exitInfo, currentStop }) => {
    const i = entry.entryIndex;
    signals.push({
      index: entry.p2Idx, confirmedIndex: i, time: candles[entry.p2Idx].time, type: 'P2',
      side: null, kind: 'info', price: entry.p2,
      text: `P2 higher low (P1 ${entry.p1.toFixed(2)} -> P2 ${entry.p2.toFixed(2)}), both in the lower VWAP zone`,
    });
    signals.push({
      index: i, confirmedIndex: i, time: candles[i].time, type: 'LONG', side: 'long',
      kind: 'entry', price: entry.entryPx,
      text: 'Entry: big green BCVC candle reclaims EMA9-low after a P1/P2 higher low',
    });
    const t = {
      type: 'LONG', side: 'long', entryIndex: i, entryTime: candles[i].time,
      entryPrice: entry.entryPx, stop: exitInfo ? entry.initialStop : currentStop,
      target: entry.targetPx, risk: entry.risk, exitIndex: null, exitPrice: null, exitReason: null,
    };
    if (exitInfo) close(t, exitInfo.exitIndex, exitInfo.exitPx, exitInfo.exitReason);
    return finishTrade(t, candles);
  });
  const col = (arr) => arr.map((v) => (Number.isFinite(v) ? v : null));
  return {
    signals: signals.concat(exitSignals(trades, candles)).sort(byIndex),
    trades,
    overlays: [
      { id: 'vwap', title: 'Session VWAP', color: '#f59e0b', values: col(indicators.vwap) },
      { id: 'lower', title: 'VWAP lower band', color: '#a78bfa', values: col(indicators.lower) },
      { id: 'upper', title: 'VWAP upper band', color: '#a78bfa', values: col(indicators.upper) },
      { id: 'ema9Low', title: 'EMA9 low', color: '#0ea5e9', values: col(indicators.ema9Low) },
    ],
  };
}

const STRATEGIES = [
  {
    id: 'pinaka',
    name: 'Pinaka (A1 / A2 / B / B2)',
    run: runPinaka,
    exitRule: 'demo',
    summary: 'Four detectors built on a yearly VWAP with 1-sigma bands and a pair of 9-period EMAs (one on highs, one on lows).',
    steps: [
      'VWAP and its bands describe where price sits relative to the year so far. EMA9-high and EMA9-low form a short-term channel.',
      'A1 (long) looks for an advance where both EMAs sit above the upper band, a pullback that closes below EMA9-low, then a full-bodied green candle that closes back above it.',
      'A2 (long) looks for a reversal from a new low below the lower band: a green close above EMA9-low, a retest of it, then a full green candle above EMA9-high while still below VWAP.',
      'B (short) fades an extended advance: price has made new highs, a candle "flew" fully above EMA9-high, and a red engulfing or red close below EMA9-low follows.',
      'B2 (short) is a failed poke: a green candle pushes above the upper band, then a red engulfing candle closes back below it within a few bars.',
      'A1x / A2x markers show shapes the filters rejected. They are reference only and are not traded.',
    ],
  },
  {
    id: 'ceiling-break-retest',
    name: 'Ceiling Break & Retest',
    run: runCeiling,
    exitRule: 'demo',
    summary: 'Finds a resistance "ceiling" from clustered pivot highs, waits for a breakout, then enters on a higher low after a retest.',
    steps: [
      'Pivot highs (5 bars each side) within 1% of each other are clustered. Two or more touches make a ceiling.',
      'A close more than 0.3% above the ceiling is a breakout (CEILING_BROKEN).',
      'After at least 8 bars, a pullback whose swing low lands near the ceiling is a RETEST. A swing low well below it is a FAILED_RETEST.',
      'If price instead extends 3% above the ceiling and stays there for 5 bars, it is a NO_RETEST (frictionless move).',
      'HIGHER_LOW is the entry: after a retest, a candle closes back above the ceiling without undercutting the retest low.',
      'Retest markers based on a pivot low appear 5 bars after the low itself, because a pivot is only confirmed once 5 more bars have printed. Watch for this in playback.',
    ],
  },
  {
    id: 'higher-low',
    name: 'P1/P2 Higher-Low (VWAP)',
    run: runHigherLow,
    exitRule: 'own',
    summary: 'Intraday long setup from the backtest: two rising pivot lows in the lower VWAP zone, then a strong green candle reclaiming EMA9-low.',
    steps: [
      'Works on intraday candles. Session VWAP and the P1/P2 structure reset at the start of each trading day. On daily candles it will not fire.',
      'A pivot low must be a red candle followed by a green one, below EMA9-low, and inside the lower VWAP zone.',
      'When a new pivot low is at least 0.1% above the previous one, the pair becomes P1/P2 and the setup is armed. Trading below P2 disarms it.',
      'Entry: a green candle with a body of at least 0.6 x ATR, a big-candle / big-volume (BCVC) confirmation, that crosses back above EMA9-low.',
      'Exits are the strategy\'s own: stop at P2 trailed to entry - 0.25R, target at 2R, exit on a red close below EMA9-low, and flat from 15:00 IST.',
    ],
  },
];

const byId = new Map(STRATEGIES.map((s) => [s.id, s]));

function getStrategy(id) {
  const s = byId.get(id);
  if (!s) throw Object.assign(new Error(`Unknown strategy "${id}"`), { status: 400 });
  return s;
}

function computeStats(trades) {
  const closed = trades.filter((t) => t.outcome !== 'open');
  const wins = closed.filter((t) => t.outcome === 'win').length;
  const totalR = closed.reduce((s, t) => s + t.r, 0);
  return {
    trades: closed.length,
    open: trades.length - closed.length,
    wins,
    losses: closed.length - wins,
    winRate: closed.length ? wins / closed.length : null,
    avgR: closed.length ? totalR / closed.length : null,
    totalR,
  };
}

function describe() {
  return STRATEGIES.map(({ id, name, summary, steps, exitRule }) => ({ id, name, summary, steps, exitRule }));
}

module.exports = { STRATEGIES, getStrategy, computeStats, describe, DEMO_EXIT };
