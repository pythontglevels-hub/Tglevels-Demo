"use strict";

// Copied verbatim from the dashboard's backtest/src/indicators.js.

// ── EMA (Wilder-style Pine ta.ema: alpha = 2/(len+1), seeded with SMA of
//    the first `len` values, exactly like Pine's ta.ema behaves on a
//    fresh series) ─────────────────────────────────────────────────────
function ema(values, len) {
  const out = new Array(values.length).fill(null);
  const alpha = 2 / (len + 1);
  let seedSum = 0;
  for (let i = 0; i < values.length; i++) {
    if (i < len) {
      seedSum += values[i];
      if (i === len - 1) out[i] = seedSum / len;
    } else {
      out[i] = values[i] * alpha + out[i - 1] * (1 - alpha);
    }
  }
  // Pine's ta.ema actually starts emitting from bar 0 (uses a running EMA
  // seeded on bar 0, not an SMA warm-up) — replicate that instead, since
  // the true-to-source behavior matters more than SMA-seeding convention.
  const out2 = new Array(values.length).fill(null);
  out2[0] = values[0];
  for (let i = 1; i < values.length; i++) {
    out2[i] = values[i] * alpha + out2[i - 1] * (1 - alpha);
  }
  return out2;
}

// ── SMA ──────────────────────────────────────────────────────────────
function sma(values, len) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= len) sum -= values[i - len];
    if (i >= len - 1) out[i] = sum / len;
  }
  return out;
}

// ── True Range + ATR (Pine's ta.atr = ta.rma(tr, len)) ────────────────
//
// Pine's ta.rma source:
//   rma(src, length) =>
//       alpha = 1/length
//       sum := na(sum[1]) ? ta.sma(src, length) : alpha*src + (1-alpha)*nz(sum[1])
// so the FIRST non-na value the recursion emits is ta.sma(src, length)
// itself (index length-1) -- only after that does it switch to the
// alpha-blended Wilder recursion. The previous version here blended from
// bar 0 with no warm-up, which is not what ta.rma/ta.atr does and shifted
// every ATR value for the first `len` bars of the series -- confirmed
// against a second independent implementation and fixed to match.
function rma(values, len) {
  const out = new Array(values.length).fill(null);
  const alpha = 1 / len;
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i === len - 1) {
      out[i] = sum / len; // first value = ta.sma(src, length)
    } else if (i >= len) {
      out[i] = values[i] * alpha + out[i - 1] * (1 - alpha);
    }
    // i < len-1 stays null, matching ta.sma's (and hence ta.rma's) warm-up
  }
  return out;
}

function atr(bars, len) {
  const tr = bars.map((b, i) => {
    if (i === 0) return b.high - b.low;
    const prevClose = bars[i - 1].close;
    return Math.max(b.high - b.low, Math.abs(b.high - prevClose), Math.abs(b.low - prevClose));
  });
  return rma(tr, len);
}

module.exports = { ema, sma, atr, rma };
