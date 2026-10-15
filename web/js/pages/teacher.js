// דף רב: אסיפות פעילות שלו, זמינות, לוח תורים, תלמידים, הערות
import { isConfigured, select } from '../lib/api.js';
import { requireStaff, staffNav } from '../lib/auth.js';
import { fullDayLabel } from '../lib/dates.js';
import { errorMessage } from '../lib/errors.js';
import { alertBox, confStatusTag, empty, h, loading, mount, siteHeader } from '../lib/ui.js';
import { renderWorkspace } from '../lib/workspace.js';

const app = /** @type {HTMLElement} */ (document.getElementById('app'));
const head = /** @type {HTMLElement} */ (document.getElementById('head'));

async function init() {
  mount(head, siteHeader(null, 'אזור הרב'));
  if (!isConfigured()) { mount(app, alertBox('warn', errorMessage('not_configured'))); return; }
  mount(app, loading());
  const me = await requireStaff();
  mount(head, siteHeader(null, 'אזור הרב', staffNav(me, 'teacher')));

  let confs;
  try {
    const mine = await select('conference_teachers', 'conference_id', (q) => q.eq('teacher_id', me.id));
    const ids = mine.map((/** @type {any} */ r) => r.conference_id);
    confs = ids.length
      ? await select('conferences', 'id, title, description, starts_on, ends_on, status', (q) =>
        q.in('id', ids).neq('status', 'archived').order('starts_on', { ascending: false }))
      : [];
  } catch (err) {
    mount(app, alertBox('err', errorMessage(err)));
    return;
  }

  if (!confs.length) {
    mount(app, h('section', { class: 'panel' }, empty('אין אסיפות פעילות', 'כשההנהלה תשייך אותך לאסיפה, היא תופיע כאן.')));
    return;
  }

  const params = new URLSearchParams(location.search);
  let current = confs.find((/** @type {any} */ c) => c.id === params.get('c')) || confs.find((/** @type {any} */ c) => c.status === 'open') || confs[0];
  const wsHost = h('div');
  const picker = /** @type {HTMLSelectElement} */ (h('select', { id: 'conf', onchange: () => {
    current = confs.find((/** @type {any} */ c) => c.id === picker.value);
    history.replaceState(null, '', `?c=${current.id}`);
    show();
  } }, ...confs.map((/** @type {any} */ c) => h('option', { value: c.id, selected: c.id === current.id }, c.title))));
  const meta = h('div');

  function show() {
    mount(meta, h('p', null, confStatusTag(current.status), ' ',
      `${fullDayLabel(current.starts_on)} עד ${fullDayLabel(current.ends_on)}`));
    renderWorkspace(wsHost, { conference: current, teacherId: me.id, teacherName: me.full_name, me });
  }

  mount(app,
    h('div', { class: 'toolbar' }, h('div', { class: 'field' }, h('label', { for: 'conf' }, 'אסיפה'), picker)),
    meta, wsHost);
  show();
}

init().catch((e) => { if (e?.message !== 'redirect') mount(app, alertBox('err', errorMessage(e))); });
