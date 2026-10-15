// Edge Function: כניסת רב/מנהל עם מספר זהות + סיסמה.
// מספר הזהות ממופה בצד השרת למשתמש Supabase Auth – כתובת המייל הפנימית לא נחשפת.
import { createClient } from 'npm:@supabase/supabase-js@2.57.4';
import { adminClient, ipHash, json, preflight, readBody, sleep, str } from '../_shared/http.ts';

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  const started = Date.now();
  // זמן תגובה מינימלי אחיד – מקשה על זיהוי קיום משתמש לפי תזמון
  const fail = async (error: string, status = 401) => {
    const wait = 600 - (Date.now() - started);
    if (wait > 0) await sleep(wait);
    return json(req, { ok: false, error }, status);
  };
  try {
    const body = await readBody(req);
    const nationalId = str(body.nationalId, 20) ?? '';
    const password = typeof body.password === 'string' && body.password.length <= 72 ? body.password : '';
    const ip = await ipHash(req);
    const db = adminClient();

    const { data: look, error: lookErr } = await db.rpc('staff_login_lookup', {
      p_national_id: nationalId,
      p_ip_hash: ip,
    });
    if (lookErr) throw lookErr;
    if (!look?.ok) return fail(look?.error ?? 'invalid_credentials', look?.error === 'rate_limited' ? 429 : 401);

    const authUserId: string | null = look.auth_user_id ?? null;
    if (!authUserId || !password) {
      await db.rpc('staff_login_report', { p_national_id: nationalId, p_ip_hash: ip, p_success: false });
      return fail('invalid_credentials');
    }

    const { data: userData, error: userErr } = await db.auth.admin.getUserById(authUserId);
    if (userErr || !userData?.user?.email) {
      await db.rpc('staff_login_report', { p_national_id: nationalId, p_ip_hash: ip, p_success: false });
      return fail('invalid_credentials');
    }

    const url = Deno.env.get('SUPABASE_URL')!;
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
    const authClient = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data: signIn, error: signErr } = await authClient.auth.signInWithPassword({
      email: userData.user.email,
      password,
    });
    if (signErr || !signIn.session) {
      await db.rpc('staff_login_report', { p_national_id: nationalId, p_ip_hash: ip, p_success: false });
      return fail('invalid_credentials');
    }
    await db.rpc('staff_login_report', { p_national_id: nationalId, p_ip_hash: ip, p_success: true });

    return json(req, {
      ok: true,
      session: {
        access_token: signIn.session.access_token,
        refresh_token: signIn.session.refresh_token,
        expires_in: signIn.session.expires_in,
      },
    });
  } catch (e) {
    console.error('staff-login error', e instanceof Error ? e.message : 'unknown');
    return json(req, { ok: false, error: 'server_error' }, 500);
  }
});
