import { PaperTrader, openResult, recentAtr } from './trading.js';

const $ = (id) => document.getElementById(id);

const state = {
  config: null,
  chart: null,
  mode: 'full', // 'full' | 'playback' (Replay) | 'live'
  candles: [],
  overlays: [],
  label: null,
  timeframe: '1m',
  cursor: 0,
  selecting: false, // Replay: waiting for a click on the candle to start from
  playing: false,
  live: null, // EventSource
  liveBars: 0, // closed candles the live market has made so far
  liveFrac: 0, // how far the forming candle has got (0-1), so a resume picks it up there
  seenSignals: new Set(),
  primed: false, // false until the first signal list of a load has been shown
  requestId: 0,
  trader: new PaperTrader(),
  forming: null, // Live: the candle that is still forming
  pick: null, // { id, field } while waiting for a chart click to move SL / target
};

// ── Setup ──────────────────────────────────────────────────────────────

// Every element the script uses. If one is missing, index.html on the
// server is older than app.js (only some files were replaced, or an old
// copy is cached), and the page says so instead of failing halfway.
const REQUIRED_IDS = ['profile', 'timeframe', 'strategy', 'modeSeg', 'regenerate', 'target', 'targetOut', 'steer',
  'chart', 'pbSelect', 'pbStart', 'pbBack', 'pbFwd', 'pbEnd', 'pbPlay', 'pbSlider', 'liveSpeed', 'livePause',
  'tkBuy', 'tkSell', 'tkAtr', 'tkType', 'tkPriceField', 'tkOrderPrice', 'tkQty', 'tkSl', 'tkTp', 'tkRisk', 'tkMsg', 'tkPositions'];

async function init() {
  const missing = REQUIRED_IDS.filter((id) => !$(id));
  if (missing.length) {
    throw new Error(`this page's index.html doesn't match app.js (missing: ${missing.join(', ')}). `
      + 'Upload every file in public/ from the latest version, then hard-refresh (Ctrl+Shift+R).');
  }
  state.config = await getJson('/api/config');
  state.chart = await createChart();

  const cfg = state.config;
  $('strategy').innerHTML = cfg.strategies.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
  // Market models: generic, or modelled on a dataset the developer added.
  // Only the dataset's volatility, price level, gaps and volume are used.
  $('profile').innerHTML = ['<option value="generic">Generic index</option>']
    .concat(cfg.profiles.map((p) => `<option value="${esc(p.id)}">Modelled on ${esc(p.name)}</option>`)).join('');
  $('timeframe').innerHTML = cfg.timeframes.map((tf) => `<option value="${tf}"${tf === cfg.defaultTimeframe ? ' selected' : ''}>${tfName(tf)}</option>`).join('');
  fillLiveSpeeds();

  bindSeg('modeSeg', (v) => { state.mode = v; reload(); });
  $('profile').addEventListener('change', reload);
  $('timeframe').addEventListener('change', () => { fillLiveSpeeds(); reload(); });
  $('strategy').addEventListener('change', reload);
  $('regenerate').addEventListener('click', reload);
  $('target').addEventListener('input', () => { $('targetOut').textContent = `${$('target').value}%`; });
  $('steer').addEventListener('change', () => { $('target').disabled = !$('steer').checked; });

  $('pbSelect').addEventListener('click', () => (state.selecting ? endSelect() : startSelect()));
  $('pbStart').addEventListener('click', () => { pause(); endSelect(); seek(0); });
  $('pbBack').addEventListener('click', () => { pause(); endSelect(); seek(state.cursor - 1); });
  $('pbFwd').addEventListener('click', () => { pause(); endSelect(); seek(state.cursor + 1); });
  $('pbEnd').addEventListener('click', () => { pause(); endSelect(); seek(state.candles.length - 1); });
  $('pbPlay').addEventListener('click', () => { endSelect(); return state.playing ? pause() : play(); });
  $('pbSlider').addEventListener('input', () => { pause(); endSelect(); seek(Number($('pbSlider').value)); });
  $('liveSpeed').addEventListener('change', () => { if (state.live) startLive(state.liveBars, state.liveFrac); else updateLiveStatus(); });
  $('livePause').addEventListener('click', toggleLivePause);

  $('tkBuy').addEventListener('click', () => placeTrade('long'));
  $('tkSell').addEventListener('click', () => placeTrade('short'));
  $('tkAtr').addEventListener('click', fillAtrDefaults);
  $('tkType').addEventListener('change', onOrderTypeChange);
  for (const id of ['tkSl', 'tkTp', 'tkQty']) $(id).addEventListener('input', renderRR);
  $('tkPositions').addEventListener('click', onPositionAction);
  state.chart.onClickPrice(onChartPrice);
  state.chart.setTradeHandlers({
    buy: () => placeTrade('long', { type: 'market' }),
    sell: () => placeTrade('short', { type: 'market' }),
    closeAll,
    close: closeTrade,
    reverse: reverseTrade,
    moveLevel: (id, field, price) => { moveLevel(id, field, price); renderTrading(); },
    moveOrder,
    cancelOrder,
    contextMenu,
    // The chart's own interval menu: same as picking a timeframe above it.
    timeframe: (tf) => {
      if (tf === $('timeframe').value || ![...$('timeframe').options].some((o) => o.value === tf)) return;
      $('timeframe').value = tf;
      fillLiveSpeeds();
      reload();
    },
  });
  document.addEventListener('keydown', onKey);

  reload();
}

// The site's chart is TradingView Advanced Charts. Developers without the
// library can add ?chart=lightweight to the URL to work on everything else.
async function createChart() {
  if (new URLSearchParams(location.search).get('chart') === 'lightweight') {
    const { LightweightChart } = await import('./charts/lightweight.js');
    await loadScript('/vendor/lightweight-charts.standalone.production.js');
    return new LightweightChart($('chart'));
  }
  if (!state.config.advancedCharts) {
    state.chartMissing = 'The TradingView Advanced Charts library is not installed on this server yet.<br>Copy TradingView\'s <code>charting_library</code> folder to <code>public/charting_library/</code> (see the README). No restart needed, just reload.';
    return new NoChart();
  }
  try {
    await loadScript('/charting_library/charting_library.standalone.js');
  } catch {
    state.chartMissing = 'The TradingView Advanced Charts library could not be loaded.<br>Check that TradingView\'s <code>charting_library</code> folder is in <code>public/charting_library/</code> on the server (see the README).';
    return new NoChart();
  }
  const { AdvancedChart } = await import('./charts/advanced.js');
  const chart = new AdvancedChart($('chart'));
  await chart.ready();
  return chart;
}

// Stands in for the chart when the library is missing, so the rest of the page still works.
class NoChart {
  ready() { return Promise.resolve(); }
  setData() {} update() {} setSignals() {} setOpenTrades() {} setPositions() {}
  setTradeHandlers() {} onClickPrice() {} fit() {} showRecent() {} followLatest() {}
}

function bindSeg(id, onChange) {
  $(id).addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b && !b.disabled && !b.classList.contains('active')) onChange(b.dataset.value);
  });
}

function syncControls() {
  for (const b of $('modeSeg').children) b.classList.toggle('active', b.dataset.value === state.mode);
  $('bars').disabled = state.mode === 'live';
  $('playbackBar').hidden = state.mode !== 'playback';
  $('liveBar').hidden = state.mode !== 'live';
  $('ticketOff').hidden = state.mode !== 'full';
  $('ticketOn').hidden = state.mode === 'full';
  $('ticketTag').className = 'tag sim';
  $('ticketTag').textContent = 'SIMULATED PRICES';

  // Every candle is simulated, and the chart always says so.
  $('simWatermark').hidden = false;
  $('simBadge').hidden = false;
  document.querySelector('.chart-wrap').classList.add('simulated');

  const s = currentStrategy();
  $('howTitle').textContent = `How ${s.name} works`;
  $('howSummary').textContent = s.summary;
  $('howSteps').innerHTML = s.steps.map((t) => `<li>${esc(t)}</li>`).join('');
  $('exitNote').textContent = `Exits: ${s.exits}`;
}

const currentStrategy = () => state.config.strategies.find((s) => s.id === $('strategy').value);

function params(extra = {}) {
  const p = new URLSearchParams({
    strategy: $('strategy').value,
    profile: $('profile').value,
    timeframe: $('timeframe').value,
    seed: $('seed').value,
    bars: $('bars').value,
    condition: $('condition').value,
    volatility: $('volatility').value,
    steer: $('steer').checked ? '1' : '0',
    targetWinRate: String(Number($('target').value) / 100),
  });
  for (const [k, v] of Object.entries(extra)) p.set(k, v);
  return p;
}

const TF_MINUTES = { '1m': 1, '3m': 3, '5m': 5, '15m': 15, '30m': 30, '1h': 60 };
const tfName = (tf) => (tf === '1h' ? '1 hour' : `${TF_MINUTES[tf]} minute${TF_MINUTES[tf] > 1 ? 's' : ''}`);

function fmtDuration(ms) {
  if (ms >= 3600000) return `${+(ms / 3600000).toFixed(1)} h`;
  if (ms >= 60000) return `${+(ms / 60000).toFixed(1)} min`;
  return `${+(ms / 1000).toFixed(1)} s`;
}

// Live speeds for the chosen timeframe. 1× is real time: a 1-minute candle
// takes a minute to form. The default makes a candle take about a minute.
function fillLiveSpeeds() {
  const barMs = TF_MINUTES[$('timeframe').value] * 60000;
  let best = null;
  const opts = [];
  for (const speed of state.config.liveSpeeds) {
    const ms = Math.max(300, barMs / speed);
    if (opts.length && opts.at(-1).ms === ms) continue; // capped at the fastest the chart can show
    opts.push({ speed, ms });
    if (!best || Math.abs(Math.log(ms / 60000)) < Math.abs(Math.log(best.ms / 60000))) best = { speed, ms };
  }
  $('liveSpeed').innerHTML = opts.map(({ speed, ms }) => `<option value="${speed}"${speed === best.speed ? ' selected' : ''}>`
    + `${speed}×${speed === 1 ? ' real time' : ''} · 1 candle / ${fmtDuration(ms)}</option>`).join('');
}

function updateLiveStatus(text = 'Live') {
  const o = $('liveSpeed').selectedOptions[0];
  $('liveStatus').textContent = `${text} · ${tfName($('timeframe').value)} candles · ${o ? o.textContent.split(' · ')[0] : ''} · simulated`;
}

// ── Loading ────────────────────────────────────────────────────────────

async function reload() {
  pause();
  stopLive();
  syncControls();
  state.seenSignals = new Set();
  state.primed = false;
  state.trader.reset();
  state.forming = null;
  cancelPick();
  state.candles = [];
  $('tkSl').value = '';
  $('tkTp').value = '';
  message('');
  renderTrading();
  const id = ++state.requestId;

  state.selecting = false;
  syncSelect();
  showEmpty(state.mode !== 'live' ? 'Generating simulated market…' : 'Starting live simulated market…');

  if (state.mode === 'live') return startLive();

  let data;
  try {
    data = await getJson(`/api/candles?${params()}`);
  } catch (err) {
    return showEmpty(esc(err.message));
  }
  if (id !== state.requestId) return;
  showEmpty(null);
  state.candles = data.candles;
  state.overlays = data.overlays;
  state.label = data.label;
  state.timeframe = data.label.timeframe;
  renderLegend(data.overlays);

  if (state.mode === 'full') {
    state.chart.setData(state.candles, state.overlays, state.timeframe, chartTitle());
    state.chart.fit();
    await analyze(state.candles.length - 1, id);
  } else {
    // Bar replay, like TradingView's: the whole chart first, then the user
    // clicks the candle to start from and everything after it is hidden.
    // Play or step without picking starts at candle 150.
    const n = state.candles.length;
    $('pbSlider').max = String(n - 1);
    state.cursor = Math.min(n - 1, 150);
    $('pbSlider').value = String(state.cursor);
    startSelect();
  }
  fillAtrDefaults();
}

// Asks the server for signals using only candles[0..upTo].
async function analyze(upTo, id = state.requestId) {
  const r = await getJson(`/api/analyze?${params({ upTo })}`);
  if (id !== state.requestId) return;
  renderAnalysis(r);
}

function renderAnalysis({ signals, trades, stats }) {
  state.chart.setSignals(signals);
  state.chart.setOpenTrades(trades.filter((t) => t.outcome === 'open'));
  renderStats(stats);
  renderLog(signals);
}

// ── Replay ─────────────────────────────────────────────────────────────

// "Select bar": show every candle (no signals or trades, they belong to the
// replay), and wait for a click on the candle to start from.
function startSelect() {
  if (state.mode !== 'playback' || !state.candles.length) return;
  pause();
  cancelPick();
  state.selecting = true;
  syncSelect();
  state.chart.setData(state.candles, state.overlays, state.timeframe, chartTitle());
  state.chart.setSignals([]);
  state.chart.setOpenTrades([]);
  state.chart.setPositions([], null, []);
  state.chart.fit();
  // Results and signals would give away what happens next: hide them until a start is picked.
  $('statsCard').innerHTML = '<span class="tag sim">REPLAY</span><h2>Pick a start candle</h2><p class="muted">Click a candle on the chart. Everything after it is hidden, and the strategy\'s signals and results build up as you step or play forward.</p>';
  $('signalLog').innerHTML = '<li class="muted">Signals appear as the replay moves forward.</li>';
  $('latestCard').hidden = true;
  state.seenSignals = new Set();
  state.primed = false;
  $('pbPos').textContent = `Click the candle to start from (or press ▶ to start at candle ${state.cursor + 1})`;
  message('');
}

// Leaves "Select bar" without picking: back to where the replay was.
function endSelect() {
  if (!state.selecting) return;
  state.selecting = false;
  syncSelect();
  seek(state.cursor, true);
}

function pickBar(time) {
  if (time == null) return;
  const c = state.candles;
  let i = c.length - 1;
  while (i > 0 && c[i].time > time) i--;
  state.selecting = false;
  syncSelect();
  seek(Math.max(1, i), true).then(() => state.chart.showRecent());
}

function syncSelect() {
  $('pbSelect').classList.toggle('armed', state.selecting);
  $('pbSelect').textContent = state.selecting ? 'Cancel select' : 'Select bar';
  document.querySelector('.chart-wrap').classList.toggle('selecting', state.selecting);
  for (const id of ['tkBuy', 'tkSell']) $(id).disabled = !canTrade();
}

const prefixOverlays = (end) => state.overlays.map((o) => ({ ...o, values: o.values.slice(0, end + 1) }));

async function seek(i, force = false) {
  const n = state.candles.length;
  i = Math.max(0, Math.min(n - 1, i));
  const prev = state.cursor;
  if (i === state.cursor + 1 && !force) {
    state.chart.update(state.candles[i], state.overlays.map((o) => ({ id: o.id, value: o.values[i] })));
  } else {
    state.chart.setData(state.candles.slice(0, i + 1), prefixOverlays(i), state.timeframe, chartTitle());
  }
  state.cursor = i;
  // Move the user's practice trades along with the candles.
  if (i < prev) state.trader.rewind(state.candles, i);
  else for (let j = prev + 1; j <= i; j++) state.trader.update(state.candles[j], j);
  renderTrading();
  $('pbSlider').value = String(i);
  $('pbPos').textContent = `Candle ${i + 1} / ${n} · ${fmtTime(state.candles[i].time)}`;
  await analyze(i);
}

async function play() {
  if (state.cursor >= state.candles.length - 1) await seek(0);
  state.playing = true;
  $('pbPlay').textContent = '❚❚';
  while (state.playing && state.cursor < state.candles.length - 1) {
    const started = performance.now();
    await seek(state.cursor + 1);
    state.chart.followLatest();
    const wait = Number($('pbSpeed').value) - (performance.now() - started);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
  pause();
}

function pause() {
  state.playing = false;
  $('pbPlay').textContent = '▶';
}

// ── Synthetic live ─────────────────────────────────────────────────────

function startLive(startAt, startFrac) {
  stopLive();
  const p = params({ speed: $('liveSpeed').value });
  if (startAt) p.set('startAt', String(startAt));
  if (startFrac) p.set('startFrac', String(startFrac));
  const es = new EventSource(`/api/live?${p}`);
  state.live = es;
  $('liveBar').classList.remove('paused');
  $('livePause').textContent = 'Pause';
  updateLiveStatus(startAt ? 'Connecting' : 'Starting');

  es.addEventListener('snapshot', (e) => {
    const d = JSON.parse(e.data);
    showEmpty(null);
    state.candles = d.candles;
    state.overlays = d.overlays;
    state.label = d.label;
    state.timeframe = d.label.timeframe;
    state.liveBars = d.label.generated;
    state.forming = null;
    state.liveRetries = 0;
    updateLiveStatus();
    renderLegend(d.overlays);
    state.chart.setData(d.candles, d.overlays, state.timeframe, chartTitle());
    state.chart.showRecent();
    renderAnalysis(d);
    if (!$('tkSl').value) fillAtrDefaults();
    renderTrading();
  });
  es.addEventListener('tick', (e) => {
    const c = JSON.parse(e.data);
    state.liveFrac = c.frac;
    delete c.frac;
    state.forming = c;
    state.chart.update(c);
    state.trader.update(c, state.candles.length);
    renderTrading();
  });
  es.addEventListener('bar', (e) => {
    const d = JSON.parse(e.data);
    state.liveBars = d.label.generated;
    state.liveFrac = 0;
    state.forming = null;
    state.candles.push(d.candle);
    state.chart.update(d.candle, d.overlayPoints);
    state.trader.update(d.candle, state.candles.length - 1);
    renderAnalysis(d);
    renderTrading();
  });
  // The stream drops when the server restarts or the host ends a long
  // request. Reconnect from the candle we reached (the market is seeded,
  // so it carries on exactly), and give up after a few failed tries.
  es.onerror = () => {
    if (state.live !== es) return;
    es.close();
    state.liveRetries = (state.liveRetries || 0) + 1;
    if (state.liveRetries > 5) {
      state.live = null;
      $('liveStatus').textContent = 'Live stream closed. Switch mode to restart.';
      return;
    }
    updateLiveStatus('Reconnecting…');
    setTimeout(() => { if (state.live === es) startLive(state.liveBars, state.liveFrac); }, 1000 * state.liveRetries);
  };
}

function stopLive() {
  if (state.live) state.live.close();
  state.live = null;
}

// Pausing closes the stream. The generator is seeded, so resuming asks
// the server to fast-forward to the same candle and carry on from there.
function toggleLivePause() {
  if (state.live) {
    stopLive();
    $('liveBar').classList.add('paused');
    $('livePause').textContent = 'Resume';
    updateLiveStatus('Paused');
  } else {
    startLive(state.liveBars, state.liveFrac);
  }
}

// ── Practice trading ───────────────────────────────────────────────────

const canTrade = () => state.mode !== 'full' && state.candles.length > 0 && !state.selecting;

// The candle "now": the playback cursor, or the forming candle in Live.
function nowCandle() {
  if (state.mode === 'live') return { candle: state.forming || state.candles.at(-1), index: state.candles.length - (state.forming ? 0 : 1), forming: !!state.forming };
  return { candle: state.candles[state.cursor], index: state.cursor, forming: false };
}

const tick = (v) => Math.round(v * 20) / 20;
const fmtP = (v) => v.toFixed(2);
const fmtRs = (v) => {
  const r = Math.round(v);
  return `${r >= 0 ? '+' : '-'}₹${Math.abs(r).toLocaleString('en-IN')}`;
};
const qty = () => Math.max(1, Math.trunc(Number($('tkQty').value)) || 1);

function fillAtrDefaults() {
  const upto = state.mode === 'playback' ? state.candles.slice(0, state.cursor + 1) : state.candles;
  const atr = recentAtr(upto);
  if (!atr) return;
  $('tkSl').value = String(Math.max(0.05, tick(atr)));
  $('tkTp').value = String(Math.max(0.1, tick(2 * atr)));
  renderRR();
}

function renderRR() {
  const sl = Number($('tkSl').value);
  const tp = Number($('tkTp').value);
  $('tkRR').textContent = sl > 0 && tp > 0 ? `${(tp / sl).toFixed(2)} : 1` : '–';
  const q = qty();
  $('tkRisk').textContent = sl > 0 ? `risk ₹${Math.round(sl * q).toLocaleString('en-IN')} · reward ₹${Math.round(tp * q).toLocaleString('en-IN')}` : '';
}

function onOrderTypeChange() {
  const market = $('tkType').value === 'market';
  $('tkPriceField').hidden = market;
  if (!market && state.candles.length) $('tkOrderPrice').value = fmtP(nowCandle().candle.close);
}

function message(text, error = false) {
  $('tkMsg').textContent = text;
  $('tkMsg').classList.toggle('error', error);
}

// Buy / Sell from the panel, keys, chart header or right-click menu.
// `atPrice` comes from the right-click menu (a limit / stop at that price).
function placeTrade(side, { type = $('tkType').value, atPrice = null } = {}) {
  if (!canTrade()) return message(state.selecting ? 'Pick the replay\'s start candle on the chart first.' : 'Switch to Replay or Live to trade.', true);
  const sl = Number($('tkSl').value);
  const tp = Number($('tkTp').value);
  if (!(sl > 0) || !(tp > 0)) return message('Enter a stop loss and a target distance in points first.', true);
  const { candle, index, forming } = nowCandle();
  const market = candle.close;
  const buy = side === 'long';
  const dir = buy ? 1 : -1;
  try {
    if (type === 'market') {
      const t = state.trader.enter({ side, price: market, candle, index, forming, qty: qty(), sl: tick(market - dir * sl), tp: tick(market + dir * tp) });
      message(`${buy ? 'Bought' : 'Sold'} ${t.qty} at ${fmtP(market)}. SL ${fmtP(t.sl)}, target ${fmtP(t.tp)}.${state.mode === 'playback' ? ' Step or play the replay forward to see how it plays out.' : ''}`);
    } else {
      const price = tick(atPrice ?? Number($('tkOrderPrice').value));
      const o = state.trader.placeOrder({ side, type, price, marketPrice: market, slPts: sl, tpPts: tp, qty: qty(), candle, index });
      message(`${buy ? 'Buy' : 'Sell'} ${type} order for ${o.qty} placed at ${fmtP(price)}. It fills when price gets there.`);
    }
  } catch (err) {
    message(err.message, true);
  }
  renderTrading();
}

function closeTrade(id) {
  const { candle, index } = nowCandle();
  const t = state.trader.close(id, candle.close, candle, index);
  if (t) message(`Closed at ${fmtP(candle.close)}: ${fmtRs(t.points * t.qty)} (${t.r >= 0 ? '+' : ''}${t.r.toFixed(2)}R).`);
  renderTrading();
}

function closeAll() {
  for (const t of state.trader.open) closeTrade(t.id);
}

function reverseTrade(id) {
  const { candle, index, forming } = nowCandle();
  try {
    const t = state.trader.reverse(id, candle.close, candle, index, forming);
    if (t) message(`Reversed: now ${t.side === 'long' ? 'long' : 'short'} ${t.qty} at ${fmtP(t.entryPrice)}.`);
  } catch (err) {
    message(err.message, true);
  }
  renderTrading();
}

function moveOrder(id, price) {
  try {
    state.trader.moveOrder(id, tick(price), nowCandle().candle.close);
    message(`Order moved to ${fmtP(tick(price))}.`);
  } catch (err) {
    message(err.message, true);
  }
  renderTrading();
}

function cancelOrder(id) {
  state.trader.cancelOrder(id, nowCandle().index);
  message('Order cancelled.');
  renderTrading();
}

function onPositionAction(e) {
  const b = e.target.closest('button[data-act]');
  if (!b) return;
  const id = Number(b.dataset.id);
  const act = b.dataset.act;
  if (act === 'cancel') return cancelOrder(id);
  if (act === 'moveorder') {
    state.pick = { id, field: 'order' };
  } else {
    const t = state.trader.open.find((x) => x.id === id);
    if (!t) return;
    if (act === 'close') return closeTrade(id);
    if (act === 'reverse') return reverseTrade(id);
    if (act === 'breakeven') { moveLevel(id, 'sl', t.entryPrice); return renderTrading(); }
    state.pick = { id, field: act };
  }
  document.querySelector('.chart-wrap').classList.add('picking');
  const what = { sl: 'stop loss', tp: 'target', order: 'order price' }[state.pick.field];
  message(`Click on the chart at the new ${what}. Press Esc to cancel.`);
  renderTrading();
}

function onChartPrice(price, time) {
  if (state.selecting) return pickBar(time);
  if (!state.pick) return;
  const { id, field } = state.pick;
  cancelPick();
  if (field === 'order') return moveOrder(id, price);
  moveLevel(id, field, tick(price));
  renderTrading();
}

function moveLevel(id, field, price) {
  const t = state.trader.open.find((x) => x.id === id);
  if (!t) return;
  price = tick(price);
  const now = nowCandle().candle.close;
  const dir = t.side === 'long' ? 1 : -1;
  if (field === 'sl' && !(dir * (now - price) > 0)) return message(`The stop loss has to be ${dir > 0 ? 'below' : 'above'} the current price (${fmtP(now)}).`, true);
  if (field === 'tp' && !(dir * (price - now) > 0)) return message(`The target has to be ${dir > 0 ? 'above' : 'below'} the current price (${fmtP(now)}).`, true);
  try {
    state.trader.modify(t.id, { [field]: price });
    message(`${field === 'sl' ? 'Stop loss' : 'Target'} moved to ${fmtP(price)}.`);
  } catch (err) {
    message(err.message, true);
  }
}

function cancelPick() {
  state.pick = null;
  document.querySelector('.chart-wrap').classList.remove('picking');
}

// Right-click menu on the chart (Advanced Charts).
function contextMenu(price) {
  if (!canTrade()) return [{ text: state.selecting ? 'Click a candle to start the replay' : 'Switch to Replay or Live to trade', action: () => {} }];
  const p = tick(price);
  const market = nowCandle().candle.close;
  const above = p > market;
  const items = [
    { text: `Buy ${qty()} at market (${fmtP(market)})`, action: () => placeTrade('long', { type: 'market' }) },
    { text: `Sell ${qty()} at market (${fmtP(market)})`, action: () => placeTrade('short', { type: 'market' }) },
    '-',
    { text: `Buy ${above ? 'stop' : 'limit'} at ${fmtP(p)}`, action: () => placeTrade('long', { type: above ? 'stop' : 'limit', atPrice: p }) },
    { text: `Sell ${above ? 'limit' : 'stop'} at ${fmtP(p)}`, action: () => placeTrade('short', { type: above ? 'limit' : 'stop', atPrice: p }) },
  ];
  for (const t of state.trader.open) {
    const name = `${t.side === 'long' ? 'Buy' : 'Sell'} @ ${fmtP(t.entryPrice)}`;
    items.push('-',
      { text: `${name}: move SL to ${fmtP(p)}`, action: () => { moveLevel(t.id, 'sl', p); renderTrading(); } },
      { text: `${name}: move target to ${fmtP(p)}`, action: () => { moveLevel(t.id, 'tp', p); renderTrading(); } },
      { text: `${name}: reverse`, action: () => reverseTrade(t.id) },
      { text: `${name}: close`, action: () => closeTrade(t.id) });
  }
  for (const o of state.trader.pending) {
    items.push('-', {
      text: `Cancel ${o.side === 'long' ? 'buy' : 'sell'} ${o.type} @ ${fmtP(o.price)}`,
      action: () => cancelOrder(o.id),
    });
  }
  if (state.trader.open.length > 1) items.push('-', { text: 'Close all', action: closeAll });
  return items;
}

function onKey(e) {
  if (e.target.closest('input, select, textarea') || e.ctrlKey || e.metaKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === 'escape' && state.pick) { cancelPick(); message(''); return; }
  if (k === 'escape' && state.selecting) { endSelect(); return; }
  if (!canTrade()) return;
  if (k === 'b') placeTrade('long');
  else if (k === 's') placeTrade('short');
  else if (k === 'x') closeAll();
  else if (k === 'r' && state.trader.open.length) reverseTrade(state.trader.open.at(-1).id);
  else if (state.mode === 'playback' && (k === 'arrowright' || k === 'arrowleft')) {
    e.preventDefault();
    pause();
    endSelect();
    seek(state.cursor + (k === 'arrowright' ? 1 : -1));
  }
}

function renderTrading() {
  const trader = state.trader;
  const now = state.candles.length ? nowCandle().candle : null;
  state.chart.setPositions(trader.trades, now?.time, trader.orders);
  $('tkPrice').textContent = now ? fmtP(now.close) : '–';
  for (const id of ['tkBuy', 'tkSell']) $(id).disabled = !canTrade();
  renderRR();

  const open = trader.open;
  const pending = trader.pending;
  const sign = (v, s = '') => `<span class="${v >= 0 ? 'pos' : 'neg'}">${v >= 0 ? '+' : ''}${v.toFixed(2)}${s}</span>`;
  const armed = (id, f) => (state.pick?.id === id && state.pick.field === f ? ' armed' : '');
  let html = '';
  if (open.length && now) {
    html += `<div class="table-scroll"><table class="positions">
      <tr><th>Side</th><th>Qty</th><th>Entry</th><th>SL</th><th>Target</th><th>P&amp;L</th><th>R</th><th></th></tr>
      ${open.map((t) => {
        const res = openResult(t, now.close);
        return `<tr>
          <td class="${t.side === 'long' ? 'pos' : 'neg'}">${t.side === 'long' ? 'Buy' : 'Sell'}</td>
          <td>${t.qty}</td><td>${fmtP(t.entryPrice)}</td><td>${fmtP(t.sl)}</td><td>${fmtP(t.tp)}</td>
          <td><span class="${res.pnl >= 0 ? 'pos' : 'neg'}">${fmtRs(res.pnl)}</span></td><td>${sign(res.r)}</td>
          <td class="actions">
            <button data-act="sl" data-id="${t.id}" class="${armed(t.id, 'sl')}">Move SL</button>
            <button data-act="tp" data-id="${t.id}" class="${armed(t.id, 'tp')}">Move target</button>
            <button data-act="breakeven" data-id="${t.id}">SL to entry</button>
            <button data-act="reverse" data-id="${t.id}">Reverse</button>
            <button data-act="close" data-id="${t.id}">Close</button>
          </td></tr>`;
      }).join('')}</table></div>`;
  }
  if (pending.length) {
    html += `<div class="table-scroll"><table class="positions">
      <tr><th>Pending order</th><th>Qty</th><th>Price</th><th>SL / target (pts)</th><th></th></tr>
      ${pending.map((o) => `<tr>
        <td class="${o.side === 'long' ? 'pos' : 'neg'}">${o.side === 'long' ? 'Buy' : 'Sell'} ${o.type}</td>
        <td>${o.qty}</td><td>${fmtP(o.price)}</td><td>${fmtP(o.slPts)} / ${fmtP(o.tpPts)}</td>
        <td class="actions">
          <button data-act="moveorder" data-id="${o.id}" class="${armed(o.id, 'order')}">Move</button>
          <button data-act="cancel" data-id="${o.id}">Cancel</button>
        </td></tr>`).join('')}</table></div>`;
  }
  $('tkPositions').innerHTML = html;

  renderJournal();
}

function renderJournal() {
  const card = $('journalCard');
  const trades = state.trader.trades;
  card.hidden = trades.length === 0;
  if (!trades.length) return;
  card.classList.add('simulated');
  const s = state.trader.stats();
  const pct = s.winRate == null ? '–' : `${(s.winRate * 100).toFixed(0)}%`;
  const sign = (v) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}`;
  const exitName = { tp: 'target', sl: 'stop loss', manual: 'closed', reversed: 'reversed' };
  const rows = state.trader.closed.slice(-20).reverse().map((t) => `<li>
    <span class="t">${fmtTime(t.entryTime)}</span>
    <span class="badge ${t.side}">${t.side === 'long' ? 'BUY' : 'SELL'} ${t.qty}</span>
    ${fmtP(t.entryPrice)} → ${fmtP(t.exitPrice)} (${exitName[t.status]})
    <span class="badge ${t.r > 0 ? 'win' : 'loss'}">${fmtRs(t.points * t.qty)} · ${sign(t.r)}R</span></li>`).join('');
  const note = '<strong>Practice on simulated prices.</strong> These candles are generated by software, so this score is not real trading performance. Outcome steering, if on, follows the strategy\'s trades, not yours.';
  card.innerHTML = `<span class="tag sim">SIMULATED</span>
    <h2>Your practice trades</h2>
    <div class="grid">
      <div><div class="num">${pct}</div><div class="cap">win rate</div></div>
      <div><div class="num">${s.trades}</div><div class="cap">closed${s.open ? ` (+${s.open} open)` : ''}</div></div>
      <div><div class="num">${s.trades ? fmtRs(s.pnl) : '–'}</div><div class="cap">paper P&amp;L · ${s.trades ? sign(s.totalR) : '–'}R</div></div>
    </div>
    <ul class="log">${rows || '<li class="muted">No closed trades yet.</li>'}</ul>
    <p class="note">${note}</p>`;
}

// ── Rendering ──────────────────────────────────────────────────────────

function renderStats(stats) {
  const card = $('statsCard');
  card.classList.add('simulated');
  if (!stats) { card.innerHTML = '<h2>Results</h2><p class="muted">No data loaded.</p>'; return; }

  const pct = (v) => (v == null ? '–' : `${(v * 100).toFixed(1)}%`);
  const r = (v) => (v == null ? '–' : `${v >= 0 ? '+' : ''}${v.toFixed(2)}R`);
  const scope = { full: 'whole chart', playback: 'replay so far', live: 'this live session' }[state.mode];
  const head = `<span class="tag sim">SIMULATED RESULTS</span>
     <h2>${esc(stats.profileName || 'Simulated market')} model · ${esc(stats.timeframe)} · ${esc(scope)}</h2>`;

  const note = stats.steer
    ? `<strong>Not real market performance.</strong> These candles were generated by software with outcome steering on: before each trade plays out, the generator picks win or loss so that about <strong>${pct(stats.targetWinRate)}</strong> of trades win, then moves the price there. The win rate above shows that setting at work. It tells you nothing about how the strategy would do in a real market.`
    : `<strong>Not real market performance.</strong> Software-generated candles (${esc(stats.condition)} market, ${esc(stats.volatility)} volatility) with no outcome steering. Useful for seeing how the strategy reacts to a kind of market, not for judging how it performs on real prices.`;

  card.innerHTML = `${head}
    <div class="grid">
      <div><div class="num">${pct(stats.winRate)}</div><div class="cap">simulated win rate</div></div>
      <div><div class="num">${stats.trades}</div><div class="cap">closed trades${stats.open ? ` (+${stats.open} open)` : ''}</div></div>
      <div><div class="num">${r(stats.avgR)}</div><div class="cap">avg per trade</div></div>
    </div>
    <p class="note">${note}</p>
    ${stats.trades < 30 ? `<p class="note">Only ${stats.trades} closed trades so far. Win rates on small samples swing a lot.</p>` : ''}`;
}

function renderLog(signals) {
  const key = (s) => `${s.type}:${s.index}:${s.kind}`;
  const fresh = state.primed && state.mode !== 'full' ? signals.filter((s) => !state.seenSignals.has(key(s))) : [];
  const shown = signals.slice(-80).reverse();
  $('signalLog').innerHTML = shown.length
    ? shown.map((s) => {
      const badgeClass = s.kind === 'exit' ? s.outcome : (s.side || '');
      const label = s.kind === 'exit' ? `EXIT ${s.outcome}` : s.type;
      return `<li class="${fresh.includes(s) ? 'fresh' : ''}"><span class="t">${fmtTime(s.time)}</span><span class="badge ${badgeClass}">${esc(label)}</span>${esc(s.text)}</li>`;
    }).join('')
    : '<li class="muted">No signals yet.</li>';

  // Callout for the newest signal while stepping or live.
  const latest = fresh.filter((s) => s.kind !== 'exit').at(-1);
  if (latest) {
    const card = $('latestCard');
    card.hidden = false;
    card.className = `card latest ${latest.side || ''}`;
    const lag = latest.confirmedIndex > latest.index ? ` Confirmed ${latest.confirmedIndex - latest.index} candles after the marked candle.` : '';
    card.innerHTML = `<h2>Just now</h2><div class="what">${esc(latest.type)} at ${latest.price.toFixed(2)}</div><div>${esc(latest.text)}.${esc(lag)}</div>`;
  } else if (!state.primed) {
    $('latestCard').hidden = true;
  }
  for (const s of signals) state.seenSignals.add(key(s));
  state.primed = true;
}

function renderLegend(overlays) {
  $('legend').innerHTML = overlays.map((o) => `<span><i style="background:${o.color}"></i>${esc(o.title)}</span>`).join('');
}

const chartTitle = () => `Simulated · ${state.label?.profileName || 'Generic index'} model`;

function showEmpty(html) {
  html = html || state.chartMissing; // keep the "library missing" note up
  const el = $('chartEmpty');
  el.hidden = !html;
  if (html) el.innerHTML = `<div>${html}</div>`;
}

// ── Utils ──────────────────────────────────────────────────────────────

async function getJson(url) {
  const res = await fetch(url);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(s);
  });
}

const fmt = new Intl.DateTimeFormat('en-IN', { timeZone: 'Asia/Kolkata', year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
const fmtTime = (ms) => fmt.format(new Date(ms));

function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

init().catch((err) => showEmpty(`Could not start: ${esc(err.message)}`));
