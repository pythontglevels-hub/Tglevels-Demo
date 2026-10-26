// Practice (paper) trades the user takes by hand during Playback or Live.
// Everything stays in the browser. Nothing is sent to the server.
//
// Market orders fill at the current price. Limit and stop orders wait as
// pending orders and fill on a later candle that reaches their price.
// An open trade is checked against every later candle: price touching the
// stop loss or the target closes it there. If one candle touches both, the
// stop is counted first (the cautious choice). A candle that opens beyond
// a level, after a gap, fills at its open price.

let nextId = 1;

export class PaperTrader {
  constructor() {
    this.trades = [];
    this.orders = [];
  }

  reset() {
    this.trades = [];
    this.orders = [];
  }

  get open() { return this.trades.filter((t) => t.status === 'open'); }
  get closed() { return this.trades.filter((t) => t.status !== 'open'); }
  get pending() { return this.orders.filter((o) => o.status === 'pending'); }

  /**
   * Market entry. side: 'long' | 'short'. `candle` is the candle the entry
   * happens on. In Live mode that candle is still forming: `formingAtEntry`
   * holds its high/low at the moment of entry, so only moves after the
   * entry count.
   */
  enter({ side, price, candle, index, sl, tp, qty = 1, forming = false, orderId = null }) {
    const dir = side === 'long' ? 1 : -1;
    if (!(dir * (price - sl) > 0) || !(dir * (tp - price) > 0)) {
      throw new Error(side === 'long'
        ? 'For a buy, the stop loss must be below the price and the target above it.'
        : 'For a sell, the stop loss must be above the price and the target below it.');
    }
    if (!(qty > 0)) throw new Error('Quantity must be more than zero.');
    const t = {
      id: nextId++, side, qty, entryPrice: price, entryTime: candle.time, entryIndex: index,
      sl, tp, initialSl: sl, risk: Math.abs(price - sl), status: 'open', orderId,
      exitPrice: null, exitTime: null, exitIndex: null,
      formingAtEntry: forming ? { high: candle.high, low: candle.low } : null,
    };
    this.trades.push(t);
    return t;
  }

  /**
   * Pending order. type 'limit' waits for a better price (buy below / sell
   * above the market), 'stop' for a breakout (buy above / sell below).
   * slPts / tpPts are distances from the fill price.
   */
  placeOrder({ side, type, price, marketPrice, slPts, tpPts, qty = 1, candle, index }) {
    checkOrderPrice(side, type, price, marketPrice);
    if (!(slPts > 0) || !(tpPts > 0)) throw new Error('Set a stop loss and a target distance first.');
    const o = {
      id: nextId++, side, type, price, slPts, tpPts, qty, status: 'pending',
      placedTime: candle.time, placedIndex: index, endIndex: null, tradeId: null,
    };
    this.orders.push(o);
    return o;
  }

  moveOrder(id, price, marketPrice) {
    const o = this.pending.find((x) => x.id === id);
    if (!o) return;
    checkOrderPrice(o.side, o.type, price, marketPrice);
    o.price = price;
  }

  cancelOrder(id, index) {
    const o = this.pending.find((x) => x.id === id);
    if (o) Object.assign(o, { status: 'cancelled', endIndex: index });
  }

  /** Moves the stop loss or target of an open trade. */
  modify(id, { sl, tp }) {
    const t = this.trades.find((x) => x.id === id && x.status === 'open');
    if (!t) return;
    const dir = t.side === 'long' ? 1 : -1;
    if (sl != null) t.sl = sl;
    if (tp != null) {
      if (!(dir * (tp - t.entryPrice) > 0)) throw new Error('The target has to be on the profit side of the entry.');
      t.tp = tp;
    }
  }

  close(id, price, candle, index) {
    const t = this.trades.find((x) => x.id === id && x.status === 'open');
    if (t) finish(t, price, candle, index, 'manual');
    return t;
  }

  /** Closes a trade and opens the opposite one with the same size and distances. */
  reverse(id, price, candle, index, forming = false) {
    const t = this.close(id, price, candle, index);
    if (!t) return null;
    const dir = t.side === 'long' ? -1 : 1;
    const slPts = Math.abs(t.entryPrice - t.sl) || t.risk;
    const tpPts = Math.abs(t.tp - t.entryPrice);
    t.status = 'reversed';
    return this.enter({
      side: t.side === 'long' ? 'short' : 'long', price, candle, index, qty: t.qty, forming,
      sl: round(price - dir * slPts), tp: round(price + dir * tpPts),
    });
  }

  /** Feeds one candle (closed, or the forming one in Live). Returns trades closed by it. */
  update(candle, index) {
    this.fillOrders(candle, index);
    const hits = [];
    for (const t of this.open) {
      if (candle.time < t.entryTime) continue;
      let { high, low } = candle;
      if (candle.time === t.entryTime) {
        // Same candle as the entry: only price action after the entry counts.
        if (!t.formingAtEntry) continue;
        high = candle.high > t.formingAtEntry.high ? candle.high : Math.max(t.entryPrice, candle.close);
        low = candle.low < t.formingAtEntry.low ? candle.low : Math.min(t.entryPrice, candle.close);
      }
      const long = t.side === 'long';
      // A candle that opens past a level (an overnight gap) fills at its open.
      const fresh = candle.time !== t.entryTime;
      const gapSl = fresh && (long ? candle.open <= t.sl : candle.open >= t.sl);
      const gapTp = fresh && (long ? candle.open >= t.tp : candle.open <= t.tp);
      if (gapSl) finish(t, candle.open, candle, index, 'sl');
      else if (gapTp) finish(t, candle.open, candle, index, 'tp');
      else if (long ? low <= t.sl : high >= t.sl) finish(t, t.sl, candle, index, 'sl');
      else if (long ? high >= t.tp : low <= t.tp) finish(t, t.tp, candle, index, 'tp');
      if (t.status !== 'open') hits.push(t);
    }
    return hits;
  }

  fillOrders(candle, index) {
    for (const o of this.pending) {
      if (candle.time <= o.placedTime) continue; // orders work from the next candle
      const buy = o.side === 'long';
      const touched = (o.type === 'limit') === buy ? candle.low <= o.price : candle.high >= o.price;
      if (!touched) continue;
      // Gapped through the order price: filled at the open instead.
      const gapped = (o.type === 'limit') === buy ? candle.open < o.price : candle.open > o.price;
      const fill = gapped ? candle.open : o.price;
      const dir = buy ? 1 : -1;
      const t = this.enter({
        side: o.side, price: fill, candle, index, qty: o.qty, orderId: o.id,
        sl: round(fill - dir * o.slPts), tp: round(fill + dir * o.tpPts),
      });
      Object.assign(o, { status: 'filled', endIndex: index, tradeId: t.id, fillPrice: fill });
    }
  }

  /**
   * Playback stepped backwards to `cursor`: drop trades and orders made
   * after it, reopen the rest and replay the candles up to the cursor.
   */
  rewind(candles, cursor) {
    this.orders = this.orders.filter((o) => o.placedIndex <= cursor);
    for (const o of this.orders) {
      if (o.status !== 'pending' && o.endIndex > cursor) Object.assign(o, { status: 'pending', endIndex: null, tradeId: null });
    }
    this.trades = this.trades.filter((t) => t.entryIndex <= cursor);
    for (const t of this.trades) {
      if (t.status !== 'open' && t.exitIndex <= cursor) continue;
      Object.assign(t, { status: 'open', exitPrice: null, exitTime: null, exitIndex: null });
    }
    const from = Math.min(
      ...this.open.map((t) => t.entryIndex + 1),
      ...this.pending.map((o) => o.placedIndex + 1),
      cursor + 1,
    );
    for (let i = from; i <= cursor; i++) this.update(candles[i], i);
  }

  stats() {
    const closed = this.closed;
    const wins = closed.filter((t) => t.r > 0).length;
    const totalR = closed.reduce((s, t) => s + t.r, 0);
    const points = closed.reduce((s, t) => s + t.points, 0);
    const pnl = closed.reduce((s, t) => s + t.points * t.qty, 0);
    return {
      trades: closed.length, open: this.open.length, pending: this.pending.length, wins,
      winRate: closed.length ? wins / closed.length : null,
      totalR, avgR: closed.length ? totalR / closed.length : null, points, pnl,
    };
  }
}

function checkOrderPrice(side, type, price, market) {
  if (!(price > 0)) throw new Error('Enter an order price.');
  const above = price > market;
  const ok = side === 'long' ? (type === 'limit' ? !above : above) : (type === 'limit' ? above : !above);
  if (!ok) {
    const where = { long: { limit: 'below', stop: 'above' }, short: { limit: 'above', stop: 'below' } }[side][type];
    throw new Error(`A ${side === 'long' ? 'buy' : 'sell'} ${type} order goes ${where} the current price (${market.toFixed(2)}).`);
  }
}

const round = (v) => Math.round(v * 20) / 20;

/** Unrealised result of an open trade at `price`. */
export function openResult(t, price) {
  const dir = t.side === 'long' ? 1 : -1;
  const points = dir * (price - t.entryPrice);
  return { points, r: points / t.risk, pnl: points * t.qty };
}

function finish(t, price, candle, index, reason) {
  const dir = t.side === 'long' ? 1 : -1;
  t.status = reason;
  t.exitPrice = price;
  t.exitTime = candle.time;
  t.exitIndex = index;
  t.points = dir * (price - t.entryPrice);
  t.r = t.points / t.risk;
}

/** Average true range over the last `len` candles, for default SL/target distances. */
export function recentAtr(candles, len = 14) {
  const n = candles.length;
  if (n < 2) return n ? candles[0].high - candles[0].low : 0;
  let sum = 0;
  let count = 0;
  for (let i = Math.max(1, n - len); i < n; i++) {
    const c = candles[i];
    const pc = candles[i - 1].close;
    sum += Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc));
    count++;
  }
  return sum / count;
}
