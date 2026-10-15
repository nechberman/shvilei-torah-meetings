// דף הורים: זיהוי בתעודת זהות (ואופציונלית קוד אישי), בחירת יום ושעה, אישור.
// הטוקן נשמר בזיכרון בלבד; אין גישה ישירה למסד.
import { callFn, isConfigured } from '../lib/api.js';
import { fullDayLabel, fullDayLabelFromTs, groupByLocalDay, hebrewLabel, gregorianLabel, weekdayName, timeLabel, timeRangeLabel } from '../lib/dates.js';
import { errorMessage } from '../lib/errors.js';
import { isValidCode, normalizeIsraeliId } from '../lib/israeli-id.js';
import { alertBox, h, loading, mount, siteHeader } from '../lib/ui.js';

const app = /** @type {HTMLElement} */ (document.getElementById('app'));
const headHost = /** @type {HTMLElement} */ (document.getElementById('head'));

/** @type {{settings: any, token: string|null, data: any, conf: any, slots: any[], day: string|null, slot: any}} */
const state = { settings: null, token: null, data: null, conf: null, slots: [], day: null, slot: null };

function renderHead() {
  mount(headHost, siteHeader(state.settings, 'זימון תור לאסיפת הורים'));
}

async function init() {
  renderHead();
  if (!isConfigured()) {
    mount(app, alertBox('warn', errorMessage('not_configured')));
    return;
  }
  mount(app, loading());
  try {
    const res = await callFn('parent', { action: 'settings' });
    if (res?.ok) state.settings = res.settings;
  } catch {
    /* ממשיכים עם ברירת מחדל */
  }
  renderHead();
  renderEntry();
}

/** @param {string} [error] */
function renderEntry(error) {
  const requireCode = !!state.settings?.require_parent_code;
  const idInput = /** @type {HTMLInputElement} */ (h('input', {
    id: 'nid', name: 'nid', type: 'text', inputmode: 'numeric', autocomplete: 'off', class: 'big',
    maxlength: '11', required: true, 'aria-describedby': 'nid-hint',
  }));
  const codeInput = requireCode ? /** @type {HTMLInputElement} */ (h('input', {
    id: 'code', name: 'code', type: 'password', inputmode: 'numeric', autocomplete: 'off', class: 'big',
    maxlength: '4', pattern: '[0-9]{4}', required: true,
  })) : null;
  const errHost = h('div', { 'aria-live': 'assertive' }, error ? alertBox('err', error) : null);
  const btn = /** @type {HTMLButtonElement} */ (h('button', { class: 'btn block', type: 'submit' }, 'המשך'));

  const form = h('form', { novalidate: true, onsubmit: async (/** @type {Event} */ e) => {
    e.preventDefault();
    const nid = normalizeIsraeliId(idInput.value);
    if (!nid) {
      mount(errHost, alertBox('err', errorMessage('invalid_id')));
      idInput.focus();
      return;
    }
    const code = codeInput ? codeInput.value.trim() : null;
    if (codeInput && !isValidCode(code)) {
      mount(errHost, alertBox('err', errorMessage('code_required')));
      codeInput.focus();
      return;
    }
    btn.disabled = true;
    btn.textContent = 'בודק…';
    try {
      const res = await callFn('parent', { action: 'lookup', nationalId: nid, code });
      if (!res?.ok) throw new Error(res?.error || 'error');
      state.token = res.token;
      state.data = res;
      if (res.settings) state.settings = res.settings;
      renderStudent();
    } catch (err) {
      mount(errHost, alertBox('err', errorMessage(err)));
      btn.disabled = false;
      btn.textContent = 'המשך';
    }
  } },
  errHost,
  h('div', { class: 'field' },
    h('label', { for: 'nid' }, 'מספר תעודת הזהות של התלמיד'),
    idInput,
    h('div', { class: 'hint', id: 'nid-hint' }, '9 ספרות, כולל ספרת ביקורת')),
  codeInput ? h('div', { class: 'field' }, h('label', { for: 'code' }, 'קוד אישי (4 ספרות)'), codeInput,
    h('div', { class: 'hint' }, 'הקוד נמסר על ידי הישיבה')) : null,
  btn);

  mount(app,
    h('div', { class: 'parent-hero' },
      state.settings?.logo_url ? h('img', { class: 'logo', src: state.settings.logo_url, alt: 'סמל הישיבה' }) : null,
      h('h1', null, 'זימון תור לאסיפת הורים'),
      h('div', { class: 'school' }, state.settings?.school_name || 'ישיבת שבילי התורה')),
    h('section', { class: 'panel', 'aria-label': 'כניסה' }, form),
    h('p', { class: 'muted small', style: 'text-align:center' },
      h('a', { href: './staff.html' }, 'כניסת צוות')));
  idInput.focus();
}

function studentStrip() {
  const s = state.data.student;
  return h('div', { class: 'student-strip' },
    h('div', null, h('div', { class: 'k' }, 'תלמיד'), h('div', { class: 'v' }, s.full_name)),
    h('div', null, h('div', { class: 'k' }, 'כיתה'), h('div', { class: 'v' }, s.class_name)),
    h('div', null, h('div', { class: 'k' }, 'הרב המשויך'), h('div', { class: 'v' }, s.teacher_name)));
}

function backToStart() {
  state.token = null;
  state.data = null;
  renderEntry();
}

function renderStudent() {
  const confs = state.data.conferences || [];
  const list = confs.length === 0
    ? h('div', { class: 'empty' }, h('strong', null, 'אין כרגע אסיפה פתוחה להרשמה'), 'כשתיפתח אסיפה, תוכלו לקבוע בה תור כאן.')
    : confs.map((/** @type {any} */ c) => h('section', { class: 'panel' },
      h('h2', null, c.title),
      c.description ? h('p', { class: 'muted' }, c.description) : null,
      c.appointment
        ? h('div', null,
          h('div', { class: 'booked-line' },
            h('div', null,
              h('div', null, 'נקבע תור:'),
              h('strong', null, `${fullDayLabelFromTs(c.appointment.starts_at)}, בשעה ${timeLabel(c.appointment.starts_at)}`))),
          h('p', { class: 'muted small', style: 'margin-top:8px' }, 'לשינוי או ביטול התור יש לפנות לרב או למזכירות.'),
          addressBlock())
        : h('button', { class: 'btn block', type: 'button', onclick: () => openConference(c) }, 'בחירת מועד')));

  mount(app,
    studentStrip(),
    list,
    h('button', { class: 'btn secondary', type: 'button', onclick: backToStart }, 'יציאה'));
}

function addressBlock() {
  const st = state.settings || {};
  if (!st.address && !st.waze_url) return null;
  return h('div', { style: 'margin-top:12px' },
    st.address ? h('p', null, h('strong', null, 'כתובת הישיבה: '), st.address) : null,
    st.waze_url ? h('a', { class: 'btn waze', href: st.waze_url, target: '_blank', rel: 'noopener noreferrer' }, 'ניווט ב-Waze') : null);
}

/** @param {any} conf */
async function openConference(conf) {
  state.conf = conf;
  state.day = null;
  state.slot = null;
  mount(app, studentStrip(), h('section', { class: 'panel' }, h('h2', null, conf.title), loading('טוען מועדים פנויים…')));
  try {
    const res = await callFn('parent', { action: 'slots', token: state.token, conferenceId: conf.id });
    if (!res?.ok) throw new Error(res?.error || 'error');
    state.slots = res.slots;
    renderPicker();
  } catch (err) {
    handleSessionError(err);
  }
}

/** @param {unknown} err @param {string} [extra] */
function handleSessionError(err, extra) {
  const msg = errorMessage(err);
  if (String(/** @type {any} */ (err)?.message) === 'session_expired') {
    renderEntry(msg);
    return;
  }
  mount(app, studentStrip(), h('section', { class: 'panel' },
    alertBox('err', msg, extra ? h('div', null, extra) : null),
    h('button', { class: 'btn secondary', type: 'button', onclick: renderStudent }, 'חזרה')));
}

/** @param {string} [notice] */
function renderPicker(notice) {
  const byDay = groupByLocalDay(state.slots, (/** @type {any} */ s) => s.starts_at);
  const panel = h('section', { class: 'panel' }, h('h2', null, state.conf.title));
  if (notice) panel.append(alertBox('err', notice));

  if (byDay.size === 0) {
    panel.append(h('div', { class: 'empty' }, h('strong', null, 'אין כרגע שעות פנויות'),
      'ייתכן שכל השעות נתפסו או שהרב עדיין לא פתח זמנים. נסו שוב מאוחר יותר.'));
  } else {
    panel.append(h('h3', { id: 'day-h' }, 'בחרו יום'));
    const leaves = h('ul', { class: 'day-leaves', 'aria-labelledby': 'day-h' });
    for (const [day, slots] of byDay) {
      const heb = hebrewLabel(day).split(' ');
      leaves.append(h('li', null, h('button', {
        class: 'leaf', type: 'button', 'aria-pressed': String(state.day === day),
        'aria-label': `${fullDayLabel(day)}, ${slots.length} שעות פנויות`,
        onclick: () => { state.day = day; state.slot = null; renderPicker(); },
      },
      h('span', { class: 'wd' }, `יום ${weekdayName(day)}`),
      h('span', { class: 'hd' }, heb[0]),
      h('span', { class: 'hm' }, heb.slice(1).join(' ')),
      h('span', { class: 'gd' }, gregorianLabel(day)),
      h('span', { class: 'cnt' }, `${slots.length} שעות פנויות`))));
    }
    panel.append(leaves);

    if (state.day && byDay.has(state.day)) {
      panel.append(h('h3', { id: 'time-h' }, `בחרו שעה – ${fullDayLabel(state.day)}`));
      const times = h('ul', { class: 'times', 'aria-labelledby': 'time-h' });
      for (const s of byDay.get(state.day) || []) {
        times.append(h('li', null, h('button', {
          class: 'time-btn', type: 'button', 'aria-pressed': String(state.slot?.id === s.id),
          onclick: () => { state.slot = s; renderConfirm(); },
        }, timeLabel(s.starts_at))));
      }
      panel.append(times);
    }
  }
  panel.append(h('button', { class: 'btn secondary', type: 'button', onclick: renderStudent }, 'חזרה'));
  mount(app, studentStrip(), panel);
}

function renderConfirm() {
  const s = state.slot;
  const st = state.data.student;
  const btn = /** @type {HTMLButtonElement} */ (h('button', { class: 'btn', type: 'button', onclick: () => book(btn) }, 'אישור וקביעת התור'));
  mount(app, h('section', { class: 'confirm-sheet', 'aria-labelledby': 'cf-h' },
    h('div', { class: 'top', id: 'cf-h' }, 'בדקו את הפרטים לפני האישור'),
    h('dl', null,
      h('dt', null, 'אסיפה'), h('dd', null, state.conf.title),
      h('dt', null, 'תלמיד'), h('dd', null, st.full_name),
      h('dt', null, 'הרב'), h('dd', null, st.teacher_name),
      h('dt', null, 'תאריך'), h('dd', { class: 'date-big' }, fullDayLabelFromTs(s.starts_at)),
      h('dt', null, 'שעה'), h('dd', null, timeRangeLabel(s.starts_at, s.ends_at))),
    h('p', { class: 'muted small', style: 'padding:0 18px' }, 'לאחר האישור לא ניתן לשנות את התור באתר.'),
    h('div', { class: 'actions' },
      btn,
      h('button', { class: 'btn secondary', type: 'button', onclick: () => renderPicker() }, 'בחירת שעה אחרת'))));
  btn.focus();
}

/** @param {HTMLButtonElement} btn */
async function book(btn) {
  btn.disabled = true;
  btn.textContent = 'שומר…';
  try {
    const res = await callFn('parent', { action: 'book', token: state.token, slotId: state.slot.id });
    if (!res?.ok) {
      const code = res?.error || 'error';
      if (['slot_taken', 'slot_unavailable', 'slot_not_found', 'slot_in_past'].includes(code)) {
        const again = await callFn('parent', { action: 'slots', token: state.token, conferenceId: state.conf.id });
        if (again?.ok) state.slots = again.slots;
        state.slot = null;
        renderPicker(errorMessage(code));
        return;
      }
      throw new Error(code);
    }
    if (res.settings) state.settings = res.settings;
    renderDone(res.confirmation);
  } catch (err) {
    handleSessionError(err);
  }
}

/** @param {any} c */
function renderDone(c) {
  const st = state.settings || {};
  // עדכון מקומי – האסיפה מסומנת כמוזמנת
  const conf = state.data.conferences.find((/** @type {any} */ x) => x.id === state.conf.id);
  if (conf) conf.appointment = { starts_at: c.starts_at, ends_at: c.ends_at };
  mount(app, h('section', { class: 'confirm-sheet', 'aria-labelledby': 'done-h' },
    h('div', { class: 'top done', id: 'done-h', tabindex: '-1' }, 'התור נקבע בהצלחה'),
    h('dl', null,
      h('dt', null, 'אסיפה'), h('dd', null, c.conference_title),
      h('dt', null, 'תלמיד'), h('dd', null, c.student_name),
      h('dt', null, 'כיתה'), h('dd', null, c.class_name),
      h('dt', null, 'הרב'), h('dd', null, c.teacher_name),
      h('dt', null, 'תאריך'), h('dd', { class: 'date-big' }, fullDayLabelFromTs(c.starts_at)),
      h('dt', null, 'שעה'), h('dd', null, timeRangeLabel(c.starts_at, c.ends_at)),
      st.address ? [h('dt', null, 'כתובת'), h('dd', null, st.address)] : null,
      st.contact_info ? [h('dt', null, 'יצירת קשר'), h('dd', null, st.contact_info)] : null),
    h('div', { class: 'actions no-print' },
      st.waze_url ? h('a', { class: 'btn waze', href: st.waze_url, target: '_blank', rel: 'noopener noreferrer' }, 'ניווט ב-Waze') : null,
      h('button', { class: 'btn secondary', type: 'button', onclick: () => window.print() }, 'הדפסה'),
      h('button', { class: 'btn secondary', type: 'button', onclick: renderStudent }, 'חזרה לאסיפות'))));
  document.getElementById('done-h')?.focus();
}

init();
