// ולידציה ונרמול של מספר זהות ישראלי (מחרוזת, כולל אפסים מובילים)
// הלוגיקה זהה לפונקציה normalize_israeli_id במסד הנתונים – השרת הוא הקובע.

/**
 * @param {unknown} value
 * @returns {string|null} 9 ספרות אם תקין, אחרת null
 */
export function normalizeIsraeliId(value) {
  if (value === null || value === undefined) return null;
  const digits = String(value).replace(/[\s-]/g, '');
  if (!/^[0-9]{5,9}$/.test(digits)) return null;
  const padded = digits.padStart(9, '0');
  if (padded === '000000000') return null;
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    let x = Number(padded[i]) * (i % 2 === 0 ? 1 : 2);
    if (x > 9) x -= 9;
    sum += x;
  }
  return sum % 10 === 0 ? padded : null;
}

/** @param {unknown} value */
export function isValidIsraeliId(value) {
  return normalizeIsraeliId(value) !== null;
}

/** מסכה לתצוגה/לוגים: רק 2 ספרות אחרונות
 * @param {string|null|undefined} id */
export function maskId(id) {
  if (!id) return '';
  return '*******' + String(id).slice(-2);
}

/** האם קוד אישי תקין (4 ספרות בדיוק, כולל אפסים מובילים)
 * @param {unknown} code */
export function isValidCode(code) {
  return typeof code === 'string' && /^[0-9]{4}$/.test(code);
}
