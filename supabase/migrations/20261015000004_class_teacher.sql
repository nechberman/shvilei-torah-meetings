-- =====================================================================
-- Migration 4: שיוך רב לכיתה
-- לכל כיתה אפשר להגדיר רב. אפשר להחיל את השיוך על כל תלמידי הכיתה בבת אחת,
-- ותלמיד חדש (או ביבוא בלי עמודת רב) מקבל אוטומטית את רב הכיתה.
-- תלמיד עם תור פעיל לא מועבר אוטומטית – מדווח כדי לטפל ידנית.
-- =====================================================================
set search_path = public, extensions;

alter table public.classes
  add column if not exists teacher_id uuid references public.staff_users (id) on delete set null;

grant select (teacher_id) on public.classes to authenticated;

create or replace function public.admin_set_class_teacher(
  p_class_id uuid, p_teacher_id uuid, p_apply_to_students boolean)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := public.require_admin();
  v_updated int := 0;
  v_blocked jsonb := '[]'::jsonb;
  r record;
begin
  if not exists (select 1 from public.classes where id = p_class_id) then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if p_teacher_id is not null and not exists (select 1 from public.staff_users where id = p_teacher_id and active) then
    raise exception 'teacher_inactive' using errcode = 'P0001';
  end if;

  update public.classes set teacher_id = p_teacher_id where id = p_class_id;

  if p_apply_to_students and p_teacher_id is not null then
    for r in
      select st.id, st.full_name from public.students st
      where st.class_id = p_class_id and st.active and st.teacher_id <> p_teacher_id
      order by st.full_name
    loop
      if public.student_has_active_appointments(r.id) then
        v_blocked := v_blocked || jsonb_build_object('id', r.id, 'full_name', r.full_name);
      else
        update public.students set teacher_id = p_teacher_id where id = r.id;
        v_updated := v_updated + 1;
      end if;
    end loop;
  end if;

  perform public.log_audit('admin', v_actor, 'class.set_teacher', 'class', p_class_id,
    jsonb_build_object('teacher_id', p_teacher_id, 'updated', v_updated, 'blocked', jsonb_array_length(v_blocked)));

  return jsonb_build_object('ok', true, 'updated', v_updated, 'blocked', v_blocked);
end;
$$;

-- יבוא: אם אין שם רב בשורה – משתמשים ברב של הכיתה
create or replace function public.admin_import_students(
  p_rows jsonb, p_update_existing boolean, p_create_classes boolean, p_dry_run boolean default false)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := public.require_admin();
  r jsonb;
  v_row int;
  v_nid text;
  v_name text;
  v_class_name text;
  v_teacher_name text;
  v_class uuid;
  v_class_teacher uuid;
  v_teacher uuid;
  v_teacher_count int;
  v_existing public.students%rowtype;
  v_inserted int := 0;
  v_updated int := 0;
  v_skipped int := 0;
  v_errors jsonb := '[]'::jsonb;
  v_seen text[] := '{}';
begin
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 5000 then
    raise exception 'invalid_rows' using errcode = 'P0001';
  end if;

  for r in select * from jsonb_array_elements(p_rows) loop
    v_row := coalesce((r ->> 'row')::int, 0);
    v_nid := public.normalize_israeli_id(r ->> 'national_id');
    v_name := btrim(coalesce(r ->> 'full_name', ''));
    v_class_name := btrim(coalesce(r ->> 'class_name', ''));
    v_teacher_name := btrim(coalesce(r ->> 'teacher_name', ''));
    v_class := null;
    v_class_teacher := null;
    v_teacher := null;

    if v_nid is null then
      v_errors := v_errors || jsonb_build_object('row', v_row, 'error', 'invalid_national_id');
      continue;
    end if;
    if v_nid = any(v_seen) then
      v_errors := v_errors || jsonb_build_object('row', v_row, 'error', 'duplicate_in_file');
      continue;
    end if;
    v_seen := v_seen || v_nid;
    if char_length(v_name) < 2 or char_length(v_name) > 100 then
      v_errors := v_errors || jsonb_build_object('row', v_row, 'error', 'invalid_name');
      continue;
    end if;

    select id, teacher_id into v_class, v_class_teacher from public.classes where name = v_class_name;
    if v_class is null then
      if p_create_classes and char_length(v_class_name) between 1 and 60 then
        if not p_dry_run then
          insert into public.classes (name) values (v_class_name) returning id into v_class;
        end if;
      else
        v_errors := v_errors || jsonb_build_object('row', v_row, 'error', 'class_not_found');
        continue;
      end if;
    end if;

    if v_teacher_name = '' then
      if v_class_teacher is null then
        v_errors := v_errors || jsonb_build_object('row', v_row, 'error', 'teacher_not_found');
        continue;
      end if;
      v_teacher := v_class_teacher;
    else
      select count(*), min(id::text)::uuid into v_teacher_count, v_teacher
      from public.staff_users where btrim(full_name) = v_teacher_name and active;
      if v_teacher_count = 0 then
        v_errors := v_errors || jsonb_build_object('row', v_row, 'error', 'teacher_not_found');
        continue;
      elsif v_teacher_count > 1 then
        v_errors := v_errors || jsonb_build_object('row', v_row, 'error', 'teacher_ambiguous');
        continue;
      end if;
    end if;

    select * into v_existing from public.students where national_id_normalized = v_nid;
    if found then
      if not p_update_existing then
        v_skipped := v_skipped + 1;
        continue;
      end if;
      if v_existing.teacher_id <> v_teacher and public.student_has_active_appointments(v_existing.id) then
        v_errors := v_errors || jsonb_build_object('row', v_row, 'error', 'student_has_active_appointments');
        continue;
      end if;
      if not p_dry_run then
        update public.students set full_name = v_name, class_id = coalesce(v_class, class_id),
          teacher_id = v_teacher, active = true
        where id = v_existing.id;
      end if;
      v_updated := v_updated + 1;
    else
      if not p_dry_run then
        insert into public.students (national_id_normalized, full_name, class_id, teacher_id)
        values (v_nid, v_name, v_class, v_teacher);
      end if;
      v_inserted := v_inserted + 1;
    end if;
  end loop;

  if not p_dry_run then
    perform public.log_audit('admin', v_actor, 'student.import', 'student', null,
      jsonb_build_object('inserted', v_inserted, 'updated', v_updated, 'skipped', v_skipped,
                         'errors', jsonb_array_length(v_errors)));
  end if;

  return jsonb_build_object('inserted', v_inserted, 'updated', v_updated, 'skipped', v_skipped,
                            'errors', v_errors, 'dry_run', p_dry_run);
end;
$$;

revoke execute on function public.admin_set_class_teacher(uuid, uuid, boolean) from public, anon;
grant execute on function public.admin_set_class_teacher(uuid, uuid, boolean) to authenticated;
revoke execute on function public.admin_import_students(jsonb, boolean, boolean, boolean) from public, anon;
grant execute on function public.admin_import_students(jsonb, boolean, boolean, boolean) to authenticated;

-- =====================================================================
-- רב: רשימת התלמידים שלו (כולל מספרי זהות) ועריכה שלה
-- רב רואה ועורך רק תלמידים המשויכים אליו, ומשייך רק לכיתות שהוגדרו לו.
-- =====================================================================
create or replace function public.staff_list_my_students()
returns table (id uuid, national_id text, full_name text, class_id uuid, class_name text, active boolean)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_me uuid := public.require_staff();
begin
  return query
    select st.id, st.national_id_normalized, st.full_name, c.id, c.name, st.active
    from public.students st
    join public.classes c on c.id = st.class_id
    where st.teacher_id = v_me
    order by c.name, st.full_name;
end;
$$;

create or replace function public.staff_my_classes()
returns table (id uuid, name text)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_me uuid := public.require_staff();
begin
  return query
    select c.id, c.name from public.classes c
    where c.active and (c.teacher_id = v_me
      or exists (select 1 from public.students st where st.class_id = c.id and st.teacher_id = v_me and st.active))
    order by c.name;
end;
$$;

create or replace function public.staff_upsert_my_student(
  p_id uuid, p_national_id text, p_full_name text, p_class_id uuid, p_active boolean)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_me uuid := public.require_staff();
  v_nid text := public.normalize_israeli_id(p_national_id);
  v_old public.students%rowtype;
  v_id uuid;
begin
  if v_nid is null then
    raise exception 'invalid_national_id' using errcode = 'P0001';
  end if;
  if not exists (
    select 1 from public.classes c where c.id = p_class_id and c.active and (c.teacher_id = v_me
      or exists (select 1 from public.students st where st.class_id = c.id and st.teacher_id = v_me))
  ) then
    raise exception 'class_not_allowed' using errcode = 'P0001';
  end if;

  if p_id is null then
    if exists (select 1 from public.students where national_id_normalized = v_nid) then
      raise exception 'national_id_exists' using errcode = 'P0001';
    end if;
    insert into public.students (national_id_normalized, full_name, class_id, teacher_id, active)
    values (v_nid, btrim(p_full_name), p_class_id, v_me, coalesce(p_active, true))
    returning id into v_id;
    perform public.log_audit(public.actor_type(), v_me, 'student.create', 'student', v_id, '{}'::jsonb);
  else
    select * into v_old from public.students where id = p_id for update;
    if not found or v_old.teacher_id <> v_me then
      raise exception 'not_authorized' using errcode = '42501';
    end if;
    update public.students set national_id_normalized = v_nid, full_name = btrim(p_full_name),
      class_id = p_class_id, active = coalesce(p_active, active)
    where id = p_id returning id into v_id;
    perform public.log_audit(public.actor_type(), v_me, 'student.update', 'student', v_id, '{}'::jsonb);
  end if;
  return v_id;
exception when unique_violation then
  raise exception 'national_id_exists' using errcode = 'P0001';
end;
$$;

-- =====================================================================
-- מחיקת אסיפה (מנהל): מוחקת לצמיתות את האסיפה וכל התורים, השעות וההערות שלה
-- =====================================================================
create or replace function public.admin_delete_conference(p_id uuid, p_confirm_title text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := public.require_admin();
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
  delete from public.appointments where conference_id = p_id;          -- הערות נמחקות ב-cascade
  delete from public.appointment_slots where conference_id = p_id;
  delete from public.conferences where id = p_id;                     -- חלונות, הפסקות ושיוכים ב-cascade
  perform public.log_audit('admin', v_actor, 'conference.delete', 'conference', p_id,
    jsonb_build_object('appointments_deleted', v_appts));
  return jsonb_build_object('ok', true, 'appointments_deleted', v_appts);
end;
$$;

revoke execute on function public.staff_list_my_students() from public, anon;
revoke execute on function public.staff_my_classes() from public, anon;
revoke execute on function public.staff_upsert_my_student(uuid, text, text, uuid, boolean) from public, anon;
revoke execute on function public.admin_delete_conference(uuid, text) from public, anon;
grant execute on function public.staff_list_my_students() to authenticated;
grant execute on function public.staff_my_classes() to authenticated;
grant execute on function public.staff_upsert_my_student(uuid, text, text, uuid, boolean) to authenticated;
grant execute on function public.admin_delete_conference(uuid, text) to authenticated;
