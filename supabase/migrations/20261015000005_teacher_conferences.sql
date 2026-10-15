-- =====================================================================
-- Migration 5: רב פותח אסיפה בעצמו; מחיקת תלמידים
-- רב יכול ליצור אסיפה משלו (הוא משויך אליה אוטומטית), לערוך, לפתוח, לסגור ולמחוק
-- רק אסיפות שהוא יצר. מנהל רואה ומנהל הכול.
-- מחיקת תלמיד אפשרית רק אם אין לו היסטוריית תורים; אחרת מסמנים "לא פעיל".
-- =====================================================================
set search_path = public, extensions;

-- מנהל, או הרב שיצר את האסיפה
create or replace function public.require_conference_owner(p_conference_id uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_me uuid := public.require_staff();
begin
  if public.is_admin() then
    return v_me;
  end if;
  if not exists (select 1 from public.conferences where id = p_conference_id and created_by = v_me) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  return v_me;
end;
$$;

create or replace function public.staff_upsert_conference(
  p_id uuid, p_title text, p_description text, p_starts_on date, p_ends_on date, p_minutes int default 15)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_me uuid := public.require_staff();
  v_id uuid;
  v_tz text := public.app_tz();
begin
  if p_id is null then
    if p_minutes is null or p_minutes < 5 or p_minutes > 120 then
      raise exception 'invalid_duration' using errcode = 'P0001';
    end if;
    insert into public.conferences (title, description, starts_on, ends_on, created_by)
    values (btrim(p_title), nullif(btrim(coalesce(p_description, '')), ''), p_starts_on, p_ends_on, v_me)
    returning id into v_id;
    -- היוצר משויך לאסיפה (מנהל שיוצר מכאן – גם הוא, כדי שיוכל לפתוח לעצמו שעות)
    insert into public.conference_teachers (conference_id, teacher_id, slot_duration_minutes)
    values (v_id, v_me, p_minutes);
  else
    perform public.require_conference_owner(p_id);
    if exists (select 1 from public.conferences where id = p_id and status = 'archived') then
      raise exception 'conference_archived' using errcode = 'P0001';
    end if;
    if exists (
      select 1 from public.availability_windows w
      where w.conference_id = p_id
        and ((w.start_at at time zone v_tz)::date < p_starts_on or (w.start_at at time zone v_tz)::date > p_ends_on)
    ) then
      raise exception 'windows_outside_range' using errcode = 'P0001';
    end if;
    update public.conferences set title = btrim(p_title),
      description = nullif(btrim(coalesce(p_description, '')), ''),
      starts_on = p_starts_on, ends_on = p_ends_on
    where id = p_id returning id into v_id;
  end if;
  perform public.log_audit(public.actor_type(), v_me, 'conference.upsert', 'conference', v_id, '{}'::jsonb);
  return v_id;
end;
$$;

create or replace function public.staff_set_conference_status(p_id uuid, p_status public.conference_status)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_me uuid := public.require_conference_owner(p_id);
  v_old public.conference_status;
begin
  select status into v_old from public.conferences where id = p_id for update;
  if v_old is null then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if not (
    (v_old = 'draft' and p_status in ('open', 'archived')) or
    (v_old = 'open' and p_status in ('closed', 'draft')) or
    (v_old = 'closed' and p_status in ('open', 'archived')) or
    (v_old = 'archived' and p_status = 'closed')
  ) then
    raise exception 'invalid_status_transition' using errcode = 'P0001';
  end if;
  update public.conferences set status = p_status where id = p_id;
  perform public.log_audit(public.actor_type(), v_me, 'conference.status', 'conference', p_id,
    jsonb_build_object('from', v_old, 'to', p_status));
end;
$$;

create or replace function public.staff_delete_conference(p_id uuid, p_confirm_title text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_me uuid := public.require_conference_owner(p_id);
  v_title text;
  v_appts int;
begin
  select title into v_title from public.conferences where id = p_id for update;
  if v_title is null then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if btrim(coalesce(p_confirm_title, '')) <> btrim(v_title) then
    raise exception 'confirm_title_mismatch' using errcode = 'P0001';
  end if;
  select count(*) into v_appts from public.appointments where conference_id = p_id;
  delete from public.appointments where conference_id = p_id;
  delete from public.appointment_slots where conference_id = p_id;
  delete from public.conferences where id = p_id;
  perform public.log_audit(public.actor_type(), v_me, 'conference.delete', 'conference', p_id,
    jsonb_build_object('appointments_deleted', v_appts));
  return jsonb_build_object('ok', true, 'appointments_deleted', v_appts);
end;
$$;

-- מחיקת תלמיד: רב – רק שלו; מנהל – כל תלמיד. רק אם אין היסטוריית תורים.
create or replace function public.staff_delete_student(p_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_me uuid := public.require_staff();
  v_teacher uuid;
begin
  select teacher_id into v_teacher from public.students where id = p_id for update;
  if v_teacher is null then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if not public.is_admin() and v_teacher <> v_me then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if exists (select 1 from public.appointments where student_id = p_id) then
    raise exception 'student_has_history' using errcode = 'P0001';
  end if;
  delete from public.students where id = p_id;   -- קודים וסשנים נמחקים ב-cascade
  perform public.log_audit(public.actor_type(), v_me, 'student.delete', 'student', p_id, '{}'::jsonb);
  return jsonb_build_object('ok', true);
end;
$$;

revoke execute on function public.require_conference_owner(uuid) from public, anon, authenticated;
revoke execute on function public.staff_upsert_conference(uuid, text, text, date, date, int) from public, anon;
revoke execute on function public.staff_set_conference_status(uuid, public.conference_status) from public, anon;
revoke execute on function public.staff_delete_conference(uuid, text) from public, anon;
revoke execute on function public.staff_delete_student(uuid) from public, anon;
grant execute on function public.staff_upsert_conference(uuid, text, text, date, date, int) to authenticated;
grant execute on function public.staff_set_conference_status(uuid, public.conference_status) to authenticated;
grant execute on function public.staff_delete_conference(uuid, text) to authenticated;
grant execute on function public.staff_delete_student(uuid) to authenticated;
