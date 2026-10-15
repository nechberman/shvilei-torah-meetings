-- =====================================================================
-- Migration 3: Row Level Security + הרשאות מינימליות
-- עיקרון: אנונימי לא קורא אף טבלה. צוות קורא לפי בעלות. כתיבה רק דרך RPC.
-- =====================================================================
set search_path = public, extensions;

-- ---------- RLS על כל הטבלאות ----------
alter table public.staff_users enable row level security;
alter table public.classes enable row level security;
alter table public.students enable row level security;
alter table public.student_codes enable row level security;
alter table public.conferences enable row level security;
alter table public.conference_teachers enable row level security;
alter table public.availability_windows enable row level security;
alter table public.blocked_windows enable row level security;
alter table public.appointment_slots enable row level security;
alter table public.appointments enable row level security;
alter table public.teacher_notes enable row level security;
alter table public.audit_logs enable row level security;
alter table public.settings enable row level security;
alter table public.parent_sessions enable row level security;
alter table public.rate_limits enable row level security;
alter table public.security_events enable row level security;

-- ---------- ביטול כל הרשאות ברירת המחדל ----------
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke execute on all functions in schema public from public, anon, authenticated;

-- ---------- הרשאות קריאה (SELECT) לצוות מחובר, עמודות לא רגישות בלבד ----------
grant select (id, full_name, role, active, created_at) on public.staff_users to authenticated;
grant select on public.classes to authenticated;
grant select (id, full_name, class_id, teacher_id, active, created_at, updated_at) on public.students to authenticated;
grant select on public.conferences to authenticated;
grant select on public.conference_teachers to authenticated;
grant select on public.availability_windows to authenticated;
grant select on public.blocked_windows to authenticated;
grant select on public.appointment_slots to authenticated;
grant select on public.appointments to authenticated;
grant select on public.teacher_notes to authenticated;
grant select on public.audit_logs to authenticated;
grant select (school_name, address, waze_url, logo_url, contact_info, timezone, require_parent_code, updated_at)
  on public.settings to authenticated;
-- student_codes, parent_sessions, rate_limits, security_events: ללא הרשאות כלל

-- ---------- Policies ----------
create policy staff_users_select on public.staff_users for select to authenticated
  using (public.is_admin() or auth_user_id = auth.uid());

create policy classes_select on public.classes for select to authenticated
  using (public.current_staff_id() is not null);

create policy students_select on public.students for select to authenticated
  using (public.is_admin() or teacher_id = public.current_staff_id());

create policy conferences_select on public.conferences for select to authenticated
  using (
    public.is_admin()
    or exists (select 1 from public.conference_teachers ct
               where ct.conference_id = conferences.id and ct.teacher_id = public.current_staff_id())
  );

create policy conference_teachers_select on public.conference_teachers for select to authenticated
  using (public.is_admin() or teacher_id = public.current_staff_id());

create policy availability_select on public.availability_windows for select to authenticated
  using (public.is_admin() or teacher_id = public.current_staff_id());

create policy blocked_select on public.blocked_windows for select to authenticated
  using (public.is_admin() or teacher_id = public.current_staff_id());

create policy slots_select on public.appointment_slots for select to authenticated
  using (public.is_admin() or teacher_id = public.current_staff_id());

create policy appointments_select on public.appointments for select to authenticated
  using (
    public.is_admin()
    or exists (select 1 from public.appointment_slots s
               where s.id = appointments.slot_id and s.teacher_id = public.current_staff_id())
  );

-- הערות: רק הרב שכתב (מנהל רואה לצורכי פיקוח)
create policy notes_select on public.teacher_notes for select to authenticated
  using (teacher_id = public.current_staff_id() or public.is_admin());

create policy audit_select on public.audit_logs for select to authenticated
  using (public.is_admin());

create policy settings_select on public.settings for select to authenticated
  using (public.current_staff_id() is not null);

-- ---------- הרשאות הרצה לפונקציות ----------
-- ציבורי (אנונימי): הגדרות לא רגישות בלבד
grant execute on function public.public_settings() to anon, authenticated;

-- צוות מחובר (כל פונקציה בודקת תפקיד בעצמה)
grant execute on function public.current_staff_id() to authenticated;
grant execute on function public.current_staff_role() to authenticated;
grant execute on function public.is_admin() to authenticated;
grant execute on function public.staff_me() to authenticated;
grant execute on function public.staff_list_teachers() to authenticated;
grant execute on function public.staff_add_availability(uuid, uuid, timestamptz, timestamptz) to authenticated;
grant execute on function public.staff_delete_availability(uuid) to authenticated;
grant execute on function public.staff_add_block(uuid, uuid, timestamptz, timestamptz, text) to authenticated;
grant execute on function public.staff_delete_block(uuid) to authenticated;
grant execute on function public.staff_set_duration(uuid, uuid, int) to authenticated;
grant execute on function public.staff_set_slot_blocked(uuid, boolean) to authenticated;
grant execute on function public.staff_book(uuid, uuid) to authenticated;
grant execute on function public.staff_cancel_appointment(uuid) to authenticated;
grant execute on function public.staff_move_appointment(uuid, uuid) to authenticated;
grant execute on function public.staff_conference_board(uuid, uuid) to authenticated;
grant execute on function public.staff_students_status(uuid, uuid) to authenticated;
grant execute on function public.staff_save_note(uuid, text) to authenticated;
grant execute on function public.normalize_israeli_id(text) to authenticated;

grant execute on function public.admin_upsert_class(uuid, text, boolean) to authenticated;
grant execute on function public.admin_list_students() to authenticated;
grant execute on function public.admin_list_staff() to authenticated;
grant execute on function public.admin_upsert_student(uuid, text, text, uuid, uuid, boolean) to authenticated;
grant execute on function public.admin_import_students(jsonb, boolean, boolean, boolean) to authenticated;
grant execute on function public.admin_update_staff(uuid, text, public.staff_role, boolean) to authenticated;
grant execute on function public.admin_upsert_conference(uuid, text, text, date, date) to authenticated;
grant execute on function public.admin_set_conference_status(uuid, public.conference_status) to authenticated;
grant execute on function public.admin_set_conference_teacher(uuid, uuid, int) to authenticated;
grant execute on function public.admin_remove_conference_teacher(uuid, uuid) to authenticated;
grant execute on function public.admin_update_settings(text, text, text, text, text) to authenticated;
grant execute on function public.admin_set_student_code(uuid, text) to authenticated;
grant execute on function public.admin_generate_student_code(uuid) to authenticated;
grant execute on function public.admin_generate_codes_bulk(boolean) to authenticated;
grant execute on function public.admin_clear_student_code(uuid) to authenticated;
grant execute on function public.admin_set_require_code(boolean) to authenticated;
grant execute on function public.admin_dashboard(uuid) to authenticated;
grant execute on function public.admin_purge_old_notes(int) to authenticated;

-- service_role בלבד (Edge Functions)
grant execute on function public.parent_lookup(text, text, text) to service_role;
grant execute on function public.parent_slots(text, uuid) to service_role;
grant execute on function public.parent_book(text, uuid, text) to service_role;
grant execute on function public.staff_login_lookup(text, text) to service_role;
grant execute on function public.staff_login_report(text, text, boolean) to service_role;
grant execute on function public.log_audit(text, uuid, text, text, uuid, jsonb) to service_role;
grant execute on function public.cleanup_expired() to service_role;
grant execute on function public.bootstrap_rate_ok(text) to service_role;
grant execute on function public.normalize_israeli_id(text) to service_role;
grant execute on function public.public_settings() to service_role;

-- פונקציות פנימיות (regenerate_slots, book_slot_internal, set_code_internal, random_code4, rl_*)
-- לא חשופות לאף תפקיד לקוח – נקראות רק מתוך פונקציות SECURITY DEFINER.

-- מניעת הרשאות אוטומטיות לאובייקטים עתידיים
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;
