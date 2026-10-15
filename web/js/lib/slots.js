// חישוב סלוטים לתצוגה מקדימה – משקף את regenerate_slots במסד הנתונים.
// המסד הוא המקור הקובע; פונקציה זו משמשת לתצוגה בטופס ולבדיקות יחידה.

/**
 * @typedef {{start: number, end: number}} Range  // מילישניות UTC
 */

/** @param {Range} a @param {Range} b */
export function overlaps(a, b) {
  return a.start < b.end && b.start < a.end;
}

/**
 * האם יש חפיפה בין טווח חדש לרשימה קיימת
 * @param {Range} candidate @param {Range[]} existing
 */
export function hasOverlap(candidate, existing) {
  return existing.some((r) => overlaps(candidate, r));
}

/**
 * חלוקת חלונות זמינות לסלוטים
 * @param {Range[]} windows
 * @param {number} durationMinutes
 * @param {Range[]} [blocks]  חלונות חסומים
 * @param {Range[]} [booked]  סלוטים עם תורים קיימים (נשמרים, לא נדרסים)
 * @returns {{start: number, end: number, status: 'available'|'blocked'}[]}
 */
export function computeSlots(windows, durationMinutes, blocks = [], booked = []) {
  if (!Number.isInteger(durationMinutes) || durationMinutes < 5 || durationMinutes > 120) {
    throw new Error('invalid_duration');
  }
  const dur = durationMinutes * 60000;
  /** @type {{start: number, end: number, status: 'available'|'blocked'}[]} */
  const out = [];
  const sorted = [...windows].sort((a, b) => a.start - b.start);
  for (const w of sorted) {
    let t = w.start;
    while (t + dur <= w.end) {
      const cand = { start: t, end: t + dur };
      const clash = booked.filter((b) => overlaps(cand, b));
      if (clash.length) {
        t = Math.max(Math.max(...clash.map((b) => b.end)), t + 60000);
        continue;
      }
      out.push({ ...cand, status: hasOverlap(cand, blocks) ? 'blocked' : 'available' });
      t += dur;
    }
  }
  return out;
}
