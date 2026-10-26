'use strict';

const test = require('node:test');
const assert = require('node:assert');

const load = () => import('../public/trading.js');
const c = (time, open, high, low, close) => ({ time, open, high, low, close });

test('a long trade hits its target, a short trade hits its stop', async () => {
  const { PaperTrader } = await load();
  const p = new PaperTrader();
  const entry = c(0, 100, 101, 99, 100);
  p.enter({ side: 'long', price: 100, candle: entry, index: 0, sl: 98, tp: 104 });
  p.enter({ side: 'short', price: 100, candle: entry, index: 0, sl: 102, tp: 96 });
  p.update(c(1, 100, 103, 99.5, 102.5), 1);
  const [long, short] = p.trades;
  assert.strictEqual(long.status, 'open');
  assert.strictEqual(short.status, 'sl');
  assert.strictEqual(short.r, -1);
  p.update(c(2, 102.5, 104.5, 102, 104), 2);
  assert.strictEqual(long.status, 'tp');
  assert.strictEqual(long.r, 2);
  assert.deepStrictEqual(p.stats().wins, 1);
});

test('a candle that touches both levels counts as the stop', async () => {
  const { PaperTrader } = await load();
  const p = new PaperTrader();
  p.enter({ side: 'long', price: 100, candle: c(0, 100, 100, 100, 100), index: 0, sl: 99, tp: 101 });
  p.update(c(1, 100, 102, 98, 100), 1);
  assert.strictEqual(p.trades[0].status, 'sl');
});

test('rejects a stop loss on the wrong side', async () => {
  const { PaperTrader } = await load();
  assert.throws(() => new PaperTrader().enter({ side: 'long', price: 100, candle: c(0, 1, 1, 1, 1), index: 0, sl: 101, tp: 105 }));
});

test('live entry on a forming candle ignores its earlier range', async () => {
  const { PaperTrader } = await load();
  const p = new PaperTrader();
  // Candle already dipped to 95 before the entry at 100.
  p.enter({ side: 'long', price: 100, candle: c(0, 99, 100, 95, 100), index: 0, sl: 97, tp: 103, forming: true });
  p.update(c(0, 99, 100.5, 95, 100.2), 0);
  assert.strictEqual(p.trades[0].status, 'open');
  p.update(c(0, 99, 100.5, 96.5, 96.8), 0);
  assert.strictEqual(p.trades[0].status, 'sl');
});

test('rewinding playback removes later entries and reopens trades', async () => {
  const { PaperTrader } = await load();
  const candles = [c(0, 100, 100, 100, 100), c(1, 100, 101, 99.5, 100.5), c(2, 100.5, 103, 100, 102.5), c(3, 102, 102, 101, 101.5)];
  const p = new PaperTrader();
  p.enter({ side: 'long', price: 100, candle: candles[0], index: 0, sl: 99, tp: 102 });
  for (let i = 1; i <= 2; i++) p.update(candles[i], i);
  p.enter({ side: 'short', price: 102.5, candle: candles[2], index: 2, sl: 104, tp: 100 });
  assert.strictEqual(p.trades[0].status, 'tp');
  p.rewind(candles, 1);
  assert.strictEqual(p.trades.length, 1);
  assert.strictEqual(p.trades[0].status, 'open');
  p.update(candles[2], 2);
  assert.strictEqual(p.trades[0].status, 'tp');
});

test('a gap through the stop fills at the open, not at the stop', async () => {
  const { PaperTrader } = await load();
  const p = new PaperTrader();
  p.enter({ side: 'long', price: 100, candle: c(0, 100, 100, 100, 100), index: 0, sl: 98, tp: 104 });
  p.update(c(1, 96, 97, 95, 96.5), 1);
  assert.strictEqual(p.trades[0].exitPrice, 96);
  assert.strictEqual(p.trades[0].r, -2);
});

test('a buy limit fills on a later candle that dips to its price', async () => {
  const { PaperTrader } = await load();
  const p = new PaperTrader();
  p.placeOrder({ side: 'long', type: 'limit', price: 98, marketPrice: 100, slPts: 2, tpPts: 4, qty: 10, candle: c(0, 100, 100, 100, 100), index: 0 });
  p.update(c(1, 100, 101, 99, 100.5), 1);
  assert.strictEqual(p.trades.length, 0);
  p.update(c(2, 100, 100, 97.5, 98.5), 2);
  const t = p.trades[0];
  assert.deepStrictEqual([t.entryPrice, t.sl, t.tp, t.qty, p.orders[0].status], [98, 96, 102, 10, 'filled']);
  p.update(c(3, 99, 102.5, 98.5, 102), 3);
  assert.strictEqual(t.status, 'tp');
  assert.strictEqual(p.stats().pnl, 40);
});

test('order prices on the wrong side are refused', async () => {
  const { PaperTrader } = await load();
  const p = new PaperTrader();
  const base = { marketPrice: 100, slPts: 1, tpPts: 2, candle: c(0, 1, 1, 1, 1), index: 0 };
  assert.throws(() => p.placeOrder({ ...base, side: 'long', type: 'limit', price: 101 }), /below/);
  assert.throws(() => p.placeOrder({ ...base, side: 'short', type: 'stop', price: 101 }), /below/);
  assert.doesNotThrow(() => p.placeOrder({ ...base, side: 'long', type: 'stop', price: 101 }));
});

test('reverse closes the trade and opens the opposite one', async () => {
  const { PaperTrader } = await load();
  const p = new PaperTrader();
  const t = p.enter({ side: 'long', price: 100, candle: c(0, 100, 100, 100, 100), index: 0, sl: 98, tp: 104, qty: 5 });
  const r = p.reverse(t.id, 101, c(1, 100, 101, 100, 101), 1);
  assert.strictEqual(t.status, 'reversed');
  assert.strictEqual(t.points, 1);
  assert.deepStrictEqual([r.side, r.entryPrice, r.sl, r.tp, r.qty], ['short', 101, 103, 97, 5]);
});

test('rewinding before a fill puts the order back to pending', async () => {
  const { PaperTrader } = await load();
  const candles = [c(0, 100, 100, 100, 100), c(1, 100, 100.5, 99.5, 100), c(2, 100, 100, 97, 98)];
  const p = new PaperTrader();
  p.placeOrder({ side: 'long', type: 'limit', price: 98, marketPrice: 100, slPts: 2, tpPts: 4, candle: candles[0], index: 0 });
  p.update(candles[1], 1);
  p.update(candles[2], 2);
  assert.strictEqual(p.trades.length, 1);
  p.rewind(candles, 1);
  assert.strictEqual(p.trades.length, 0);
  assert.strictEqual(p.orders[0].status, 'pending');
});
