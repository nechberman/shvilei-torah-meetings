// תאריכים: נשמרים ב-UTC (timestamptz), מוצגים לפי Asia/Jerusalem,
// עם יום בשבוע + תאריך עברי מלא + תאריך לועזי DD.MM.YYYY.
// התאריך העברי מחושב ע"י @hebcal/core – אין המרה ידנית.
// מדיניות: לתורים ביום משתמשים בתאריך האזרחי המקומי, ומציגים את התאריך העברי של אותו יום
// (ללא מעבר בשקיעה). ראו README.
import { HDate, gematriya } from '@hebcal/core';

export const TZ = 'Asia/Jerusalem';

const WEEKDAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

// שמות חודשים לפי מספור hebcal (ניסן=1 ... אדר ב׳=13)
const MONTHS = {
  1: 'ניסן', 2: 'אייר', 3: 'סיוון', 4: 'תמוז', 5: 'אב', 6: 'אלול',
  7: 'תשרי', 8: 'חשוון', 9: 'כסלו', 10: 'טבת', 11: 'שבט',
};

const partsFmt = new Intl.DateTimeFormat('en-GB', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
});

/**
 * רכיבי תאריך/שעה מקומיים בירושלים
 * @param {Date|string|number} d
 */
export function zonedParts(d) {
  const date = d instanceof Date ? d : new Date(d);
  /** @type {Record<string, number>} */
  const p = {};
  for (const part of partsFmt.formatToParts(date)) {
    if (part.type !== 'literal') p[part.type] = Number(part.value);
  }
  return { year: p.year, month: p.month, day: p.day, hour: p.hour, minute: p.minute, second: p.second };
}

/** מפתח יום מקומי YYYY-MM-DD
 * @param {Date|string|number} d */
export function localDateKey(d) {
  const p = zonedParts(d);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/**
 * המרת תאריך+שעה מקומיים בירושלים ל-Date (UTC). מטפל בשעון קיץ.
 * @param {string} dateStr YYYY-MM-DD
 * @param {string} timeStr HH:MM
 */
export function zonedToUtc(dateStr, timeStr) {
  const dm = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  const tm = /^(\d{2}):(\d{2})$/.exec(timeStr);
  if (!dm || !tm) throw new Error('invalid_datetime');
  const [y, mo, da] = [Number(dm[1]), Number(dm[2]), Number(dm[3])];
  const [h, mi] = [Number(tm[1]), Number(tm[2])];
  if (h > 23 || mi > 59) throw new Error('invalid_datetime');
  const wanted = Date.UTC(y, mo - 1, da, h, mi);
  let guess = wanted;
  for (let i = 0; i < 3; i++) {
    const p = zonedParts(new Date(guess));
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute);
    const diff = wanted - asUtc;
    if (diff === 0) break;
    guess += diff;
  }
  return new Date(guess);
}

/** @param {string} key YYYY-MM-DD */
function keyToParts(key) {
  const [y, m, d] = key.split('-').map(Number);
  return { y, m, d };
}

/** שם יום בשבוע לפי יום מקומי
 * @param {string} key YYYY-MM-DD */
export function weekdayName(key) {
  const { y, m, d } = keyToParts(key);
  return WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

/** @param {string} key YYYY-MM-DD */
export function gregorianLabel(key) {
  const { y, m, d } = keyToParts(key);
  return `${String(d).padStart(2, '0')}.${String(m).padStart(2, '0')}.${y}`;
}

/** תאריך עברי מלא, למשל: ד׳ בחשוון תשפ״ז
 * @param {string} key YYYY-MM-DD (יום אזרחי מקומי) */
export function hebrewLabel(key) {
  const { y, m, d } = keyToParts(key);
  const hd = new HDate(new Date(y, m - 1, d));
  const month = hd.getMonth();
  const leap = HDate.isLeapYear(hd.getFullYear());
  let monthName;
  if (month === 12) monthName = leap ? 'אדר א׳' : 'אדר';
  else if (month === 13) monthName = 'אדר ב׳';
  else monthName = MONTHS[month];
  return `${gematriya(hd.getDate())} ב${monthName} ${gematriya(hd.getFullYear())}`;
}

/** תווית מלאה: יום חמישי, ד׳ בחשוון תשפ״ז (15.10.2026)
 * @param {string} key YYYY-MM-DD */
export function fullDayLabel(key) {
  return `יום ${weekdayName(key)}, ${hebrewLabel(key)} (${gregorianLabel(key)})`;
}

/** תווית מלאה מתוך timestamp
 * @param {Date|string|number} ts */
export function fullDayLabelFromTs(ts) {
  return fullDayLabel(localDateKey(ts));
}

/** שעה HH:MM בירושלים
 * @param {Date|string|number} ts */
export function timeLabel(ts) {
  const p = zonedParts(ts);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

/** @param {Date|string|number} start @param {Date|string|number} end */
export function timeRangeLabel(start, end) {
  // בידוד LTR כדי שהטווח לא יתהפך בתוך טקסט עברי
  return `\u2066${timeLabel(start)}–${timeLabel(end)}\u2069`;
}

/** רשימת ימים (YYYY-MM-DD) בטווח כולל
 * @param {string} fromKey @param {string} toKey */
export function daysBetween(fromKey, toKey) {
  const out = [];
  const a = keyToParts(fromKey);
  const b = keyToParts(toKey);
  let t = Date.UTC(a.y, a.m - 1, a.d);
  const end = Date.UTC(b.y, b.m - 1, b.d);
  while (t <= end && out.length < 400) {
    const dt = new Date(t);
    out.push(`${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`);
    t += 86400000;
  }
  return out;
}

/** קיבוץ פריטים לפי יום מקומי
 * @template T
 * @param {T[]} items
 * @param {(item: T) => string} getTs
 * @returns {Map<string, T[]>} */
export function groupByLocalDay(items, getTs) {
  const map = new Map();
  for (const it of items) {
    const k = localDateKey(getTs(it));
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(it);
  }
  return new Map([...map.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}
