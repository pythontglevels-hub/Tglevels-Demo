'use strict';

/**
 * Demo strategy registry.
 *
 * Every strategy has one shape the demo can draw and score:
 *
 *   run(candles) -> {
 *     signals:  [{ index, confirmedIndex, time, type, side, kind, price, text }],
 *     trades:   [{ type, side, entryIndex, entryPrice, stop, target,
 *                  exitIndex, exitPrice, exitReason, outcome, r }],
 *     overlays: [{ id, title, color, values: [number|null per candle] }],
 *   }
 *
 * `kind` is "entry" or "exit". Candles are { time (epoch ms), open, high,
 * low, close, volume }, oldest first.
 *
 * Both strategies only use bars up to and including bar i to decide what
 * happens on bar i, so running on candles[0..n] gives the same answer for
 * those bars as running on the full series. Replay relies on that (see
 * test/noLookahead.test.js).
 */

const { ema, sma, atr } = require('./indicators');

const ATR_LEN = 14;
const BB = { len: 20, mult: 2, stopAtr: 1, minTargetAtr: 0.3, maxBars: 30 };
const CROSS = { fast: 9, slow: 50, stopAtr: 1.5, targetAtr: 3 };

// ── Shared trade bookkeeping ───────────────────────────────────────────

/**
 * Walks the candles once, holding at most one trade at a time.
 *   entryAt(i)       -> { type, side, stop, target, text } | null, entered at candles[i].close
 *   exitAt(i, trade) -> reason | null, an exit at candles[i].close (checked after stop / target)
 * Stop and target are checked on every candle after the entry. If one
 * candle touches both, the stop counts (we can't know which came first).
 */
function simulate(candles, { entryAt, exitAt = () => null, maxBars = Infinity }) {
  const trades = [];
  const entries = [];
  let open = null;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (open && i > open.entryIndex) {
      const dir = open.side === 'long' ? 1 : -1;
      const hitStop = dir > 0 ? c.low <= open.stop : c.high >= open.stop;
      const hitTarget = dir > 0 ? c.high >= open.target : c.low <= open.target;
      let reason = null;
      if (hitStop) close(open, i, open.stop, 'Stop');
      else if (hitTarget) close(open, i, open.target, 'Target');
      else if ((reason = exitAt(i, open))) close(open, i, c.close, reason);
      else if (i - open.entryIndex >= maxBars) close(open, i, c.close, 'Time');
      if (open.exitIndex != null) open = null;
    }
    if (!open) {
      const e = entryAt(i);
      if (e) {
        open = {
          type: e.type, side: e.side, entryIndex: i, entryTime: c.time, entryPrice: c.close,
          stop: e.stop, target: e.target, risk: Math.abs(c.close - e.stop),
          exitIndex: null, exitPrice: null, exitReason: null,
        };
        trades.push(open);
        entries.push({
          index: i, confirmedIndex: i, time: c.time, type: e.type, side: e.side,
          kind: 'entry', price: c.close, text: e.text,
        });
      }
    }
  }
  const finished = trades.map((t) => finishTrade(t, candles));
  return { trades: finished, signals: entries.concat(exitSignals(finished, candles)).sort(byIndex) };
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
const round2 = (v) => (Number.isFinite(v) ? v : null);

// ── Bollinger Bands (20, 2) mean reversion ─────────────────────────────

function bollinger(closes, len, mult) {
  const mid = sma(closes, len);
  const upper = new Array(closes.length).fill(null);
  const lower = new Array(closes.length).fill(null);
  for (let i = len - 1; i < closes.length; i++) {
    let sq = 0;
    for (let k = i - len + 1; k <= i; k++) sq += (closes[k] - mid[i]) ** 2;
    const sd = Math.sqrt(sq / len); // population standard deviation, as TradingView's BB
    upper[i] = mid[i] + mult * sd;
    lower[i] = mid[i] - mult * sd;
  }
  return { mid, upper, lower };
}

function runBollinger(candles) {
  const closes = candles.map((c) => c.close);
  const { mid, upper, lower } = bollinger(closes, BB.len, BB.mult);
  const atrArr = atr(candles, ATR_LEN);
  const { trades, signals } = simulate(candles, {
    maxBars: BB.maxBars,
    entryAt: (i) => {
      if (i < 1 || lower[i - 1] == null || atrArr[i] == null) return null;
      const a = atrArr[i];
      const p = closes[i];
      // Long: the previous close was below the lower band and this one closes back inside.
      if (closes[i - 1] < lower[i - 1] && p > lower[i] && mid[i] - p >= BB.minTargetAtr * a) {
        return {
          type: 'BB Buy', side: 'long', stop: p - BB.stopAtr * a, target: mid[i],
          text: `Close back above the lower Bollinger Band after closing below it. Target the middle band (${mid[i].toFixed(2)})`,
        };
      }
      if (closes[i - 1] > upper[i - 1] && p < upper[i] && p - mid[i] >= BB.minTargetAtr * a) {
        return {
          type: 'BB Sell', side: 'short', stop: p + BB.stopAtr * a, target: mid[i],
          text: `Close back below the upper Bollinger Band after closing above it. Target the middle band (${mid[i].toFixed(2)})`,
        };
      }
      return null;
    },
  });
  return {
    signals,
    trades,
    overlays: [
      { id: 'bbUpper', title: 'Upper band (20, 2)', color: '#a78bfa', values: upper.map(round2) },
      { id: 'bbMiddle', title: 'Middle band (SMA 20)', color: '#f59e0b', values: mid.map(round2) },
      { id: 'bbLower', title: 'Lower band (20, 2)', color: '#a78bfa', values: lower.map(round2) },
    ],
  };
}

// ── EMA 9 / EMA 50 crossover (on close) ────────────────────────────────

function runEmaCross(candles) {
  const closes = candles.map((c) => c.close);
  const fast = ema(closes, CROSS.fast);
  const slow = ema(closes, CROSS.slow);
  const atrArr = atr(candles, ATR_LEN);
  // EMA 50 needs about 50 candles before its value means anything.
  const crossAt = (i) => {
    if (i < CROSS.slow) return 0;
    if (fast[i - 1] <= slow[i - 1] && fast[i] > slow[i]) return 1;
    if (fast[i - 1] >= slow[i - 1] && fast[i] < slow[i]) return -1;
    return 0;
  };
  const { trades, signals } = simulate(candles, {
    exitAt: (i, t) => (crossAt(i) === (t.side === 'long' ? -1 : 1) ? 'Opposite cross' : null),
    entryAt: (i) => {
      const x = crossAt(i);
      if (!x || atrArr[i] == null) return null;
      const a = atrArr[i];
      const p = closes[i];
      return x > 0
        ? { type: 'EMA Buy', side: 'long', stop: p - CROSS.stopAtr * a, target: p + CROSS.targetAtr * a, text: 'EMA 9 crossed above EMA 50 on the close' }
        : { type: 'EMA Sell', side: 'short', stop: p + CROSS.stopAtr * a, target: p - CROSS.targetAtr * a, text: 'EMA 9 crossed below EMA 50 on the close' };
    },
  });
  return {
    signals,
    trades,
    overlays: [
      { id: 'ema9', title: 'EMA 9 (close)', color: '#38bdf8', values: fast.map(round2) },
      { id: 'ema50', title: 'EMA 50 (close)', color: '#f59e0b', values: slow.map((v, i) => (i < CROSS.slow - 1 ? null : round2(v))) },
    ],
  };
}

const STRATEGIES = [
  {
    id: 'bollinger',
    name: 'Bollinger Bands (20, 2) reversal',
    run: runBollinger,
    summary: 'Bollinger Bands are a 20-candle average (the middle band) with bands 2 standard deviations above and below it. This strategy trades price snapping back inside the bands.',
    steps: [
      'Middle band: the simple average of the last 20 closes. Upper and lower bands: 2 standard deviations above and below it. Wide bands mean a volatile market, narrow bands a quiet one.',
      'Buy when a candle closes back above the lower band after the previous candle closed below it.',
      'Sell when a candle closes back below the upper band after the previous candle closed above it.',
      'The target is the middle band as it stood at entry. Entries where the middle band is too close (under 0.3× ATR away) are skipped.',
    ],
    exits: `Stop ${BB.stopAtr}× ATR(${ATR_LEN}) beyond the entry, target the middle band, or exit after ${BB.maxBars} candles. One trade at a time.`,
  },
  {
    id: 'ema-cross',
    name: 'EMA 9 / EMA 50 crossover',
    run: runEmaCross,
    summary: 'A trend-following strategy: a fast 9-candle EMA crossing a slow 50-candle EMA, both on the close, signals that the short-term trend has turned.',
    steps: [
      'EMA 9 follows price closely. EMA 50 shows the slower trend. Both use closing prices.',
      'Buy when EMA 9 crosses above EMA 50 on a closed candle (a "golden cross" on this timeframe).',
      'Sell when EMA 9 crosses below EMA 50.',
      'An opposite cross closes the trade and opens one the other way.',
    ],
    exits: `Stop ${CROSS.stopAtr}× ATR(${ATR_LEN}), target ${CROSS.targetAtr}× ATR (2R), or the opposite crossover, whichever comes first.`,
  },
];

const byId = new Map(STRATEGIES.map((s) => [s.id, s]));
const DEFAULT_STRATEGY = STRATEGIES[0].id;

function getStrategy(id) {
  const s = byId.get(id || DEFAULT_STRATEGY);
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
  return STRATEGIES.map(({ id, name, summary, steps, exits }) => ({ id, name, summary, steps, exits }));
}

module.exports = { STRATEGIES, DEFAULT_STRATEGY, getStrategy, computeStats, describe };
