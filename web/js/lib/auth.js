// סשן אנשי צוות. ההרשאה בפועל נאכפת בשרת; כאן רק ניתוב ממשק.
import { callFn, rpc, supabase } from './api.js';
import { h } from './ui.js';

/** @typedef {{id: string, full_name: string, role: 'admin'|'teacher'}} Me */

/**
 * @param {string} nationalId @param {string} password
 */
export async function staffLogin(nationalId, password) {
  const res = await callFn('staff-login', { nationalId, password });
  if (!res?.ok) throw new Error(res?.error || 'invalid_credentials');
  const { error } = await supabase().auth.setSession({
    access_token: res.session.access_token,
    refresh_token: res.session.refresh_token,
  });
  if (error) throw new Error('invalid_credentials');
  return /** @type {Me} */ (await rpc('staff_me'));
}

/** @returns {Promise<Me|null>} */
export async function currentStaff() {
  const { data } = await supabase().auth.getSession();
  if (!data.session) return null;
  try {
    const me = await rpc('staff_me');
    return me && me.id ? me : null;
  } catch {
    return null;
  }
}

/**
 * מוודא כניסה; אחרת מעביר לדף הכניסה
 * @param {'admin'|'teacher'|null} [role]
 * @returns {Promise<Me>}
 */
export async function requireStaff(role = null) {
  const me = await currentStaff();
  if (!me) {
    location.replace('./staff.html');
    throw new Error('redirect');
  }
  if (role === 'admin' && me.role !== 'admin') {
    location.replace('./teacher.html');
    throw new Error('redirect');
  }
  return me;
}

export async function logout() {
  try {
    await supabase().auth.signOut();
  } finally {
    location.replace('./staff.html');
  }
}

/** ניווט עליון לצוות
 * @param {Me} me @param {'teacher'|'admin'} current */
export function staffNav(me, current) {
  return h('nav', { 'aria-label': 'ניווט' },
    h('span', { class: 'who' }, me.full_name),
    me.role === 'admin' && current !== 'admin' ? h('a', { class: 'btn ghost', href: './admin.html' }, 'ניהול') : null,
    current !== 'teacher' ? h('a', { class: 'btn ghost', href: './teacher.html' }, 'התורים שלי') : null,
    h('a', { class: 'btn ghost', href: './staff.html#password' }, 'שינוי סיסמה'),
    h('button', { class: 'btn ghost', type: 'button', onclick: logout }, 'יציאה'));
}
