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
      const s = computeStats(generate({ seed, bars: 1200, strategy: 'pinaka', steer, targetWinRate }).analyze().trades);
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
