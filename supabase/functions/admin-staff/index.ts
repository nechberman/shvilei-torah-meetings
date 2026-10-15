// Edge Function: ניהול אנשי צוות (מנהל בלבד) + הקמת מנהל ראשון חד-פעמית.
// פעולות: create, reset_password, bootstrap
// יצירת משתמשי Auth דורשת service role – לכן היא כאן ולא בדפדפן.
import {
  adminClient, internalEmail, ipHash, isUuid, json, normalizeIsraeliId, preflight, readBody, sleep, str,
  strongPassword,
} from '../_shared/http.ts';

type Db = ReturnType<typeof adminClient>;

async function requireAdmin(req: Request, db: Db): Promise<string | null> {
  const auth = req.headers.get('authorization') ?? '';
  const jwt = auth.replace(/^Bearer\s+/i, '');
  if (!jwt) return null;
  const { data, error } = await db.auth.getUser(jwt);
  if (error || !data.user) return null;
  const { data: staff } = await db.from('staff_users')
    .select('id, role, active').eq('auth_user_id', data.user.id).maybeSingle();
  if (!staff || !staff.active || staff.role !== 'admin') return null;
  return staff.id as string;
}

async function createStaff(
  db: Db, nationalId: string, fullName: string, role: 'admin' | 'teacher', password: string,
): Promise<{ id?: string; error?: string }> {
  const { data: existing } = await db.from('staff_users').select('id')
    .eq('national_id_normalized', nationalId).maybeSingle();
  if (existing) return { error: 'staff_exists' };

  const { data: created, error: cErr } = await db.auth.admin.createUser({
    email: internalEmail(),
    password,
    email_confirm: true,
    app_metadata: { app: 'shvilei-torah-meetings' },
  });
  if (cErr || !created.user) {
    const msg = cErr?.message ?? '';
    return { error: /password/i.test(msg) ? 'weak_password' : 'server_error' };
  }
  const { data: row, error: iErr } = await db.from('staff_users').insert({
    national_id_normalized: nationalId,
    auth_user_id: created.user.id,
    full_name: fullName,
    role,
  }).select('id').single();
  if (iErr || !row) {
    await db.auth.admin.deleteUser(created.user.id);
    return { error: iErr?.code === '23505' ? 'staff_exists' : 'server_error' };
  }
  return { id: row.id as string };
}

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  try {
    const body = await readBody(req);
    const action = str(body.action, 30);
    const db = adminClient();

    // ---------- הקמה ראשונית: רק כשאין מנהל, ורק עם BOOTSTRAP_TOKEN שהוגדר כ-secret ----------
    if (action === 'bootstrap') {
      const started = Date.now();
      const expected = Deno.env.get('BOOTSTRAP_TOKEN') ?? '';
      const ip = await ipHash(req);
      const { data: allowed, error: rlErr } = await db.rpc('bootstrap_rate_ok', { p_ip_hash: ip });
      if (rlErr) throw rlErr;
      if (allowed !== true) return json(req, { ok: false, error: 'rate_limited' }, 429);
      const { count } = await db.from('staff_users').select('id', { count: 'exact', head: true }).eq('role', 'admin');
      if ((count ?? 0) > 0 || expected.length < 20) {
        return json(req, { ok: false, error: 'bootstrap_disabled' }, 403);
      }
      const token = typeof body.token === 'string' ? body.token : '';
      const a = new TextEncoder().encode(token.padEnd(128, '\0').slice(0, 128));
      const b = new TextEncoder().encode(expected.padEnd(128, '\0').slice(0, 128));
      let diff = token.length === expected.length ? 0 : 1;
      for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
      if (diff !== 0) {
        await sleep(Math.max(0, 800 - (Date.now() - started)));
        return json(req, { ok: false, error: 'bootstrap_token_invalid' }, 403);
      }
      const nid = normalizeIsraeliId(body.nationalId);
      const name = str(body.fullName, 100);
      if (!nid) return json(req, { ok: false, error: 'invalid_national_id' }, 400);
      if (!name || name.length < 2) return json(req, { ok: false, error: 'invalid_request' }, 400);
      if (!strongPassword(body.password)) return json(req, { ok: false, error: 'weak_password' }, 400);
      const res = await createStaff(db, nid, name, 'admin', body.password);
      if (res.error) return json(req, { ok: false, error: res.error }, 400);
      await db.rpc('log_audit', {
        p_actor_type: 'system', p_actor_id: null, p_action: 'staff.bootstrap_admin',
        p_entity_type: 'staff_user', p_entity_id: res.id, p_metadata: {},
      });
      return json(req, { ok: true });
    }

    // ---------- פעולות מנהל ----------
    const adminId = await requireAdmin(req, db);
    if (!adminId) return json(req, { ok: false, error: 'not_authorized' }, 403);

    if (action === 'create') {
      const nid = normalizeIsraeliId(body.nationalId);
      const name = str(body.fullName, 100);
      const role = body.role === 'admin' ? 'admin' : 'teacher';
      if (!nid) return json(req, { ok: false, error: 'invalid_national_id' }, 400);
      if (!name || name.length < 2) return json(req, { ok: false, error: 'invalid_request' }, 400);
      if (!strongPassword(body.password)) return json(req, { ok: false, error: 'weak_password' }, 400);
      const res = await createStaff(db, nid, name, role, body.password);
      if (res.error) return json(req, { ok: false, error: res.error }, 400);
      await db.rpc('log_audit', {
        p_actor_type: 'admin', p_actor_id: adminId, p_action: 'staff.create',
        p_entity_type: 'staff_user', p_entity_id: res.id, p_metadata: { role },
      });
      return json(req, { ok: true, id: res.id });
    }

    if (action === 'reset_password') {
      if (!isUuid(body.staffId)) return json(req, { ok: false, error: 'invalid_request' }, 400);
      if (!strongPassword(body.password)) return json(req, { ok: false, error: 'weak_password' }, 400);
      const { data: staff } = await db.from('staff_users').select('id, auth_user_id, national_id_normalized, full_name, role')
        .eq('id', body.staffId).maybeSingle();
      if (!staff) return json(req, { ok: false, error: 'not_found' }, 404);
      if (staff.auth_user_id) {
        const { error } = await db.auth.admin.updateUserById(staff.auth_user_id, { password: body.password });
        if (error) return json(req, { ok: false, error: /password/i.test(error.message) ? 'weak_password' : 'server_error' }, 400);
      } else {
        // איש צוות ללא משתמש כניסה (למשל לאחר מחיקת משתמש) – יוצרים ומקשרים
        const { data: created, error } = await db.auth.admin.createUser({
          email: internalEmail(), password: body.password, email_confirm: true,
        });
        if (error || !created.user) return json(req, { ok: false, error: 'server_error' }, 500);
        await db.from('staff_users').update({ auth_user_id: created.user.id }).eq('id', staff.id);
      }
      // ניתוק סשנים קיימים אינו נתמך ישירות כאן; הסיסמה החדשה תקפה מיד
      await db.rpc('log_audit', {
        p_actor_type: 'admin', p_actor_id: adminId, p_action: 'staff.reset_password',
        p_entity_type: 'staff_user', p_entity_id: staff.id, p_metadata: {},
      });
      return json(req, { ok: true });
    }

    return json(req, { ok: false, error: 'invalid_request' }, 400);
  } catch (e) {
    console.error('admin-staff error', e instanceof Error ? e.message : 'unknown');
    return json(req, { ok: false, error: 'server_error' }, 500);
  }
});
