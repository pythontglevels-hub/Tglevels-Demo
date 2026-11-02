'use strict';

/**
 * Synthetic market generator.
 *
 * Produces candles (1 minute to 1 hour) on an NSE-like session
 * (09:15-15:30 IST, weekdays) starting in 2030, so a synthetic chart can
 * never be mistaken for a real past date.
 *
 * Market model: price level, volatility, overnight gap size and volume
 * come either from generic index-like defaults or from a historical
 * dataset's summary statistics (server/calibrate.js). Real candles are
 * never copied: the path is always freshly drawn from the random model.
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
const calibrate = require('./calibrate');

const START_MS = Date.UTC(2030, 0, 1, 3, 45); // 2030-01-01 09:15 IST
const SUBSTEPS = 12;
const TIMEFRAMES = { '1m': 1, '3m': 3, '5m': 5, '15m': 15, '30m': 30, '1h': 60 };
const DEFAULT_TIMEFRAME = '1m';
// Generic market: roughly an index future (0.12% per 5-minute bar).
const GENERIC = {
  id: 'generic', name: 'Generic index',
  startPrice: 22000, sigmaPerMinute: 0.0012 / Math.sqrt(5), gapSigma: 0.0018, volumePerMinute: 12000,
};
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
    strategy: getStrategy(o.strategy).id,
    timeframe: TIMEFRAMES[o.timeframe] ? o.timeframe : DEFAULT_TIMEFRAME,
    profile: typeof o.profile === 'string' && o.profile && o.profile !== 'generic' ? o.profile : 'generic',
    startPrice: o.startPrice == null || o.startPrice === '' ? null : clamp(num(o.startPrice, 22000), 10, 1e7),
  };
}

function resolveProfile(id) {
  if (id === 'generic') return GENERIC;
  const p = calibrate.profileFor(id);
  return {
    ...p,
    sigmaPerMinute: p.sigmaPerMinute > 0 ? p.sigmaPerMinute : GENERIC.sigmaPerMinute,
    gapSigma: p.gapSigma > 0 ? p.gapSigma : GENERIC.gapSigma,
    volumePerMinute: p.volumePerMinute || GENERIC.volumePerMinute,
  };
}

class SyntheticMarket {
  constructor(options) {
    this.opts = normalizeOptions(options);
    this.strategy = getStrategy(this.opts.strategy);
    this.rng = mulberry32(this.opts.seed);
    this.outcomeRng = mulberry32(this.opts.seed ^ 0x9e3779b9);
    this.profile = resolveProfile(this.opts.profile);
    this.barMinutes = TIMEFRAMES[this.opts.timeframe];
    this.clock = sessionClock(START_MS, this.barMinutes);
    this.candles = [];
    this.logP = Math.log(this.opts.startPrice || this.profile.startPrice);
    this.anchor = this.logP;
    const volMult = VOLATILITY[this.opts.volatility];
    this.base = this.profile.sigmaPerMinute * Math.sqrt(this.barMinutes) * volMult;
    this.gapSigma = this.profile.gapSigma * volMult;
    // Keep trends, mean reversion and regime lengths similar in clock time
    // whatever the candle size (all tuned on 5-minute candles).
    this.tfScale = Math.sqrt(this.barMinutes / 5);
    this.h = this.base * this.base; // GARCH variance
    this.regime = this.opts.condition === 'auto' ? 'range' : this.opts.condition;
    this.regimeLeft = Math.max(8, Math.round(80 / this.tfScale ** 2));
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
      this.logP += gaussian(rng) * this.gapSigma * (Math.sqrt(this.h) / this.base); // overnight gap
    }
    this.switchRegime();

    const x = barOfSession / (barsPerSession - 1);
    const intraday = 0.75 + 3.2 * (x - 0.5) * (x - 0.5); // ~1.55 at open/close, 0.75 midday
    let sigma = Math.sqrt(this.h) * intraday;
    let mu = 0;
    const k = this.tfScale;
    if (this.regime === 'trend-up') mu = 0.07 * k * sigma;
    else if (this.regime === 'trend-down') mu = -0.07 * k * sigma;
    else if (this.regime === 'range') mu = -0.04 * k * k * (this.logP - this.anchor) / this.base * sigma;
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
    if (this.regime !== 'range') this.anchor += Math.min(0.5, 0.02 * this.tfScale ** 2) * (this.logP - this.anchor);

    const tick = this.tick();
    const round = (v) => Math.round(v / tick) * tick;
    const r2 = (v) => Math.round(round(v) * 100) / 100;
    const candle = {
      time,
      open: r2(path[0]),
      high: r2(Math.max(...path)),
      low: r2(Math.min(...path)),
      close: r2(path[path.length - 1]),
      volume: Math.round(this.profile.volumePerMinute * this.barMinutes * intraday * (1 + 2.5 * Math.abs(r) / (sigma || 1e-9)) * Math.exp(0.35 * gaussian(rng))),
    };
    this.candles.push(candle);
    this.generated++;
    this.afterBar();
    return { candle, path: path.map(r2) };
  }

  /** Price tick: 0.05 like NSE, finer for low-priced instruments. */
  tick() {
    const p = Math.exp(this.logP);
    return p >= 50 ? 0.05 : 0.01;
  }

  switchRegime() {
    if (this.opts.condition !== 'auto') return;
    if (--this.regimeLeft > 0) return;
    this.regime = REGIMES[Math.floor(this.rng() * REGIMES.length)];
    // Same length in clock time on every timeframe (60-260 five-minute candles).
    this.regimeLeft = Math.max(8, Math.round((60 + Math.floor(this.rng() * 200)) / this.tfScale ** 2));
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
      generated: this.generated, timeframe: o.timeframe, barMinutes: this.barMinutes,
      profile: this.profile.id, profileName: this.profile.name,
    };
  }
}

function generate(options) {
  const market = new SyntheticMarket(options);
  for (let i = 0; i < market.opts.bars; i++) market.step();
  return market;
}

module.exports = { SyntheticMarket, generate, normalizeOptions, TIMEFRAMES, DEFAULT_TIMEFRAME, GENERIC };
