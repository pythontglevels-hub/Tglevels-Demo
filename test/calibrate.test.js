'use strict';

// A historical file only shapes the synthetic market. Its candles must
// never come back out of the generator.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'calib-'));
process.env.HISTORICAL_DIR = dir;

// Two weeks of 5-minute candles around 1500 with about 0.3% moves per candle.
function writeDataset(name) {
  const lines = ['time,open,high,low,close,volume'];
  let p = 1500;
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  for (let day = 1; day <= 10; day++) {
    for (let k = 0; k < 75; k++) {
      const open = p;
      p *= 1 + (rnd() - 0.5) * 0.0104; // uniform, std ≈ 0.3%
      const hi = Math.max(open, p) * 1.0005;
      const lo = Math.min(open, p) * 0.9995;
      const mins = 555 + k * 5;
      const t = `2024-03-${String(day).padStart(2, '0')} ${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
      lines.push(`${t},${open.toFixed(2)},${hi.toFixed(2)},${lo.toFixed(2)},${p.toFixed(2)},5000`);
    }
  }
  fs.writeFileSync(path.join(dir, `${name}.csv`), lines.join('\n'));
  return p;
}

const lastClose = writeDataset('TEST_5m');
const { profileFor, listProfiles } = require('../server/calibrate');
const { generate } = require('../server/synthetic');

test('a dataset becomes a market model', () => {
  assert.deepStrictEqual(listProfiles().map((p) => p.id), ['TEST_5m']);
  const p = profileFor('TEST_5m');
  assert.ok(Math.abs(p.startPrice - lastClose) < 0.01);
  const per5 = p.sigmaPerMinute * Math.sqrt(5);
  assert.ok(per5 > 0.0025 && per5 < 0.0035, `5-minute sigma ${per5}`);
  assert.ok(Math.abs(p.volumePerMinute - 1000) < 1);
});

test('the modelled market is synthetic, priced and sized like the data', () => {
  const m = generate({ seed: 1, bars: 800, steer: false, profile: 'TEST_5m', timeframe: '5m', condition: 'range' });
  const c = m.candles;
  assert.ok(new Date(c[0].time).getUTCFullYear() >= 2030);
  assert.ok(Math.abs(c[0].open / lastClose - 1) < 0.02, `starts at ${c[0].open}, data ended at ${lastClose}`);
  const r = [];
  for (let i = 1; i < c.length; i++) r.push(Math.log(c[i].close / c[i - 1].close));
  const sd = Math.sqrt(r.reduce((s, x) => s + x * x, 0) / r.length);
  assert.ok(sd > 0.002 && sd < 0.0055, `synthetic 5-minute sigma ${sd}`);
  assert.strictEqual(m.describe().profileName, 'TEST');
});

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
