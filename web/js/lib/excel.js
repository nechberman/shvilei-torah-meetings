// יצוא ויבוא Excel בעזרת ExcelJS (נטען רק כשצריך)
import { downloadBlob } from './ui.js';

async function loadExcel() {
  const mod = await import('exceljs');
  return /** @type {any} */ (mod).default || mod;
}

/**
 * יצוא טבלה ל-xlsx עם גיליון מימין לשמאל
 * @param {string} filename
 * @param {string} sheetName
 * @param {string[]} headers
 * @param {(string|number|null)[][]} rows
 * @param {string} [title]
 */
export async function exportXlsx(filename, sheetName, headers, rows, title) {
  const ExcelJS = await loadExcel();
  const wb = new ExcelJS.Workbook();
  wb.creator = 'מערכת זימון אסיפות הורים';
  const ws = wb.addWorksheet(sheetName.slice(0, 31), { views: [{ rightToLeft: true, state: 'frozen', ySplit: title ? 2 : 1 }] });
  if (title) {
    ws.addRow([title]).font = { bold: true, size: 14 };
    ws.mergeCells(1, 1, 1, Math.max(1, headers.length));
  }
  const hr = ws.addRow(headers);
  hr.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  hr.eachCell((/** @type {any} */ c) => {
    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF14284B' } };
    c.alignment = { horizontal: 'right' };
  });
  for (const r of rows) ws.addRow(r.map((v) => (v === null || v === undefined ? '' : v)));
  headers.forEach((hd, i) => {
    const maxLen = Math.max(hd.length, ...rows.map((r) => String(r[i] ?? '').length));
    ws.getColumn(i + 1).width = Math.min(50, Math.max(10, maxLen + 2));
    ws.getColumn(i + 1).alignment = { horizontal: 'right' };
  });
  const buf = await wb.xlsx.writeBuffer();
  downloadBlob(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), filename);
}

/**
 * קריאת קובץ xlsx לשורות טקסט (מספרי זהות נשמרים כטקסט כולל אפסים)
 * @param {File} file
 * @returns {Promise<string[][]>}
 */
export async function readXlsx(file) {
  const ExcelJS = await loadExcel();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(await file.arrayBuffer());
  const ws = wb.worksheets[0];
  if (!ws) return [];
  /** @type {string[][]} */
  const out = [];
  ws.eachRow({ includeEmpty: false }, (/** @type {any} */ row) => {
    /** @type {string[]} */
    const cells = [];
    for (let i = 1; i <= row.cellCount; i++) {
      const c = row.getCell(i);
      let v = c.value;
      if (v && typeof v === 'object') {
        if ('result' in v) v = v.result;
        else if ('richText' in v) v = v.richText.map((/** @type {any} */ t) => t.text).join('');
        else if ('text' in v) v = v.text;
      }
      cells.push(v === null || v === undefined ? '' : String(v).trim());
    }
    out.push(cells);
  });
  return out.filter((r) => r.some((c) => c !== ''));
}
