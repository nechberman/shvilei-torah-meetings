// Edge Function: פעולות הורים (זיהוי, סלוטים פנויים, הזמנה)
// אין גישה ישירה של הדפדפן לטבלאות – רק דרך פונקציה זו, עם הגבלת קצב במסד.
import { adminClient, ipHash, isUuid, json, preflight, readBody, str } from '../_shared/http.ts';

Deno.serve(async (req) => {
  const pre = preflight(req);
  if (pre) return pre;
  try {
    const body = await readBody(req);
    const action = str(body.action, 20);
    const db = adminClient();

    if (action === 'lookup') {
      const nationalId = str(body.nationalId, 20) ?? '';
      const code = str(body.code, 4);
      const { data, error } = await db.rpc('parent_lookup', {
        p_national_id: nationalId,
        p_code: code,
        p_ip_hash: await ipHash(req),
      });
      if (error) throw error;
      return json(req, data);
    }

    if (action === 'slots') {
      if (!isUuid(body.conferenceId)) return json(req, { ok: false, error: 'invalid_request' }, 400);
      const { data, error } = await db.rpc('parent_slots', {
        p_token: str(body.token, 100) ?? '',
        p_conference_id: body.conferenceId,
      });
      if (error) throw error;
      return json(req, data);
    }

    if (action === 'book') {
      if (!isUuid(body.slotId)) return json(req, { ok: false, error: 'invalid_request' }, 400);
      const { data, error } = await db.rpc('parent_book', {
        p_token: str(body.token, 100) ?? '',
        p_slot_id: body.slotId,
        p_ip_hash: await ipHash(req),
      });
      if (error) throw error;
      return json(req, data);
    }

    if (action === 'settings') {
      const { data, error } = await db.rpc('public_settings');
      if (error) throw error;
      return json(req, { ok: true, settings: data });
    }

    return json(req, { ok: false, error: 'invalid_request' }, 400);
  } catch (e) {
    // לא מחזירים פרטי שגיאה פנימיים
    console.error('parent function error', e instanceof Error ? e.message : 'unknown');
    return json(req, { ok: false, error: 'server_error' }, 500);
  }
});
