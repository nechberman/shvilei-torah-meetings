// כלי ממשק: יצירת אלמנטים בטוחה (textContent בלבד – הגנה מ-XSS), הודעות, דיאלוגים
/**
 * @param {string} tag
 * @param {Record<string, any>|null} [attrs]
 * @param {...(Node|string|number|null|undefined|false|(Node|string)[])} children
 * @returns {HTMLElement}
 */
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'value') /** @type {HTMLInputElement} */ (el).value = v;
      else if (k === 'checked') /** @type {HTMLInputElement} */ (el).checked = !!v;
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
  }
  append(el, children);
  return el;
}

/** @param {HTMLElement} el @param {any[]} children */
function append(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

/** @param {Element} el @param {...any} children */
export function mount(el, ...children) {
  el.replaceChildren();
  append(/** @type {HTMLElement} */ (el), children);
}

/** @param {string} [text] */
export function loading(text = 'טוען…') {
  return h('div', { class: 'loading', role: 'status' }, h('span', { class: 'spinner', 'aria-hidden': 'true' }), text);
}

/** @param {string} title @param {string} [text] */
export function empty(title, text) {
  return h('div', { class: 'empty' }, h('strong', null, title), text || '');
}

/** @param {'err'|'ok'|'warn'|'info'} kind @param {...any} children */
export function alertBox(kind, ...children) {
  return h('div', { class: `alert ${kind}`, role: kind === 'err' ? 'alert' : 'status' }, ...children);
}

let toastTimer = 0;
/** @param {string} text @param {'ok'|'err'} [kind] */
export function toast(text, kind = 'ok') {
  let host = document.querySelector('.toast-host');
  if (!host) {
    host = h('div', { class: 'toast-host', 'aria-live': 'polite' });
    document.body.append(host);
  }
  mount(host, h('div', { class: `toast ${kind === 'err' ? 'err' : ''}` }, text));
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => host && host.replaceChildren(), 4500);
}

/**
 * דיאלוג אישור (ללא window.confirm)
 * @param {string} title @param {string|Node} body
 * @param {{okText?: string, danger?: boolean}} [opts]
 * @returns {Promise<boolean>}
 */
export function confirmDialog(title, body, opts = {}) {
  return new Promise((resolve) => {
    const dlg = /** @type {HTMLDialogElement} */ (h('dialog', { 'aria-labelledby': 'dlg-title' }));
    const done = (/** @type {boolean} */ v) => { dlg.close(); dlg.remove(); resolve(v); };
    mount(dlg,
      h('div', { class: 'dlg-body' }, h('h3', { id: 'dlg-title' }, title), typeof body === 'string' ? h('p', null, body) : body),
      h('div', { class: 'dlg-actions' },
        h('button', { class: `btn ${opts.danger ? 'danger' : ''}`, type: 'button', onclick: () => done(true) }, opts.okText || 'אישור'),
        h('button', { class: 'btn secondary', type: 'button', onclick: () => done(false) }, 'ביטול')),
    );
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); done(false); });
    document.body.append(dlg);
    dlg.showModal();
  });
}

/**
 * דיאלוג עם טופס. onSubmit מחזיר true לסגירה.
 * @param {string} title
 * @param {HTMLElement} content
 * @param {(form: HTMLFormElement) => Promise<boolean|void>} onSubmit
 * @param {string} [submitText]
 */
export function formDialog(title, content, onSubmit, submitText = 'שמירה') {
  const dlg = /** @type {HTMLDialogElement} */ (h('dialog', { 'aria-labelledby': 'fdlg-title' }));
  const errHost = h('div');
  const form = /** @type {HTMLFormElement} */ (h('form', { novalidate: true },
    h('div', { class: 'dlg-body' }, h('h3', { id: 'fdlg-title' }, title), errHost, content),
    h('div', { class: 'dlg-actions' },
      h('button', { class: 'btn', type: 'submit' }, submitText),
      h('button', { class: 'btn secondary', type: 'button', onclick: () => { dlg.close(); dlg.remove(); } }, 'ביטול'))));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = /** @type {HTMLButtonElement} */ (form.querySelector('button[type=submit]'));
    btn.disabled = true;
    errHost.replaceChildren();
    try {
      const close = await onSubmit(form);
      if (close !== false) { dlg.close(); dlg.remove(); }
    } catch (err) {
      const { errorMessage } = await import('./errors.js');
      mount(errHost, alertBox('err', errorMessage(err)));
    } finally {
      btn.disabled = false;
    }
  });
  dlg.append(form);
  document.body.append(dlg);
  dlg.showModal();
  const first = /** @type {HTMLElement|null} */ (form.querySelector('input,select,textarea'));
  first?.focus();
  return dlg;
}

/** שדה טופס עם תווית
 * @param {string} labelText @param {HTMLElement} input @param {string} [hint] */
export function field(labelText, input, hint) {
  const id = input.id || `f-${Math.random().toString(36).slice(2, 9)}`;
  input.id = id;
  return h('div', { class: 'field' }, h('label', { for: id }, labelText), input, hint ? h('div', { class: 'hint' }, hint) : null);
}

/** @param {HTMLFormElement} form @param {string} name */
export function val(form, name) {
  const el = /** @type {HTMLInputElement|null} */ (form.elements.namedItem(name));
  return el ? el.value.trim() : '';
}

/** תגית סטטוס אסיפה */
const CONF_STATUS = { draft: 'טיוטה', open: 'פתוחה להרשמה', closed: 'סגורה', archived: 'בארכיון' };
/** @param {string} s */
export function confStatusTag(s) {
  return h('span', { class: `tag ${s}` }, CONF_STATUS[/** @type {keyof typeof CONF_STATUS} */ (s)] || s);
}

/** כותרת אתר עם לוגו
 * @param {{school_name?: string, logo_url?: string|null}|null} settings
 * @param {string} subtitle
 * @param {HTMLElement|null} [nav] */
export function siteHeader(settings, subtitle, nav) {
  return h('header', { class: 'site-head' },
    h('div', { class: 'inner' },
      h('img', { class: 'logo', src: settings?.logo_url || './assets/logo.svg', alt: '' }),
      h('div', null,
        h('div', { class: 'name' }, settings?.school_name || 'ישיבת שבילי התורה'),
        h('div', { class: 'sub' }, subtitle)),
      nav || null));
}

/** הורדת קובץ
 * @param {Blob} blob @param {string} filename */
export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}
