'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { parseCsv } = require('../server/historical');

test('parses ISO and epoch times, sorts, and drops duplicate times', () => {
  const csv = [
    'time,open,high,low,close,volume',
    '2024-01-02T09:20:00+05:30,2,3,1,2.5,10',
    '1704167100,1,2,0.5,1.5,5',
    '2024-01-02T09:20:00+05:30,9,9,9,9,9',
  ].join('\n');
  const c = parseCsv(csv, 't.csv');
  assert.strictEqual(c.length, 2);
  assert.strictEqual(c[0].time, 1704167100 * 1000);
  assert.strictEqual(c[1].close, 2.5);
});

test('volume is optional', () => {
  const c = parseCsv('time,open,high,low,close\n1704167100,1,2,0.5,1.5', 't.csv');
  assert.strictEqual(c[0].volume, 0);
});

test('rejects a file without OHLC columns', () => {
  assert.throws(() => parseCsv('time,price\n1,2', 't.csv'), /missing "open"/);
});

test('reads a "datetime" column with zone-less times as IST', () => {
  const c = parseCsv('datetime,open,high,low,close,volume\n2021-10-18 09:15:00,805.0,805.0,787.53,789.84,1134930', 't.csv');
  assert.strictEqual(new Date(c[0].time).toISOString(), '2021-10-18T03:45:00.000Z');
  assert.strictEqual(c[0].volume, 1134930);
});

test('reads DD-MM-YYYY dates', () => {
  const c = parseCsv('Date,Open,High,Low,Close\n18-10-2021 09:15,1,2,0.5,1.5', 't.csv');
  assert.strictEqual(new Date(c[0].time).toISOString(), '2021-10-18T03:45:00.000Z');
});

test('widens a high/low that sits inside the open/close and reports it', () => {
  const c = parseCsv('datetime,open,high,low,close\n2023-09-21 09:15:00,753.0,758.37,753.01,755.52', 't.csv');
  assert.strictEqual(c[0].low, 753.0);
  assert.strictEqual(c.fixed.length, 1);
});
