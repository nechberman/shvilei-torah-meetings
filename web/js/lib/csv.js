// מפענח CSV לפי RFC 4180 (מרכאות, פסיקים ושורות בתוך שדה), כולל BOM
/**
 * @param {string} text
 * @returns {string[][]}
 */
export function parseCsv(text) {
  const src = text.replace(/^\uFEFF/, '');
  const delim = detectDelimiter(src);
  /** @type {string[][]} */
  const rows = [];
  /** @type {string[]} */
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"' && field === '') {
      // מרכאות פותחות רק בתחילת שדה (כך ת"ז לא שובר את הפענוח)
      inQuotes = true;
    } else if (ch === delim) {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

/** @param {string} src */
function detectDelimiter(src) {
  const firstLine = src.split(/\r?\n/, 1)[0] || '';
  const counts = { ',': 0, ';': 0, '\t': 0 };
  for (const ch of firstLine) if (ch in counts) counts[/** @type {',' | ';' | '\t'} */ (ch)]++;
  return /** @type {string} */ (Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0]);
}

/** CSV מחרוזת עם BOM (לפתיחה תקינה בעברית ב-Excel)
 * @param {(string|number|null|undefined)[][]} rows */
export function toCsv(rows) {
  const esc = (/** @type {unknown} */ v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return '\uFEFF' + rows.map((r) => r.map(esc).join(',')).join('\r\n');
}
