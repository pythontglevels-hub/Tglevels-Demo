# Strategy Lab (educational demo)

A small site that shows how our strategies read a chart. Users switch between
historical and synthetic candles, step through history candle by candle, or
watch a synthetic market run live, and see each strategy's signals appear as
they would have in real time.

Nothing on the site is investment advice. Synthetic results are simulated and
are labelled that way on the chart, in the results panel and site-wide.

## Run it

```bash
npm install
npm start            # http://localhost:3000  (PORT to change)
npm test             # 23 tests, incl. a no-lookahead check for every strategy
```

Node 18+. Runtime dependencies: `express`, `exceljs` (reading Excel files in
`add-data`) and `lightweight-charts` (developer fallback only). `pg` is
optional and only used by the export script. The chart itself is
TradingView Advanced Charts, which you add yourself (see below).

## What's in it

| Path | What it does |
| --- | --- |
| `server/index.js` | Express app and API (`/api/config`, `/api/candles`, `/api/analyze`, `/api/live`) |
| `server/strategies/` | The three strategies and the wrapper that turns them into signals and trades |
| `server/synthetic.js` | Synthetic market generator, including win-rate steering |
| `server/historical.js` | Loads historical CSVs from `data/historical/` |
| `deploy/` | pm2, nginx, env and update-script for the server |
| `api/index.js`, `vercel.json` | Vercel entry point and settings |
| `scripts/add-data.js` | Adds an Excel or CSV file of candles to the site (`npm run add-data`) |
| `scripts/export-from-db.js` | Exports candles from the dashboard database into those CSVs |
| `public/` | The page: plain HTML/JS, no build step |
| `public/trading.js` | Practice trades: market / limit / stop orders, SL / target, reverse, journal |
| `public/charts/` | Chart adapters: Advanced Charts (the site's chart) and Lightweight Charts (developer fallback) |

## Strategies

Ported from the dashboard code, logic unchanged:

- **Pinaka (A1 / A2 / B / B2)**: `pinakaEngine.js` is copied verbatim from
  `frontend/src/strategies/pinakaEngine.js`.
- **Ceiling Break & Retest**: `ceilingEngine.js` is the engine class from
  `backend/src/strategies/ceilingBreakRetest.js`, copied verbatim.
- **P1/P2 Higher-Low (VWAP)**: `higherLowEngine.js` and `indicators.js` come
  from `backtest/src/`. One change, marked `DEMO CHANGE`: a trade still open
  at the last candle is reported as open instead of being force-closed,
  because in playback the last candle is "now". This one is intraday-only
  (it resets per session) and will not fire on daily candles.

These are copies, so changes to the dashboard strategies need copying over by
hand. `server/strategies/index.js` holds the plain-English explanations shown
in the sidebar.

Pinaka and Ceiling Break only mark entries. To show results the demo closes
every entry the same way: stop 1x ATR(14), target 1.5x ATR, or after 30
candles. The UI says this is a demo rule, not part of the strategy. Higher-Low
uses its own exits.

## Practice trading

In **Playback** and **Live** mode, users take their own paper trades:

- **From the chart.** Right-click anywhere on the chart for *Buy / Sell at
  market*, a *limit* or *stop* order at the clicked price, and *move SL /
  target here* or *close* for each open trade. The chart header has
  **Buy**, **Sell** and **Close all** buttons.
- **On the chart.** An open trade shows an entry line with quantity and
  running ₹ P&L, plus dashed SL and target lines you drag to a new price.
  TradingView's long/short position tool shades the green and red zones.
  Pending orders show as dotted lines you drag to a new price. Right-click
  again to reverse, close or cancel. Entries and exits are marked with
  arrows.
- **From the ticket** under the chart: order type (market / limit / stop),
  quantity, SL and target distances in points (**Use ATR** fills 1× and 2×
  the recent candle range), with the ₹ risk and reward shown before you
  click. Keys: `B` buy, `S` sell, `R` reverse, `X` close all, `←`/`→` step
  in Playback, `Esc` cancel.
- Market orders fill at the current price (Playback: the current candle's
  close; Live: the latest tick, and only later price moves count). Limit
  orders wait for a better price, stop orders for a breakout, and both fill
  from the next candle that reaches them. A candle that gaps past a price
  fills at its open. If one candle touches both SL and target, the SL
  counts. Stepping back in Playback undoes trades and orders placed after
  that point.
- The "Your practice trades" panel shows win rate, ₹ P&L, total R and a
  journal. On synthetic data it is tagged SIMULATED. Practice trades are
  kept apart from the strategy's results, live in the browser only, and
  reset when the data changes.

The logic is in `public/trading.js` and covered by `test/trading.test.js`.

## Playback works without lookahead

On every step the browser calls `/api/analyze?upTo=N`, and the server runs
the strategy on candles `0..N` only. `test/noLookahead.test.js` checks that
each strategy gives the same signals on a prefix as on the full series. Some
Ceiling Break markers are drawn on a pivot candle but only appear 5 candles
later, once the pivot is confirmed. The sidebar explains that delay.

## Synthetic data and the target win rate

The generator produces 5-minute candles on an NSE-like session (09:15 to
15:30 IST, weekdays). Dates start in 2030 so they can't be mistaken for real
history. The price model includes volatility clustering, fat-tailed shocks,
U-shaped intraday volume and volatility, overnight gaps, and a market regime
(trending up or down, ranging, volatile, or mixed).

**Outcome steering** (on by default, target 55%, adjustable from 30 to 70%):
when the selected strategy opens a trade, the generator picks win or loss in
advance with the target probability, then drifts price toward that trade's
target or stop. That is how the demo reaches the configured win rate. It also
means the synthetic win rate is a setting, not evidence about the strategy,
and the results panel says exactly that. With steering off, the candles don't
depend on the strategy at all. Use that to show how a strategy behaves in
different market conditions.

Measured over 12 seeds × 1,500 candles at a 55% target: Pinaka about 55%,
Ceiling Break about 52%. Overlapping trades and small samples move it around.
The panel warns when there are fewer than 30 trades.

Synthetic results and historical results are never combined. The results
panel only shows the currently selected source and changes its style and
labelling to match.

## Deploying

Two ways to host it on a tglevels.com subdomain:

- **Vercel**: see [VERCEL.md](VERCEL.md). It's serverless, with no server to
  look after. Data is added on your computer and pushed.
- **Your own Linux server**: see [DEPLOY.md](DEPLOY.md) (DNS, pm2, nginx,
  HTTPS, updates without downtime). There is no admin page:
developers add data from the command line (below).

## Historical data

### Adding an Excel or CSV file (developers)

```bash
npm run add-data -- ~/Downloads/BAJFINANCE_15min.xlsx
npm run add-data -- NIFTY.csv --name NIFTY_5m        # pick the name shown
npm run add-data -- data.xlsx --sheet "15 min"       # a sheet other than the first
npm run add-data -- NIFTY.xlsx --name NIFTY_5m --replace
npm run add-data -- --list                           # what's on the site
npm run add-data -- --remove NIFTY_5m                # take one off
```

It reads `.xlsx` and `.csv` (save old `.xls` files as `.xlsx` first). The
sheet needs a header row with the columns described under Option 2 below.
Excel date cells are read as IST, same as text dates. The file is checked
before anything is written: you see the candle count, timeframe, date range
and any rows it had to fix, and a bad file is refused with the reason. The
site picks the dataset up straight away, with no restart. Visitors see it in
the Dataset list the next time they load the page. `--remove` moves the file
to a `.deleted/` folder next to the data, so it can be put back.

On the server the script uses the same data folder as the site
(`HISTORICAL_DIR` in `/etc/strategy-lab/env`).

### Where the data lives

The site reads every `.csv` file in `data/historical/` (on the server,
`HISTORICAL_DIR`). Each file becomes one
entry in the **Dataset** dropdown, named after the file (`NIFTY50_5m.csv`
shows up as "NIFTY50 5m"). The dropdown is filled when the page loads, so
after adding a file, reload the page. You don't need to restart the server.
A file that is edited in place is picked up on the next request.

### Option 1: export from the dashboard database (recommended)

The dashboard already stores candles in Postgres (`candles` table: 1-minute
bars, plus daily bars as resolution 1440). From this project's folder:

```bash
npm install pg
# same connection settings as the dashboard (database/src/pool.js)
export DATABASE_URL=postgres://USER:PASSWORD@HOST:5432/tgg

# 5-minute candles for Jan to Mar 2025
npm run export-db -- --symbol NSE:NIFTY50-INDEX --minutes 5 --from 2025-01-01 --to 2025-03-31
# daily candles
npm run export-db -- --symbol NSE:NIFTY50-INDEX --minutes 1440 --from 2023-01-01 --to 2025-03-31
```

That writes e.g. `data/historical/NIFTY50_INDEX_5m.csv`. Use the symbol
exactly as stored in the dashboard (see `symbols/*.json` there). `--out
path.csv` picks a different file name. The script makes one read-only
SELECT. Run it from a machine that can reach the database, then copy the CSV
to the server. The public site never connects to the database itself.

### Option 2: any CSV you already have

Export from Fyers, a broker terminal, Excel, etc. and save it as
`data/historical/<name>.csv` with this header:

```
time,open,high,low,close,volume
2025-01-02T09:15:00+05:30,23700.5,23745.1,23690.0,23730.2,123456
2025-01-02T09:20:00+05:30,23730.2,23751.0,23722.4,23748.9,98211
```

- `time` (or `datetime`, `date`, `timestamp`): when the candle opens.
  Accepted: `2025-01-02 09:15:00`, `2025-01-02T09:15:00+05:30`,
  `02-01-2025 09:15` (day first), or epoch seconds/milliseconds. Times
  without a zone are read as IST (set `HISTORICAL_TZ=+00:00` to change).
  Rows can be in any order. Duplicate times are dropped.

This format, as exported for BAJFINANCE 15-minute candles, works as-is:

```
datetime,open,high,low,close,volume
2021-10-18 09:15:00,805.0,805.0,787.53,789.84,1134930
```
- `open,high,low,close`: numbers, no thousands separators.
- `volume`: optional. Higher-Low needs it for VWAP and BCVC; Pinaka treats
  missing volume as 1 per bar.
- Column names are case-insensitive and extra columns are ignored.
- Keep one timeframe per file. Large files work: 30,000 candles of 15-minute
  data load in under a second and playback steps take about a quarter second.

Which data suits which strategy: Higher-Low only fires on intraday candles
(it resets every session). Pinaka and Ceiling Break work on any timeframe.

If a file has a problem (missing column, bad number), the dropdown leaves it
out and `/api/config` lists the error next to the file name.

## TradingView Advanced Charts

The chart is TradingView's **Advanced Charts** library (`charting_library`).
TradingView gives it to companies free of charge for public web projects (on
their terms), but it is not open source and can't be shipped in this repo.
Request access at https://www.tradingview.com/advanced-charts/ (the
"Get library" form). Once approved you get access to their private GitHub
repository.

To install it, copy the `charting_library/` folder from that repository to
`public/charting_library/` (so `public/charting_library/charting_library.standalone.js`
exists) and reload the page. No restart is needed. Until it is there, the
chart area says the library is missing.

`public/charts/advanced.js` connects it to the demo:

- A datafeed for historical, synthetic and live candles (live ticks
  stream into the forming bar).
- A custom indicator, "Strategy Lines", that plots the strategy's VWAP,
  bands, EMAs and ceiling.
- Strategy signals as arrows, and the strategy's open stop / target as
  dashed lines.
- The practice-trading tools described above, built only from drawings
  (lines, arrows, the long/short position tool), the right-click menu and
  header buttons. Order lines, position lines and execution shapes are
  Trading Platform features since library version 29, so they aren't used:
  the plain Advanced Charts library is enough.

Tested in a browser against Advanced Charts v29+ (the library build the
team installed).

For development without the library, `?chart=lightweight` on the URL uses
the free Lightweight Charts instead. Visitors are never sent there.

## Deploying on the subdomain

It's a single Node process. Put it behind your usual reverse proxy. For live
mode, turn off response buffering on `/api/live` (it sends
`X-Accel-Buffering: no` for nginx). `MAX_LIVE_STREAMS` (default 50) caps
concurrent live sessions, and each one runs its own generator.
