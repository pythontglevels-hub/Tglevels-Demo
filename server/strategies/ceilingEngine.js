'use strict';

/**
 * Ceiling Break & Retest engine.
 * Copied verbatim from the dashboard's backend/src/strategies/ceilingBreakRetest.js
 * (DEFAULT_CONFIG, findPivot and CeilingBreakRetestScanner only). The
 * dashboard's scanner wrapper is left out; server/strategies/index.js
 * wraps this for the demo instead. Keep the logic in sync by hand.
 */

const DEFAULT_CONFIG = {
  // Ceiling Detection
  pivotLen: 5, // Pivot Lookback (bars each side)
  tolerancePct: 1.0, // Ceiling Cluster Tolerance %
  minTouches: 2, // Minimum Touches to Qualify as Ceiling
  lookback: 150, // Pivot Search Lookback (bars)

  // Breakout
  breakoutBufPct: 0.3, // Breakout Confirmation Buffer %

  // Retest Classification
  minBarsBeforeRetest: 8, // Min bars after breakout before a pullback counts as retest
  retestTolPct: 2.0, // Retest Proximity Tolerance % (how close swing low must be to ceiling)
  failBufferPct: 0.5, // Failed-Retest Break Buffer % (close below ceiling by this much)
  extensionConfirmPct: 3.0, // Extension % above ceiling to confirm "No Retest" (checked every bar)
  noRetestHoldBars: 5, // Hold bars after extension before locking "No Retest"
  giveUpBars: 120, // Give up tracking after this many bars (no label, ambiguous)
};

/**
 * Simple confirmed pivot-high / pivot-low detector, equivalent to
 * ta.pivothigh(len, len) / ta.pivotlow(len, len) in Pine Script.
 *
 * A pivot high at `center` requires `high[center]` to be greater than every
 * high in the `len` bars before AND after it. A pivot low is the mirror
 * image using lows. Both are only "confirmed" once `len` bars have printed
 * after the candidate bar (hence the lag).
 */
function findPivot(candles, centerIdx, len, type) {
  const key = type === 'high' ? 'high' : 'low';
  const centerVal = candles[centerIdx][key];
  for (let j = centerIdx - len; j <= centerIdx + len; j++) {
    if (j === centerIdx) continue;
    const v = candles[j][key];
    if (type === 'high') {
      if (v >= centerVal) return false;
    } else {
      if (v <= centerVal) return false;
    }
  }
  return true;
}

class CeilingBreakRetestScanner {
  constructor(config = {}) {
    this.cfg = { ...DEFAULT_CONFIG, ...config };

    // normalize percentages to fractions, same as the Pine inputs (/100)
    this.tolerance = this.cfg.tolerancePct / 100;
    this.breakoutBuf = this.cfg.breakoutBufPct / 100;
    this.retestTol = this.cfg.retestTolPct / 100;
    this.failBuffer = this.cfg.failBufferPct / 100;
    this.extensionConfirm = this.cfg.extensionConfirmPct / 100;
  }

  /**
   * Run the scanner over a full candle series.
   * @param {Array<{time:any, open:number, high:number, low:number, close:number}>} candles
   * @returns {{ events: Array<Object>, series: Array<Object> }}
   */
  run(candles) {
    const cfg = this.cfg;
    const events = [];
    const series = new Array(candles.length);

    // ---------------- Pivot storage ----------------
    const pivotPrices = [];
    const pivotBars = [];

    // ---------------- State machine ----------------
    let state = 'idle'; // 'idle' | 'watching' | 'retested'
    let activeCeiling = NaN;
    let breakoutBar = NaN;
    let ceilLineStartBar = NaN; // equivalent of the ceiling line's x1
    let retestLow = NaN;
    let retestBarIdx = NaN;
    let extensionArmed = false;
    let extensionBar = NaN;

    const emit = (type, barIndex, price, extra = {}) => {
      events.push({
        type,
        barIndex,
        time: candles[barIndex] ? candles[barIndex].time : undefined,
        price,
        ...extra,
      });
    };

    // ---------------- Ceiling clustering (mirrors findCeiling()) ----------------
    const findCeiling = () => {
      const n = pivotPrices.length;
      if (n < cfg.minTouches) return { level: NaN, touches: 0, firstBar: NaN };

      const anchor = pivotPrices[n - 1];
      let cnt = 0;
      let sum = 0;
      let fB = NaN;

      for (let j = 0; j < n; j++) {
        const p = pivotPrices[j];
        if (Math.abs(p - anchor) / anchor <= this.tolerance) {
          cnt += 1;
          sum += p;
          const bIdx = pivotBars[j];
          fB = Number.isNaN(fB) ? bIdx : Math.min(fB, bIdx);
        }
      }

      if (cnt >= cfg.minTouches) {
        return { level: sum / cnt, touches: cnt, firstBar: fB };
      }
      return { level: NaN, touches: 0, firstBar: NaN };
    };

    // ---------------- Main bar-by-bar loop ----------------
    for (let i = 0; i < candles.length; i++) {
      const bar = candles[i];

      // --- pivot high detection (feeds the ceiling cluster) ---
      const centerIdx = i - cfg.pivotLen;
      let ph = NaN;
      let pl = NaN;
      if (centerIdx - cfg.pivotLen >= 0 && centerIdx + cfg.pivotLen <= i) {
        if (findPivot(candles, centerIdx, cfg.pivotLen, 'high')) {
          ph = candles[centerIdx].high;
        }
        if (findPivot(candles, centerIdx, cfg.pivotLen, 'low')) {
          pl = candles[centerIdx].low;
        }
      }

      if (!Number.isNaN(ph)) {
        pivotPrices.push(ph);
        pivotBars.push(centerIdx);
      }

      // drop pivots that have aged out of the lookback window
      while (
        pivotBars.length > 0 &&
        i - pivotBars[0] > cfg.lookback
      ) {
        pivotPrices.shift();
        pivotBars.shift();
      }

      // --- ceiling clustering ---
      const { level: ceilLevel, touches: ceilTouches, firstBar: ceilFirstBar } = findCeiling();
      const hasCeiling = ceilTouches >= cfg.minTouches;

      // --- breakout trigger (ta.crossover(close, ceilLevel * (1 + breakoutBuf))) ---
      let breakoutTrigger = false;
      if (hasCeiling && state === 'idle' && i > 0) {
        const threshold = ceilLevel * (1 + this.breakoutBuf);
        const prevClose = candles[i - 1].close;
        const currClose = bar.close;
        // crossover: previous close at/below threshold, current close above it
        breakoutTrigger = prevClose <= threshold && currClose > threshold;
      }

      if (breakoutTrigger) {
        activeCeiling = ceilLevel;
        breakoutBar = i;
        state = 'watching';
        retestLow = NaN;
        retestBarIdx = NaN;
        extensionArmed = false;
        extensionBar = NaN;
        ceilLineStartBar = ceilFirstBar;

        emit('CEILING_BROKEN', i, bar.high, { ceiling: activeCeiling });
      }

      // --- watching state ---
      if (state === 'watching') {
        const barsSince = i - breakoutBar;

        // 1) genuine confirmed pivot-low retest check
        if (!Number.isNaN(pl)) {
          const plBar = centerIdx;
          const plPrice = pl;
          if (plBar - breakoutBar >= cfg.minBarsBeforeRetest) {
            if (plPrice < activeCeiling * (1 - this.failBuffer)) {
              emit('FAILED_RETEST', plBar, plPrice, {
                reason: 'Ceiling gave way',
                ceiling: activeCeiling,
              });
              state = 'idle';
              activeCeiling = NaN;
            } else if (plPrice <= activeCeiling * (1 + this.retestTol)) {
              emit('RETEST', plBar, plPrice, {
                reason: 'Watching for Higher Low',
                ceiling: activeCeiling,
              });
              retestLow = plPrice;
              retestBarIdx = plBar;
              state = 'retested';
            }
          }
        }

        // 2) still open? track extension / hold window / give-up
        if (state === 'watching') {
          const dippedBack = i > breakoutBar && bar.low <= activeCeiling * (1 + this.retestTol);

          if (!extensionArmed && bar.close >= activeCeiling * (1 + this.extensionConfirm)) {
            extensionArmed = true;
            extensionBar = i;
          }

          if (extensionArmed) {
            if (dippedBack) {
              emit('RETEST', i, bar.low, {
                reason: 'Pullback after extension',
                ceiling: activeCeiling,
              });
              retestLow = bar.low;
              retestBarIdx = i;
              extensionArmed = false;
              state = 'retested';
            } else if (i - extensionBar >= cfg.noRetestHoldBars) {
              emit('NO_RETEST', i, bar.high, {
                reason: 'Frictionless Move',
                ceiling: activeCeiling,
              });
              state = 'idle';
              activeCeiling = NaN;
            }
          }

          if (state === 'watching' && barsSince > cfg.giveUpBars) {
            // ambiguous / choppy - close quietly, no event
            state = 'idle';
            activeCeiling = NaN;
          }
        }
      }

      // --- retested state: waiting for higher low (entry) or failure ---
      if (state === 'retested') {
        const barsSince = i - retestBarIdx;

        if (bar.close < activeCeiling * (1 - this.failBuffer) && bar.low < retestLow) {
          emit('FAILED_RETEST', i, bar.low, {
            reason: 'Broke the swing low',
            ceiling: activeCeiling,
          });
          state = 'idle';
          activeCeiling = NaN;
        } else if (
          bar.close > activeCeiling * (1 + this.breakoutBuf) &&
          bar.low > retestLow &&
          i > retestBarIdx
        ) {
          emit('HIGHER_LOW', i, bar.low, {
            reason: 'Entry Point',
            ceiling: activeCeiling,
          });
          state = 'idle';
          activeCeiling = NaN;
        } else if (barsSince > cfg.giveUpBars) {
          state = 'idle';
          activeCeiling = NaN;
        }
      }

      // --- per-bar snapshot (mirrors the plots/shading in the Pine script) ---
      const zoneHi = state !== 'idle' ? activeCeiling * (1 + this.retestTol) : NaN;
      const zoneLo = state !== 'idle' ? activeCeiling * (1 - this.failBuffer) : NaN;

      series[i] = {
        time: bar.time,
        state,
        hasCeiling,
        ceilingLevel: hasCeiling ? ceilLevel : NaN,
        activeCeiling: state !== 'idle' ? activeCeiling : NaN,
        ceilLineX1: state !== 'idle' ? ceilLineStartBar : NaN,
        ceilLineX2: state !== 'idle' ? i : NaN,
        zoneHi,
        zoneLo,
      };
    }

    return { events, series };
  }
}

module.exports = { CeilingBreakRetestScanner, DEFAULT_CONFIG };
