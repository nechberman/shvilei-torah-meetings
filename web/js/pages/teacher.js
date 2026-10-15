// דף רב: "התורים שלי" (אסיפות, שעות, לוח תורים) ו"התלמידים שלי" (רשימה כולל מספרי זהות, הוספה ועריכה)
import { isConfigured, rpc, select } from '../lib/api.js';
import { requireStaff, staffNav } from '../lib/auth.js';
import { fullDayLabel } from '../lib/dates.js';
import { errorMessage } from '../lib/errors.js';
import { exportXlsx } from '../lib/excel.js';
import { normalizeIsraeliId } from '../lib/israeli-id.js';
import { alertBox, confStatusTag, confirmDialog, empty, field, formDialog, h, loading, mount, siteHeader, toast, val } from '../lib/ui.js';
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
    ? await select('conferences', 'id, title, description, starts_on, ends_on, status, created_by', (q) =>
      q.in('id', ids).neq('status', 'archived').order('starts_on', { ascending: false }))
    : [];
  const reload = (/** @type {string} */ selectId) => {
    if (selectId) history.replaceState(null, '', `?c=${selectId}${location.hash}`);
    tabMeetings(el);
  };

  /** @param {any|null} c */
  const confDialog = (c) => formDialog(c ? 'עריכת אסיפה' : 'אסיפת הורים חדשה', h('div', null,
    field('שם האסיפה', h('input', { name: 'title', type: 'text', required: true, maxlength: '120', value: c?.title || '', placeholder: 'למשל: אסיפת הורים – חנוכה' })),
    field('הודעה להורים (לא חובה)', h('textarea', { name: 'desc', maxlength: '1000' }, c?.description || '')),
    h('div', { class: 'row' },
      field('מתאריך', h('input', { name: 'from', type: 'date', required: true, value: c?.starts_on || '' })),
      field('עד תאריך', h('input', { name: 'to', type: 'date', required: true, value: c?.ends_on || '' }))),
    !c ? field('כל כמה דקות תור', h('select', { name: 'dur' },
      ...[5, 10, 15, 20, 30, 45, 60].map((m) => h('option', { value: String(m), selected: m === 15 }, m === 15 ? 'רבע שעה (15 דקות)' : m === 30 ? 'חצי שעה (30 דקות)' : m === 60 ? 'שעה' : `${m} דקות`)))) : null,
    !c ? h('p', { class: 'muted small' }, 'אחרי היצירה תוסיפו שעות קבלה, ואז "פתיחה להרשמה" כדי שההורים יוכלו לקבוע.') : null), async (form) => {
    if (!val(form, 'title') || !val(form, 'from') || !val(form, 'to')) throw new Error('invalid_range');
    const id = await rpc('staff_upsert_conference', {
      p_id: c?.id || null, p_title: val(form, 'title'),
      p_description: /** @type {HTMLTextAreaElement} */ (form.elements.namedItem('desc')).value,
      p_starts_on: val(form, 'from'), p_ends_on: val(form, 'to'), p_minutes: Number(val(form, 'dur') || 15),
    });
    toast(c ? 'האסיפה עודכנה' : 'האסיפה נוצרה');
    reload(id);
  }, c ? 'שמירה' : 'יצירת האסיפה');

  const newBtn = h('button', { class: 'btn', type: 'button', onclick: () => confDialog(null) }, 'אסיפת הורים חדשה');

  if (!confs.length) {
    mount(el, h('section', { class: 'panel' }, empty('אין אסיפות פעילות', 'אפשר לפתוח אסיפה בעצמך, או לחכות שההנהלה תשייך אותך לאסיפה.'),
      h('div', { style: 'text-align:center' }, newBtn)));
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

  /** @param {string} status @param {string} text @param {string} msg */
  const statusBtn = (status, text, msg) => h('button', { class: 'btn small secondary', type: 'button', onclick: async () => {
    if (!(await confirmDialog(text, msg))) return;
    try {
      await rpc('staff_set_conference_status', { p_id: current.id, p_status: status });
      toast('הסטטוס עודכן');
      reload(current.id);
    } catch (err) { toast(errorMessage(err), 'err'); }
  } }, text);

  const deleteDialog = () => formDialog(`מחיקת האסיפה "${current.title}"`, h('div', null,
    alertBox('err', 'המחיקה סופית: יימחקו האסיפה, השעות, התורים שנקבעו בה וההערות עליהם.'),
    field('לאישור, הקלידו את שם האסיפה', h('input', { name: 'confirm', type: 'text', autocomplete: 'off', required: true, placeholder: current.title }))), async (form) => {
    await rpc('staff_delete_conference', { p_id: current.id, p_confirm_title: val(form, 'confirm') });
    toast('האסיפה נמחקה');
    history.replaceState(null, '', location.pathname + location.hash);
    tabMeetings(el);
  }, 'מחיקה לצמיתות');

  function showConf() {
    const own = current.created_by === me.id || me.role === 'admin';
    const st = current.status;
    mount(meta,
      h('p', null, confStatusTag(st), ' ', `${fullDayLabel(current.starts_on)} עד ${fullDayLabel(current.ends_on)}`),
      own ? h('div', { class: 'row no-print', style: 'gap:8px;margin-bottom:14px' },
        h('button', { class: 'btn small secondary', type: 'button', onclick: () => confDialog(current) }, 'עריכת האסיפה'),
        st === 'draft' ? statusBtn('open', 'פתיחה להרשמה', 'ההורים יוכלו לקבוע תורים באסיפה זו.') : null,
        st === 'open' ? statusBtn('closed', 'סגירת ההרשמה', 'ההורים לא יוכלו לקבוע תורים חדשים.') : null,
        st === 'closed' ? statusBtn('open', 'פתיחה מחדש', 'ההורים יוכלו שוב לקבוע תורים.') : null,
        st === 'closed' || st === 'draft' ? statusBtn('archived', 'העברה לארכיון', 'האסיפה תוסתר ותישמר לצפייה בלבד.') : null,
        h('button', { class: 'btn small danger', type: 'button', onclick: deleteDialog }, 'מחיקת האסיפה'))
        : h('p', { class: 'muted small' }, 'את האסיפה הזו פתחה ההנהלה – פתיחה וסגירה שלה נעשות על ידי ההנהלה.'));
    renderWorkspace(wsHost, { conference: current, teacherId: me.id, teacherName: me.full_name, me });
  }
  mount(el, h('div', { class: 'toolbar' }, h('div', { class: 'field' }, h('label', { for: 'conf' }, 'אסיפה'), picker), newBtn), meta, wsHost);
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

  /** @param {any} s */
  const removeStudent = async (s) => {
    if (!(await confirmDialog(`מחיקת ${s.full_name}`, 'התלמיד יימחק מהרשימה לצמיתות.', { danger: true, okText: 'מחיקה' }))) return;
    try {
      await rpc('staff_delete_student', { p_id: s.id });
      toast('התלמיד נמחק');
      reload();
    } catch (err) {
      const code = String(/** @type {any} */ (err)?.message || '');
      if (code.includes('student_has_history') && s.active
        && await confirmDialog('אי אפשר למחוק', 'לתלמיד יש תורים קודמים במערכת, ולכן הוא נשמר להיסטוריה. להפוך אותו ל"לא פעיל"? כך הוא ייעלם מההורים ומהדוחות.', { okText: 'סימון כלא פעיל' })) {
        await rpc('staff_upsert_my_student', { p_id: s.id, p_national_id: s.national_id, p_full_name: s.full_name, p_class_id: s.class_id, p_active: false });
        toast('התלמיד סומן כלא פעיל');
        reload();
      } else if (!code.includes('student_has_history')) {
        toast(errorMessage(err), 'err');
      }
    }
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
          h('td', null, h('div', { class: 'row', style: 'gap:6px' },
            h('button', { class: 'btn small secondary', type: 'button', onclick: () => dialog(s) }, 'עריכה'),
            h('button', { class: 'btn small danger', type: 'button', onclick: () => removeStudent(s) }, 'מחיקה')))))))));
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
