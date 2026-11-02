# Strategy Lab (educational demo)

A small site that shows how our strategies read a chart and lets visitors
practise trading. Every candle on the site is simulated: users see a full
chart, replay it candle by candle from a candle they pick (like
TradingView's Bar Replay), or watch a simulated market form in real time,
and see each strategy's signals appear as they would have at that moment.

Real historical prices are never shown. Data files you add are only used on
the server to calibrate the simulated market (price level, volatility, gaps
and volume). See "Market models" below.

Nothing on the site is investment advice. All results are simulated and are
labelled that way on the chart, in the results panel and site-wide.

## Run it

```bash
npm install
npm start            # http://localhost:3000  (PORT to change)
npm test             # 27 tests, incl. a no-lookahead check for every strategy
```

Node 18+. Runtime dependencies: `express`, `exceljs` (reading Excel files in
`add-data`) and `lightweight-charts` (developer fallback only). `pg` is
optional and only used by the export script. The chart itself is
TradingView Advanced Charts, which you add yourself (see below).

## What's in it

| Path | What it does |
| --- | --- |
| `server/index.js` | Express app and API (`/api/config`, `/api/candles`, `/api/analyze`, `/api/live`) |
| `server/strategies/` | The two strategies (Bollinger Bands, EMA 9/50 crossover) and their indicators |
| `server/synthetic.js` | Simulated market generator: timeframes, market models, win-rate steering |
| `server/calibrate.js` | Turns a data file into a market model (summary numbers only) |
| `server/historical.js` | Reads the data files in `data/historical/` (server side only) |
| `deploy/` | pm2, nginx, env and update-script for the server |
| `api/index.js`, `vercel.json` | Vercel entry point and settings |
| `scripts/add-data.js` | Adds an Excel or CSV file as a market model (`npm run add-data`) |
| `scripts/export-from-db.js` | Exports candles from the dashboard database into those CSVs |
| `public/` | The page: plain HTML/JS, no build step |
| `public/trading.js` | Practice trades: market / limit / stop orders, SL / target, reverse, journal |
| `public/charts/` | Chart adapters: Advanced Charts (the site's chart) and Lightweight Charts (developer fallback) |

## Strategies

Both are in `server/strategies/index.js`, with the plain-English explanation
shown in the sidebar. One trade at a time; entries are at the candle's close.

- **Bollinger Bands (20, 2) reversal.** Middle band = SMA 20 of closes, upper
  and lower bands = ±2 standard deviations (population, as TradingView's BB).
  Buy when a candle closes back above the lower band after the previous
  candle closed below it; sell is the mirror at the upper band. Target: the
  middle band at entry. Stop: 1× ATR(14). Time exit after 30 candles. An
  entry whose middle band is under 0.3× ATR away is skipped.
- **EMA 9 / EMA 50 crossover (on close).** Buy when EMA 9 crosses above
  EMA 50 on a closed candle, sell when it crosses below. Stop 1.5× ATR(14),
  target 3× ATR (2R), and an opposite cross closes the trade and opens the
  other way. No signals before candle 50 (EMA 50 needs the history).

The numbers are constants at the top of the file (`BB`, `CROSS`).

## Practice trading

In **Replay** and **Live** mode, users take their own paper trades:

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
  in Replay, `Esc` cancel.
- Market orders fill at the current price (Replay: the current candle's
  close; Live: the latest tick, and only later price moves count). Limit
  orders wait for a better price, stop orders for a breakout, and both fill
  from the next candle that reaches them. A candle that gaps past a price
  fills at its open. If one candle touches both SL and target, the SL
  counts. Stepping back in Replay undoes trades and orders placed after
  that point.
- The "Your practice trades" panel shows win rate, ₹ P&L, total R and a
  journal, tagged SIMULATED. Practice trades are
  kept apart from the strategy's results, live in the browser only, and
  reset when the data changes.

The logic is in `public/trading.js` and covered by `test/trading.test.js`.

## Replay (bar replay) works without lookahead

Choosing **Replay** shows the whole chart with "Click a candle to start the
replay from there". Clicking a candle hides everything after it. Then step
(`▶|`, `→`), step back (`◀`, `←`), play at 1 candle per 3 s up to 20 per
second, drag the slider, or jump to the start or end. **Select bar** picks a
new starting candle at any time (`Esc` cancels). Pressing play without
picking starts at candle 151. Results and signals are hidden while picking,
so they can't give away what comes next.

On every step the browser calls `/api/analyze?upTo=N`, and the server runs
the strategy on candles `0..N` only. `test/noLookahead.test.js` checks that
each strategy gives the same signals on a prefix as on the full series.

## The simulated market

The generator makes candles of **1, 3, 5, 15, 30 minutes or 1 hour**
(Timeframe list, or the chart's own interval menu) on an NSE-like session
(09:15 to 15:30 IST, weekdays). Dates start in 2030 so they can't be
mistaken for real history. Each candle is built from 12 sub-steps, with
volatility clustering, fat-tailed shocks, U-shaped intraday volume and
volatility, overnight gaps, and a market regime (trending up or down,
ranging, volatile, or mixed). Moves scale with the candle length, so a
1-hour candle is about √60 times the size of a 1-minute one, and trends and
regimes last the same clock time on every timeframe. Each timeframe is
generated on its own (a 5-minute chart is not the 1-minute chart merged).

### Market models

**Generic index** is roughly an index future around 22,000. Each data file
in `data/historical/` (1-minute to 1-hour candles) adds "Modelled on <name>"
to the Market model list. `server/calibrate.js` reads the file on the
server and keeps only five numbers: last close (the starting price),
volatility per minute, overnight gap size, and volume per minute. The
generator then draws its own random path from those. No real candle, date
or sequence is sent to the browser, and no API returns historical candles.

### Live

Live runs a simulated market in real time. Speed **1×** is real time (a
1-minute candle takes a minute to form); 2×, 5×, 10×, 30×, 60× and 300× are
faster (never quicker than 0.3 s per candle). The default makes one candle
take about a minute. While a candle forms, the price moves in small ticks
(every 0.25 to 1 s) along a random path through the generator's sub-steps,
so the candle grows the way a real one does. Pause, a speed change or a
reconnect picks up the same candle where it was (the market is seeded).

### Outcome steering and the target win rate

On by default, target 55%, adjustable from 30 to 70%: when the selected
strategy opens a trade, the generator picks win or loss in advance with the
target probability, then drifts price toward that trade's target or stop.
That is how the demo reaches the configured win rate. It also means the
simulated win rate is a setting, not evidence about the strategy, and the
results panel says exactly that. With steering off, the candles don't depend
on the strategy at all. Use that to show how a strategy behaves in different
market conditions.

Measured over 12 seeds × 1,500 candles at a 55% target: Bollinger about 52%
(about 85 trades per chart), EMA crossover about 57% (about 36 trades).
Overlapping trades and small samples move it around. The panel warns when
there are fewer than 30 trades.

## Deploying

Two ways to host it on a tglevels.com subdomain:

- **Vercel**: see [VERCEL.md](VERCEL.md). It's serverless, with no server to
  look after. Data is added on your computer and pushed.
- **Your own Linux server**: see [DEPLOY.md](DEPLOY.md) (DNS, pm2, nginx,
  HTTPS, updates without downtime). There is no admin page:
developers add data from the command line (below).

## Adding market models (data files)

Data files are **never shown on the site**. Each one becomes a market model
("Modelled on <name>") that sets the simulated market's price level,
volatility, gaps and volume (see above). Use intraday candles, 1 minute to
1 hour. Daily files are ignored for models.

### Adding an Excel or CSV file (developers)

```bash
npm run add-data -- ~/Downloads/BAJFINANCE_15min.xlsx
npm run add-data -- NIFTY.csv --name NIFTY_5m        # pick the name used
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
site picks it up straight away, with no restart. Visitors see it in the
Market model list the next time they load the page. A trailing timeframe in
the name is dropped there ("ADANIPORTS_15min" shows as "Modelled on
ADANIPORTS"). `--remove` moves the file to a `.deleted/` folder next to the
data, so it can be put back.

On the server the script uses the same data folder as the site
(`HISTORICAL_DIR` in `/etc/strategy-lab/env`).

### Where the data lives

The server reads every `.csv` file in `data/historical/` (on the server,
`HISTORICAL_DIR`). The list is filled when the page loads, so after adding a
file, reload the page. You don't need to restart the server. A file that is
edited in place is picked up on the next request.

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
- `volume`: optional. Without it the model uses the generic volume.
- Column names are case-insensitive and extra columns are ignored.
- Keep one timeframe per file. Large files are fine: a model is computed
  once (about 30 ms for 30,000 candles) and cached until the file changes.

If a file has a problem (missing column, bad number), the Market model list
leaves it out.

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

- A datafeed for the simulated candles: full chart, replay and live (live
  ticks stream into the forming bar). The chart's interval menu offers the
  six timeframes and switching there generates that timeframe.
- A custom indicator, "Strategy Lines", that plots the Bollinger Bands or
  EMA 9 / EMA 50.
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
