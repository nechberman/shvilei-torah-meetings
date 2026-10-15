// בדיקות אינטגרציה למסד הנתונים: הרשאות, RLS, הזמנה אטומית, תחרות, קודים אישיים.
// דורש Postgres מקומי עם המיגרציות (scripts/db-reset-local.sh) ו-TEST_DATABASE_URL.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';

const URL = process.env.TEST_DATABASE_URL;
const skip = !URL && 'TEST_DATABASE_URL not set';

/** @type {pg.Pool} */
let pool;

/** יוצר מספר זהות תקין מ-8 ספרות
 * @param {number} n */
function makeId(n) {
  const base = String(n).padStart(8, '0');
  let sum = 0;
  for (let i = 0; i < 8; i++) {
    let x = Number(base[i]) * (i % 2 === 0 ? 1 : 2);
    if (x > 9) x -= 9;
    sum += x;
  }
  return base + String((10 - (sum % 10)) % 10);
}

/**
 * @param {'anon'|'authenticated'|'service_role'} role
 * @param {string|null} sub
 * @param {string} sql
 * @param {unknown[]} [params]
 */
async function as(role, sub, sql, params = []) {
  const c = await pool.connect();
  try {
    await c.query('begin');
    await c.query(`set local role ${role}`);
    await c.query("select set_config('request.jwt.claim.sub', $1, true)", [sub ?? '']);
    const r = await c.query(sql, params);
    await c.query('commit');
    return r.rows;
  } catch (e) {
    await c.query('rollback');
    throw e;
  } finally {
    c.release();
  }
}
/** @param {string} sql @param {unknown[]} [params] */
const su = async (sql, params = []) => (await pool.query(sql, params)).rows;

const U = {
  admin: crypto.randomUUID(),
  t1: crypto.randomUUID(),
  t2: crypto.randomUUID(),
  stranger: crypto.randomUUID(),
};
/** @type {Record<string, any>} */
const S = {};
const ip = () => 'ip-' + crypto.randomUUID();

test.describe('database', { skip }, () => {
  test.before(async () => {
    pool = new pg.Pool({ connectionString: URL, max: 20 });
    for (const [k, id] of Object.entries(U)) {
      await su('insert into auth.users (id, email) values ($1, $2)', [id, `${k}@test.invalid`]);
    }
    S.adminStaff = (await su(
      `insert into staff_users (national_id_normalized, auth_user_id, full_name, role)
       values ($1,$2,'מנהל ראשי','admin') returning id`, [makeId(10000001), U.admin]))[0].id;
    S.t1 = (await su(
      `insert into staff_users (national_id_normalized, auth_user_id, full_name, role)
       values ($1,$2,'הרב אלף','teacher') returning id`, [makeId(10000002), U.t1]))[0].id;
    S.t2 = (await su(
      `insert into staff_users (national_id_normalized, auth_user_id, full_name, role)
       values ($1,$2,'הרב בית','teacher') returning id`, [makeId(10000003), U.t2]))[0].id;
  });

  test.after(async () => {
    await pool?.end();
  });

  test('anon cannot read any table or call staff/parent RPCs', async () => {
    for (const t of ['students', 'staff_users', 'appointments', 'teacher_notes', 'student_codes',
      'appointment_slots', 'settings', 'audit_logs', 'parent_sessions', 'classes', 'conferences']) {
      await assert.rejects(as('anon', null, `select * from ${t} limit 1`), /permission denied/, t);
    }
    await assert.rejects(as('anon', null, "select parent_lookup('123456782', null, 'x')"), /permission denied/);
    await assert.rejects(as('anon', null, 'select * from admin_list_students()'), /permission denied/);
    await assert.rejects(as('anon', null, "select book_slot_internal(gen_random_uuid(), gen_random_uuid(), 'parent', null)"), /permission denied/);
    const [{ s }] = await as('anon', null, 'select public_settings() as s');
    assert.equal(s.school_name, 'ישיבת שבילי התורה');
  });

  test('authenticated user without staff record has no access', async () => {
    await assert.rejects(as('authenticated', U.stranger, 'select * from admin_list_students()'), /not_authorized/);
    const rows = await as('authenticated', U.stranger, 'select id from students');
    assert.equal(rows.length, 0);
    await assert.rejects(as('authenticated', U.stranger, "select admin_upsert_class(null, 'x', true)"), /not_authorized/);
  });

  test('authenticated cannot write tables directly', async () => {
    await assert.rejects(as('authenticated', U.admin, "insert into classes (name) values ('x')"), /permission denied/);
    await assert.rejects(as('authenticated', U.admin, "update settings set require_parent_code = true"), /permission denied/);
  });

  test('admin sets up classes, students, conference', async () => {
    const [{ id: c1 }] = await as('authenticated', U.admin, "select admin_upsert_class(null, 'שיעור א׳', true) as id");
    S.class1 = c1;
    S.students = [];
    for (let i = 0; i < 12; i++) {
      const teacher = i < 10 ? S.t1 : S.t2;
      const [{ id }] = await as('authenticated', U.admin,
        'select admin_upsert_student(null, $1, $2, $3, $4, true) as id',
        [makeId(20000000 + i), `תלמיד ${i}`, S.class1, teacher]);
      S.students.push({ id, nid: makeId(20000000 + i), teacher });
    }
    await assert.rejects(as('authenticated', U.admin,
      'select admin_upsert_student(null, $1, $2, $3, $4, true)', ['123456789', 'שגוי', S.class1, S.t1]), /invalid_national_id/);
    await assert.rejects(as('authenticated', U.admin,
      'select admin_upsert_student(null, $1, $2, $3, $4, true)', [S.students[0].nid, 'כפול', S.class1, S.t1]), /national_id_exists/);

    const [{ id: conf }] = await as('authenticated', U.admin,
      "select admin_upsert_conference(null, 'אסיפת חשוון', null, '2026-11-01', '2026-11-03') as id");
    S.conf = conf;
    await as('authenticated', U.admin, 'select admin_set_conference_teacher($1, $2, 10)', [conf, S.t1]);
    await as('authenticated', U.admin, 'select admin_set_conference_teacher($1, $2, 10)', [conf, S.t2]);
  });

  test('teacher sees only own students, never national ids', async () => {
    const rows = await as('authenticated', U.t1, 'select id, teacher_id from students');
    assert.equal(rows.length, 10);
    assert.ok(rows.every((r) => r.teacher_id === S.t1));
    await assert.rejects(as('authenticated', U.t1, 'select national_id_normalized from students'), /permission denied/);
    await assert.rejects(as('authenticated', U.t1, 'select national_id_normalized from staff_users'), /permission denied/);
    const staff = await as('authenticated', U.t1, 'select id from staff_users');
    assert.deepEqual(staff.map((r) => r.id), [S.t1]);
    await assert.rejects(as('authenticated', U.t1, 'select * from admin_list_students()'), /not_authorized/);
  });

  test('availability: teacher only for self, slots generated, overlap rejected', async () => {
    // 01.11.2026 17:00–18:00 שעון ירושלים (UTC+2) = 15:00Z–16:00Z
    await as('authenticated', U.t1, 'select staff_add_availability($1, $2, $3, $4)',
      [S.conf, S.t1, '2026-11-01T15:00:00Z', '2026-11-01T16:00:00Z']);
    await assert.rejects(as('authenticated', U.t1, 'select staff_add_availability($1, $2, $3, $4)',
      [S.conf, S.t2, '2026-11-01T15:00:00Z', '2026-11-01T16:00:00Z']), /not_authorized/);
    await assert.rejects(as('authenticated', U.t1, 'select staff_add_availability($1, $2, $3, $4)',
      [S.conf, S.t1, '2026-11-01T15:30:00Z', '2026-11-01T16:30:00Z']), /availability_overlap/);
    await assert.rejects(as('authenticated', U.t1, 'select staff_add_availability($1, $2, $3, $4)',
      [S.conf, S.t1, '2026-11-05T15:00:00Z', '2026-11-05T16:00:00Z']), /window_outside_conference_dates/);
    const slots = await as('authenticated', U.t1, 'select * from appointment_slots where conference_id = $1 order by starts_at', [S.conf]);
    assert.equal(slots.length, 6);
    // רב ב׳ לא רואה סלוטים של רב א׳
    assert.equal((await as('authenticated', U.t2, 'select * from appointment_slots')).length, 0);
    // admin opens for t2
    await as('authenticated', U.admin, 'select staff_add_availability($1, $2, $3, $4)',
      [S.conf, S.t2, '2026-11-01T15:00:00Z', '2026-11-01T15:30:00Z']);
    S.t1slots = slots;
  });

  test('exclusion constraint prevents overlapping slots even for direct inserts', async () => {
    await assert.rejects(su(
      `insert into appointment_slots (conference_id, teacher_id, starts_at, ends_at)
       values ($1, $2, '2026-11-01T15:05:00Z', '2026-11-01T15:15:00Z')`, [S.conf, S.t1]), /slots_no_overlap|duplicate/);
  });

  test('parent cannot book while conference is draft', async () => {
    const r = (await as('service_role', null, 'select parent_lookup($1, null, $2) as r', [S.students[0].nid, ip()]))[0].r;
    assert.equal(r.ok, true);
    assert.equal(r.conferences.length, 0, 'draft conference is hidden');
    await as('authenticated', U.admin, "select admin_set_conference_status($1, 'open')", [S.conf]);
  });

  test('parent lookup: minimal data only; errors do not reveal existence', async () => {
    const r = (await as('service_role', null, 'select parent_lookup($1, null, $2) as r', [S.students[0].nid, ip()]))[0].r;
    assert.equal(r.ok, true);
    assert.equal(r.student.full_name, 'תלמיד 0');
    assert.equal(r.student.teacher_name, 'הרב אלף');
    assert.equal(r.conferences.length, 1);
    const json = JSON.stringify(r);
    assert.ok(!json.includes(S.students[0].nid), 'no national id echoed');
    assert.ok(!json.includes('note'), 'no notes');
    S.token0 = r.token;

    const bad = (await as('service_role', null, 'select parent_lookup($1, null, $2) as r', ['123456789', ip()]))[0].r;
    assert.equal(bad.error, 'invalid_id');
    const unknown = (await as('service_role', null, 'select parent_lookup($1, null, $2) as r', [makeId(99999999), ip()]))[0].r;
    assert.equal(unknown.error, 'not_found');
  });

  test('parent books one slot; second booking for same conference rejected', async () => {
    const sl = (await as('service_role', null, 'select parent_slots($1, $2) as r', [S.token0, S.conf]))[0].r;
    assert.equal(sl.ok, true);
    assert.equal(sl.slots.length, 6);
    const b = (await as('service_role', null, 'select parent_book($1, $2, $3) as r', [S.token0, sl.slots[0].id, ip()]))[0].r;
    assert.equal(b.ok, true);
    assert.equal(b.confirmation.teacher_name, 'הרב אלף');
    const again = (await as('service_role', null, 'select parent_book($1, $2, $3) as r', [S.token0, sl.slots[1].id, ip()]))[0].r;
    assert.equal(again.error, 'already_booked');
    const after = (await as('service_role', null, 'select parent_slots($1, $2) as r', [S.token0, S.conf]))[0].r;
    assert.equal(after.error, 'already_booked');
    // סלוט של רב אחר
    const t2slot = (await su('select id from appointment_slots where teacher_id = $1 limit 1', [S.t2]))[0].id;
    const r1 = (await as('service_role', null, 'select parent_lookup($1, null, $2) as r', [S.students[1].nid, ip()]))[0].r;
    const wrong = (await as('service_role', null, 'select parent_book($1, $2, $3) as r', [r1.token, t2slot, ip()]))[0].r;
    assert.equal(wrong.error, 'wrong_teacher');
    // token לא תקף
    const exp = (await as('service_role', null, 'select parent_slots($1, $2) as r', ['bogus', S.conf]))[0].r;
    assert.equal(exp.error, 'session_expired');
  });

  test('race: 9 parents booking the same slot concurrently -> exactly one succeeds', async () => {
    const target = S.t1slots[3].id;
    const tokens = [];
    for (let i = 1; i < 10; i++) {
      const r = (await as('service_role', null, 'select parent_lookup($1, null, $2) as r', [S.students[i].nid, ip()]))[0].r;
      tokens.push(r.token);
    }
    const results = await Promise.all(tokens.map((t) =>
      as('service_role', null, 'select parent_book($1, $2, $3) as r', [t, target, ip()]).then((x) => x[0].r)));
    const ok = results.filter((r) => r.ok);
    assert.equal(ok.length, 1);
    assert.ok(results.filter((r) => !r.ok).every((r) => r.error === 'slot_taken'));
    const [{ n }] = await su("select count(*)::int as n from appointments where slot_id = $1 and status = 'booked'", [target]);
    assert.equal(n, 1);
  });

  test('notes: only the teacher sees them; other teacher cannot read or write', async () => {
    const [{ id: appt }] = await as('authenticated', U.t1, "select id from appointments where status = 'booked' limit 1");
    S.appt = appt;
    await as('authenticated', U.t1, "select staff_save_note($1, 'הערה פנימית רגישה')", [appt]);
    assert.equal((await as('authenticated', U.t1, 'select * from teacher_notes')).length, 1);
    assert.equal((await as('authenticated', U.t2, 'select * from teacher_notes')).length, 0);
    assert.equal((await as('authenticated', U.t2, 'select * from appointments')).length, 0);
    await assert.rejects(as('authenticated', U.t2, "select staff_save_note($1, 'x')", [appt]), /not_authorized/);
    const r = (await as('service_role', null, 'select parent_lookup($1, null, $2) as r', [S.students[0].nid, ip()]))[0].r;
    assert.ok(!JSON.stringify(r).includes('הערה'));
    const logs = await su("select metadata::text as m from audit_logs where action = 'note.save'");
    assert.ok(logs.every((l) => !l.m.includes('הערה')));
  });

  test('teacher cannot cancel/move another teacher appointment; admin can move, history kept', async () => {
    const [{ r }] = await as('authenticated', U.t2, 'select staff_cancel_appointment($1)::text as r', [S.appt]).catch((e) => [{ r: e.message }]);
    assert.match(r, /not_authorized/);
    const free = (await as('authenticated', U.admin,
      'select slot_id from staff_conference_board($1, $2) where appointment_id is null order by starts_at desc limit 1',
      [S.conf, S.t1]))[0].slot_id;
    const mv = (await as('authenticated', U.admin, 'select staff_move_appointment($1, $2) as r', [S.appt, free]))[0].r;
    assert.equal(mv.ok, true);
    const hist = await su('select status, replaced_by from appointments where id = $1', [S.appt]);
    assert.equal(hist[0].status, 'cancelled');
    assert.equal(hist[0].replaced_by, mv.appointment_id);
    // ההערה עברה לתור החדש
    assert.equal((await su('select count(*)::int n from teacher_notes where appointment_id = $1', [mv.appointment_id]))[0].n, 1);
    S.appt = mv.appointment_id;
  });

  test('duration change keeps existing bookings intact', async () => {
    const before = await su("select a.id, s.starts_at, s.ends_at from appointments a join appointment_slots s on s.id = a.slot_id where a.status = 'booked' and s.teacher_id = $1", [S.t1]);
    await as('authenticated', U.t1, 'select staff_set_duration($1, $2, 15)', [S.conf, S.t1]);
    const after = await su("select a.id, s.starts_at, s.ends_at from appointments a join appointment_slots s on s.id = a.slot_id where a.status = 'booked' and s.teacher_id = $1", [S.t1]);
    assert.deepEqual(after, before);
    const overlaps = await su(`select count(*)::int n from appointment_slots a join appointment_slots b
      on a.teacher_id = b.teacher_id and a.id < b.id and a.status <> 'retired' and b.status <> 'retired'
      and tstzrange(a.starts_at, a.ends_at) && tstzrange(b.starts_at, b.ends_at)`);
    assert.equal(overlaps[0].n, 0);
  });

  test('block window over a booking is refused; deleting window with bookings refused', async () => {
    const [{ starts_at, ends_at }] = await su("select s.starts_at, s.ends_at from appointments a join appointment_slots s on s.id = a.slot_id where a.id = $1", [S.appt]);
    await assert.rejects(as('authenticated', U.t1, "select staff_add_block($1, $2, $3, $4, 'הפסקה')",
      [S.conf, S.t1, starts_at, ends_at]), /block_overlaps_appointments/);
    const [{ id: w }] = await su('select id from availability_windows where teacher_id = $1', [S.t1]);
    await assert.rejects(as('authenticated', U.t1, 'select staff_delete_availability($1)', [w]), /window_has_appointments/);
  });

  test('changing teacher of student with active appointment is blocked', async () => {
    const [{ student_id }] = await su('select student_id from appointments where id = $1', [S.appt]);
    const st = S.students.find((x) => x.id === student_id);
    await assert.rejects(as('authenticated', U.admin, 'select admin_upsert_student($1, $2, $3, $4, $5, true)',
      [student_id, st.nid, 'שם', S.class1, S.t2]), /student_has_active_appointments/);
  });

  test('booking a past slot is refused', async () => {
    await su("insert into availability_windows (conference_id, teacher_id, start_at, end_at) values ($1, $2, now() - interval '3 hours', now() - interval '2 hours')", [S.conf, S.t2]);
    const [{ id }] = await su("insert into appointment_slots (conference_id, teacher_id, starts_at, ends_at) values ($1, $2, now() - interval '3 hours', now() - interval '170 minutes') returning id", [S.conf, S.t2]);
    const r = (await as('service_role', null, 'select parent_lookup($1, null, $2) as r', [S.students[10].nid, ip()]))[0].r;
    const b = (await as('service_role', null, 'select parent_book($1, $2, $3) as r', [r.token, id, ip()]))[0].r;
    assert.equal(b.error, 'slot_in_past');
  });

  test('personal code: enabling blocked until all have codes; then enforced', async () => {
    const fail = (await as('authenticated', U.admin, 'select admin_set_require_code(true) as r'))[0].r;
    assert.equal(fail.ok, false);
    assert.equal(fail.error, 'students_missing_code');
    // קוד ידני עם אפסים מובילים
    await as('authenticated', U.admin, "select admin_set_student_code($1, '0042')", [S.students[0].id]);
    await assert.rejects(as('authenticated', U.admin, "select admin_set_student_code($1, '42')", [S.students[0].id]), /invalid_code/);
    const bulk = await as('authenticated', U.admin, 'select * from admin_generate_codes_bulk(false)');
    assert.equal(bulk.length, 11, 'does not overwrite existing code');
    assert.ok(bulk.every((b) => /^[0-9]{4}$/.test(b.code)));
    const [{ h }] = await su('select code_hash as h from student_codes where student_id = $1', [S.students[0].id]);
    assert.ok(h.startsWith('$2'), 'bcrypt hash, not plaintext');
    assert.notEqual(h, '0042');
    const ok = (await as('authenticated', U.admin, 'select admin_set_require_code(true) as r'))[0].r;
    assert.equal(ok.ok, true);

    const noCode = (await as('service_role', null, 'select parent_lookup($1, null, $2) as r', [S.students[0].nid, ip()]))[0].r;
    assert.equal(noCode.error, 'code_required');
    const wrong = (await as('service_role', null, "select parent_lookup($1, '9999', $2) as r", [S.students[0].nid, ip()]))[0].r;
    assert.equal(wrong.error, 'not_found');
    const right = (await as('service_role', null, "select parent_lookup($1, '0042', $2) as r", [S.students[0].nid, ip()]))[0].r;
    assert.equal(right.ok, true);
    const unknown = (await as('service_role', null, "select parent_lookup($1, '1234', $2) as r", [makeId(98765432), ip()]))[0].r;
    assert.equal(unknown.error, 'not_found', 'same error for unknown id');

    // נעילה אחרי 5 כישלונות לתלמיד (גם מ-IP שונים)
    for (let i = 0; i < 5; i++) {
      await as('service_role', null, "select parent_lookup($1, '1111', $2)", [S.students[2].nid, ip()]);
    }
    const realCode = bulk.find((b) => b.student_id === S.students[2].id).code;
    const locked = (await as('service_role', null, 'select parent_lookup($1, $2, $3) as r', [S.students[2].nid, realCode, ip()]))[0].r;
    assert.equal(locked.error, 'rate_limited');
    // איפוס קוד משחרר נעילה
    const [{ c }] = await as('authenticated', U.admin, 'select admin_generate_student_code($1) as c', [S.students[2].id]);
    const unlocked = (await as('service_role', null, 'select parent_lookup($1, $2, $3) as r', [S.students[2].nid, c, ip()]))[0].r;
    assert.equal(unlocked.ok, true);

    await assert.rejects(as('authenticated', U.t1, 'select admin_generate_student_code($1)', [S.students[0].id]), /not_authorized/);
    await assert.rejects(as('authenticated', U.admin, 'select admin_clear_student_code($1)', [S.students[0].id]), /code_required_mode_on/);
    await as('authenticated', U.admin, 'select admin_set_require_code(false)');
  });

  test('rate limit by IP on parent lookups', async () => {
    const theIp = ip();
    let last;
    for (let i = 0; i < 31; i++) {
      last = (await as('service_role', null, 'select parent_lookup($1, null, $2) as r', [S.students[3].nid, theIp]))[0].r;
    }
    assert.equal(last.error, 'rate_limited');
    const [{ n }] = await su("select count(*)::int n from security_events where kind = 'parent_rate_limited'");
    assert.ok(n >= 1);
  });

  test('staff login lookup: lockout after 5 failures', async () => {
    const nid = makeId(10000002);
    const r = (await as('service_role', null, 'select staff_login_lookup($1, $2) as r', [nid, ip()]))[0].r;
    assert.equal(r.auth_user_id, U.t1);
    for (let i = 0; i < 5; i++) await as('service_role', null, 'select staff_login_report($1, $2, false)', [nid, ip()]);
    const locked = (await as('service_role', null, 'select staff_login_lookup($1, $2) as r', [nid, ip()]))[0].r;
    assert.equal(locked.error, 'rate_limited');
    await as('service_role', null, 'select staff_login_report($1, $2, true)', [nid, ip()]);
    await assert.rejects(as('authenticated', U.admin, 'select staff_login_lookup($1, $2)', [nid, 'x']), /permission denied/);
  });

  test('audit logs never contain full national ids', async () => {
    const logs = await su('select metadata::text as m from audit_logs union all select metadata::text from security_events');
    const ids = S.students.map((s) => s.nid).concat([makeId(10000001), makeId(10000002), makeId(10000003)]);
    for (const l of logs) for (const nid of ids) assert.ok(!l.m.includes(nid), 'id leaked in log');
    assert.ok((await as('authenticated', U.admin, 'select * from audit_logs')).length > 5);
    assert.equal((await as('authenticated', U.t1, 'select * from audit_logs')).length, 0);
  });

  test('dashboard and status reports', async () => {
    const [{ d }] = await as('authenticated', U.admin, 'select admin_dashboard($1) as d', [S.conf]);
    assert.equal(d.total, 12);
    assert.equal(d.booked, 2);
    const mine = await as('authenticated', U.t1, 'select * from staff_students_status($1, $2)', [S.conf, S.t2]);
    assert.ok(mine.every((r) => r.teacher_id === S.t1), 'teacher filter is forced to self');
  });

  test('archive conference; archived cannot be edited', async () => {
    await as('authenticated', U.admin, "select admin_set_conference_status($1, 'closed')", [S.conf]);
    const r = (await as('service_role', null, 'select parent_lookup($1, null, $2) as r', [S.students[5].nid, ip()]))[0].r;
    assert.equal(r.conferences.length, 0);
    await as('authenticated', U.admin, "select admin_set_conference_status($1, 'archived')", [S.conf]);
    await assert.rejects(as('authenticated', U.t1, 'select staff_add_availability($1, $2, $3, $4)',
      [S.conf, S.t1, '2026-11-02T15:00:00Z', '2026-11-02T16:00:00Z']), /conference_archived/);
    await assert.rejects(as('authenticated', U.admin, "select admin_set_conference_status($1, 'open')", [S.conf]), /invalid_status_transition/);
  });

  test('import students: validation report, duplicates, dry run', async () => {
    const rows = [
      { row: 2, national_id: '12345678', full_name: 'א', class_name: 'שיעור א׳', teacher_name: 'הרב אלף' },
      { row: 3, national_id: makeId(30000001).replace(/^0+/, ''), full_name: 'יבוא אחד', class_name: 'שיעור ב׳', teacher_name: 'הרב אלף' },
      { row: 4, national_id: makeId(30000001), full_name: 'כפול', class_name: 'שיעור ב׳', teacher_name: 'הרב אלף' },
      { row: 5, national_id: makeId(30000002), full_name: 'בלי רב', class_name: 'שיעור ב׳', teacher_name: 'לא קיים' },
      { row: 6, national_id: S.students[11].nid, full_name: 'עדכון', class_name: 'שיעור א׳', teacher_name: 'הרב בית' },
    ];
    const [{ r: dry }] = await as('authenticated', U.admin, 'select admin_import_students($1, true, true, true) as r', [JSON.stringify(rows)]);
    assert.equal(dry.inserted, 1);
    assert.equal(dry.updated, 1);
    assert.deepEqual(dry.errors.map((/** @type {any} */ e) => e.error).sort(),
      ['duplicate_in_file', 'invalid_national_id', 'teacher_not_found']);
    assert.equal((await su("select count(*)::int n from classes where name = 'שיעור ב׳'"))[0].n, 0, 'dry run writes nothing');
    const [{ r }] = await as('authenticated', U.admin, 'select admin_import_students($1, false, true, false) as r', [JSON.stringify(rows)]);
    assert.equal(r.inserted, 1);
    assert.equal(r.skipped, 1);
    assert.equal((await su('select full_name from students where national_id_normalized = $1', [makeId(30000001)]))[0].full_name, 'יבוא אחד');
  });
});
