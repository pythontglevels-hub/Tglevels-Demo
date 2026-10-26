// Shared helpers for both chart adapters.

// Lightweight Charts shows times as UTC. Shift by IST so the axis reads
// in exchange time (the Advanced Charts adapter sets the timezone instead).
export const IST_OFFSET_S = 330 * 60;
export const toChartTime = (ms) => Math.floor(ms / 1000) + IST_OFFSET_S;

export const COLORS = { long: '#22c55e', short: '#ef4444', info: '#94a3b8', win: '#22c55e', loss: '#ef4444' };

export function markerFor(s) {
  const time = toChartTime(s.time);
  if (s.kind === 'entry') {
    const long = s.side === 'long';
    return { time, position: long ? 'belowBar' : 'aboveBar', color: long ? COLORS.long : COLORS.short, shape: long ? 'arrowUp' : 'arrowDown', text: s.type };
  }
  if (s.kind === 'exit') {
    return { time, position: s.side === 'long' ? 'aboveBar' : 'belowBar', color: COLORS[s.outcome] || COLORS.info, shape: 'square', text: s.outcome === 'win' ? 'win' : 'loss' };
  }
  return { time, position: 'aboveBar', color: COLORS.info, shape: 'circle', text: s.type.replace('_', ' ').toLowerCase() };
}

const EXIT_TEXT = { tp: 'You: target hit', sl: 'You: SL hit', manual: 'You: closed', reversed: 'You: reversed' };

// Markers for the user's own practice trades (blue, so they stand apart
// from the strategy's signals).
export function userMarkers(trades) {
  const out = [];
  for (const t of trades) {
    const long = t.side === 'long';
    out.push({
      time: toChartTime(t.entryTime), position: long ? 'belowBar' : 'aboveBar', color: '#3b82f6',
      shape: long ? 'arrowUp' : 'arrowDown', text: long ? 'You: Buy' : 'You: Sell',
    });
    if (t.status !== 'open') {
      out.push({
        time: toChartTime(t.exitTime), position: long ? 'aboveBar' : 'belowBar',
        color: t.r > 0 ? COLORS.win : COLORS.loss, shape: 'circle',
        text: `${EXIT_TEXT[t.status]} ${t.r >= 0 ? '+' : ''}${t.r.toFixed(2)}R`,
      });
    }
  }
  return out;
}
