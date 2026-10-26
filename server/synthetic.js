'use strict';

/**
 * Synthetic market generator.
 *
 * Produces 5-minute candles on an NSE-like session (09:15-15:30 IST,
 * weekdays) starting in 2030, so a synthetic chart can never be mistaken
 * for a real past date.
 *
 * Price model, per bar:
 *   - log returns built from 12 sub-steps (so highs/lows/wicks look real)
 *   - GARCH(1,1) volatility clustering plus occasional fat-tail shocks
 *   - U-shaped intraday volatility and volume (busy open and close)
 *   - overnight gaps between sessions
 *   - a market regime: trending up, trending down, ranging (mean
 *     reverting) or volatile. "auto" switches between them at random.
 *
 * Outcome steering (optional, on by default for the demo):
 *   When the selected strategy opens a trade, the generator draws that
 *   trade's outcome up front (win with probability targetWinRate) and
 *   then adds a drift that pushes price toward the trade's target or its
 *   stop until the trade closes. This is how the demo hits a configured
 *   win rate. It means the synthetic win rate is a setting, not a result,
 *   and the UI says so wherever synthetic stats appear.
 */

const { getStrategy } = require('./strategies');
const { sessionClock } = require('./time');

const START_MS = Date.UTC(2030, 0, 1, 3, 45); // 2030-01-01 09:15 IST
const SUBSTEPS = 12;
const BASE_SIGMA = 0.0012; // per 5-min bar, roughly an index future
const VOLATILITY = { low: 0.6, normal: 1, high: 1.8 };
const REGIMES = ['trend-up', 'trend-down', 'range', 'volatile'];
const GARCH = { alpha: 0.08, beta: 0.9 };

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

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function normalizeOptions(o = {}) {
  const num = (v, d) => (v === undefined || v === '' || !Number.isFinite(Number(v)) ? d : Number(v));
  const condition = ['auto', ...REGIMES].includes(o.condition) ? o.condition : 'auto';
  return {
    seed: Math.trunc(num(o.seed, 42)) >>> 0,
    bars: Math.trunc(clamp(num(o.bars, 1500), 100, 3000)),
    condition,
    volatility: VOLATILITY[o.volatility] ? o.volatility : 'normal',
    steer: !(o.steer === false || o.steer === 'false' || o.steer === '0'),
    targetWinRate: clamp(num(o.targetWinRate, 0.55), 0.3, 0.7),
    steerStrength: clamp(num(o.steerStrength, 1.0), 0, 2),
    strategy: getStrategy(o.strategy || 'pinaka').id,
    startPrice: clamp(num(o.startPrice, 22000), 10, 1e7),
  };
}

class SyntheticMarket {
  constructor(options) {
    this.opts = normalizeOptions(options);
    this.strategy = getStrategy(this.opts.strategy);
    this.rng = mulberry32(this.opts.seed);
    this.outcomeRng = mulberry32(this.opts.seed ^ 0x9e3779b9);
    this.clock = sessionClock(START_MS, 5);
    this.candles = [];
    this.logP = Math.log(this.opts.startPrice);
    this.anchor = this.logP;
    this.base = BASE_SIGMA * VOLATILITY[this.opts.volatility];
    this.h = this.base * this.base; // GARCH variance
    this.regime = this.opts.condition === 'auto' ? 'range' : this.opts.condition;
    this.regimeLeft = 80;
    this.assigned = new Map(); // trade key -> 'win' | 'loss'
    this.steerTo = null; // price the generator is currently drifting toward
    this.analysis = null;
    this.generated = 0; // candles generated so far, including trimmed ones
  }

  /** Generates one closed candle. Returns { candle, path } where path is the sub-step prices. */
  step() {
    const { time, barOfSession, barsPerSession } = this.clock.next().value;
    const rng = this.rng;

    if (barOfSession === 0 && this.candles.length) {
      this.logP += gaussian(rng) * 1.5 * Math.sqrt(this.h); // overnight gap
    }
    this.switchRegime();

    const x = barOfSession / (barsPerSession - 1);
    const intraday = 0.75 + 3.2 * (x - 0.5) * (x - 0.5); // ~1.55 at open/close, 0.75 midday
    let sigma = Math.sqrt(this.h) * intraday;
    let mu = 0;
    if (this.regime === 'trend-up') mu = 0.15 * sigma;
    else if (this.regime === 'trend-down') mu = -0.15 * sigma;
    else if (this.regime === 'range') mu = -0.04 * (this.logP - this.anchor) / this.base * sigma;
    else if (this.regime === 'volatile') sigma *= 1.7;

    if (this.steerTo != null) {
      const dir = Math.sign(Math.log(this.steerTo) - this.logP);
      mu += dir * this.opts.steerStrength * sigma;
    }

    const startLog = this.logP;
    const path = [Math.exp(startLog)];
    for (let k = 0; k < SUBSTEPS; k++) {
      const shock = rng() < 0.015 ? 3 : 1;
      this.logP += mu / SUBSTEPS + (sigma / Math.sqrt(SUBSTEPS)) * gaussian(rng) * shock;
      path.push(Math.exp(this.logP));
    }

    // GARCH on the standardised shock, so the intraday / regime multipliers
    // can't feed back into the variance and blow it up.
    const r = this.logP - startLog;
    const eps = (r - mu) / sigma;
    const { alpha, beta } = GARCH;
    const b2 = this.base * this.base;
    this.h = clamp(b2 * (1 - alpha - beta) + (alpha * eps * eps + beta) * this.h, 0.25 * b2, 9 * b2);
    if (this.regime !== 'range') this.anchor += 0.02 * (this.logP - this.anchor);

    const round = (v) => Math.round(v * 20) / 20; // 0.05 tick
    const candle = {
      time,
      open: round(path[0]),
      high: round(Math.max(...path)),
      low: round(Math.min(...path)),
      close: round(path[path.length - 1]),
      volume: Math.round(60000 * intraday * (1 + 2.5 * Math.abs(r) / (sigma || 1e-9)) * Math.exp(0.35 * gaussian(rng))),
    };
    this.candles.push(candle);
    this.generated++;
    this.afterBar();
    return { candle, path: path.map(round) };
  }

  switchRegime() {
    if (this.opts.condition !== 'auto') return;
    if (--this.regimeLeft > 0) return;
    this.regime = REGIMES[Math.floor(this.rng() * REGIMES.length)];
    this.regimeLeft = 60 + Math.floor(this.rng() * 200);
    if (this.regime === 'range') this.anchor = this.logP;
  }

  afterBar() {
    this.analysis = null;
    if (!this.opts.steer) { this.steerTo = null; return; }
    const { trades } = this.analyze();
    let steer = null;
    for (const t of trades) {
      if (t.outcome !== 'open') continue;
      const key = `${t.type}:${t.entryIndex}`;
      if (!this.assigned.has(key)) {
        this.assigned.set(key, this.outcomeRng() < this.opts.targetWinRate ? 'win' : 'loss');
      }
      if (steer) continue; // steer toward the oldest open trade only
      const win = this.assigned.get(key) === 'win';
      const dir = t.side === 'long' ? 1 : -1;
      const level = win ? t.target : t.stop;
      // Aim a little past the level so price actually crosses it.
      steer = level + (win ? dir : -dir) * 0.25 * t.risk;
    }
    this.steerTo = steer;
  }

  analyze() {
    if (!this.analysis) this.analysis = this.strategy.run(this.candles);
    return this.analysis;
  }

  /** Drops the oldest candles (live mode keeps a bounded window). */
  trim(keep) {
    const drop = this.candles.length - keep;
    if (drop <= 0) return false;
    this.candles = this.candles.slice(drop);
    const shifted = new Map();
    for (const [key, v] of this.assigned) {
      const [type, idx] = key.split(':');
      if (Number(idx) - drop >= 0) shifted.set(`${type}:${Number(idx) - drop}`, v);
    }
    this.assigned = shifted;
    this.analysis = null;
    return true;
  }

  describe() {
    const o = this.opts;
    return {
      seed: o.seed, condition: o.condition, volatility: o.volatility, steer: o.steer,
      targetWinRate: o.steer ? o.targetWinRate : null, strategy: o.strategy, regime: this.regime,
      generated: this.generated,
    };
  }
}

function generate(options) {
  const market = new SyntheticMarket(options);
  for (let i = 0; i < market.opts.bars; i++) market.step();
  return market;
}

module.exports = { SyntheticMarket, generate, normalizeOptions };
