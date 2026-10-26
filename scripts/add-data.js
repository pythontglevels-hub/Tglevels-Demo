#!/usr/bin/env node
'use strict';

/**
 * Adds historical candles to the site from an Excel (.xlsx) or CSV file.
 * The site picks the new dataset up immediately: no restart, no downtime.
 *
 *   npm run add-data -- path/to/BAJFINANCE_15min.xlsx
 *   npm run add-data -- path/to/file.csv --name NIFTY_5m
 *   npm run add-data -- path/to/file.xlsx --sheet "15 min" --replace
 *   npm run add-data -- --list            # show what's on the site
 *   npm run add-data -- --remove NIFTY_5m # take one off (kept in .deleted/)
 *
 * The file needs a header row with time (or datetime / date / timestamp),
 * open, high, low, close and optionally volume. Excel date cells and text
 * like "2021-10-18 09:15:00" are both read as IST wall-clock time.
 *
 * On the server it uses HISTORICAL_DIR from /etc/strategy-lab/env (the same
 * folder the site reads), so no extra setup is needed there.
 *
 * The file is checked first. Only a valid file is written, and it is
 * written to a temporary name and renamed into place, so a visitor never
 * loads a half-written dataset.
 */

const fs = require('fs');
const path = require('path');

// Same data folder as the running site.
const ENV_FILE = process.env.STRATEGY_LAB_ENV || '/etc/strategy-lab/env';
if (!process.env.HISTORICAL_DIR && fs.existsSync(ENV_FILE)) {
  const m = fs.readFileSync(ENV_FILE, 'utf8').match(/^\s*HISTORICAL_DIR\s*=\s*(.*?)\s*$/m);
  if (m) process.env.HISTORICAL_DIR = m[1].replace(/^(['"])(.*)\1$/, '$2');
}
const historical = require('../server/historical');

const ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const pad = (n) => String(n).padStart(2, '0');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--replace' || a === '--list') out[a.slice(2)] = true;
    else if (a.startsWith('--')) out[a.slice(2)] = argv[++i];
    else out._.push(a);
  }
  return out;
}

// Excel stores date cells as wall-clock time; exceljs hands them back as
// Dates whose UTC fields hold that wall-clock time.
function cellText(v) {
  if (v == null) return '';
  if (v instanceof Date) {
    return `${v.getUTCFullYear()}-${pad(v.getUTCMonth() + 1)}-${pad(v.getUTCDate())} ${pad(v.getUTCHours())}:${pad(v.getUTCMinutes())}:${pad(v.getUTCSeconds())}`;
  }
  if (typeof v === 'object') {
    if ('result' in v) return cellText(v.result); // formula
    if (v.richText) return v.richText.map((r) => r.text).join('');
    if ('text' in v) return String(v.text);
  }
  return String(v).replace(/,/g, '');
}

async function excelToCsv(file, sheetName) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const ws = sheetName ? wb.getWorksheet(sheetName) : wb.worksheets[0];
  if (!ws) throw new Error(`No sheet called "${sheetName}". Sheets: ${wb.worksheets.map((w) => w.name).join(', ')}`);
  const lines = [];
  ws.eachRow({ includeEmpty: false }, (row) => {
    const cells = [];
    for (let c = 1; c <= row.cellCount; c++) cells.push(cellText(row.getCell(c).value).trim());
    if (cells.some(Boolean)) lines.push(cells.join(','));
  });
  return lines.join('\n') + '\n';
}

function listDatasets() {
  const sets = historical.list();
  if (!sets.length) return console.log(`No datasets in ${historical.DIR}`);
  for (const d of sets) {
    if (d.error) console.log(`  ✗ ${d.id}: ${d.error}`);
    else console.log(`  ✓ ${d.id}  ${d.timeframe}  ${d.bars} candles  ${new Date(d.from).toISOString().slice(0, 10)} → ${new Date(d.to).toISOString().slice(0, 10)}`);
  }
}

function removeDataset(id) {
  const file = path.join(historical.DIR, `${id}.csv`);
  if (!ID_RE.test(id) || !fs.existsSync(file)) throw new Error(`No dataset called "${id}". Run with --list to see them.`);
  const bin = path.join(historical.DIR, '.deleted');
  fs.mkdirSync(bin, { recursive: true });
  const dest = path.join(bin, `${id}.${new Date().toISOString().replace(/[:.]/g, '-')}.csv`);
  fs.renameSync(file, dest);
  console.log(`Removed "${id}" from the site (moved to ${dest}).`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.list) return listDatasets();
  if (args.remove) return removeDataset(args.remove);

  const src = args._[0];
  if (!src) {
    console.error('Usage: npm run add-data -- <file.xlsx|file.csv> [--name NAME] [--sheet SHEET] [--replace]\n       npm run add-data -- --list | --remove NAME');
    process.exit(1);
  }
  const ext = path.extname(src).toLowerCase();
  if (!['.xlsx', '.csv', '.txt'].includes(ext)) {
    throw new Error(ext === '.xls'
      ? 'Old .xls files are not supported. In Excel use File > Save As > .xlsx (or CSV) and try again.'
      : `Unsupported file type "${ext}". Use .xlsx or .csv.`);
  }
  const id = args.name || path.basename(src, path.extname(src)).replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+/, '').slice(0, 64);
  if (!ID_RE.test(id)) throw new Error(`"${id}" can't be used as a dataset name. Pass --name with letters, numbers, "-" or "_".`);

  const text = ext === '.xlsx' ? await excelToCsv(src, args.sheet) : fs.readFileSync(src, 'utf8');
  const s = historical.inspect(text, id);
  for (const w of s.warnings) console.log(`Note: ${w}`);

  const dest = path.join(historical.DIR, `${id}.csv`);
  if (fs.existsSync(dest) && !args.replace) {
    throw new Error(`A dataset called "${id}" already exists. Add --replace to overwrite it, or pick another --name.`);
  }
  fs.mkdirSync(historical.DIR, { recursive: true });
  const tmp = path.join(historical.DIR, `.${id}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, dest);

  const day = (ms) => new Date(ms + 330 * 60000).toISOString().slice(0, 16).replace('T', ' ');
  console.log(`Added "${id}": ${s.bars} candles, ${s.timeframe}, ${day(s.from)} → ${day(s.to)} IST`);
  console.log(`Live now. Visitors see "${id.replace(/[_-]+/g, ' ')}" in the Dataset list after reloading the page.`);
}

main().catch((err) => {
  console.error(`✗ ${err.message}`);
  process.exit(1);
});
