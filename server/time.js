'use strict';

// All candle times are epoch ms. Strategies that care about sessions
// (P1/P2 Higher-Low) read them as IST wall-clock strings.

const IST_OFFSET_MS = 330 * 60 * 1000;

const pad = (n) => String(n).padStart(2, '0');

function istParts(ms) {
  const d = new Date(ms + IST_OFFSET_MS);
  return {
    y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(),
    h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds(), wd: d.getUTCDay(),
  };
}

const istDate = (ms) => { const p = istParts(ms); return `${p.y}-${pad(p.mo)}-${pad(p.d)}`; };
const istClock = (ms) => { const p = istParts(ms); return `${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}`; };

// IST 09:15 on the given IST calendar day, as epoch ms.
const istSessionOpen = (y, mo, d) => Date.UTC(y, mo - 1, d, 9, 15) - IST_OFFSET_MS;

/**
 * Yields bar open times for an NSE-like session: Mon-Fri, 09:15-15:30 IST.
 * No holiday calendar, the synthetic market only needs a plausible rhythm.
 */
function* sessionClock(startMs, barMinutes) {
  const barMs = barMinutes * 60 * 1000;
  const barsPerSession = Math.floor((375 / barMinutes));
  let p = istParts(startMs);
  let day = Date.UTC(p.y, p.mo - 1, p.d);
  for (;;) {
    const wd = new Date(day).getUTCDay();
    if (wd !== 0 && wd !== 6) {
      const dd = new Date(day);
      const open = istSessionOpen(dd.getUTCFullYear(), dd.getUTCMonth() + 1, dd.getUTCDate());
      for (let k = 0; k < barsPerSession; k++) {
        const t = open + k * barMs;
        if (t >= startMs) yield { time: t, barOfSession: k, barsPerSession };
      }
    }
    day += 86400000;
  }
}

module.exports = { IST_OFFSET_MS, istDate, istClock, sessionClock };
