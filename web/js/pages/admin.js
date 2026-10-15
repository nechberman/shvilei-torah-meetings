// דף מנהל: סקירה, אסיפות, זמינות ותורים, תלמידים, יבוא, כיתות, צוות, קודים אישיים, הגדרות, יומן
import { callFn, isConfigured, rpc, select, supabase } from '../lib/api.js';
import { requireStaff, staffNav } from '../lib/auth.js';
import { parseCsv } from '../lib/csv.js';
import { fullDayLabel, fullDayLabelFromTs, timeLabel } from '../lib/dates.js';
import { errorMessage } from '../lib/errors.js';
import { exportXlsx, readXlsx } from '../lib/excel.js';
import { normalizeIsraeliId } from '../lib/israeli-id.js';
import {
  alertBox, confStatusTag, confirmDialog, empty, field, formDialog, h, loading, mount, siteHeader, toast, val,
} from '../lib/ui.js';
import { renderWorkspace } from '../lib/workspace.js';

const app = /** @type {HTMLElement} */ (document.getElementById('app'));
const head = /** @type {HTMLElement} */ (document.getElementById('head'));
/** @type {{id: string, full_name: string, role: 'admin'|'teacher'}} */
let me;

const TABS = [
  ['dashboard', 'סקירה'], ['conferences', 'אסיפות'], ['board', 'זמינות ותורים'], ['students', 'תלמידים'],
  ['import', 'יבוא תלמידים'], ['classes', 'כיתות'], ['staff', 'רבנים וצוות'], ['codes', 'קודים אישיים'],
  ['settings', 'הגדרות'], ['audit', 'יומן פעולות'],
];

async function init() {
  mount(head, siteHeader(null, 'ניהול המערכת'));
  if (!isConfigured()) { mount(app, alertBox('warn', errorMessage('not_configured'))); return; }
  mount(app, loading());
  me = /** @type {any} */ (await requireStaff('admin'));
  mount(head, siteHeader(null, 'ניהול המערכת', staffNav(me, 'admin')));
  const tabsEl = h('div', { class: 'tabs', role: 'tablist' });
  const panel = h('div', { role: 'tabpanel', id: 'tabpanel' });
  mount(app, tabsEl, panel);

  const show = () => {
    const key = (location.hash.slice(1) || 'dashboard').split('?')[0];
    const valid = TABS.some(([k]) => k === key) ? key : 'dashboard';
    mount(tabsEl, ...TABS.map(([k, label]) => h('button', {
      role: 'tab', type: 'button', 'aria-selected': String(k === valid), 'aria-controls': 'tabpanel',
      onclick: () => { location.hash = k; },
    }, label)));
    const fn = /** @type {Record<string, (el: HTMLElement) => Promise<void>>} */ ({
      dashboard: tabDashboard, conferences: tabConferences, board: tabBoard, students: tabStudents, import: tabImport,
      classes: tabClasses, staff: tabStaff, codes: tabCodes, settings: tabSettings, audit: tabAudit,
    })[valid];
    mount(panel, loading());
    fn(panel).catch((err) => mount(panel, alertBox('err', errorMessage(err))));
  };
  window.addEventListener('hashchange', show);
  show();
}

// ---------- עזרים ----------
const loadConfs = () => select('conferences', 'id, title, description, starts_on, ends_on, status, created_at', (q) => q.order('starts_on', { ascending: false }));
const loadTeachers = () => rpc('staff_list_teachers');
const loadClasses = () => select('classes', 'id, name, active', (q) => q.order('name'));

/** @param {any[]} confs @param {string|null} selected @param {(id: string) => void} onChange */
function confPicker(confs, selected, onChange) {
  const sel = /** @type {HTMLSelectElement} */ (h('select', { id: 'pick-conf', onchange: () => onChange(sel.value) },
    ...confs.map((c) => h('option', { value: c.id, selected: c.id === selected }, `${c.title} (${statusText(c.status)})`))));
  return h('div', { class: 'field' }, h('label', { for: 'pick-conf' }, 'אסיפה'), sel);
}
/** @param {string} s */
const statusText = (s) => ({ draft: 'טיוטה', open: 'פתוחה', closed: 'סגורה', archived: 'ארכיון' })[/** @type {'draft'} */ (s)] || s;
/** @param {any[]} confs */
const defaultConf = (confs) => (confs.find((c) => c.status === 'open') || confs[0])?.id || null;

/** @param {string} name */
function getParam(name) {
  const q = location.hash.split('?')[1] || '';
  return new URLSearchParams(q).get(name);
}

async function accessToken() {
  const { data } = await supabase().auth.getSession();
  return data.session?.access_token || '';
}

// =====================================================================
// סקירה
// =====================================================================
/** @param {HTMLElement} el */
async function tabDashboard(el) {
  const confs = await loadConfs();
  if (!confs.length) {
    mount(el, h('section', { class: 'panel' }, empty('עדיין אין אסיפות', 'צרו אסיפה ראשונה בלשונית "אסיפות".'),
      h('div', { style: 'text-align:center' }, h('a', { class: 'btn', href: '#conferences' }, 'מעבר לאסיפות'))));
    return;
  }
  let confId = getParam('c') || defaultConf(confs);
  const body = h('div');
  const render = async () => {
    mount(body, loading());
    const conf = confs.find((c) => c.id === confId);
    const [d, status] = await Promise.all([
      rpc('admin_dashboard', { p_conference_id: confId }),
      rpc('staff_students_status', { p_conference_id: confId, p_teacher_id: null }),
    ]);
    const pct = d.total ? Math.round((d.booked / d.total) * 100) : 0;
    /** @param {any[]} rows @param {string} title */
    const breakdown = (rows, title) => h('section', { class: 'panel' }, h('h3', null, title),
      rows.length === 0 ? empty('אין נתונים') : h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
        h('thead', null, h('tr', null, h('th', null, 'שם'), h('th', { class: 'num' }, 'תלמידים'), h('th', { class: 'num' }, 'נרשמו'), h('th', { class: 'num' }, 'טרם'), h('th', null, 'שיעור הרשמה'))),
        h('tbody', null, ...rows.map((r) => {
          const p = r.total ? Math.round((r.booked / r.total) * 100) : 0;
          return h('tr', null, h('td', null, r.name), h('td', { class: 'num' }, String(r.total)), h('td', { class: 'num' }, String(r.booked)),
            h('td', { class: 'num' }, String(r.total - r.booked)),
            h('td', null, h('div', { class: 'row', style: 'align-items:center;gap:8px' }, h('div', { class: 'bar', style: 'flex:1' }, h('span', { style: `width:${p}%` })), `${p}%`)));
        })))));
    const missing = status.filter((/** @type {any} */ s) => !s.appointment_id);
    mount(body,
      h('div', { class: 'stats' },
        h('div', null, h('div', { class: 'v' }, String(d.total)), h('div', { class: 'k' }, 'תלמידים באסיפה')),
        h('div', null, h('div', { class: 'v' }, String(d.booked)), h('div', { class: 'k' }, 'נרשמו')),
        h('div', null, h('div', { class: 'v' }, String(d.total - d.booked)), h('div', { class: 'k' }, 'טרם נרשמו')),
        h('div', null, h('div', { class: 'v' }, `${pct}%`), h('div', { class: 'k' }, 'שיעור הרשמה')),
        h('div', null, h('div', { class: 'v' }, String(d.free_slots)), h('div', { class: 'k' }, 'שעות פנויות'))),
      h('div', { class: 'toolbar' },
        h('a', { class: 'btn secondary', href: `./print.html?c=${confId}`, target: '_blank', rel: 'noopener' }, 'דוח כל הרבנים להדפסה'),
        h('a', { class: 'btn secondary', href: `./print.html?c=${confId}&missing=1`, target: '_blank', rel: 'noopener' }, 'דוח לא נרשמו להדפסה'),
        h('button', { class: 'btn secondary', type: 'button', onclick: () => exportXlsx(`לא-נרשמו-${conf.title}.xlsx`, 'לא נרשמו',
          ['תלמיד', 'כיתה', 'רב'], missing.map((/** @type {any} */ s) => [s.full_name, s.class_name, s.teacher_name]), `${conf.title} – תלמידים שטרם נרשמו`) }, 'יצוא לא נרשמו'),
        h('button', { class: 'btn secondary', type: 'button', onclick: () => exportXlsx(`הרשמה-${conf.title}.xlsx`, 'הרשמה',
          ['תלמיד', 'כיתה', 'רב', 'מצב', 'יום ותאריך', 'שעה'], status.map((/** @type {any} */ s) => [s.full_name, s.class_name, s.teacher_name,
            s.appointment_id ? 'נרשם' : 'טרם נרשם', s.starts_at ? fullDayLabelFromTs(s.starts_at) : '', s.starts_at ? timeLabel(s.starts_at) : '']),
          `${conf.title} – מצב הרשמה`) }, 'יצוא מצב הרשמה')),
      h('div', { class: 'row' }, h('div', { style: 'flex:1 1 420px' }, breakdown(d.by_teacher, 'לפי רב')),
        h('div', { style: 'flex:1 1 420px' }, breakdown(d.by_class, 'לפי כיתה'))));
  };
  mount(el, h('div', { class: 'toolbar' }, confPicker(confs, confId, (id) => { confId = id; render(); })), body);
  await render();
}

// =====================================================================
// אסיפות
// =====================================================================
/** @param {HTMLElement} el */
async function tabConferences(el) {
  const [confs, teachers, links] = await Promise.all([
    loadConfs(), loadTeachers(), select('conference_teachers', 'conference_id, teacher_id, slot_duration_minutes'),
  ]);
  const reload = () => tabConferences(el);
  const activeTeachers = teachers.filter((/** @type {any} */ t) => t.active);

  /** @param {any|null} c */
  const editDialog = (c) => formDialog(c ? 'עריכת אסיפה' : 'אסיפה חדשה', h('div', null,
    field('שם האסיפה', h('input', { name: 'title', type: 'text', required: true, maxlength: '120', value: c?.title || '' })),
    field('תיאור (מוצג להורים)', h('textarea', { name: 'desc', maxlength: '1000' }, c?.description || '')),
    h('div', { class: 'row' },
      field('מתאריך', h('input', { name: 'from', type: 'date', required: true, value: c?.starts_on || '' })),
      field('עד תאריך', h('input', { name: 'to', type: 'date', required: true, value: c?.ends_on || '' })))), async (form) => {
    if (!val(form, 'title') || !val(form, 'from') || !val(form, 'to')) throw new Error('invalid_range');
    await rpc('admin_upsert_conference', {
      p_id: c?.id || null, p_title: val(form, 'title'),
      p_description: /** @type {HTMLTextAreaElement} */ (form.elements.namedItem('desc')).value,
      p_starts_on: val(form, 'from'), p_ends_on: val(form, 'to'),
    });
    toast('האסיפה נשמרה');
    reload();
  });

  /** @param {any} c @param {string} status @param {string} text */
  const statusBtn = (c, status, text) => h('button', { class: 'btn small secondary', type: 'button', onclick: async () => {
    const msgs = /** @type {Record<string,string>} */ ({
      open: 'ההורים יוכלו לקבוע תורים באסיפה זו.', closed: 'ההורים לא יוכלו לקבוע תורים חדשים.', archived: 'האסיפה תישמר לצפייה בלבד ולא ניתן יהיה לשנות בה תורים.', draft: 'האסיפה תוסתר מההורים.',
    });
    if (!(await confirmDialog(text, msgs[status]))) return;
    try {
      await rpc('admin_set_conference_status', { p_id: c.id, p_status: status });
      toast('הסטטוס עודכן');
      reload();
    } catch (err) { toast(errorMessage(err), 'err'); }
  } }, text);

  /** @param {any} c */
  const teacherDialog = (c) => formDialog(`שיוך רב לאסיפה: ${c.title}`, h('div', null,
    field('רב', h('select', { name: 't', required: true }, ...activeTeachers.map((/** @type {any} */ t) => h('option', { value: t.id }, t.full_name)))),
    field('משך פגישה (דקות)', h('input', { name: 'min', type: 'number', min: '5', max: '120', value: '10', required: true }))), async (form) => {
    await rpc('admin_set_conference_teacher', { p_conference_id: c.id, p_teacher_id: val(form, 't'), p_minutes: Number(val(form, 'min')) });
    toast('הרב שויך');
    reload();
  }, 'שיוך');

  /** @param {any} c */
  const addAllTeachers = async (c) => {
    const existing = new Set(links.filter((/** @type {any} */ l) => l.conference_id === c.id).map((/** @type {any} */ l) => l.teacher_id));
    const todo = activeTeachers.filter((/** @type {any} */ t) => !existing.has(t.id));
    if (!todo.length) { toast('כל הרבנים כבר משויכים'); return; }
    if (!(await confirmDialog('שיוך כל הרבנים', `${todo.length} רבנים ישויכו עם משך פגישה של 10 דקות (ניתן לשנות לכל רב).`))) return;
    try {
      for (const t of todo) await rpc('admin_set_conference_teacher', { p_conference_id: c.id, p_teacher_id: t.id, p_minutes: 10 });
      toast('הרבנים שויכו');
      reload();
    } catch (err) { toast(errorMessage(err), 'err'); }
  };

  const tName = (/** @type {string} */ id) => teachers.find((/** @type {any} */ t) => t.id === id)?.full_name || '';
  mount(el,
    h('div', { class: 'section-title' }, h('h2', null, 'אסיפות'),
      h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', onclick: () => editDialog(null) }, 'אסיפה חדשה'))),
    confs.length === 0 ? h('section', { class: 'panel' }, empty('עדיין אין אסיפות', 'צרו אסיפה, שייכו רבנים, ופתחו אותה להרשמה.')) :
      confs.map((c) => {
        const ct = links.filter((/** @type {any} */ l) => l.conference_id === c.id);
        return h('section', { class: 'panel' },
          h('div', { class: 'section-title' }, h('h3', { style: 'margin:0' }, c.title), confStatusTag(c.status),
            h('div', { class: 'actions' },
              c.status !== 'archived' ? h('button', { class: 'btn small secondary', type: 'button', onclick: () => editDialog(c) }, 'עריכה') : null,
              c.status === 'draft' ? statusBtn(c, 'open', 'פתיחה להרשמה') : null,
              c.status === 'open' ? statusBtn(c, 'closed', 'סגירת ההרשמה') : null,
              c.status === 'open' ? statusBtn(c, 'draft', 'החזרה לטיוטה') : null,
              c.status === 'closed' ? statusBtn(c, 'open', 'פתיחה מחדש') : null,
              c.status === 'closed' || c.status === 'draft' ? statusBtn(c, 'archived', 'העברה לארכיון') : null,
              c.status === 'archived' ? statusBtn(c, 'closed', 'שחזור מהארכיון') : null)),
          h('p', { class: 'muted' }, `${fullDayLabel(c.starts_on)} עד ${fullDayLabel(c.ends_on)}`),
          c.description ? h('p', null, c.description) : null,
          h('h3', null, 'רבנים משויכים'),
          ct.length === 0 ? h('p', { class: 'muted' }, 'עדיין לא שויכו רבנים.') :
            h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
              h('thead', null, h('tr', null, h('th', null, 'רב'), h('th', { class: 'num' }, 'משך פגישה'), h('th', null, ''))),
              h('tbody', null, ...ct.map((/** @type {any} */ l) => h('tr', null, h('td', null, tName(l.teacher_id)),
                h('td', { class: 'num' }, `${l.slot_duration_minutes} דק׳`),
                h('td', null, h('div', { class: 'row', style: 'gap:6px' },
                  h('a', { class: 'btn small secondary', href: `#board?c=${c.id}&t=${l.teacher_id}` }, 'שעות ותורים'),
                  c.status !== 'archived' ? h('button', { class: 'btn small danger', type: 'button', onclick: async () => {
                    if (!(await confirmDialog('הסרת רב מהאסיפה', 'אפשרי רק אם אין לרב תורים באסיפה זו.', { danger: true, okText: 'הסרה' }))) return;
                    try { await rpc('admin_remove_conference_teacher', { p_conference_id: c.id, p_teacher_id: l.teacher_id }); toast('הרב הוסר'); reload(); } catch (err) { toast(errorMessage(err), 'err'); }
                  } }, 'הסרה') : null))))))),
          c.status !== 'archived' ? h('div', { class: 'row', style: 'margin-top:12px;gap:8px' },
            h('button', { class: 'btn small secondary', type: 'button', onclick: () => teacherDialog(c) }, 'שיוך רב'),
            h('button', { class: 'btn small secondary', type: 'button', onclick: () => addAllTeachers(c) }, 'שיוך כל הרבנים')) : null);
      }));
}

// =====================================================================
// זמינות ותורים (לכל רב)
// =====================================================================
/** @param {HTMLElement} el */
async function tabBoard(el) {
  const [confs, teachers, links] = await Promise.all([loadConfs(), loadTeachers(), select('conference_teachers', 'conference_id, teacher_id')]);
  if (!confs.length) { mount(el, h('section', { class: 'panel' }, empty('עדיין אין אסיפות'))); return; }
  let confId = getParam('c') || defaultConf(confs);
  let teacherId = getParam('t');
  const ws = h('div');
  const tHost = h('div');
  const renderT = () => {
    const ids = links.filter((/** @type {any} */ l) => l.conference_id === confId).map((/** @type {any} */ l) => l.teacher_id);
    const list = teachers.filter((/** @type {any} */ t) => ids.includes(t.id));
    if (!list.length) {
      mount(tHost);
      mount(ws, h('section', { class: 'panel' }, empty('לא שויכו רבנים לאסיפה', 'שייכו רבנים בלשונית "אסיפות".')));
      return;
    }
    if (!teacherId || !ids.includes(teacherId)) teacherId = list[0].id;
    const sel = /** @type {HTMLSelectElement} */ (h('select', { id: 'pick-t', onchange: () => { teacherId = sel.value; renderW(); } },
      ...list.map((/** @type {any} */ t) => h('option', { value: t.id, selected: t.id === teacherId }, t.full_name))));
    mount(tHost, h('div', { class: 'field' }, h('label', { for: 'pick-t' }, 'רב'), sel));
    renderW();
  };
  const renderW = () => {
    const conf = confs.find((c) => c.id === confId);
    const t = teachers.find((/** @type {any} */ x) => x.id === teacherId);
    renderWorkspace(ws, { conference: conf, teacherId: /** @type {string} */ (teacherId), teacherName: t?.full_name || '', me });
  };
  mount(el, h('div', { class: 'toolbar' }, confPicker(confs, confId, (id) => { confId = id; renderT(); }), tHost), ws);
  renderT();
}

// =====================================================================
// תלמידים
// =====================================================================
/** @param {HTMLElement} el */
async function tabStudents(el) {
  const [students, classes, teachers] = await Promise.all([rpc('admin_list_students'), loadClasses(), loadTeachers()]);
  const reload = () => tabStudents(el);
  const search = /** @type {HTMLInputElement} */ (h('input', { id: 's-q', type: 'search', placeholder: 'שם או מספר זהות' }));
  const fClass = /** @type {HTMLSelectElement} */ (h('select', { id: 's-c' }, h('option', { value: '' }, 'כל הכיתות'), ...classes.map((/** @type {any} */ c) => h('option', { value: c.id }, c.name))));
  const fTeacher = /** @type {HTMLSelectElement} */ (h('select', { id: 's-t' }, h('option', { value: '' }, 'כל הרבנים'), ...teachers.map((/** @type {any} */ t) => h('option', { value: t.id }, t.full_name))));
  const fActive = /** @type {HTMLSelectElement} */ (h('select', { id: 's-a' }, h('option', { value: 'active' }, 'פעילים'), h('option', { value: 'all' }, 'כולם'), h('option', { value: 'inactive' }, 'לא פעילים')));
  const tableHost = h('div');

  /** @param {any|null} s */
  const editDialog = (s) => {
    if (!classes.length || !teachers.length) { toast('יש ליצור כיתה ורב לפני הוספת תלמידים', 'err'); return; }
    formDialog(s ? 'עריכת תלמיד' : 'תלמיד חדש', h('div', null,
      field('שם מלא', h('input', { name: 'name', type: 'text', required: true, maxlength: '100', value: s?.full_name || '' })),
      field('מספר זהות', h('input', { name: 'nid', type: 'text', inputmode: 'numeric', required: true, maxlength: '11', value: s?.national_id || '' })),
      h('div', { class: 'row' },
        field('כיתה', h('select', { name: 'class' }, ...classes.map((/** @type {any} */ c) => h('option', { value: c.id, selected: c.id === s?.class_id }, c.name)))),
        field('רב משויך', h('select', { name: 'teacher' }, ...teachers.filter((/** @type {any} */ t) => t.active || t.id === s?.teacher_id)
          .map((/** @type {any} */ t) => h('option', { value: t.id, selected: t.id === s?.teacher_id }, t.full_name))))),
      h('label', { class: 'check' }, h('input', { name: 'active', type: 'checkbox', checked: s ? s.active : true }), 'תלמיד פעיל'),
      s ? h('p', { class: 'muted small' }, 'שינוי רב לתלמיד עם תור פעיל ייחסם – יש לבטל או להעביר את התור קודם.') : null), async (form) => {
      const nid = normalizeIsraeliId(val(form, 'nid'));
      if (!nid) throw new Error('invalid_national_id');
      await rpc('admin_upsert_student', {
        p_id: s?.id || null, p_national_id: nid, p_full_name: val(form, 'name'), p_class_id: val(form, 'class'),
        p_teacher_id: val(form, 'teacher'), p_active: /** @type {HTMLInputElement} */ (form.elements.namedItem('active')).checked,
      });
      toast('התלמיד נשמר');
      reload();
    });
  };

  /** @param {any} s */
  const codeDialog = (s) => {
    const out = h('div');
    formDialog(`קוד אישי – ${s.full_name}`, h('div', null,
      h('p', { class: 'muted small' }, s.has_code ? 'לתלמיד יש קוד. הקוד שמור מוצפן ולא ניתן להציגו – אפשר רק להגדיר קוד חדש.' : 'לתלמיד אין קוד.'),
      field('קוד ידני (4 ספרות)', h('input', { name: 'code', type: 'text', inputmode: 'numeric', maxlength: '4', pattern: '[0-9]{4}' }),
        'השאירו ריק ולחצו "יצירת קוד אקראי" כדי שהמערכת תיצור קוד.'),
      h('button', { class: 'btn secondary', type: 'button', onclick: async () => {
        try {
          const code = await rpc('admin_generate_student_code', { p_student_id: s.id });
          mount(out, alertBox('ok', 'הקוד החדש: ', h('strong', { style: 'font-size:1.4rem;letter-spacing:.15em', dir: 'ltr' }, code),
            h('div', { class: 'small' }, 'רשמו אותו עכשיו – הוא לא יוצג שוב.')));
          s.has_code = true;
        } catch (err) { mount(out, alertBox('err', errorMessage(err))); }
      } }, 'יצירת קוד אקראי'),
      s.has_code ? h('button', { class: 'btn danger', type: 'button', style: 'margin-inline-start:8px', onclick: async () => {
        try { await rpc('admin_clear_student_code', { p_student_id: s.id }); mount(out, alertBox('ok', 'הקוד נמחק.')); s.has_code = false; } catch (err) { mount(out, alertBox('err', errorMessage(err))); }
      } }, 'מחיקת הקוד') : null,
      h('div', { style: 'margin-top:12px' }, out)), async (form) => {
      const code = val(form, 'code');
      if (!code) { reload(); return true; }
      if (!/^[0-9]{4}$/.test(code)) throw new Error('invalid_code');
      await rpc('admin_set_student_code', { p_student_id: s.id, p_code: code });
      toast('הקוד נשמר');
      reload();
    }, 'שמירה וסגירה');
  };

  const filtered = () => {
    const q = search.value.trim();
    return students.filter((/** @type {any} */ s) =>
      (!q || s.full_name.includes(q) || s.national_id.includes(q.replace(/\D/g, '') || '§')) &&
      (!fClass.value || s.class_id === fClass.value) && (!fTeacher.value || s.teacher_id === fTeacher.value) &&
      (fActive.value === 'all' || (fActive.value === 'active' ? s.active : !s.active)));
  };
  const renderTable = () => {
    const rows = filtered();
    mount(tableHost, rows.length === 0 ? h('section', { class: 'panel' }, empty('אין תלמידים להצגה', students.length ? 'שנו את הסינון.' : 'הוסיפו תלמיד או ייבאו קובץ Excel.')) :
      h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
        h('thead', null, h('tr', null, h('th', null, 'שם'), h('th', { class: 'num' }, 'מספר זהות'), h('th', null, 'כיתה'), h('th', null, 'רב'), h('th', null, 'קוד'), h('th', null, 'מצב'), h('th', null, ''))),
        h('tbody', null, ...rows.map((/** @type {any} */ s) => h('tr', null,
          h('td', null, s.full_name), h('td', { class: 'num' }, s.national_id), h('td', null, s.class_name), h('td', null, s.teacher_name),
          h('td', null, s.has_code ? 'יש' : '—'), h('td', null, s.active ? 'פעיל' : h('span', { class: 'tag blocked' }, 'לא פעיל')),
          h('td', null, h('div', { class: 'row', style: 'gap:6px' },
            h('button', { class: 'btn small secondary', type: 'button', onclick: () => editDialog(s) }, 'עריכה'),
            h('button', { class: 'btn small secondary', type: 'button', onclick: () => codeDialog(s) }, 'קוד')))))))),
    h('p', { class: 'muted small' }, `מוצגים ${rows.length} מתוך ${students.length}`));
  };
  for (const c of [search, fClass, fTeacher, fActive]) c.addEventListener('input', renderTable);

  mount(el,
    h('div', { class: 'section-title' }, h('h2', null, 'תלמידים'),
      h('div', { class: 'actions' },
        h('button', { class: 'btn', type: 'button', onclick: () => editDialog(null) }, 'תלמיד חדש'),
        h('a', { class: 'btn secondary', href: '#import' }, 'יבוא מקובץ'),
        h('button', { class: 'btn secondary', type: 'button', onclick: () => exportXlsx('תלמידים.xlsx', 'תלמידים', ['שם', 'מספר זהות', 'כיתה', 'רב', 'פעיל'],
          filtered().map((/** @type {any} */ s) => [s.full_name, s.national_id, s.class_name, s.teacher_name, s.active ? 'כן' : 'לא'])) }, 'יצוא ל-Excel'))),
    h('div', { class: 'toolbar' },
      h('div', { class: 'field' }, h('label', { for: 's-q' }, 'חיפוש'), search),
      h('div', { class: 'field' }, h('label', { for: 's-c' }, 'כיתה'), fClass),
      h('div', { class: 'field' }, h('label', { for: 's-t' }, 'רב'), fTeacher),
      h('div', { class: 'field' }, h('label', { for: 's-a' }, 'מצב'), fActive)),
    tableHost);
  renderTable();
}

// =====================================================================
// יבוא
// =====================================================================
/** @param {HTMLElement} el */
async function tabImport(el) {
  const FIELDS = [
    ['national_id', 'מספר זהות', ['ת"ז', 'תז', 'תעודת זהות', 'מספר זהות', 'id']],
    ['full_name', 'שם מלא', ['שם', 'שם מלא', 'שם התלמיד', 'name']],
    ['class_name', 'כיתה', ['כיתה', 'שיעור', 'class']],
    ['teacher_name', 'שם הרב', ['רב', 'שם הרב', 'מחנך', 'teacher']],
  ];
  const step = h('div');
  /** @type {string[][]} */
  let table = [];

  const fileInput = /** @type {HTMLInputElement} */ (h('input', { id: 'imp-file', type: 'file', accept: '.xlsx,.csv,text/csv' }));
  fileInput.addEventListener('change', async () => {
    const f = fileInput.files?.[0];
    if (!f) return;
    mount(step, loading('קורא את הקובץ…'));
    try {
      table = /\.csv$/i.test(f.name) ? parseCsv(await f.text()) : await readXlsx(f);
      if (table.length < 2) throw new Error('empty');
      renderMapping();
    } catch {
      mount(step, alertBox('err', 'לא ניתן לקרוא את הקובץ. ודאו שזה קובץ Excel (xlsx) או CSV עם שורת כותרות.'));
    }
  });

  function renderMapping() {
    const headers = table[0];
    const selects = FIELDS.map(([key, label, guesses]) => {
      const guess = headers.findIndex((hd) => /** @type {string[]} */ (guesses).some((g) => hd.replace(/\s/g, '').toLowerCase() === g.replace(/\s/g, '').toLowerCase()));
      return /** @type {HTMLSelectElement} */ (h('select', { name: String(key), 'aria-label': String(label) },
        h('option', { value: '-1' }, '— בחרו עמודה —'),
        ...headers.map((hd, i) => h('option', { value: String(i), selected: i === guess }, hd || `עמודה ${i + 1}`))));
    });
    const updateExisting = /** @type {HTMLInputElement} */ (h('input', { type: 'checkbox', checked: true }));
    const createClasses = /** @type {HTMLInputElement} */ (h('input', { type: 'checkbox', checked: true }));
    const preview = h('div');

    const buildRows = () => {
      const idx = selects.map((s) => Number(s.value));
      return table.slice(1).map((r, i) => ({
        row: i + 2,
        national_id: idx[0] >= 0 ? r[idx[0]] || '' : '',
        full_name: idx[1] >= 0 ? r[idx[1]] || '' : '',
        class_name: idx[2] >= 0 ? r[idx[2]] || '' : '',
        teacher_name: idx[3] >= 0 ? r[idx[3]] || '' : '',
      }));
    };

    const runPreview = async () => {
      if (selects.some((s) => s.value === '-1')) { mount(preview, alertBox('err', 'יש למפות את כל ארבע העמודות.')); return; }
      mount(preview, loading('בודק את הנתונים מול המערכת…'));
      const rows = buildRows();
      try {
        const rep = await rpc('admin_import_students', { p_rows: rows, p_update_existing: updateExisting.checked, p_create_classes: createClasses.checked, p_dry_run: true });
        const errRows = new Map(rep.errors.map((/** @type {any} */ e) => [e.row, e.error]));
        mount(preview,
          h('div', { class: 'stats' },
            h('div', null, h('div', { class: 'v' }, String(rep.inserted)), h('div', { class: 'k' }, 'חדשים')),
            h('div', null, h('div', { class: 'v' }, String(rep.updated)), h('div', { class: 'k' }, 'יעודכנו')),
            h('div', null, h('div', { class: 'v' }, String(rep.skipped)), h('div', { class: 'k' }, 'קיימים – ידולגו')),
            h('div', null, h('div', { class: 'v' }, String(rep.errors.length)), h('div', { class: 'k' }, 'שגיאות'))),
          rep.errors.length ? alertBox('warn', 'שורות עם שגיאות לא ייובאו. אפשר לתקן את הקובץ ולהעלות שוב.') : null,
          h('div', { class: 'table-wrap', style: 'max-height:420px;overflow:auto' }, h('table', { class: 'data' },
            h('thead', null, h('tr', null, h('th', { class: 'num' }, 'שורה'), h('th', { class: 'num' }, 'מספר זהות'), h('th', null, 'שם'), h('th', null, 'כיתה'), h('th', null, 'רב'), h('th', null, 'בדיקה'))),
            h('tbody', null, ...rows.slice(0, 500).map((r) => h('tr', null,
              h('td', { class: 'num' }, String(r.row)), h('td', { class: 'num' }, normalizeIsraeliId(r.national_id) || r.national_id), h('td', null, r.full_name),
              h('td', null, r.class_name), h('td', null, r.teacher_name),
              h('td', null, errRows.has(r.row) ? h('span', { class: 'tag pending' }, errorText(errRows.get(r.row))) : h('span', { class: 'tag booked' }, 'תקין'))))))),
          rows.length > 500 ? h('p', { class: 'muted small' }, `מוצגות 500 שורות ראשונות מתוך ${rows.length}.`) : null,
          h('div', { class: 'row', style: 'margin-top:14px;gap:8px' },
            h('button', { class: 'btn', type: 'button', disabled: rep.inserted + rep.updated === 0, onclick: async () => {
              if (!(await confirmDialog('אישור יבוא', `ייווספו ${rep.inserted} תלמידים ויעודכנו ${rep.updated}.`, { okText: 'ייבוא' }))) return;
              try {
                const fin = await rpc('admin_import_students', { p_rows: rows, p_update_existing: updateExisting.checked, p_create_classes: createClasses.checked, p_dry_run: false });
                mount(step, alertBox('ok', `היבוא הושלם: ${fin.inserted} נוספו, ${fin.updated} עודכנו, ${fin.skipped} דולגו, ${fin.errors.length} שגיאות.`),
                  fin.errors.length ? h('button', { class: 'btn secondary', type: 'button', onclick: () => exportXlsx('שגיאות-יבוא.xlsx', 'שגיאות', ['שורה', 'שגיאה'],
                    fin.errors.map((/** @type {any} */ e) => [e.row, errorText(e.error)])) }, 'הורדת דוח שגיאות') : null,
                  h('a', { class: 'btn secondary', href: '#students', style: 'margin-inline-start:8px' }, 'לרשימת התלמידים'));
              } catch (err) { toast(errorMessage(err), 'err'); }
            } }, 'ייבוא'),
            rep.errors.length ? h('button', { class: 'btn secondary', type: 'button', onclick: () => exportXlsx('שגיאות-יבוא.xlsx', 'שגיאות', ['שורה', 'שגיאה'],
              rep.errors.map((/** @type {any} */ e) => [e.row, errorText(e.error)])) }, 'הורדת דוח שגיאות') : null));
      } catch (err) { mount(preview, alertBox('err', errorMessage(err))); }
    };

    mount(step, h('section', { class: 'panel' },
      h('h3', null, 'מיפוי עמודות'),
      h('p', { class: 'muted' }, `נמצאו ${table.length - 1} שורות נתונים.`),
      h('div', { class: 'row' }, ...FIELDS.map(([, label], i) => h('div', { class: 'field' }, h('label', null, String(label)), selects[i]))),
      h('label', { class: 'check' }, updateExisting, 'לעדכן תלמידים קיימים (לפי מספר זהות)'),
      h('label', { class: 'check' }, createClasses, 'ליצור כיתות שלא קיימות'),
      h('div', { style: 'margin-top:12px' }, h('button', { class: 'btn', type: 'button', onclick: runPreview }, 'תצוגה מקדימה ובדיקה')),
      h('div', { style: 'margin-top:16px' }, preview)));
  }

  mount(el, h('section', { class: 'panel' },
    h('h2', null, 'יבוא תלמידים מ-Excel או CSV'),
    h('p', null, 'הקובץ צריך לכלול שורת כותרות ועמודות: מספר זהות, שם מלא, כיתה, שם הרב (בדיוק כפי שמופיע ברשימת הרבנים).'),
    h('p', { class: 'muted small' }, 'מספרי זהות נקראים כטקסט; אפסים מובילים שנמחקו ב-Excel מושלמים אוטומטית. כפילויות בקובץ ומספרים לא תקינים יסומנו.'),
    field('בחירת קובץ', fileInput),
    h('button', { class: 'btn small secondary', type: 'button', onclick: () => exportXlsx('תבנית-יבוא-תלמידים.xlsx', 'תלמידים', ['מספר זהות', 'שם מלא', 'כיתה', 'שם הרב'], []) }, 'הורדת תבנית ריקה')),
  step);
}

/** @param {string} code */
function errorText(code) {
  return ({
    invalid_national_id: 'מספר זהות לא תקין', duplicate_in_file: 'כפול בקובץ', invalid_name: 'שם חסר או לא תקין',
    class_not_found: 'כיתה לא קיימת', teacher_not_found: 'רב לא נמצא', teacher_ambiguous: 'יותר מרב אחד בשם זה',
    student_has_active_appointments: 'שינוי רב לתלמיד עם תור פעיל',
  })[/** @type {'invalid_name'} */ (code)] || code;
}

// =====================================================================
// כיתות
// =====================================================================
/** @param {HTMLElement} el */
async function tabClasses(el) {
  const classes = await loadClasses();
  /** @param {any|null} c */
  const dialog = (c) => formDialog(c ? 'עריכת כיתה' : 'כיתה חדשה', h('div', null,
    field('שם הכיתה', h('input', { name: 'name', type: 'text', required: true, maxlength: '60', value: c?.name || '' })),
    h('label', { class: 'check' }, h('input', { name: 'active', type: 'checkbox', checked: c ? c.active : true }), 'פעילה')), async (form) => {
    await rpc('admin_upsert_class', { p_id: c?.id || null, p_name: val(form, 'name'), p_active: /** @type {HTMLInputElement} */ (form.elements.namedItem('active')).checked });
    toast('הכיתה נשמרה');
    tabClasses(el);
  });
  mount(el, h('div', { class: 'section-title' }, h('h2', null, 'כיתות'),
    h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', onclick: () => dialog(null) }, 'כיתה חדשה'))),
  classes.length === 0 ? h('section', { class: 'panel' }, empty('אין כיתות', 'הוסיפו כיתה, או סמנו "ליצור כיתות" ביבוא.')) :
    h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
      h('thead', null, h('tr', null, h('th', null, 'כיתה'), h('th', null, 'מצב'), h('th', null, ''))),
      h('tbody', null, ...classes.map((/** @type {any} */ c) => h('tr', null, h('td', null, c.name), h('td', null, c.active ? 'פעילה' : 'לא פעילה'),
        h('td', null, h('button', { class: 'btn small secondary', type: 'button', onclick: () => dialog(c) }, 'עריכה'))))))));
}

// =====================================================================
// צוות
// =====================================================================
/** @param {HTMLElement} el */
async function tabStaff(el) {
  const staff = await rpc('admin_list_staff');
  const reload = () => tabStaff(el);
  const pwHint = 'לפחות 10 תווים, כולל אותיות באנגלית וספרות. מסרו לאיש הצוות ובקשו שישנה אותה בכניסה הראשונה.';

  const createDialog = () => formDialog('הוספת רב / איש צוות', h('div', null,
    field('שם מלא (כפי שיופיע להורים)', h('input', { name: 'name', type: 'text', required: true, maxlength: '100' })),
    field('מספר זהות (משמש לכניסה)', h('input', { name: 'nid', type: 'text', inputmode: 'numeric', required: true, maxlength: '11' })),
    field('תפקיד', h('select', { name: 'role' }, h('option', { value: 'teacher' }, 'רב'), h('option', { value: 'admin' }, 'מנהל'))),
    field('סיסמה ראשונית', h('input', { name: 'pw', type: 'text', required: true, maxlength: '72', autocomplete: 'off' }), pwHint)), async (form) => {
    const nid = normalizeIsraeliId(val(form, 'nid'));
    if (!nid) throw new Error('invalid_national_id');
    const res = await callFn('admin-staff', { action: 'create', nationalId: nid, fullName: val(form, 'name'), role: val(form, 'role'), password: val(form, 'pw') }, await accessToken());
    if (!res?.ok) throw new Error(res?.error || 'error');
    toast('איש הצוות נוסף');
    reload();
  }, 'הוספה');

  /** @param {any} s */
  const editDialog = (s) => formDialog(`עריכה – ${s.full_name}`, h('div', null,
    field('שם מלא', h('input', { name: 'name', type: 'text', required: true, maxlength: '100', value: s.full_name })),
    field('תפקיד', h('select', { name: 'role' }, h('option', { value: 'teacher', selected: s.role === 'teacher' }, 'רב'), h('option', { value: 'admin', selected: s.role === 'admin' }, 'מנהל'))),
    h('label', { class: 'check' }, h('input', { name: 'active', type: 'checkbox', checked: s.active }), 'פעיל (רשאי להתחבר)'),
    h('p', { class: 'muted small' }, 'לא ניתן להשבית רב שיש לו תלמידים פעילים.')), async (form) => {
    await rpc('admin_update_staff', { p_id: s.id, p_full_name: val(form, 'name'), p_role: val(form, 'role'), p_active: /** @type {HTMLInputElement} */ (form.elements.namedItem('active')).checked });
    toast('הפרטים נשמרו');
    reload();
  });

  /** @param {any} s */
  const pwDialog = (s) => formDialog(`הגדרת סיסמה חדשה – ${s.full_name}`, h('div', null,
    field('סיסמה חדשה', h('input', { name: 'pw', type: 'text', required: true, maxlength: '72', autocomplete: 'off' }), pwHint)), async (form) => {
    const res = await callFn('admin-staff', { action: 'reset_password', staffId: s.id, password: val(form, 'pw') }, await accessToken());
    if (!res?.ok) throw new Error(res?.error || 'error');
    toast('הסיסמה עודכנה');
  });

  mount(el, h('div', { class: 'section-title' }, h('h2', null, 'רבנים וצוות'),
    h('div', { class: 'actions' }, h('button', { class: 'btn', type: 'button', onclick: createDialog }, 'הוספת איש צוות'))),
  h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
    h('thead', null, h('tr', null, h('th', null, 'שם'), h('th', { class: 'num' }, 'מספר זהות'), h('th', null, 'תפקיד'), h('th', { class: 'num' }, 'תלמידים'), h('th', null, 'מצב'), h('th', null, ''))),
    h('tbody', null, ...staff.map((/** @type {any} */ s) => h('tr', null,
      h('td', null, s.full_name), h('td', { class: 'num' }, s.national_id), h('td', null, s.role === 'admin' ? 'מנהל' : 'רב'),
      h('td', { class: 'num' }, String(s.student_count)),
      h('td', null, s.active ? (s.has_login ? 'פעיל' : 'ללא סיסמה') : h('span', { class: 'tag blocked' }, 'מושבת')),
      h('td', null, h('div', { class: 'row', style: 'gap:6px' },
        h('button', { class: 'btn small secondary', type: 'button', onclick: () => editDialog(s) }, 'עריכה'),
        h('button', { class: 'btn small secondary', type: 'button', onclick: () => pwDialog(s) }, 'סיסמה חדשה')))))))));
}

// =====================================================================
// קודים אישיים
// =====================================================================
/** @param {HTMLElement} el */
async function tabCodes(el) {
  const [settingsRows, students] = await Promise.all([select('settings', 'require_parent_code'), rpc('admin_list_students')]);
  const required = !!settingsRows[0]?.require_parent_code;
  const active = students.filter((/** @type {any} */ s) => s.active);
  const missing = active.filter((/** @type {any} */ s) => !s.has_code).length;
  const out = h('div');
  const overwrite = /** @type {HTMLInputElement} */ (h('input', { type: 'checkbox' }));

  const toggle = async () => {
    const turnOn = !required;
    if (turnOn && missing > 0) {
      toast(`לא ניתן להפעיל: ל-${missing} תלמידים פעילים אין קוד. צרו קודים קודם.`, 'err');
      return;
    }
    const msg = turnOn ? 'מעכשיו ההורים יתבקשו להזין מספר זהות וגם קוד אישי. ודאו שהקודים נמסרו להורים.'
      : 'ההורים ייכנסו עם מספר זהות בלבד. זו אפשרות פחות מאובטחת.';
    if (!(await confirmDialog(turnOn ? 'הפעלת דרישת קוד אישי' : 'כיבוי דרישת קוד אישי', msg, { danger: !turnOn }))) return;
    try {
      await rpc('admin_set_require_code', { p_require: turnOn });
      toast(turnOn ? 'דרישת קוד אישי הופעלה' : 'דרישת קוד אישי כובתה');
      tabCodes(el);
    } catch (err) { toast(errorMessage(err), 'err'); }
  };

  const bulk = async () => {
    const n = overwrite.checked ? active.length : missing;
    if (n === 0) { toast('לכל התלמידים הפעילים כבר יש קוד'); return; }
    const warn = overwrite.checked ? `ייווצרו קודים חדשים ל-${n} תלמידים, והקודים הקיימים יפסיקו לעבוד.` : `ייווצרו קודים ל-${n} תלמידים שאין להם קוד. קודים קיימים לא ישתנו.`;
    if (!(await confirmDialog('יצירת קודים גורפת', warn, { danger: overwrite.checked, okText: 'יצירה' }))) return;
    try {
      const codes = await rpc('admin_generate_codes_bulk', { p_overwrite: overwrite.checked });
      mount(out, h('section', { class: 'panel' },
        alertBox('warn', 'אלו הקודים שנוצרו. הם מוצגים פעם אחת בלבד – הורידו או הדפיסו אותם עכשיו.'),
        h('div', { class: 'row no-print', style: 'gap:8px;margin-bottom:12px' },
          h('button', { class: 'btn', type: 'button', onclick: () => exportXlsx('קודים-אישיים.xlsx', 'קודים', ['תלמיד', 'כיתה', 'רב', 'קוד'],
            codes.map((/** @type {any} */ c) => [c.full_name, c.class_name, c.teacher_name, c.code])) }, 'הורדה ל-Excel'),
          h('button', { class: 'btn secondary', type: 'button', onclick: () => window.print() }, 'הדפסה')),
        h('div', { class: 'codes-sheet' }, ...codes.map((/** @type {any} */ c) => h('div', null,
          h('strong', null, c.full_name), ` (${c.class_name}) – קוד: `, h('strong', { dir: 'ltr', style: 'letter-spacing:.15em' }, c.code))))));
      toast(`נוצרו ${codes.length} קודים`);
    } catch (err) { toast(errorMessage(err), 'err'); }
  };

  mount(el,
    h('section', { class: 'panel' },
      h('h2', null, 'דרישת קוד אישי מהורים'),
      alertBox('warn',
        h('p', null, h('strong', null, 'חשוב לדעת: '), 'כניסה עם מספר זהות בלבד אינה הזדהות בטוחה – כל מי שיודע את מספר הזהות של תלמיד יכול לקבוע לו תור ולראות את שמו, כיתתו והרב שלו.'),
        h('p', { style: 'margin:0' }, 'קוד בן 4 ספרות מוסיף שכבת הגנה, אך גם הוא חלש יחסית. המערכת מגבילה ניסיונות, חוסמת זמנית אחרי כישלונות ומתעדת ניסיונות חשודים. מומלץ להפעיל את הקוד לפני שימוש עם נתוני אמת.')),
      h('p', null, 'מצב נוכחי: ', h('strong', null, required ? 'פעיל – נדרשים מספר זהות וקוד אישי' : 'כבוי – כניסה עם מספר זהות בלבד')),
      h('p', { class: 'muted' }, `תלמידים פעילים: ${active.length}. ללא קוד: ${missing}.`),
      h('button', { class: `btn ${required ? 'danger' : ''}`, type: 'button', onclick: toggle }, required ? 'כיבוי דרישת הקוד' : 'הפעלת דרישת קוד אישי')),
    h('section', { class: 'panel' },
      h('h2', null, 'יצירת קודים לכל התלמידים'),
      h('p', null, 'המערכת יוצרת קודים אקראיים בצד השרת ושומרת רק גרסה מוצפנת (hash). אחרי היצירה הקודים מוצגים פעם אחת למסירה להורים.'),
      h('label', { class: 'check' }, overwrite, 'להחליף גם קודים קיימים'),
      h('div', { style: 'margin-top:12px' }, h('button', { class: 'btn', type: 'button', onclick: bulk }, 'יצירת קודים')),
      h('p', { class: 'muted small', style: 'margin-top:10px' }, 'לקוד לתלמיד בודד (ידני או אקראי): לשונית "תלמידים", כפתור "קוד".')),
    out);
}

// =====================================================================
// הגדרות
// =====================================================================
/** @param {HTMLElement} el */
async function tabSettings(el) {
  const [s] = await select('settings', 'school_name, address, waze_url, logo_url, contact_info, timezone');
  const err = h('div');
  const form = /** @type {HTMLFormElement} */ (h('form', { class: 'panel', novalidate: true, onsubmit: async (/** @type {Event} */ e) => {
    e.preventDefault();
    const waze = val(form, 'waze');
    if (waze && !/^https:\/\/(www\.|ul\.)?waze\.com\/\S*$/.test(waze)) { mount(err, alertBox('err', 'קישור Waze חייב להתחיל ב-https://waze.com/ (העתיקו "שיתוף" מתוך Waze).')); return; }
    try {
      await rpc('admin_update_settings', { p_school_name: val(form, 'name'), p_address: val(form, 'addr'), p_waze_url: waze, p_logo_url: val(form, 'logo'), p_contact_info: val(form, 'contact') });
      mount(err, alertBox('ok', 'ההגדרות נשמרו.'));
    } catch (ex) { mount(err, alertBox('err', errorMessage(ex))); }
  } },
  h('h2', null, 'הגדרות הישיבה'), err,
  field('שם הישיבה', h('input', { name: 'name', type: 'text', required: true, maxlength: '120', value: s.school_name })),
  field('כתובת (מוצגת להורים באישור)', h('input', { name: 'addr', type: 'text', maxlength: '300', value: s.address || '' })),
  field('קישור Waze', h('input', { name: 'waze', type: 'url', dir: 'ltr', placeholder: 'https://waze.com/ul?...', value: s.waze_url || '' }),
    'בתוך Waze: חפשו את כתובת הישיבה ← שיתוף ← העתקת קישור. המערכת לא מנחשת כתובות.'),
  field('קישור ללוגו (אופציונלי)', h('input', { name: 'logo', type: 'url', dir: 'ltr', placeholder: 'https://… או ./assets/logo.png', value: s.logo_url || '' }),
    'קובץ לוגו אפשר להעלות לתיקייה web/assets ב-GitHub ולכתוב ./assets/שם-הקובץ'),
  field('פרטי קשר (אופציונלי)', h('input', { name: 'contact', type: 'text', maxlength: '300', value: s.contact_info || '' })),
  h('p', { class: 'muted small' }, `אזור זמן: ${s.timezone}. תאריכים מוצגים ביום האזרחי המקומי עם התאריך העברי של אותו יום.`),
  h('button', { class: 'btn', type: 'submit' }, 'שמירת ההגדרות')));
  mount(el, form,
    h('section', { class: 'panel' }, h('h2', null, 'שימור נתונים'),
      h('p', null, 'הערות פנימיות של רבנים נשמרות עד שמוחקים אותן. מומלץ למחוק הערות ישנות מדי שנה.'),
      h('button', { class: 'btn danger', type: 'button', onclick: async () => {
        if (!(await confirmDialog('מחיקת הערות ישנות', 'יימחקו לצמיתות כל ההערות הפנימיות שלא עודכנו ב-365 הימים האחרונים.', { danger: true, okText: 'מחיקה' }))) return;
        try { const n = await rpc('admin_purge_old_notes', { p_older_than_days: 365 }); toast(`נמחקו ${n} הערות`); } catch (ex) { toast(errorMessage(ex), 'err'); }
      } }, 'מחיקת הערות בנות יותר משנה')));
}

// =====================================================================
// יומן פעולות
// =====================================================================
/** @param {HTMLElement} el */
async function tabAudit(el) {
  const [logs, staff] = await Promise.all([
    select('audit_logs', 'id, actor_id, actor_type, action, entity_type, created_at', (q) => q.order('created_at', { ascending: false }).limit(300)),
    rpc('admin_list_staff'),
  ]);
  const names = new Map(staff.map((/** @type {any} */ s) => [s.id, s.full_name]));
  const ACTIONS = /** @type {Record<string,string>} */ ({
    'appointment.book': 'קביעת תור', 'appointment.cancel': 'ביטול תור', 'appointment.move': 'העברת תור',
    'availability.add': 'הוספת זמינות', 'availability.delete': 'מחיקת זמינות', 'block.add': 'הוספת הפסקה', 'block.delete': 'הסרת הפסקה',
    'slot.block': 'חסימת שעה', 'slot.unblock': 'פתיחת שעה', 'note.save': 'שמירת הערה', 'student.create': 'הוספת תלמיד',
    'student.update': 'עדכון תלמיד', 'student.import': 'יבוא תלמידים', 'class.upsert': 'עדכון כיתה', 'staff.create': 'הוספת איש צוות',
    'staff.update': 'עדכון איש צוות', 'staff.reset_password': 'איפוס סיסמה', 'staff.bootstrap_admin': 'הקמת מנהל ראשון',
    'conference.upsert': 'עדכון אסיפה', 'conference.status': 'שינוי סטטוס אסיפה', 'conference_teacher.set': 'שיוך רב לאסיפה',
    'conference_teacher.remove': 'הסרת רב מאסיפה', 'conference_teacher.duration': 'שינוי משך פגישה', 'settings.update': 'עדכון הגדרות',
    'settings.require_code': 'שינוי דרישת קוד', 'code.set_manual': 'הגדרת קוד ידני', 'code.generate': 'יצירת קוד', 'code.generate_bulk': 'יצירת קודים גורפת',
    'code.clear': 'מחיקת קוד', 'notes.purge': 'מחיקת הערות ישנות',
  });
  const actor = (/** @type {any} */ l) => l.actor_type === 'parent' ? 'הורה' : l.actor_type === 'system' ? 'מערכת' : names.get(l.actor_id) || '';
  mount(el, h('h2', null, 'יומן פעולות'), h('p', { class: 'muted' }, '300 הפעולות האחרונות. היומן אינו כולל מספרי זהות או תוכן הערות.'),
    logs.length === 0 ? empty('אין פעולות') : h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
      h('thead', null, h('tr', null, h('th', null, 'מתי'), h('th', null, 'מי'), h('th', null, 'פעולה'))),
      h('tbody', null, ...logs.map((/** @type {any} */ l) => h('tr', null,
        h('td', null, `${fullDayLabelFromTs(l.created_at)} ${timeLabel(l.created_at)}`), h('td', null, actor(l)), h('td', null, ACTIONS[l.action] || l.action)))))));
}

init().catch((e) => { if (e?.message !== 'redirect') mount(app, alertBox('err', errorMessage(e))); });
