#!/usr/bin/env node
'use strict';

/**
 * Exports candles from the dashboard's Postgres `candles` table into a CSV
 * the demo can load (data/historical/<name>.csv).
 *
 *   DATABASE_URL=postgres://... npm run export-db -- \
 *     --symbol NSE:NIFTY50-INDEX --minutes 5 --from 2025-01-01 --to 2025-03-31
 *
 * Connection: DATABASE_URL, or PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD,
 * same as the dashboard's database/src/pool.js. Read-only: one SELECT.
 *
 * --minutes 1440 reads the stored daily candles. Anything else reads the
 * stored 1-minute candles and aggregates them into N-minute bars aligned
 * to the 09:15 IST session open.
 */

const fs = require('fs');
const path = require('path');

function args() {
  const out = { minutes: 5 };
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i += 2) out[a[i].replace(/^--/, '')] = a[i + 1];
  if (!out.symbol || !out.from || !out.to) {
    console.error('Usage: export-from-db.js --symbol NSE:NIFTY50-INDEX --minutes 5 --from YYYY-MM-DD --to YYYY-MM-DD [--out file.csv]');
    process.exit(1);
  }
  out.minutes = Number(out.minutes);
  return out;
}

const IST_MS = 330 * 60000;
const SESSION_OPEN_MIN = 9 * 60 + 15;

function aggregate(rows, minutes) {
  const bars = [];
  let cur = null;
  for (const r of rows) {
    const t = r.time.getTime();
    const ist = t + IST_MS;
    const dayStart = ist - (ist % 86400000);
    const minOfDay = (ist - dayStart) / 60000;
    const bucket = Math.floor((minOfDay - SESSION_OPEN_MIN) / minutes);
    const start = dayStart - IST_MS + (SESSION_OPEN_MIN + bucket * minutes) * 60000;
    if (!cur || cur.time !== start) {
      cur = { time: start, open: r.open, high: r.high, low: r.low, close: r.close, volume: Number(r.volume) };
      bars.push(cur);
    } else {
      cur.high = Math.max(cur.high, r.high);
      cur.low = Math.min(cur.low, r.low);
      cur.close = r.close;
      cur.volume += Number(r.volume);
    }
  }
  return bars;
}

async function main() {
  const opts = args();
  let pg;
  try { pg = require('pg'); } catch { console.error('Install pg first: npm install pg'); process.exit(1); }
  const pool = process.env.DATABASE_URL
    ? new pg.Pool({ connectionString: process.env.DATABASE_URL })
    : new pg.Pool({
      host: process.env.PGHOST || 'localhost', port: Number(process.env.PGPORT || 5432),
      database: process.env.PGDATABASE || 'tgg', user: process.env.PGUSER || 'postgres', password: String(process.env.PGPASSWORD || ''),
    });

  const daily = opts.minutes === 1440;
  const { rows } = await pool.query(
    `SELECT time, open, high, low, close, volume FROM candles
      WHERE symbol = $1 AND resolution = $2 AND time >= $3::date AND time < ($4::date + 1)
      ORDER BY time`,
    [opts.symbol, daily ? 1440 : 1, opts.from, opts.to],
  );
  await pool.end();
  if (!rows.length) { console.error('No candles found for that symbol and range.'); process.exit(1); }

  const bars = daily
    ? rows.map((r) => ({ time: r.time.getTime(), open: r.open, high: r.high, low: r.low, close: r.close, volume: Number(r.volume) }))
    : aggregate(rows, opts.minutes);

  const tf = daily ? '1D' : `${opts.minutes}m`;
  const name = opts.out || path.join(__dirname, '..', 'data', 'historical', `${opts.symbol.replace(/^.*:/, '').replace(/[^A-Za-z0-9]+/g, '_')}_${tf}.csv`);
  const lines = ['time,open,high,low,close,volume', ...bars.map((b) => `${new Date(b.time).toISOString()},${b.open},${b.high},${b.low},${b.close},${b.volume}`)];
  fs.mkdirSync(path.dirname(name), { recursive: true });
  fs.writeFileSync(name, lines.join('\n') + '\n');
  console.log(`Wrote ${bars.length} ${tf} candles to ${name}`);
}

main().catch((err) => { console.error(err.message); process.exit(1); });
