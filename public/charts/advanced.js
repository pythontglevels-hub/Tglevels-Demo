// Chart adapter for TradingView Advanced Charts (the licensed
// "charting_library"). This is the site's chart. The library itself is not
// in this repo: TradingView gives access after an application, and it goes
// in public/charting_library/. See README.md.
//
// What it draws:
//   - candles from our own datafeed (historical, synthetic, playback, live)
//   - the strategy's indicator lines, through a custom indicator
//   - strategy signals as arrows
//   - the user's practice trades: an entry line with running P&L, stop loss
//     and target lines you can drag, pending limit / stop orders you can
//     drag, and the long / short position tool for the green / red zones.
//     Only drawings are used: order / position lines and execution shapes
//     need the Trading Platform licence, not Advanced Charts.
//   - right-click menu and header buttons for Buy / Sell / Close all
//
// The adapter talks back to app.js through setTradeHandlers().

const TIMEFRAME_TO_RESOLUTION = { '1m': '1', '3m': '3', '5m': '5', '15m': '15', '30m': '30', '1h': '60', '2h': '120', '4h': '240', '1D': '1D' };
const PRICE_SCALE = 100; // 0.01 tick
const MAX_SIGNAL_SHAPES = 400; // newest signals only, so long files stay fast

// Fixed slots for the strategy lines. Every strategy's overlays map onto these.
const SLOTS = [
  { title: 'VWAP', color: '#f59e0b', ids: ['vwap'] },
  { title: 'Upper band', color: '#a78bfa', ids: ['bandUp', 'upper'] },
  { title: 'Lower band', color: '#a78bfa', ids: ['bandDn', 'lower'] },
  { title: 'EMA9 high', color: '#38bdf8', ids: ['emaHigh'] },
  { title: 'EMA9 low', color: '#0ea5e9', ids: ['emaLow', 'ema9Low'] },
  { title: 'Ceiling', color: '#f43f5e', ids: ['ceiling'] },
];
const SLOT_OF = Object.fromEntries(SLOTS.flatMap((s, i) => s.ids.map((id) => [id, i])));
const INDICATOR = 'Strategy Lines';
const LOCKED = { lock: true, disableSelection: true, disableSave: true, disableUndo: true, showInObjectsTree: false };

export class AdvancedChart {
  constructor(el) {
    this.el = el;
    this.bars = [];
    this.lines = new Map(); // tv time (ms) -> [slot values]
    this.subscriber = null;
    this.resolution = '5';
    this.daily = false;
    this.gen = 0;
    this.title = 'Demo';
    this.loading = Promise.resolve();
    this.handlers = {};
    this.signalShapes = new Map(); // key -> execution shape
    this.strategyLines = new Map(); // key -> entity id
    this.userObjects = new Map(); // key -> { kind, obj, sig }
    this.dragging = new Set();
    this.readyPromise = new Promise((resolve) => {
      this.widget = new window.TradingView.widget({
        container: el,
        library_path: '/charting_library/',
        datafeed: this.datafeed(),
        symbol: 'DEMO',
        interval: this.resolution,
        timezone: 'Asia/Kolkata',
        theme: 'dark',
        locale: 'en',
        autosize: true,
        custom_indicators_getter: (PineJS) => Promise.resolve([this.indicator(PineJS)]),
        disabled_features: [
          'header_symbol_search', 'header_compare', 'symbol_search_hot_key', 'header_resolutions',
          'header_saveload', 'use_localstorage_for_settings', 'timeframes_toolbar', 'display_market_status',
        ],
        overrides: {
          'paneProperties.backgroundType': 'solid',
          'paneProperties.background': '#121a24',
          'mainSeriesProperties.candleStyle.upColor': '#22c55e',
          'mainSeriesProperties.candleStyle.downColor': '#ef4444',
          'mainSeriesProperties.candleStyle.wickUpColor': '#22c55e',
          'mainSeriesProperties.candleStyle.wickDownColor': '#ef4444',
          'mainSeriesProperties.candleStyle.drawBorder': false,
        },
      });
      this.widget.chartReady().then(() => {
        this.chart.createStudy(INDICATOR, true, true);
        this.widget.onContextMenu((unixtime, price) => this.contextMenu(price));
        this.widget.headerReady().then(() => this.headerButtons());
        resolve();
      });
    });
  }

  get name() { return 'TradingView Advanced Charts'; }

  ready() { return this.readyPromise; }

  get chart() { return this.widget.activeChart(); }

  setTradeHandlers(h) { this.handlers = h; }

  // ── Data ────────────────────────────────────────────────────────────

  // Daily bars must sit at 00:00 UTC of their trading date.
  tvTime(ms) {
    if (!this.daily) return ms;
    const ist = new Date(ms + 330 * 60000);
    return Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate());
  }

  toBar(c) {
    return { time: this.tvTime(c.time), open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume };
  }

  datafeed() {
    return {
      onReady: (cb) => setTimeout(() => cb({ supported_resolutions: Object.values(TIMEFRAME_TO_RESOLUTION) })),
      searchSymbols: (input, exchange, type, onResult) => onResult([]),
      resolveSymbol: (name, onResolve) => setTimeout(() => onResolve({
        name: this.title, ticker: name, description: this.title, type: 'stock', exchange: 'Strategy Lab', listed_exchange: 'Strategy Lab',
        session: '24x7', timezone: 'Asia/Kolkata', format: 'price', minmov: 1, pricescale: PRICE_SCALE,
        has_intraday: !this.daily, has_daily: true, supported_resolutions: [this.resolution],
        visible_plots_set: 'ohlcv', volume_precision: 0, data_status: 'streaming',
      })),
      getBars: (symbolInfo, resolution, { from, to, countBack, firstDataRequest }, onResult) => {
        if (resolution !== this.resolution) return onResult([], { noData: true });
        const end = this.bars.findIndex((b) => b.time >= to * 1000);
        const stop = end < 0 ? this.bars.length : end;
        let start = stop;
        while (start > 0 && this.bars[start - 1].time >= from * 1000) start--;
        start = Math.max(0, Math.min(start, stop - (countBack || 0)));
        // Hand over everything on the first request. Drawings can only be
        // placed on loaded bars, and even 30,000 candles are cheap.
        // (Synthetic dates are in the future, past the `to` the chart asks
        // for, so the first answer ignores `to` as well.)
        const bars = firstDataRequest ? this.bars.slice() : this.bars.slice(start, stop);
        onResult(bars, { noData: bars.length === 0 && !firstDataRequest });
      },
      // One subscription per loaded series. A tick meant for the new series
      // must never reach the old one: the chart rejects a bar older than
      // its last and stops updating for good.
      subscribeBars: (symbolInfo, resolution, onTick, uid) => {
        this.subscriber = symbolInfo.ticker === `DEMO-${this.gen}` ? { uid, onTick } : null;
      },
      unsubscribeBars: (uid) => { if (this.subscriber && this.subscriber.uid === uid) this.subscriber = null; },
    };
  }

  indicator(PineJS) {
    const lines = this.lines;
    const nan = SLOTS.map(() => NaN);
    return {
      name: INDICATOR,
      metainfo: {
        _metainfoVersion: 53,
        id: 'StrategyLines@tv-basicstudies-1',
        name: INDICATOR,
        description: INDICATOR,
        shortDescription: 'Strategy',
        is_price_study: true,
        isCustomIndicator: true,
        format: { type: 'inherit' },
        plots: SLOTS.map((s, i) => ({ id: `plot_${i}`, type: 'line' })),
        defaults: {
          styles: Object.fromEntries(SLOTS.map((s, i) => [`plot_${i}`, {
            linestyle: 0, linewidth: 1, plottype: 7, trackPrice: false, transparency: 0, visible: true, color: s.color,
          }])),
          inputs: {},
        },
        styles: Object.fromEntries(SLOTS.map((s, i) => [`plot_${i}`, { title: s.title, histogramBase: 0 }])),
        inputs: [],
      },
      constructor: function () {
        this.main = function (context) {
          return lines.get(PineJS.Std.time(context)) || nan;
        };
      },
    };
  }

  // Loads a whole new series. Calls made after this wait until it's on screen.
  setData(candles, overlays = [], timeframe, title) {
    this.daily = timeframe === '1D';
    this.resolution = TIMEFRAME_TO_RESOLUTION[timeframe] || '5';
    if (title) this.title = title;
    this.bars = candles.map((c) => this.toBar(c));
    this.lines.clear();
    candles.forEach((c, i) => this.lines.set(this.tvTime(c.time), slotValues(overlays, i)));
    this.overlayIds = overlays.map((o) => o.id);
    this.clearDrawings();
    const gen = ++this.gen;
    this.subscriber = null;
    this.loading = this.ready().then(() => new Promise((resolve) => {
      // widget.setSymbol takes symbol + interval together. (chart.setSymbol
      // has no interval argument and would leave the old one in place.)
      this.widget.setSymbol(`DEMO-${gen}`, this.resolution, resolve);
    })).then(() => this.dataReady());
    return this.loading;
  }

  // Drawings can only go on bars the chart has already taken in.
  dataReady() {
    return new Promise((resolve) => {
      const r = safe(() => this.chart.dataReady(() => resolve()));
      if (r === true || r == null) resolve();
      else if (typeof r.then === 'function') r.then(() => resolve(), () => resolve());
      setTimeout(resolve, 3000); // never hold the page up
    });
  }

  // Adds a new candle or updates the forming one.
  update(candle, overlayPoints = []) {
    const bar = this.toBar(candle);
    const last = this.bars[this.bars.length - 1];
    if (last && last.time === bar.time) this.bars[this.bars.length - 1] = bar;
    else this.bars.push(bar);
    if (overlayPoints.length) {
      const v = SLOTS.map(() => NaN);
      for (const p of overlayPoints) if (p.value != null && SLOT_OF[p.id] != null) v[SLOT_OF[p.id]] = p.value;
      this.lines.set(bar.time, v);
    }
    if (this.subscriber) this.subscriber.onTick(bar);
  }

  clearDrawings() {
    for (const id of this.signalShapes.values()) this.removeEntity(id);
    this.signalShapes.clear();
    for (const id of this.strategyLines.values()) this.removeEntity(id);
    this.strategyLines.clear();
    for (const o of this.userObjects.values()) this.removeEntity(o.promise);
    this.userObjects.clear();
  }

  // ── Strategy signals ────────────────────────────────────────────────

  // Arrows with a label. (Execution shapes, order lines and position lines
  // are Trading Platform only, so everything here uses plain drawings,
  // which Advanced Charts has.)
  async setSignals(signals) {
    await this.loading;
    const want = new Map(signals.slice(-MAX_SIGNAL_SHAPES).map((s) => [`${s.type}:${s.index}:${s.kind}`, s]));
    for (const [key, id] of this.signalShapes) {
      if (!want.has(key)) { this.removeEntity(id); this.signalShapes.delete(key); }
    }
    for (const [key, s] of want) {
      if (this.signalShapes.has(key)) continue;
      const up = s.kind === 'entry' ? s.side === 'long' : (s.kind === 'exit' ? s.side !== 'long' : false);
      const color = s.kind === 'info' ? '#94a3b8' : s.kind === 'exit' ? (s.outcome === 'win' ? '#22c55e' : '#ef4444') : (up ? '#22c55e' : '#ef4444');
      this.signalShapes.set(key, this.arrow(s.time, s.price, up, s.kind === 'exit' ? s.outcome : s.type, color));
    }
  }

  arrow(time, price, up, text, color, retry = true) {
    const gen = this.gen;
    return Promise.resolve().then(() => this.chart.createShape({ time: this.tvTime(time) / 1000, price }, {
      shape: up ? 'arrow_up' : 'arrow_down', text, ...LOCKED,
      overrides: { arrowColor: color, color, fontsize: 12 },
    })).catch((err) => {
      // The chart may still be taking in the bars: try once more.
      if (retry && gen === this.gen) return new Promise((r) => setTimeout(r, 600)).then(() => (gen === this.gen ? this.arrow(time, price, up, text, color, false) : null));
      console.warn('Advanced Charts: arrow', err);
      return null;
    });
  }

  removeEntity(idOrPromise) {
    Promise.resolve(idOrPromise).then((id) => { if (id != null) safe(() => this.chart.removeEntity(id)); });
  }

  // The strategy's own open trades: faint dashed stop / target lines.
  async setOpenTrades(trades) {
    await this.loading;
    const want = new Map();
    for (const t of trades) {
      want.set(`${t.type}:${t.entryIndex}:tp:${t.target}`, [t.target, '#22c55e', `${t.type} target`]);
      want.set(`${t.type}:${t.entryIndex}:sl:${t.stop}`, [t.stop, '#ef4444', `${t.type} stop`]);
    }
    for (const [key, id] of this.strategyLines) {
      if (!want.has(key)) { this.removeEntity(id); this.strategyLines.delete(key); }
    }
    for (const [key, [price, color, text]] of want) {
      if (this.strategyLines.has(key)) continue;
      this.strategyLines.set(key, this.hline(price, text, color, { linestyle: 2, transparency: 40 }));
    }
  }

  hline(price, text, color, extra = {}, draggable = false) {
    const lastTime = this.bars.length ? this.bars[this.bars.length - 1].time / 1000 : Date.now() / 1000;
    return this.chart.createShape({ time: lastTime, price }, {
      shape: 'horizontal_line', text,
      ...(draggable ? { lock: false, disableSelection: false, disableSave: true, disableUndo: true, showInObjectsTree: false } : LOCKED),
      overrides: {
        linecolor: color, linewidth: 1, linestyle: 0, showLabel: true, textcolor: color, showPrice: true,
        horzLabelsAlign: 'right', vertLabelsAlign: 'bottom', fontsize: 12, bold: true, ...extra,
      },
    }).catch((err) => { console.warn('Advanced Charts: line', err); return null; });
  }

  // ── The user's practice trades ──────────────────────────────────────
  //
  // Entry line with running P&L, SL and target lines you can drag, pending
  // orders as dashed lines you can drag, green / red zones with the long /
  // short position tool, and arrows where trades opened and closed.

  watchDrags() {
    if (this.watchingDrags) return;
    this.watchingDrags = true;
    this.widget.subscribe('drawing_event', (id, type) => {
      const entry = [...this.userObjects.values()].find((o) => o.id === id);
      if (!entry) return;
      if (type === 'remove') {
        // Deleted by the user (Delete key / trash icon): draw it again next time.
        for (const [key, o] of this.userObjects) if (o === entry) this.userObjects.delete(key);
        return;
      }
      if ((type === 'points_changed' || type === 'move') && entry.onDrag) {
        const price = safe(() => this.chart.getShapeById(id).getPoints()[0].price);
        if (price != null && Math.abs(price - entry.price) > 1e-9) {
          entry.price = price;
          clearTimeout(entry.dragTimer);
          // points_changed fires while dragging; act once the line settles.
          entry.dragTimer = setTimeout(() => entry.onDrag(price), 250);
        }
      }
    });
  }

  async setPositions(trades, lastTime, orders = []) {
    await this.loading;
    this.watchDrags();
    const h = this.handlers;
    const seen = new Set();
    const lastPrice = this.bars.length ? this.bars[this.bars.length - 1].close : 0;

    for (const t of trades) {
      const buy = t.side === 'long';
      const name = buy ? 'Buy' : 'Sell';
      if (t.status === 'open') {
        const pnl = (buy ? 1 : -1) * (lastPrice - t.entryPrice) * t.qty;
        this.keepLine(seen, `pos:${t.id}`, t.entryPrice, `${name} ${t.qty} @ ${t.entryPrice.toFixed(2)} · P&L ${rupees(pnl)}`, '#3b82f6', {}, null);
        for (const [field, color, label] of [['sl', '#ef4444', 'SL'], ['tp', '#22c55e', 'Target']]) {
          const level = t[field];
          const amount = Math.abs(level - t.entryPrice) * t.qty * (field === 'sl' ? -1 : 1);
          this.keepLine(seen, `${field}:${t.id}`, level, `${label} ${level.toFixed(2)} · ${rupees(amount)}`, color,
            { linestyle: 2 }, (price) => h.moveLevel?.(t.id, field, price));
        }
      }

      // Green / red zones with the built-in long / short position tool.
      const endTime = t.status === 'open' ? lastTime : t.exitTime;
      const sig = `${t.status}:${t.sl}:${t.tp}:${endTime}`;
      this.keepEntity(seen, `zone:${t.id}`, sig, () => this.chart.createMultipointShape(
        [{ time: this.tvTime(t.entryTime) / 1000, price: t.entryPrice }, { time: this.tvTime(endTime) / 1000, price: t.entryPrice }],
        {
          shape: buy ? 'long_position' : 'short_position', ...LOCKED,
          overrides: {
            profitLevel: Math.round(Math.abs(t.tp - t.entryPrice) * PRICE_SCALE),
            stopLevel: Math.round(Math.abs(t.entryPrice - t.sl) * PRICE_SCALE),
            qty: t.qty,
          },
        },
      ));

      this.keepEntity(seen, `in:${t.id}`, '', () => this.arrow(t.entryTime, t.entryPrice, buy, `You: ${name}`, '#3b82f6'));
      if (t.status !== 'open') {
        const label = { tp: 'Target', sl: 'SL', manual: 'Closed', reversed: 'Reversed' }[t.status];
        this.keepEntity(seen, `out:${t.id}`, '', () => this.arrow(t.exitTime, t.exitPrice, !buy,
          `${label} ${t.r >= 0 ? '+' : ''}${t.r.toFixed(2)}R`, t.r > 0 ? '#22c55e' : '#ef4444'));
      }
    }

    for (const o of orders.filter((x) => x.status === 'pending')) {
      const color = o.side === 'long' ? '#22c55e' : '#ef4444';
      this.keepLine(seen, `ord:${o.id}`, o.price,
        `${o.side === 'long' ? 'Buy' : 'Sell'} ${o.type} ${o.qty} @ ${o.price.toFixed(2)}`,
        color, { linestyle: 1 }, (price) => h.moveOrder?.(o.id, price));
    }

    for (const [key, o] of this.userObjects) {
      if (!seen.has(key)) { this.removeEntity(o.promise); this.userObjects.delete(key); }
    }
  }

  // A horizontal line kept in step with `price` and `text`. With `onDrag`
  // the user can drag it; the new price goes to onDrag.
  keepLine(seen, key, price, text, color, extra, onDrag) {
    seen.add(key);
    let entry = this.userObjects.get(key);
    if (!entry) {
      entry = { price, text, onDrag };
      entry.promise = this.hline(price, text, color, extra, !!onDrag).then((id) => { entry.id = id; return id; });
      this.userObjects.set(key, entry);
      return;
    }
    entry.onDrag = onDrag;
    if (entry.id == null) return;
    const shape = safe(() => this.chart.getShapeById(entry.id));
    if (!shape) return;
    if (text !== entry.text) { entry.text = text; safe(() => shape.setProperties({ text })); }
    // Snap back to the trade's level (also undoes a drag the app refused).
    if (Math.abs(price - entry.price) > 1e-9 || Math.abs(shape.getPoints()[0].price - price) > 1e-9) {
      entry.price = price;
      clearTimeout(entry.dragTimer);
      safe(() => shape.setPoints([{ time: shape.getPoints()[0].time, price }]));
    }
  }

  // A drawing that can't be edited in place: recreated when `sig` changes.
  keepEntity(seen, key, sig, create) {
    seen.add(key);
    const entry = this.userObjects.get(key);
    if (entry && entry.sig === sig) return;
    if (entry) this.removeEntity(entry.promise);
    const next = { sig };
    next.promise = Promise.resolve().then(create).then((id) => { next.id = id; return id; })
      .catch((err) => { console.warn(`Advanced Charts: could not draw ${key}`, err); return null; });
    this.userObjects.set(key, next);
  }

  // ── Actions from the chart itself ───────────────────────────────────

  contextMenu(price) {
    const items = this.handlers.contextMenu?.(price) || [];
    return items.map((i) => (i === '-' ? { position: 'top', text: '-' } : { position: 'top', text: i.text, click: i.action }));
  }

  headerButtons() {
    const add = (text, color, title, action) => {
      const b = this.widget.createButton({ align: 'left' });
      b.textContent = text;
      b.title = title;
      b.style.cssText = `color:#fff;background:${color};padding:0 12px;border-radius:4px;font-weight:600;cursor:pointer`;
      b.addEventListener('click', () => action());
    };
    add('Buy', '#15803d', 'Buy at market with the SL / target from the trade panel', () => this.handlers.buy?.());
    add('Sell', '#b91c1c', 'Sell at market with the SL / target from the trade panel', () => this.handlers.sell?.());
    add('Close all', '#334155', 'Close every open practice trade', () => this.handlers.closeAll?.());
  }

  onClickPrice(cb) {
    this.ready().then(() => {
      let price = null;
      this.chart.crossHairMoved().subscribe(null, (p) => { price = p.price; });
      this.widget.subscribe('mouse_down', () => { if (price != null) cb(price); });
    });
  }

  fit() { this.loading.then(() => safe(() => this.chart.executeActionById('timeScaleReset'))); }
  showRecent() { this.fit(); }
  followLatest() { safe(() => this.chart.executeActionById('timeScaleReset')); }
}

function slotValues(overlays, i) {
  const v = SLOTS.map(() => NaN);
  for (const o of overlays) {
    const slot = SLOT_OF[o.id];
    if (slot != null && o.values[i] != null) v[slot] = o.values[i];
  }
  return v;
}

function safe(fn) {
  try { return fn(); } catch (err) { console.warn('Advanced Charts:', err); return undefined; }
}

function rupees(v) {
  const r = Math.round(v);
  return `${r >= 0 ? '+' : '-'}₹${Math.abs(r).toLocaleString('en-IN')}`;
}
