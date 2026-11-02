'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { generate } = require('../server/synthetic');
const { computeStats } = require('../server/strategies');

test('same seed gives the same candles', () => {
  const a = generate({ seed: 11, bars: 300, steer: false }).candles;
  const b = generate({ seed: 11, bars: 300, steer: false }).candles;
  assert.deepStrictEqual(a, b);
});

test('candles are well formed and stay inside the session', () => {
  const { candles } = generate({ seed: 5, bars: 800, steer: false, volatility: 'high' });
  for (const c of candles) {
    assert.ok(c.high >= Math.max(c.open, c.close) && c.low <= Math.min(c.open, c.close));
    assert.ok(c.low > 0 && c.volume > 0);
    const ist = new Date(c.time + 330 * 60000);
    const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
    assert.ok(mins >= 555 && mins < 930, `bar at ${ist.toISOString()} is outside 09:15-15:30 IST`);
    assert.ok(ist.getUTCDay() !== 0 && ist.getUTCDay() !== 6);
    assert.ok(ist.getUTCFullYear() >= 2030, 'synthetic dates must not look like real history');
  }
});

test('prices stay in a sane range over long runs', () => {
  for (let seed = 1; seed <= 40; seed++) {
    for (const condition of ['auto', 'volatile']) {
      const { candles } = generate({ seed, bars: 3000, steer: false, condition, volatility: 'high' });
      for (const c of candles) assert.ok(c.low > 22000 / 5 && c.high < 22000 * 5, `seed ${seed} ${condition}: ${c.low}..${c.high}`);
    }
  }
});

test('steering moves the simulated win rate toward the target', () => {
  const rate = (targetWinRate, steer) => {
    let wins = 0, trades = 0;
    for (let seed = 1; seed <= 8; seed++) {
      const s = computeStats(generate({ seed, bars: 1200, strategy: 'bollinger', steer, targetWinRate }).analyze().trades);
      wins += s.wins; trades += s.trades;
    }
    return wins / trades;
  };
  const low = rate(0.35, true);
  const high = rate(0.65, true);
  assert.ok(high - low > 0.15, `target 35% gave ${low.toFixed(3)}, 65% gave ${high.toFixed(3)}`);
  const at55 = rate(0.55, true);
  assert.ok(Math.abs(at55 - 0.55) < 0.08, `target 55% gave ${at55.toFixed(3)}`);
});

test('every timeframe has the right candle spacing and a realistic size', () => {
  const { TIMEFRAMES } = require('../server/synthetic');
  const sizes = {};
  for (const [tf, minutes] of Object.entries(TIMEFRAMES)) {
    const m = generate({ seed: 9, bars: 600, steer: false, timeframe: tf });
    const c = m.candles;
    const gaps = new Set();
    for (let i = 1; i < c.length; i++) {
      const sameDay = Math.floor((c[i].time + 19800000) / 864e5) === Math.floor((c[i - 1].time + 19800000) / 864e5);
      if (sameDay) gaps.add(c[i].time - c[i - 1].time);
    }
    assert.deepStrictEqual([...gaps], [minutes * 60000], `${tf} spacing`);
    let sum = 0;
    for (let i = 1; i < c.length; i++) sum += Math.abs(Math.log(c[i].close / c[i - 1].close));
    sizes[tf] = sum / (c.length - 1);
  }
  // Longer candles move more, roughly with the square root of their length.
  assert.ok(sizes['1m'] < sizes['5m'] && sizes['5m'] < sizes['15m'] && sizes['15m'] < sizes['1h'], JSON.stringify(sizes));
  const ratio = sizes['1h'] / sizes['1m'];
  assert.ok(ratio > 4 && ratio < 14, `1h/1m move ratio ${ratio.toFixed(2)}`);
});

test('EMA crossover steering also follows the target', () => {
  let wins = 0, trades = 0;
  for (let seed = 1; seed <= 8; seed++) {
    const s = computeStats(generate({ seed, bars: 1500, strategy: 'ema-cross', steer: true, targetWinRate: 0.6 }).analyze().trades);
    wins += s.wins; trades += s.trades;
  }
  assert.ok(trades > 20, `only ${trades} trades`);
  assert.ok(Math.abs(wins / trades - 0.6) < 0.12, `target 60% gave ${(wins / trades).toFixed(3)}`);
});

test('normalised options can be passed in again unchanged', () => {
  const { normalizeOptions } = require('../server/synthetic');
  const once = normalizeOptions({ seed: 4, timeframe: '15m' });
  assert.deepStrictEqual(normalizeOptions(once), once);
  assert.strictEqual(generate(once).candles[0].open, 22000);
});
