// הקמת מנהל ראשון – פועל רק כשאין מנהל במערכת ורק עם קוד הקמה (BOOTSTRAP_TOKEN) שהוגדר בשרת.
import { callFn, isConfigured } from '../lib/api.js';
import { errorMessage } from '../lib/errors.js';
import { normalizeIsraeliId } from '../lib/israeli-id.js';
import { alertBox, field, h, mount, siteHeader, val } from '../lib/ui.js';

const app = /** @type {HTMLElement} */ (document.getElementById('app'));
mount(/** @type {HTMLElement} */ (document.getElementById('head')), siteHeader(null, 'הקמה ראשונית'));

if (!isConfigured()) {
  mount(app, alertBox('warn', errorMessage('not_configured')));
} else {
  const err = h('div', { 'aria-live': 'assertive' });
  const form = /** @type {HTMLFormElement} */ (h('form', { class: 'panel login-box', novalidate: true, onsubmit: async (/** @type {Event} */ e) => {
    e.preventDefault();
    const nid = normalizeIsraeliId(val(form, 'nid'));
    if (!nid) { mount(err, alertBox('err', errorMessage('invalid_national_id'))); return; }
    const pw = /** @type {HTMLInputElement} */ (form.elements.namedItem('pw')).value;
    if (pw !== /** @type {HTMLInputElement} */ (form.elements.namedItem('pw2')).value) { mount(err, alertBox('err', 'הסיסמאות אינן זהות.')); return; }
    const btn = /** @type {HTMLButtonElement} */ (form.querySelector('button'));
    btn.disabled = true;
    try {
      const res = await callFn('admin-staff', { action: 'bootstrap', token: val(form, 'token'), nationalId: nid, fullName: val(form, 'name'), password: pw });
      if (!res?.ok) throw new Error(res?.error || 'error');
      mount(app, h('section', { class: 'panel login-box' }, alertBox('ok', 'המנהל הראשון נוצר. מומלץ למחוק עכשיו את ה-secret בשם BOOTSTRAP_TOKEN ב-Supabase.'),
        h('a', { class: 'btn block', href: './staff.html' }, 'לכניסת צוות')));
    } catch (ex) {
      mount(err, alertBox('err', errorMessage(ex)));
      btn.disabled = false;
    }
  } },
  h('h1', null, 'יצירת מנהל ראשון'),
  h('p', { class: 'muted' }, 'הדף פעיל רק כל עוד אין מנהל במערכת. קוד ההקמה הוא הערך שהגדרתם ב-Supabase בשם BOOTSTRAP_TOKEN.'),
  err,
  field('קוד הקמה', h('input', { name: 'token', type: 'password', required: true, autocomplete: 'off' })),
  field('שם מלא', h('input', { name: 'name', type: 'text', required: true, maxlength: '100' })),
  field('מספר זהות', h('input', { name: 'nid', type: 'text', inputmode: 'numeric', required: true, maxlength: '11' })),
  field('סיסמה', h('input', { name: 'pw', type: 'password', required: true, autocomplete: 'new-password', maxlength: '72' }), 'לפחות 10 תווים, כולל אותיות באנגלית וספרות'),
  field('אימות סיסמה', h('input', { name: 'pw2', type: 'password', required: true, autocomplete: 'new-password', maxlength: '72' })),
  h('button', { class: 'btn block', type: 'submit' }, 'יצירת מנהל')));
  mount(app, form);
}
