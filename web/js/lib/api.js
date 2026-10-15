// תקשורת עם Supabase: Edge Functions (הורים/כניסה) ו-RPC מאובטח (צוות)
// בדפדפן יש רק מפתח publishable ציבורי. כל ההרשאות נאכפות בשרת (RLS + בדיקות בפונקציות).
import { createClient } from '@supabase/supabase-js';

/** @typedef {{SUPABASE_URL: string, SUPABASE_PUBLISHABLE_KEY: string}} AppConfig */

/** @returns {AppConfig} */
export function config() {
  // config.js הוא המקור; אם לא נטען – גיבוי שנארז בזמן build
  /* global __BUNDLED_CONFIG__ */
  const bundled = typeof __BUNDLED_CONFIG__ !== 'undefined' ? __BUNDLED_CONFIG__ : {};
  const w = /** @type {any} */ (window).APP_CONFIG || {};
  const c = w.SUPABASE_URL ? w : bundled;
  return { SUPABASE_URL: String(c.SUPABASE_URL || ''), SUPABASE_PUBLISHABLE_KEY: String(c.SUPABASE_PUBLISHABLE_KEY || '') };
}

export function isConfigured() {
  const c = config();
  return /^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(c.SUPABASE_URL) && c.SUPABASE_PUBLISHABLE_KEY.length > 20;
}

/**
 * קריאה ל-Edge Function
 * @param {string} name
 * @param {Record<string, unknown>} body
 * @param {string} [accessToken]
 * @returns {Promise<any>}
 */
export async function callFn(name, body, accessToken) {
  if (!isConfigured()) throw new Error('not_configured');
  const c = config();
  let res;
  try {
    res = await fetch(`${c.SUPABASE_URL}/functions/v1/${name}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: c.SUPABASE_PUBLISHABLE_KEY,
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error('network');
  }
  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error('network');
  }
  return data;
}

/** @type {import('@supabase/supabase-js').SupabaseClient|null} */
let client = null;
export function supabase() {
  if (!isConfigured()) throw new Error('not_configured');
  if (!client) {
    const c = config();
    client = createClient(c.SUPABASE_URL, c.SUPABASE_PUBLISHABLE_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, storageKey: 'shvilei-staff-auth' },
    });
  }
  return client;
}

/**
 * RPC עם זריקת שגיאה בקוד קצר
 * @param {string} fn @param {Record<string, unknown>} [params]
 * @returns {Promise<any>}
 */
export async function rpc(fn, params = {}) {
  const { data, error } = await supabase().rpc(fn, params);
  if (error) throw new Error(error.message || 'error');
  if (data && typeof data === 'object' && !Array.isArray(data) && data.ok === false) {
    throw new Error(data.error || 'error');
  }
  return data;
}

/**
 * select מטבלה (RLS קובע מה מוחזר)
 * @param {string} table @param {string} columns
 * @param {(q: any) => any} [build]
 * @returns {Promise<any[]>}
 */
export async function select(table, columns, build) {
  /** @type {any} */
  let q = supabase().from(table).select(columns);
  if (build) q = build(q);
  const { data, error } = await q;
  if (error) throw new Error(error.message || 'error');
  return data || [];
}
