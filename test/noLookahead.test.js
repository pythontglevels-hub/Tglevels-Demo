'use strict';

// Playback depends on every strategy being causal: running on
// candles[0..n] must give the same signals for those candles as running
// on the full series. If this fails, playback would show signals that
// could not have been known at that point.

const test = require('node:test');
const assert = require('node:assert');
const { STRATEGIES } = require('../server/strategies');
const { generate } = require('../server/synthetic');

const key = (s) => `${s.type}|${s.kind}|${s.index}|${s.price}`;

for (const strategy of STRATEGIES) {
  test(`${strategy.id} gives the same signals on a prefix as on the full series`, () => {
    let checked = 0;
    for (const seed of [3, 7]) {
      const candles = generate({ seed, bars: 900, steer: false, strategy: strategy.id }).candles;
      const full = strategy.run(candles);
      for (let n = 120; n < candles.length; n += 37) {
        const prefix = strategy.run(candles.slice(0, n + 1));
        const expected = full.signals
          .filter((s) => (s.kind === 'exit' ? s.index : s.confirmedIndex) <= n)
          .map(key).sort();
        assert.deepStrictEqual(prefix.signals.map(key).sort(), expected, `seed ${seed}, upTo ${n}`);
        checked += prefix.signals.length;
      }
    }
    assert.ok(checked > 0, 'test series produced no signals at all');
  });
}
