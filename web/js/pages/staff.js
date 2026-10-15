// כניסת צוות + שינוי סיסמה
import { isConfigured, supabase } from '../lib/api.js';
import { currentStaff, staffLogin, staffNav } from '../lib/auth.js';
import { errorMessage } from '../lib/errors.js';
import { normalizeIsraeliId } from '../lib/israeli-id.js';
import { alertBox, h, loading, mount, siteHeader, toast } from '../lib/ui.js';

const app = /** @type {HTMLElement} */ (document.getElementById('app'));
const head = /** @type {HTMLElement} */ (document.getElementById('head'));

/** @param {{role: string}} me */
const homeFor = (me) => (me.role === 'admin' ? './admin.html' : './teacher.html');

async function init() {
  mount(head, siteHeader(null, 'כניסת צוות'));
  if (!isConfigured()) {
    mount(app, alertBox('warn', errorMessage('not_configured')));
    return;
  }
  mount(app, loading());
  const me = await currentStaff();
  if (me && location.hash === '#password') {
    mount(head, siteHeader(null, 'שינוי סיסמה', staffNav(me, 'teacher')));
    renderPassword(me);
    return;
  }
  if (me) {
    location.replace(homeFor(me));
    return;
  }
  renderLogin();
}

function renderLogin() {
  const nid = /** @type {HTMLInputElement} */ (h('input', { id: 'nid', type: 'text', inputmode: 'numeric', autocomplete: 'username', required: true, maxlength: '11' }));
  const pw = /** @type {HTMLInputElement} */ (h('input', { id: 'pw', type: 'password', autocomplete: 'current-password', required: true, maxlength: '72' }));
  const err = h('div', { 'aria-live': 'assertive' });
  const btn = /** @type {HTMLButtonElement} */ (h('button', { class: 'btn block', type: 'submit' }, 'כניסה'));
  mount(app, h('section', { class: 'panel login-box' },
    h('h1', null, 'כניסת רבנים והנהלה'),
    h('form', { novalidate: true, onsubmit: async (/** @type {Event} */ e) => {
      e.preventDefault();
      const id = normalizeIsraeliId(nid.value);
      if (!id || !pw.value) {
        mount(err, alertBox('err', errorMessage('invalid_credentials')));
        return;
      }
      btn.disabled = true;
      btn.textContent = 'מתחבר…';
      try {
        const me = await staffLogin(id, pw.value);
        location.replace(homeFor(me));
      } catch (ex) {
        mount(err, alertBox('err', errorMessage(ex)));
        btn.disabled = false;
        btn.textContent = 'כניסה';
        pw.value = '';
        pw.focus();
      }
    } },
    err,
    h('div', { class: 'field' }, h('label', { for: 'nid' }, 'מספר תעודת זהות'), nid),
    h('div', { class: 'field' }, h('label', { for: 'pw' }, 'סיסמה'), pw),
    btn),
    h('p', { class: 'muted small', style: 'margin-top:14px' }, 'שכחתם סיסמה? מנהל המערכת יכול להגדיר לכם סיסמה חדשה.'),
    h('p', { class: 'small' }, h('a', { href: './' }, 'לדף ההורים'))));
  nid.focus();
}

/** @param {{role: string}} me */
function renderPassword(me) {
  const p1 = /** @type {HTMLInputElement} */ (h('input', { id: 'p1', type: 'password', autocomplete: 'new-password', maxlength: '72' }));
  const p2 = /** @type {HTMLInputElement} */ (h('input', { id: 'p2', type: 'password', autocomplete: 'new-password', maxlength: '72' }));
  const err = h('div', { 'aria-live': 'assertive' });
  mount(app, h('section', { class: 'panel login-box' },
    h('h1', null, 'שינוי סיסמה'),
    h('form', { novalidate: true, onsubmit: async (/** @type {Event} */ e) => {
      e.preventDefault();
      const v = p1.value;
      if (v.length < 10 || !/[A-Za-z]/.test(v) || !/[0-9]/.test(v)) {
        mount(err, alertBox('err', errorMessage('weak_password')));
        return;
      }
      if (v !== p2.value) {
        mount(err, alertBox('err', 'הסיסמאות אינן זהות.'));
        return;
      }
      const { error } = await supabase().auth.updateUser({ password: v });
      if (error) {
        mount(err, alertBox('err', /password/i.test(error.message) ? errorMessage('weak_password') : errorMessage(error)));
        return;
      }
      toast('הסיסמה עודכנה');
      setTimeout(() => location.replace(homeFor(me)), 900);
    } },
    err,
    h('div', { class: 'field' }, h('label', { for: 'p1' }, 'סיסמה חדשה'), p1,
      h('div', { class: 'hint' }, 'לפחות 10 תווים, כולל אותיות באנגלית וספרות')),
    h('div', { class: 'field' }, h('label', { for: 'p2' }, 'אימות סיסמה'), p2),
    h('button', { class: 'btn block', type: 'submit' }, 'שמירת הסיסמה'))));
  p1.focus();
}

window.addEventListener('hashchange', () => init());
init();
