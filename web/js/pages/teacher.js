// דף רב: "התורים שלי" (אסיפות, שעות, לוח תורים) ו"התלמידים שלי" (רשימה כולל מספרי זהות, הוספה ועריכה)
import { isConfigured, rpc, select } from '../lib/api.js';
import { requireStaff, staffNav } from '../lib/auth.js';
import { fullDayLabel } from '../lib/dates.js';
import { errorMessage } from '../lib/errors.js';
import { exportXlsx } from '../lib/excel.js';
import { normalizeIsraeliId } from '../lib/israeli-id.js';
import { alertBox, confStatusTag, empty, field, formDialog, h, loading, mount, siteHeader, toast, val } from '../lib/ui.js';
import { renderWorkspace } from '../lib/workspace.js';

const app = /** @type {HTMLElement} */ (document.getElementById('app'));
const head = /** @type {HTMLElement} */ (document.getElementById('head'));
/** @type {{id: string, full_name: string, role: 'admin'|'teacher'}} */
let me;

async function init() {
  mount(head, siteHeader(null, 'אזור הרב'));
  if (!isConfigured()) { mount(app, alertBox('warn', errorMessage('not_configured'))); return; }
  mount(app, loading());
  me = /** @type {any} */ (await requireStaff());
  mount(head, siteHeader(null, 'אזור הרב', staffNav(me, 'teacher')));

  const tabsEl = h('div', { class: 'tabs', role: 'tablist' });
  const panel = h('div', { role: 'tabpanel', id: 'tabpanel' });
  mount(app, tabsEl, panel);
  const TABS = [['meetings', 'התורים שלי'], ['students', 'התלמידים שלי']];
  const show = () => {
    const key = location.hash.slice(1).split('?')[0] === 'students' ? 'students' : 'meetings';
    mount(tabsEl, ...TABS.map(([k, label]) => h('button', {
      role: 'tab', type: 'button', 'aria-selected': String(k === key), 'aria-controls': 'tabpanel',
      onclick: () => { location.hash = k; },
    }, label)));
    mount(panel, loading());
    (key === 'students' ? tabStudents(panel) : tabMeetings(panel))
      .catch((err) => mount(panel, alertBox('err', errorMessage(err))));
  };
  window.addEventListener('hashchange', show);
  show();
}

/** @param {HTMLElement} el */
async function tabMeetings(el) {
  const mine = await select('conference_teachers', 'conference_id', (q) => q.eq('teacher_id', me.id));
  const ids = mine.map((r) => r.conference_id);
  const confs = ids.length
    ? await select('conferences', 'id, title, description, starts_on, ends_on, status', (q) =>
      q.in('id', ids).neq('status', 'archived').order('starts_on', { ascending: false }))
    : [];
  if (!confs.length) {
    mount(el, h('section', { class: 'panel' }, empty('אין אסיפות פעילות', 'כשההנהלה תשייך אותך לאסיפה, היא תופיע כאן.')));
    return;
  }
  const params = new URLSearchParams(location.search);
  let current = confs.find((c) => c.id === params.get('c')) || confs.find((c) => c.status === 'open') || confs[0];
  const wsHost = h('div');
  const meta = h('div');
  const picker = /** @type {HTMLSelectElement} */ (h('select', { id: 'conf', onchange: () => {
    current = confs.find((c) => c.id === picker.value);
    history.replaceState(null, '', `?c=${current.id}${location.hash}`);
    showConf();
  } }, ...confs.map((c) => h('option', { value: c.id, selected: c.id === current.id }, c.title))));

  function showConf() {
    mount(meta, h('p', null, confStatusTag(current.status), ' ', `${fullDayLabel(current.starts_on)} עד ${fullDayLabel(current.ends_on)}`));
    renderWorkspace(wsHost, { conference: current, teacherId: me.id, teacherName: me.full_name, me });
  }
  mount(el, h('div', { class: 'toolbar' }, h('div', { class: 'field' }, h('label', { for: 'conf' }, 'אסיפה'), picker)), meta, wsHost);
  showConf();
}

/** @param {HTMLElement} el */
async function tabStudents(el) {
  const [students, classes] = await Promise.all([rpc('staff_list_my_students'), rpc('staff_my_classes')]);
  const reload = () => tabStudents(el);
  const search = /** @type {HTMLInputElement} */ (h('input', { id: 'q', type: 'search', placeholder: 'שם או מספר זהות' }));
  const host = h('div');

  /** @param {any|null} s */
  const dialog = (s) => {
    if (!classes.length) { toast(errorMessage('class_not_allowed'), 'err'); return; }
    formDialog(s ? `עריכת תלמיד – ${s.full_name}` : 'הוספת תלמיד', h('div', null,
      field('שם מלא', h('input', { name: 'name', type: 'text', required: true, maxlength: '100', value: s?.full_name || '' })),
      field('מספר זהות', h('input', { name: 'nid', type: 'text', inputmode: 'numeric', required: true, maxlength: '11', value: s?.national_id || '' })),
      field('כיתה', h('select', { name: 'class' }, ...classes.map((/** @type {any} */ c) => h('option', { value: c.id, selected: c.id === s?.class_id }, c.name)))),
      h('label', { class: 'check' }, h('input', { name: 'active', type: 'checkbox', checked: s ? s.active : true }), 'תלמיד פעיל'),
      h('p', { class: 'muted small' }, 'תלמיד לא פעיל לא מופיע להורים ולא נספר בדוחות. כדי להעביר תלמיד לרב אחר – פנו להנהלה.')), async (form) => {
      const nid = normalizeIsraeliId(val(form, 'nid'));
      if (!nid) throw new Error('invalid_national_id');
      await rpc('staff_upsert_my_student', {
        p_id: s?.id || null, p_national_id: nid, p_full_name: val(form, 'name'), p_class_id: val(form, 'class'),
        p_active: /** @type {HTMLInputElement} */ (form.elements.namedItem('active')).checked,
      });
      toast(s ? 'התלמיד עודכן' : 'התלמיד נוסף');
      reload();
    });
  };

  const render = () => {
    const q = search.value.trim();
    const digits = q.replace(/\D/g, '');
    const rows = students.filter((/** @type {any} */ s) => !q || s.full_name.includes(q) || (digits && s.national_id.includes(digits)));
    mount(host, rows.length === 0
      ? h('section', { class: 'panel' }, empty(students.length ? 'אין תלמידים מתאימים לחיפוש' : 'אין עדיין תלמידים משויכים אליך', 'אפשר להוסיף תלמיד בכפתור "הוספת תלמיד".'))
      : h('div', { class: 'table-wrap' }, h('table', { class: 'data' },
        h('thead', null, h('tr', null, h('th', null, 'שם'), h('th', { class: 'num' }, 'מספר זהות'), h('th', null, 'כיתה'), h('th', null, 'מצב'), h('th', null, ''))),
        h('tbody', null, ...rows.map((/** @type {any} */ s) => h('tr', null,
          h('td', null, s.full_name), h('td', { class: 'num' }, s.national_id), h('td', null, s.class_name),
          h('td', null, s.active ? 'פעיל' : h('span', { class: 'tag blocked' }, 'לא פעיל')),
          h('td', null, h('button', { class: 'btn small secondary', type: 'button', onclick: () => dialog(s) }, 'עריכה'))))))));
  };
  search.addEventListener('input', render);

  mount(el,
    h('div', { class: 'section-title' }, h('h2', null, 'התלמידים שלי'),
      h('div', { class: 'actions' },
        h('button', { class: 'btn', type: 'button', onclick: () => dialog(null) }, 'הוספת תלמיד'),
        h('button', { class: 'btn secondary', type: 'button', onclick: () => exportXlsx(`התלמידים של ${me.full_name}.xlsx`, 'תלמידים',
          ['שם', 'מספר זהות', 'כיתה', 'פעיל'], students.map((/** @type {any} */ s) => [s.full_name, s.national_id, s.class_name, s.active ? 'כן' : 'לא'])) }, 'יצוא ל-Excel'))),
    h('p', { class: 'muted' }, `${students.filter((/** @type {any} */ s) => s.active).length} תלמידים פעילים. הכיתות שלך: ${classes.map((/** @type {any} */ c) => c.name).join(', ') || 'לא הוגדרו'}.`),
    h('div', { class: 'toolbar' }, h('div', { class: 'field' }, h('label', { for: 'q' }, 'חיפוש'), search)),
    host);
  render();
}

init().catch((e) => { if (e?.message !== 'redirect') mount(app, alertBox('err', errorMessage(e))); });
