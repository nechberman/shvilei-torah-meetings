// דוח הדפסה A4 מימין לשמאל: סדר יום לרב (או לכל הרבנים), או דוח "לא נרשמו"
import { isConfigured, rpc, select } from '../lib/api.js';
import { requireStaff } from '../lib/auth.js';
import { fullDayLabel, groupByLocalDay, timeRangeLabel } from '../lib/dates.js';
import { errorMessage } from '../lib/errors.js';
import { alertBox, empty, h, loading, mount } from '../lib/ui.js';

const app = /** @type {HTMLElement} */ (document.getElementById('app'));

async function init() {
  if (!isConfigured()) { mount(app, alertBox('warn', errorMessage('not_configured'))); return; }
  mount(app, loading());
  await requireStaff();
  const p = new URLSearchParams(location.search);
  const confId = p.get('c');
  const teacherId = p.get('t');
  const missing = p.get('missing') === '1';
  if (!confId) { mount(app, alertBox('err', 'חסרה אסיפה בכתובת.')); return; }

  const [[settings], [conf]] = await Promise.all([
    select('settings', 'school_name'),
    select('conferences', 'id, title, starts_on, ends_on', (q) => q.eq('id', confId)),
  ]);
  if (!conf) { mount(app, alertBox('err', errorMessage('not_authorized'))); return; }
  const school = settings?.school_name || 'ישיבת שבילי התורה';
  const toolbar = h('div', { class: 'toolbar no-print' },
    h('button', { class: 'btn', type: 'button', onclick: () => window.print() }, 'הדפסה'),
    h('button', { class: 'btn secondary', type: 'button', onclick: () => window.close() }, 'סגירה'));

  /** @param {string} title @param {string} subtitle */
  const pageHead = (title, subtitle) => h('div', { class: 'print-head' },
    h('div', null, h('h1', null, school), h('div', null, title)),
    h('div', { class: 'meta' }, h('div', null, conf.title), h('div', null, subtitle)));

  if (missing) {
    const rows = (await rpc('staff_students_status', { p_conference_id: confId, p_teacher_id: teacherId }))
      .filter((/** @type {any} */ r) => !r.appointment_id);
    const byTeacher = groupBy(rows, (/** @type {any} */ r) => r.teacher_name);
    mount(app, toolbar, rows.length === 0 ? empty('כל התלמידים נרשמו') :
      [...byTeacher].map(([tname, list]) => h('section', { class: 'print-page' },
        pageHead(`תלמידים שטרם נרשמו – ${tname}`, `${list.length} תלמידים`),
        h('table', { class: 'data' },
          h('thead', null, h('tr', null, h('th', null, '#'), h('th', null, 'תלמיד'), h('th', null, 'כיתה'), h('th', null, 'הערות / רישום ידני'))),
          h('tbody', null, ...list.map((/** @type {any} */ r, /** @type {number} */ i) => h('tr', null,
            h('td', null, String(i + 1)), h('td', null, r.full_name), h('td', null, r.class_name), h('td', { class: 'write-in' }, ''))))))));
    return;
  }

  const board = await rpc('staff_conference_board', { p_conference_id: confId, p_teacher_id: teacherId });
  const byTeacher = groupBy(board, (/** @type {any} */ b) => b.teacher_name);
  const pages = [];
  for (const [tname, slots] of byTeacher) {
    const byDay = groupByLocalDay(slots, (/** @type {any} */ s) => s.starts_at);
    for (const [day, list] of byDay) {
      const first = list[0];
      const last = list[list.length - 1];
      pages.push(h('section', { class: 'print-page' },
        pageHead(`סדר יום – ${tname}`, `${list.filter((/** @type {any} */ s) => s.appointment_id).length} פגישות`),
        h('div', { class: 'print-day' }, `${fullDayLabel(day)}, ${timeRangeLabel(first.starts_at, last.ends_at)}`),
        h('table', { class: 'data' },
          h('thead', null, h('tr', null, h('th', null, 'שעה'), h('th', null, 'תלמיד'), h('th', null, 'כיתה'), h('th', null, 'רישום ידני'))),
          h('tbody', null, ...list.map((/** @type {any} */ s) => h('tr', null,
            h('td', { style: 'white-space:nowrap' }, timeRangeLabel(s.starts_at, s.ends_at)),
            h('td', null, s.appointment_id ? s.student_name : s.slot_status === 'blocked' ? '— הפסקה —' : ''),
            h('td', null, s.class_name || ''),
            h('td', { class: 'write-in' }, '')))))));
    }
  }
  mount(app, toolbar, pages.length ? pages : empty('אין תורים להצגה'));
}

/**
 * @template T @param {T[]} items @param {(x: T) => string} key
 * @returns {Map<string, T[]>}
 */
function groupBy(items, key) {
  const m = new Map();
  for (const it of items) {
    const k = key(it);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(it);
  }
  return m;
}

init().catch((e) => { if (e?.message !== 'redirect') mount(app, alertBox('err', errorMessage(e))); });
