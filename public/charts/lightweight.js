// Chart adapter for TradingView Lightweight Charts (free, Apache-2.0).
// Same interface as charts/advanced.js so app.js doesn't care which is used.

import { toChartTime, markerFor, userMarkers } from './common.js';

export class LightweightChart {
  constructor(el) {
    const { createChart, CrosshairMode } = window.LightweightCharts;
    this.el = el;
    this.chart = createChart(el, {
      autoSize: true,
      localization: { locale: 'en-IN' },
      layout: { background: { color: '#121a24' }, textColor: '#8b9bb0' },
      grid: { vertLines: { color: '#1b2533' }, horzLines: { color: '#1b2533' } },
      crosshair: { mode: CrosshairMode.Normal },
      rightPriceScale: { borderColor: '#233042' },
      timeScale: { borderColor: '#233042', timeVisible: true, secondsVisible: false, rightOffset: 6 },
    });
    this.candles = this.chart.addCandlestickSeries({
      upColor: '#22c55e', downColor: '#ef4444', wickUpColor: '#22c55e', wickDownColor: '#ef4444', borderVisible: false,
    });
    this.lines = new Map();
    this.priceLines = [];
    this.signalMarkers = [];
    this.tradeMarkers = [];
    this.positionLines = [];
    this.positions = [];

    // Shaded target / stop zones for the user's trades, drawn over the chart.
    this.zones = document.createElement('div');
    this.zones.className = 'zones';
    el.appendChild(this.zones);
    const redraw = () => this.drawZones();
    this.chart.timeScale().subscribeVisibleLogicalRangeChange(redraw);
    new ResizeObserver(redraw).observe(el);
    // The price scale autoscales on every update, so keep zones in step.
    const loop = () => { if (this.positions.length) this.drawZones(); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  }

  async ready() {}

  get name() { return 'TradingView Lightweight Charts'; }

  setData(candles, overlays = []) {
    this.candles.setData(candles.map(toBar));
    const seen = new Set();
    for (const o of overlays) {
      seen.add(o.id);
      let s = this.lines.get(o.id);
      if (!s) {
        s = this.chart.addLineSeries({ color: o.color, lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
        this.lines.set(o.id, s);
      }
      s.setData(candles.map((c, i) => (o.values[i] == null ? { time: toChartTime(c.time) } : { time: toChartTime(c.time), value: o.values[i] })));
    }
    for (const [id, s] of this.lines) {
      if (!seen.has(id)) { this.chart.removeSeries(s); this.lines.delete(id); }
    }
  }

  // Adds a new candle or updates the forming one. overlayPoints: [{ id, value }]
  update(candle, overlayPoints = []) {
    this.candles.update(toBar(candle));
    for (const p of overlayPoints) {
      const s = this.lines.get(p.id);
      if (s) s.update(p.value == null ? { time: toChartTime(candle.time) } : { time: toChartTime(candle.time), value: p.value });
    }
  }

  setSignals(signals) {
    this.signalMarkers = signals.map(markerFor);
    this.applyMarkers();
  }

  applyMarkers() {
    this.candles.setMarkers([...this.signalMarkers, ...this.tradeMarkers].sort((a, b) => a.time - b.time));
  }

  // Stop / target lines for the strategy's trades that are still open.
  setOpenTrades(trades) {
    for (const l of this.priceLines) this.candles.removePriceLine(l);
    this.priceLines = [];
    for (const t of trades) {
      this.priceLines.push(
        this.candles.createPriceLine({ price: t.target, color: 'rgba(34,197,94,0.6)', lineStyle: 2, lineWidth: 1, axisLabelVisible: false, title: `${t.type} target` }),
        this.candles.createPriceLine({ price: t.stop, color: 'rgba(239,68,68,0.6)', lineStyle: 2, lineWidth: 1, axisLabelVisible: false, title: `${t.type} stop` }),
      );
    }
  }

  // The user's practice trades: entry / SL / target lines for open ones,
  // shaded zones for all of them, and entry / exit markers.
  setTradeHandlers() {} // drag / right-click trading is Advanced Charts only

  setPositions(trades, lastTime, orders = []) {
    this.positions = trades;
    this.lastTime = lastTime;
    for (const l of this.positionLines) this.candles.removePriceLine(l);
    this.positionLines = [];
    for (const t of trades.filter((x) => x.status === 'open')) {
      const name = t.side === 'long' ? 'Buy' : 'Sell';
      this.positionLines.push(
        this.candles.createPriceLine({ price: t.entryPrice, color: '#3b82f6', lineWidth: 2, axisLabelVisible: true, title: `${name} entry` }),
        this.candles.createPriceLine({ price: t.tp, color: '#22c55e', lineWidth: 2, axisLabelVisible: true, title: 'Target' }),
        this.candles.createPriceLine({ price: t.sl, color: '#ef4444', lineWidth: 2, axisLabelVisible: true, title: 'SL' }),
      );
    }
    for (const o of orders.filter((x) => x.status === 'pending')) {
      this.positionLines.push(this.candles.createPriceLine({
        price: o.price, color: o.side === 'long' ? '#22c55e' : '#ef4444', lineWidth: 1, lineStyle: 1,
        axisLabelVisible: true, title: `${o.side === 'long' ? 'Buy' : 'Sell'} ${o.type}`,
      }));
    }
    this.tradeMarkers = userMarkers(trades);
    this.applyMarkers();
    this.drawZones();
  }

  drawZones() {
    const ts = this.chart.timeScale();
    const width = ts.width();
    const html = [];
    for (const t of this.positions) {
      const x1 = ts.timeToCoordinate(toChartTime(t.entryTime));
      const end = t.status === 'open' ? null : ts.timeToCoordinate(toChartTime(t.exitTime));
      if (x1 == null || x1 > width) continue;
      const x2 = t.status === 'open' ? width : Math.max(end ?? width, x1 + 4);
      const yEntry = this.candles.priceToCoordinate(t.entryPrice);
      const yTp = this.candles.priceToCoordinate(t.tp);
      const ySl = this.candles.priceToCoordinate(t.sl);
      if (yEntry == null || yTp == null || ySl == null) continue;
      const box = (a, b, cls) => `<div class="zone ${cls}${t.status === 'open' ? '' : ' done'}" style="left:${x1}px;width:${x2 - x1}px;top:${Math.min(a, b)}px;height:${Math.abs(a - b)}px"></div>`;
      html.push(box(yEntry, yTp, 'tp'), box(yEntry, ySl, 'sl'));
    }
    this.zones.innerHTML = html.join('');
  }

  // Calls cb(price) when the chart is clicked (used to place SL / target).
  onClickPrice(cb) {
    this.el.addEventListener('click', (e) => {
      const y = e.clientY - this.el.getBoundingClientRect().top;
      if (y > this.chart.paneSize().height) return; // click on the time axis
      const price = this.candles.coordinateToPrice(y);
      if (price != null) cb(price);
    }, true); // capture: the chart's canvas stops click propagation
  }

  fit() { this.chart.timeScale().fitContent(); }

  showRecent(bars = 150) {
    const ts = this.chart.timeScale();
    const n = this.candles.data().length;
    ts.setVisibleLogicalRange({ from: Math.max(0, n - bars), to: n + 6 });
  }

  followLatest() { this.chart.timeScale().scrollToRealTime(); }
}

function toBar(c) {
  return { time: toChartTime(c.time), open: c.open, high: c.high, low: c.low, close: c.close };
}
