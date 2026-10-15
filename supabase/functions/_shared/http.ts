// כלים משותפים ל-Edge Functions: CORS, JSON, hash ל-IP, לקוח service-role
import { createClient, type SupabaseClient } from 'npm:@supabase/supabase-js@2.57.4';

const allowed = (Deno.env.get('ALLOWED_ORIGINS') ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get('origin') ?? '';
  // אם ALLOWED_ORIGINS לא הוגדר – מאפשרים (לשלב ההקמה); בייצור יש להגדיר את כתובת GitHub Pages
  const allow = allowed.length === 0 ? '*' : allowed.includes(origin) ? origin : allowed[0];
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

export function json(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(req),
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

export function preflight(req: Request): Response | null {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders(req) });
  if (req.method !== 'POST') return json(req, { ok: false, error: 'method_not_allowed' }, 405);
  return null;
}

export async function readBody(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (text.length > 20000) throw new Error('payload_too_large');
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export function str(v: unknown, max = 200): string | null {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  return s.length === 0 || s.length > max ? null : s;
}

const serviceKey = (): string =>
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

export function adminClient(): SupabaseClient {
  const url = Deno.env.get('SUPABASE_URL');
  const key = serviceKey();
  if (!url || !key) throw new Error('server_misconfigured');
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

// hash של IP עם salt סודי – לא שומרים כתובות IP גלויות
export async function ipHash(req: Request): Promise<string> {
  const fwd = req.headers.get('x-forwarded-for') ?? '';
  const ip = fwd.split(',')[0].trim() || req.headers.get('cf-connecting-ip') || 'unknown';
  const salt = Deno.env.get('IP_HASH_SALT') ?? serviceKey().slice(-24);
  const data = new TextEncoder().encode(salt + '|' + ip);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
}

export function isUuid(v: unknown): v is string {
  return typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

export function strongPassword(p: unknown): p is string {
  return typeof p === 'string' && p.length >= 10 && p.length <= 72 && /[A-Za-z]/.test(p) && /[0-9]/.test(p);
}

export function normalizeIsraeliId(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const digits = String(value).replace(/[\s-]/g, '');
  if (!/^[0-9]{5,9}$/.test(digits)) return null;
  const padded = digits.padStart(9, '0');
  if (padded === '000000000') return null;
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    let x = Number(padded[i]) * (i % 2 === 0 ? 1 : 2);
    if (x > 9) x -= 9;
    sum += x;
  }
  return sum % 10 === 0 ? padded : null;
}

// כתובת מייל פנימית שאינה מבוססת על מספר הזהות ואינה נחשפת למשתמש
export function internalEmail(): string {
  return `staff-${crypto.randomUUID()}@staff.shvilei-torah.invalid`;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
