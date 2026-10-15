-- =====================================================================
-- Migration 2: helper functions, slot generation, atomic booking,
-- staff RPCs, parent RPCs (service-role only), personal codes, rate limits
-- כל פונקציות הכתיבה הן SECURITY DEFINER עם בדיקת הרשאה מפורשת.
-- =====================================================================
set search_path = public, extensions;

-- ---------------------------------------------------------------------
-- זהות איש הצוות המחובר
-- ---------------------------------------------------------------------
create or replace function public.current_staff_id()
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select s.id from public.staff_users s
  where s.auth_user_id = auth.uid() and s.active
$$;

create or replace function public.current_staff_role()
returns public.staff_role
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select s.role from public.staff_users s
  where s.auth_user_id = auth.uid() and s.active
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce(public.current_staff_role() = 'admin', false)
$$;

-- מחזיר את איש הצוות או זורק שגיאה
create or replace function public.require_staff()
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v uuid := public.current_staff_id();
begin
  if v is null then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  return v;
end;
$$;

create or replace function public.require_admin()
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v uuid := public.require_staff();
begin
  if not public.is_admin() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  return v;
end;
$$;

-- רב רשאי לפעול רק על עצמו; מנהל על כולם
create or replace function public.require_teacher_scope(p_teacher_id uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v uuid := public.require_staff();
begin
  if not public.is_admin() and v is distinct from p_teacher_id then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  return v;
end;
$$;

create or replace function public.actor_type()
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select case when public.is_admin() then 'admin' else 'teacher' end
$$;

create or replace function public.app_tz()
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((select timezone from public.settings where id), 'Asia/Jerusalem')
$$;

create or replace function public.log_audit(
  p_actor_type text, p_actor_id uuid, p_action text,
  p_entity_type text, p_entity_id uuid, p_metadata jsonb default '{}'::jsonb)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into public.audit_logs (actor_type, actor_id, action, entity_type, entity_id, metadata)
  values (p_actor_type, p_actor_id, p_action, p_entity_type, p_entity_id, coalesce(p_metadata, '{}'::jsonb));
$$;

-- מסכה למספר זהות ללוגים: רק 2 ספרות אחרונות
create or replace function public.mask_id(p text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
  select case when p is null then null else '*******' || right(p, 2) end
$$;

-- ---------------------------------------------------------------------
-- Rate limiting
-- ---------------------------------------------------------------------
-- מגדיל מונה ומחזיר true אם עדיין מתחת לסף
create or replace function public.rl_hit(p_key text, p_limit int, p_window interval)
returns boolean
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v int;
begin
  insert into public.rate_limits as r (key, window_start, count)
  values (p_key, now(), 1)
  on conflict (key) do update set
    count = case when r.window_start < now() - p_window then 1 else r.count + 1 end,
    window_start = case when r.window_start < now() - p_window then now() else r.window_start end
  returning count into v;
  return v <= p_limit;
end;
$$;

-- קורא מונה בלי להגדיל
create or replace function public.rl_peek(p_key text, p_window interval)
returns int
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select coalesce((
    select r.count from public.rate_limits r
    where r.key = p_key and r.window_start >= now() - p_window
  ), 0)
$$;

create or replace function public.log_security_event(
  p_kind text, p_ip_hash text, p_student_id uuid, p_metadata jsonb default '{}'::jsonb)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  insert into public.security_events (kind, ip_hash, student_id, metadata)
  values (p_kind, p_ip_hash, p_student_id, coalesce(p_metadata, '{}'::jsonb));
$$;

create or replace function public.cleanup_expired()
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
  delete from public.parent_sessions where expires_at < now();
  delete from public.rate_limits where window_start < now() - interval '1 day';
  delete from public.security_events where created_at < now() - interval '180 days';
$$;

-- הקמת מנהל ראשון: עד 5 ניסיונות לשעה לכל IP
create or replace function public.bootstrap_rate_ok(p_ip_hash text)
returns boolean
language sql
security definer
set search_path = public, pg_temp
as $$
  select public.rl_hit('bootstrap:ip:' || coalesce(nullif(p_ip_hash, ''), 'unknown'), 5, interval '1 hour')
$$;

-- ---------------------------------------------------------------------
-- יצירת סלוטים מחלונות זמינות (אידמפוטנטי, לא פוגע בתורים קיימים)
-- ---------------------------------------------------------------------
create or replace function public.regenerate_slots(p_conference_id uuid, p_teacher_id uuid)
returns int
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_dur interval;
  w record;
  t timestamptz;
  e timestamptz;
  v_block_end timestamptz;
  v_status public.slot_status;
  v_count int := 0;
  v_id uuid;
begin
  select make_interval(mins => ct.slot_duration_minutes) into v_dur
  from public.conference_teachers ct
  where ct.conference_id = p_conference_id and ct.teacher_id = p_teacher_id;
  if v_dur is null then
    raise exception 'teacher_not_in_conference' using errcode = 'P0001';
  end if;

  -- נעילה לוגית למניעת יצירה מקבילה לאותו רב
  perform pg_advisory_xact_lock(hashtext('slots:' || p_teacher_id::text));

  -- 1. מחיקת סלוטים ללא היסטוריית תורים
  delete from public.appointment_slots s
  where s.conference_id = p_conference_id and s.teacher_id = p_teacher_id
    and not exists (select 1 from public.appointments a where a.slot_id = s.id);

  -- 2. סלוטים עם היסטוריה בלבד (ללא תור פעיל) – הוצאה זמנית משימוש
  update public.appointment_slots s set status = 'retired'
  where s.conference_id = p_conference_id and s.teacher_id = p_teacher_id
    and s.status <> 'retired'
    and not exists (select 1 from public.appointments a where a.slot_id = s.id and a.status = 'booked');

  -- 3. יצירת רשת סלוטים לכל חלון
  for w in
    select aw.start_at, aw.end_at from public.availability_windows aw
    where aw.conference_id = p_conference_id and aw.teacher_id = p_teacher_id
    order by aw.start_at
  loop
    t := w.start_at;
    while t + v_dur <= w.end_at loop
      e := t + v_dur;

      -- סלוט פעיל (עם תור) שחופף – מדלגים לסופו
      select max(s.ends_at) into v_block_end
      from public.appointment_slots s
      where s.teacher_id = p_teacher_id and s.status <> 'retired'
        and tstzrange(s.starts_at, s.ends_at, '[)') && tstzrange(t, e, '[)');
      if v_block_end is not null then
        t := greatest(v_block_end, t + interval '1 minute');
        continue;
      end if;

      v_status := case when exists (
        select 1 from public.blocked_windows b
        where b.conference_id = p_conference_id and b.teacher_id = p_teacher_id
          and tstzrange(b.start_at, b.end_at, '[)') && tstzrange(t, e, '[)')
      ) then 'blocked'::public.slot_status else 'available'::public.slot_status end;

      -- שימוש חוזר בסלוט ישן זהה (שומר היסטוריה)
      update public.appointment_slots s set status = v_status
      where s.id = (
        select s2.id from public.appointment_slots s2
        where s2.conference_id = p_conference_id and s2.teacher_id = p_teacher_id
          and s2.status = 'retired' and s2.starts_at = t and s2.ends_at = e
        limit 1
      )
      returning s.id into v_id;

      if v_id is null then
        insert into public.appointment_slots (conference_id, teacher_id, starts_at, ends_at, status)
        values (p_conference_id, p_teacher_id, t, e, v_status);
      end if;
      v_id := null;
      v_count := v_count + 1;
      t := e;
    end loop;
  end loop;

  return v_count;
end;
$$;

-- ---------------------------------------------------------------------
-- הזמנה אטומית – הלב של המערכת
-- ---------------------------------------------------------------------
create or replace function public.book_slot_internal(
  p_student_id uuid, p_slot_id uuid, p_actor_type text, p_actor_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_slot public.appointment_slots%rowtype;
  v_conf_status public.conference_status;
  v_student public.students%rowtype;
  v_id uuid;
begin
  -- נעילת שורת הסלוט: מבקשה מקבילה תמתין ואז תראה שהסלוט נתפס
  select * into v_slot from public.appointment_slots where id = p_slot_id for update;
  if not found or v_slot.status = 'retired' then
    return jsonb_build_object('ok', false, 'error', 'slot_not_found');
  end if;
  if v_slot.status <> 'available' then
    return jsonb_build_object('ok', false, 'error', 'slot_unavailable');
  end if;
  if v_slot.starts_at <= now() then
    return jsonb_build_object('ok', false, 'error', 'slot_in_past');
  end if;

  select status into v_conf_status from public.conferences where id = v_slot.conference_id;
  if v_conf_status is distinct from 'open' then
    return jsonb_build_object('ok', false, 'error', 'conference_not_open');
  end if;

  select * into v_student from public.students where id = p_student_id;
  if not found or not v_student.active then
    return jsonb_build_object('ok', false, 'error', 'student_not_found');
  end if;
  if v_student.teacher_id <> v_slot.teacher_id then
    return jsonb_build_object('ok', false, 'error', 'wrong_teacher');
  end if;

  if exists (select 1 from public.appointments where slot_id = p_slot_id and status = 'booked') then
    return jsonb_build_object('ok', false, 'error', 'slot_taken');
  end if;
  if exists (select 1 from public.appointments
             where student_id = p_student_id and conference_id = v_slot.conference_id and status = 'booked') then
    return jsonb_build_object('ok', false, 'error', 'already_booked');
  end if;

  begin
    insert into public.appointments (conference_id, student_id, slot_id, status, booked_by_type, changed_by)
    values (v_slot.conference_id, p_student_id, p_slot_id, 'booked', p_actor_type, p_actor_id)
    returning id into v_id;
  exception when unique_violation then
    if exists (select 1 from public.appointments where slot_id = p_slot_id and status = 'booked') then
      return jsonb_build_object('ok', false, 'error', 'slot_taken');
    end if;
    return jsonb_build_object('ok', false, 'error', 'already_booked');
  end;

  perform public.log_audit(p_actor_type, p_actor_id, 'appointment.book', 'appointment', v_id,
    jsonb_build_object('slot_id', p_slot_id, 'conference_id', v_slot.conference_id));

  return jsonb_build_object('ok', true, 'appointment_id', v_id);
end;
$$;

-- ---------------------------------------------------------------------
-- הגדרות ציבוריות (לא רגישות) – נגיש גם לאנונימי
-- ---------------------------------------------------------------------
create or replace function public.public_settings()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'school_name', s.school_name,
    'address', s.address,
    'waze_url', s.waze_url,
    'logo_url', s.logo_url,
    'contact_info', s.contact_info,
    'timezone', s.timezone,
    'require_parent_code', s.require_parent_code
  ) from public.settings s where s.id
$$;

-- =====================================================================
-- RPC להורים – נקראות רק מ-Edge Function עם service role
-- =====================================================================
create or replace function public.parent_session_student(p_token text)
returns uuid
language sql
stable
security definer
set search_path = public, extensions, pg_temp
as $$
  select ps.student_id from public.parent_sessions ps
  join public.students st on st.id = ps.student_id and st.active
  where ps.token_hash = encode(digest(coalesce(p_token, ''), 'sha256'), 'hex')
    and ps.expires_at > now()
$$;

create or replace function public.parent_student_payload(p_student_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object(
    'student', jsonb_build_object(
      'full_name', st.full_name,
      'class_name', c.name,
      'teacher_name', t.full_name
    ),
    'conferences', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', cf.id,
        'title', cf.title,
        'description', cf.description,
        'starts_on', cf.starts_on,
        'ends_on', cf.ends_on,
        'appointment', (
          select jsonb_build_object('starts_at', sl.starts_at, 'ends_at', sl.ends_at)
          from public.appointments a
          join public.appointment_slots sl on sl.id = a.slot_id
          where a.student_id = st.id and a.conference_id = cf.id and a.status = 'booked'
        )
      ) order by cf.starts_on)
      from public.conferences cf
      join public.conference_teachers ct on ct.conference_id = cf.id and ct.teacher_id = st.teacher_id
      where cf.status = 'open'
    ), '[]'::jsonb),
    'settings', public.public_settings()
  )
  from public.students st
  join public.classes c on c.id = st.class_id
  join public.staff_users t on t.id = st.teacher_id
  where st.id = p_student_id
$$;

-- זיהוי הורה. מחזיר token לסשן קצר (30 דקות) או שגיאה כללית.
create or replace function public.parent_lookup(p_national_id text, p_code text, p_ip_hash text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  v_nid text;
  v_student_id uuid;
  v_require boolean;
  v_hash text;
  v_token text;
  v_ip text := coalesce(nullif(p_ip_hash, ''), 'unknown');
begin
  if random() < 0.05 then
    perform public.cleanup_expired();
  end if;

  -- הגבלת קצב כללית לפי IP
  if not public.rl_hit('plookup:ip:' || v_ip, 30, interval '10 minutes') then
    perform public.log_security_event('parent_rate_limited', v_ip, null, '{}'::jsonb);
    return jsonb_build_object('ok', false, 'error', 'rate_limited');
  end if;
  -- חסימה זמנית אחרי ריבוי כישלונות מאותו IP
  if public.rl_peek('pfail:ip:' || v_ip, interval '15 minutes') >= 10 then
    return jsonb_build_object('ok', false, 'error', 'rate_limited');
  end if;

  v_nid := public.normalize_israeli_id(p_national_id);
  if v_nid is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_id');
  end if;

  select require_parent_code into v_require from public.settings where id;

  select st.id into v_student_id from public.students st
  where st.national_id_normalized = v_nid and st.active;

  if v_require then
    if p_code is null or p_code !~ '^[0-9]{4}$' then
      return jsonb_build_object('ok', false, 'error', 'code_required');
    end if;
    if v_student_id is not null
       and public.rl_peek('pfail:st:' || v_student_id::text, interval '15 minutes') >= 5 then
      perform public.log_security_event('parent_student_locked', v_ip, v_student_id, '{}'::jsonb);
      return jsonb_build_object('ok', false, 'error', 'rate_limited');
    end if;
    select sc.code_hash into v_hash from public.student_codes sc where sc.student_id = v_student_id;
    if v_hash is null then
      -- עבודה דמה לאיזון זמני תגובה (מקשה על enumeration)
      perform crypt(p_code, gen_salt('bf', 8));
      v_student_id := null;
    elsif crypt(p_code, v_hash) <> v_hash then
      perform public.rl_hit('pfail:st:' || v_student_id::text, 1000, interval '15 minutes');
      v_student_id := null;
    end if;
  end if;

  if v_student_id is null then
    perform public.rl_hit('pfail:ip:' || v_ip, 1000, interval '15 minutes');
    perform public.log_security_event('parent_lookup_failed', v_ip, null,
      jsonb_build_object('code_mode', v_require));
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;

  v_token := encode(gen_random_bytes(32), 'hex');
  insert into public.parent_sessions (token_hash, student_id, expires_at)
  values (encode(digest(v_token, 'sha256'), 'hex'), v_student_id, now() + interval '30 minutes');

  return jsonb_build_object('ok', true, 'token', v_token) || public.parent_student_payload(v_student_id);
end;
$$;

-- סלוטים פנויים לאסיפה עבור התלמיד שבסשן
create or replace function public.parent_slots(p_token text, p_conference_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_student_id uuid := public.parent_session_student(p_token);
  v_teacher uuid;
begin
  if v_student_id is null then
    return jsonb_build_object('ok', false, 'error', 'session_expired');
  end if;
  select teacher_id into v_teacher from public.students where id = v_student_id;

  if not exists (
    select 1 from public.conferences cf
    join public.conference_teachers ct on ct.conference_id = cf.id and ct.teacher_id = v_teacher
    where cf.id = p_conference_id and cf.status = 'open'
  ) then
    return jsonb_build_object('ok', false, 'error', 'conference_not_open');
  end if;

  if exists (select 1 from public.appointments a
             where a.student_id = v_student_id and a.conference_id = p_conference_id and a.status = 'booked') then
    return jsonb_build_object('ok', false, 'error', 'already_booked');
  end if;

  return jsonb_build_object('ok', true, 'slots', coalesce((
    select jsonb_agg(jsonb_build_object('id', s.id, 'starts_at', s.starts_at, 'ends_at', s.ends_at)
                     order by s.starts_at)
    from public.appointment_slots s
    where s.conference_id = p_conference_id and s.teacher_id = v_teacher
      and s.status = 'available' and s.starts_at > now()
      and not exists (select 1 from public.appointments a where a.slot_id = s.id and a.status = 'booked')
  ), '[]'::jsonb));
end;
$$;

create or replace function public.parent_book(p_token text, p_slot_id uuid, p_ip_hash text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_student_id uuid := public.parent_session_student(p_token);
  v_res jsonb;
  v_ip text := coalesce(nullif(p_ip_hash, ''), 'unknown');
begin
  if not public.rl_hit('pbook:ip:' || v_ip, 20, interval '10 minutes') then
    perform public.log_security_event('parent_book_rate_limited', v_ip, v_student_id, '{}'::jsonb);
    return jsonb_build_object('ok', false, 'error', 'rate_limited');
  end if;
  if v_student_id is null then
    return jsonb_build_object('ok', false, 'error', 'session_expired');
  end if;

  v_res := public.book_slot_internal(v_student_id, p_slot_id, 'parent', null);
  if not (v_res ->> 'ok')::boolean then
    return v_res;
  end if;

  return jsonb_build_object(
    'ok', true,
    'confirmation', (
      select jsonb_build_object(
        'student_name', st.full_name,
        'class_name', c.name,
        'teacher_name', t.full_name,
        'conference_title', cf.title,
        'starts_at', sl.starts_at,
        'ends_at', sl.ends_at
      )
      from public.appointments a
      join public.appointment_slots sl on sl.id = a.slot_id
      join public.conferences cf on cf.id = a.conference_id
      join public.students st on st.id = a.student_id
      join public.classes c on c.id = st.class_id
      join public.staff_users t on t.id = sl.teacher_id
      where a.id = (v_res ->> 'appointment_id')::uuid
    ),
    'settings', public.public_settings()
  );
end;
$$;

-- =====================================================================
-- כניסת צוות (נקרא מ-Edge Function עם service role)
-- =====================================================================
create or replace function public.staff_login_lookup(p_national_id text, p_ip_hash text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_nid text := public.normalize_israeli_id(p_national_id);
  v_ip text := coalesce(nullif(p_ip_hash, ''), 'unknown');
  v_auth uuid;
begin
  if not public.rl_hit('slogin:ip:' || v_ip, 20, interval '15 minutes') then
    perform public.log_security_event('staff_login_rate_limited', v_ip, null, '{}'::jsonb);
    return jsonb_build_object('ok', false, 'error', 'rate_limited');
  end if;
  if v_nid is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_credentials');
  end if;
  if public.rl_peek('sfail:id:' || v_nid, interval '15 minutes') >= 5 then
    perform public.log_security_event('staff_account_locked', v_ip, null,
      jsonb_build_object('id', public.mask_id(v_nid)));
    return jsonb_build_object('ok', false, 'error', 'rate_limited');
  end if;
  select s.auth_user_id into v_auth from public.staff_users s
  where s.national_id_normalized = v_nid and s.active and s.auth_user_id is not null;
  return jsonb_build_object('ok', true, 'auth_user_id', v_auth);
end;
$$;

create or replace function public.staff_login_report(p_national_id text, p_ip_hash text, p_success boolean)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_nid text := public.normalize_israeli_id(p_national_id);
begin
  if p_success then
    delete from public.rate_limits where key = 'sfail:id:' || v_nid;
  else
    perform public.rl_hit('sfail:id:' || coalesce(v_nid, 'invalid'), 1000, interval '15 minutes');
    perform public.log_security_event('staff_login_failed', p_ip_hash, null,
      jsonb_build_object('id', public.mask_id(v_nid)));
  end if;
end;
$$;

-- =====================================================================
-- RPC לאנשי צוות (authenticated)
-- =====================================================================

-- מי אני
create or replace function public.staff_me()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select jsonb_build_object('id', s.id, 'full_name', s.full_name, 'role', s.role)
  from public.staff_users s where s.auth_user_id = auth.uid() and s.active
$$;

-- רשימת רבנים (שמות בלבד) – לשימוש בטפסים
create or replace function public.staff_list_teachers()
returns table (id uuid, full_name text, role public.staff_role, active boolean)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.require_staff();
  if public.is_admin() then
    return query select s.id, s.full_name, s.role, s.active from public.staff_users s order by s.full_name;
  else
    return query select s.id, s.full_name, s.role, s.active from public.staff_users s
      where s.id = public.current_staff_id();
  end if;
end;
$$;

-- ---------- זמינות ----------
create or replace function public.check_window_in_conference(
  p_conference_id uuid, p_start timestamptz, p_end timestamptz)
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_conf public.conferences%rowtype;
  v_tz text := public.app_tz();
  v_d1 date;
  v_d2 date;
begin
  select * into v_conf from public.conferences where id = p_conference_id;
  if not found then
    raise exception 'conference_not_found' using errcode = 'P0001';
  end if;
  if v_conf.status = 'archived' then
    raise exception 'conference_archived' using errcode = 'P0001';
  end if;
  if p_end <= p_start then
    raise exception 'invalid_range' using errcode = 'P0001';
  end if;
  v_d1 := (p_start at time zone v_tz)::date;
  v_d2 := ((p_end - interval '1 microsecond') at time zone v_tz)::date;
  if v_d1 <> v_d2 then
    raise exception 'window_must_be_single_day' using errcode = 'P0001';
  end if;
  if v_d1 < v_conf.starts_on or v_d1 > v_conf.ends_on then
    raise exception 'window_outside_conference_dates' using errcode = 'P0001';
  end if;
end;
$$;

create or replace function public.staff_add_availability(
  p_conference_id uuid, p_teacher_id uuid, p_start timestamptz, p_end timestamptz)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := public.require_teacher_scope(p_teacher_id);
  v_id uuid;
begin
  if not exists (select 1 from public.conference_teachers
                 where conference_id = p_conference_id and teacher_id = p_teacher_id) then
    raise exception 'teacher_not_in_conference' using errcode = 'P0001';
  end if;
  perform public.check_window_in_conference(p_conference_id, p_start, p_end);
  begin
    insert into public.availability_windows (conference_id, teacher_id, start_at, end_at, created_by)
    values (p_conference_id, p_teacher_id, p_start, p_end, v_actor)
    returning id into v_id;
  exception when exclusion_violation then
    raise exception 'availability_overlap' using errcode = 'P0001';
  end;
  perform public.regenerate_slots(p_conference_id, p_teacher_id);
  perform public.log_audit(public.actor_type(), v_actor, 'availability.add', 'availability_window', v_id,
    jsonb_build_object('start_at', p_start, 'end_at', p_end));
  return v_id;
end;
$$;

create or replace function public.staff_delete_availability(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  w public.availability_windows%rowtype;
  v_actor uuid;
begin
  select * into w from public.availability_windows where id = p_id;
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  v_actor := public.require_teacher_scope(w.teacher_id);
  if exists (
    select 1 from public.appointments a
    join public.appointment_slots s on s.id = a.slot_id
    where a.status = 'booked' and s.teacher_id = w.teacher_id and s.conference_id = w.conference_id
      and tstzrange(s.starts_at, s.ends_at, '[)') && tstzrange(w.start_at, w.end_at, '[)')
  ) then
    raise exception 'window_has_appointments' using errcode = 'P0001';
  end if;
  delete from public.availability_windows where id = p_id;
  perform public.regenerate_slots(w.conference_id, w.teacher_id);
  perform public.log_audit(public.actor_type(), v_actor, 'availability.delete', 'availability_window', p_id, '{}'::jsonb);
end;
$$;

create or replace function public.staff_add_block(
  p_conference_id uuid, p_teacher_id uuid, p_start timestamptz, p_end timestamptz, p_reason text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := public.require_teacher_scope(p_teacher_id);
  v_id uuid;
begin
  if not exists (select 1 from public.conference_teachers
                 where conference_id = p_conference_id and teacher_id = p_teacher_id) then
    raise exception 'teacher_not_in_conference' using errcode = 'P0001';
  end if;
  perform public.check_window_in_conference(p_conference_id, p_start, p_end);
  if exists (
    select 1 from public.appointments a
    join public.appointment_slots s on s.id = a.slot_id
    where a.status = 'booked' and s.teacher_id = p_teacher_id
      and tstzrange(s.starts_at, s.ends_at, '[)') && tstzrange(p_start, p_end, '[)')
  ) then
    raise exception 'block_overlaps_appointments' using errcode = 'P0001';
  end if;
  insert into public.blocked_windows (conference_id, teacher_id, start_at, end_at, reason, created_by)
  values (p_conference_id, p_teacher_id, p_start, p_end, nullif(btrim(coalesce(p_reason, '')), ''), v_actor)
  returning id into v_id;
  perform public.regenerate_slots(p_conference_id, p_teacher_id);
  perform public.log_audit(public.actor_type(), v_actor, 'block.add', 'blocked_window', v_id, '{}'::jsonb);
  return v_id;
end;
$$;

create or replace function public.staff_delete_block(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  b public.blocked_windows%rowtype;
  v_actor uuid;
begin
  select * into b from public.blocked_windows where id = p_id;
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  v_actor := public.require_teacher_scope(b.teacher_id);
  delete from public.blocked_windows where id = p_id;
  perform public.regenerate_slots(b.conference_id, b.teacher_id);
  perform public.log_audit(public.actor_type(), v_actor, 'block.delete', 'blocked_window', p_id, '{}'::jsonb);
end;
$$;

-- שינוי משך פגישה: תורים קיימים נשמרים, סלוטים פנויים מחושבים מחדש
create or replace function public.staff_set_duration(p_conference_id uuid, p_teacher_id uuid, p_minutes int)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := public.require_teacher_scope(p_teacher_id);
  v_n int;
begin
  if p_minutes is null or p_minutes < 5 or p_minutes > 120 then
    raise exception 'invalid_duration' using errcode = 'P0001';
  end if;
  update public.conference_teachers set slot_duration_minutes = p_minutes
  where conference_id = p_conference_id and teacher_id = p_teacher_id;
  if not found then
    raise exception 'teacher_not_in_conference' using errcode = 'P0001';
  end if;
  v_n := public.regenerate_slots(p_conference_id, p_teacher_id);
  perform public.log_audit(public.actor_type(), v_actor, 'conference_teacher.duration', 'conference', p_conference_id,
    jsonb_build_object('teacher_id', p_teacher_id, 'minutes', p_minutes));
  return v_n;
end;
$$;

create or replace function public.staff_set_slot_blocked(p_slot_id uuid, p_blocked boolean)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  s public.appointment_slots%rowtype;
  v_actor uuid;
begin
  select * into s from public.appointment_slots where id = p_slot_id for update;
  if not found or s.status = 'retired' then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  v_actor := public.require_teacher_scope(s.teacher_id);
  if exists (select 1 from public.appointments where slot_id = p_slot_id and status = 'booked') then
    raise exception 'slot_has_appointment' using errcode = 'P0001';
  end if;
  update public.appointment_slots
  set status = case when p_blocked then 'blocked'::public.slot_status else 'available'::public.slot_status end
  where id = p_slot_id;
  perform public.log_audit(public.actor_type(), v_actor, case when p_blocked then 'slot.block' else 'slot.unblock' end,
    'appointment_slot', p_slot_id, '{}'::jsonb);
end;
$$;

-- ---------- תורים (צוות) ----------
create or replace function public.staff_book(p_student_id uuid, p_slot_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := public.require_staff();
  v_teacher uuid;
begin
  select teacher_id into v_teacher from public.appointment_slots where id = p_slot_id;
  if v_teacher is null then
    return jsonb_build_object('ok', false, 'error', 'slot_not_found');
  end if;
  perform public.require_teacher_scope(v_teacher);
  return public.book_slot_internal(p_student_id, p_slot_id, public.actor_type(), v_actor);
end;
$$;

create or replace function public.staff_cancel_appointment(p_appointment_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := public.require_staff();
  a public.appointments%rowtype;
  v_teacher uuid;
begin
  select * into a from public.appointments where id = p_appointment_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  select teacher_id into v_teacher from public.appointment_slots where id = a.slot_id;
  perform public.require_teacher_scope(v_teacher);
  if a.status <> 'booked' then
    return jsonb_build_object('ok', false, 'error', 'already_cancelled');
  end if;
  update public.appointments set status = 'cancelled', cancelled_at = now(), changed_by = v_actor
  where id = p_appointment_id;
  perform public.log_audit(public.actor_type(), v_actor, 'appointment.cancel', 'appointment', p_appointment_id, '{}'::jsonb);
  return jsonb_build_object('ok', true);
end;
$$;

-- העברת תור לסלוט אחר באותה אסיפה – אטומי; התור הישן נשמר כמבוטל להיסטוריה
create or replace function public.staff_move_appointment(p_appointment_id uuid, p_new_slot_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := public.require_staff();
  a public.appointments%rowtype;
  v_old public.appointment_slots%rowtype;
  v_new public.appointment_slots%rowtype;
  v_new_id uuid;
begin
  select * into a from public.appointments where id = p_appointment_id for update;
  if not found or a.status <> 'booked' then
    return jsonb_build_object('ok', false, 'error', 'not_found');
  end if;
  select * into v_old from public.appointment_slots where id = a.slot_id;
  perform public.require_teacher_scope(v_old.teacher_id);

  select * into v_new from public.appointment_slots where id = p_new_slot_id for update;
  if not found or v_new.status <> 'available' then
    return jsonb_build_object('ok', false, 'error', 'slot_unavailable');
  end if;
  if v_new.conference_id <> a.conference_id then
    return jsonb_build_object('ok', false, 'error', 'slot_conference_mismatch');
  end if;
  if v_new.teacher_id <> (select teacher_id from public.students where id = a.student_id) then
    return jsonb_build_object('ok', false, 'error', 'wrong_teacher');
  end if;
  perform public.require_teacher_scope(v_new.teacher_id);
  if v_new.starts_at <= now() then
    return jsonb_build_object('ok', false, 'error', 'slot_in_past');
  end if;
  if exists (select 1 from public.appointments where slot_id = p_new_slot_id and status = 'booked') then
    return jsonb_build_object('ok', false, 'error', 'slot_taken');
  end if;

  update public.appointments set status = 'cancelled', cancelled_at = now(), changed_by = v_actor
  where id = a.id;
  begin
    insert into public.appointments (conference_id, student_id, slot_id, status, booked_by_type, changed_by)
    values (a.conference_id, a.student_id, p_new_slot_id, 'booked', public.actor_type(), v_actor)
    returning id into v_new_id;
  exception when unique_violation then
    raise exception 'slot_taken' using errcode = 'P0001';
  end;
  update public.appointments set replaced_by = v_new_id where id = a.id;
  -- הערות עוברות לתור החדש
  update public.teacher_notes set appointment_id = v_new_id where appointment_id = a.id;
  perform public.log_audit(public.actor_type(), v_actor, 'appointment.move', 'appointment', v_new_id,
    jsonb_build_object('from_appointment', a.id, 'from_slot', a.slot_id, 'to_slot', p_new_slot_id));
  return jsonb_build_object('ok', true, 'appointment_id', v_new_id);
end;
$$;

-- לוח תורים: סלוטים + תורים, לרב (שלו בלבד) או למנהל
create or replace function public.staff_conference_board(p_conference_id uuid, p_teacher_id uuid default null)
returns table (
  slot_id uuid, teacher_id uuid, teacher_name text, starts_at timestamptz, ends_at timestamptz,
  slot_status public.slot_status, appointment_id uuid, student_id uuid, student_name text,
  class_name text, booked_by_type text, booked_at timestamptz)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_me uuid := public.require_staff();
  v_filter uuid := p_teacher_id;
begin
  if not public.is_admin() then
    v_filter := v_me;
  end if;
  return query
    select s.id, s.teacher_id, t.full_name, s.starts_at, s.ends_at, s.status,
           a.id, st.id, st.full_name, c.name, a.booked_by_type, a.booked_at
    from public.appointment_slots s
    join public.staff_users t on t.id = s.teacher_id
    left join public.appointments a on a.slot_id = s.id and a.status = 'booked'
    left join public.students st on st.id = a.student_id
    left join public.classes c on c.id = st.class_id
    where s.conference_id = p_conference_id
      and s.status <> 'retired'
      and (v_filter is null or s.teacher_id = v_filter)
    order by t.full_name, s.starts_at;
end;
$$;

-- סטטוס הרשמה לתלמידים
create or replace function public.staff_students_status(p_conference_id uuid, p_teacher_id uuid default null)
returns table (
  student_id uuid, full_name text, class_id uuid, class_name text, teacher_id uuid, teacher_name text,
  appointment_id uuid, starts_at timestamptz, ends_at timestamptz)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_me uuid := public.require_staff();
  v_filter uuid := p_teacher_id;
begin
  if not public.is_admin() then
    v_filter := v_me;
  end if;
  return query
    select st.id, st.full_name, c.id, c.name, t.id, t.full_name, a.id, sl.starts_at, sl.ends_at
    from public.students st
    join public.classes c on c.id = st.class_id
    join public.staff_users t on t.id = st.teacher_id
    join public.conference_teachers ct on ct.conference_id = p_conference_id and ct.teacher_id = st.teacher_id
    left join public.appointments a on a.student_id = st.id and a.conference_id = p_conference_id and a.status = 'booked'
    left join public.appointment_slots sl on sl.id = a.slot_id
    where st.active and (v_filter is null or st.teacher_id = v_filter)
    order by c.name, st.full_name;
end;
$$;

-- הערות פנימיות – רק הרב של התור, לעולם לא להורה
create or replace function public.staff_save_note(p_appointment_id uuid, p_text text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_me uuid := public.require_staff();
  v_teacher uuid;
begin
  select s.teacher_id into v_teacher from public.appointments a
  join public.appointment_slots s on s.id = a.slot_id where a.id = p_appointment_id;
  if v_teacher is null or v_teacher <> v_me then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_text is null or btrim(p_text) = '' then
    delete from public.teacher_notes where appointment_id = p_appointment_id and teacher_id = v_me;
  else
    if char_length(p_text) > 2000 then
      raise exception 'note_too_long' using errcode = 'P0001';
    end if;
    insert into public.teacher_notes (appointment_id, teacher_id, note_text)
    values (p_appointment_id, v_me, p_text)
    on conflict (appointment_id, teacher_id) do update set note_text = excluded.note_text;
  end if;
  -- ללא תוכן ההערה בלוג
  perform public.log_audit('teacher', v_me, 'note.save', 'appointment', p_appointment_id, '{}'::jsonb);
end;
$$;

-- =====================================================================
-- RPC למנהל
-- =====================================================================
create or replace function public.admin_upsert_class(p_id uuid, p_name text, p_active boolean)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := public.require_admin();
  v_id uuid;
begin
  if p_id is null then
    insert into public.classes (name, active) values (btrim(p_name), coalesce(p_active, true)) returning id into v_id;
  else
    update public.classes set name = btrim(p_name), active = coalesce(p_active, active) where id = p_id returning id into v_id;
    if v_id is null then
      raise exception 'not_found' using errcode = 'P0001';
    end if;
  end if;
  perform public.log_audit('admin', v_actor, 'class.upsert', 'class', v_id, '{}'::jsonb);
  return v_id;
exception when unique_violation then
  raise exception 'class_name_exists' using errcode = 'P0001';
end;
$$;

create or replace function public.admin_list_students()
returns table (id uuid, national_id text, full_name text, class_id uuid, class_name text,
               teacher_id uuid, teacher_name text, active boolean, has_code boolean)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.require_admin();
  return query
    select st.id, st.national_id_normalized, st.full_name, c.id, c.name, t.id, t.full_name, st.active,
           exists (select 1 from public.student_codes sc where sc.student_id = st.id)
    from public.students st
    join public.classes c on c.id = st.class_id
    join public.staff_users t on t.id = st.teacher_id
    order by c.name, st.full_name;
end;
$$;

create or replace function public.admin_list_staff()
returns table (id uuid, national_id text, full_name text, role public.staff_role, active boolean,
               has_login boolean, student_count bigint)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.require_admin();
  return query
    select s.id, s.national_id_normalized, s.full_name, s.role, s.active, s.auth_user_id is not null,
           (select count(*) from public.students st where st.teacher_id = s.id and st.active)
    from public.staff_users s order by s.full_name;
end;
$$;

create or replace function public.student_has_active_appointments(p_student_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.appointments a
    join public.conferences cf on cf.id = a.conference_id
    where a.student_id = p_student_id and a.status = 'booked' and cf.status in ('draft', 'open', 'closed')
  )
$$;

create or replace function public.admin_upsert_student(
  p_id uuid, p_national_id text, p_full_name text, p_class_id uuid, p_teacher_id uuid, p_active boolean)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := public.require_admin();
  v_nid text := public.normalize_israeli_id(p_national_id);
  v_old public.students%rowtype;
  v_id uuid;
begin
  if v_nid is null then
    raise exception 'invalid_national_id' using errcode = 'P0001';
  end if;
  if p_id is null then
    insert into public.students (national_id_normalized, full_name, class_id, teacher_id, active)
    values (v_nid, btrim(p_full_name), p_class_id, p_teacher_id, coalesce(p_active, true))
    returning id into v_id;
    perform public.log_audit('admin', v_actor, 'student.create', 'student', v_id, '{}'::jsonb);
  else
    select * into v_old from public.students where id = p_id for update;
    if not found then
      raise exception 'not_found' using errcode = 'P0001';
    end if;
    -- שינוי רב עם תורים פעילים – דורש טיפול יזום (ביטול/העברה) ולא מועבר אוטומטית
    if v_old.teacher_id <> p_teacher_id and public.student_has_active_appointments(p_id) then
      raise exception 'student_has_active_appointments' using errcode = 'P0001';
    end if;
    update public.students set national_id_normalized = v_nid, full_name = btrim(p_full_name),
      class_id = p_class_id, teacher_id = p_teacher_id, active = coalesce(p_active, active)
    where id = p_id returning id into v_id;
    perform public.log_audit('admin', v_actor, 'student.update', 'student', v_id,
      jsonb_build_object('teacher_changed', v_old.teacher_id <> p_teacher_id));
  end if;
  return v_id;
exception when unique_violation then
  raise exception 'national_id_exists' using errcode = 'P0001';
end;
$$;

-- יבוא תלמידים: השרת מאמת שוב כל שורה; מחזיר דוח
-- p_rows: [{row, national_id, full_name, class_name, teacher_name}]
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

    select id into v_class from public.classes where name = v_class_name;
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

    select count(*), min(id::text)::uuid into v_teacher_count, v_teacher
    from public.staff_users where btrim(full_name) = v_teacher_name and active;
    if v_teacher_count = 0 then
      v_errors := v_errors || jsonb_build_object('row', v_row, 'error', 'teacher_not_found');
      continue;
    elsif v_teacher_count > 1 then
      v_errors := v_errors || jsonb_build_object('row', v_row, 'error', 'teacher_ambiguous');
      continue;
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

create or replace function public.admin_update_staff(
  p_id uuid, p_full_name text, p_role public.staff_role, p_active boolean)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := public.require_admin();
  v_old public.staff_users%rowtype;
begin
  select * into v_old from public.staff_users where id = p_id for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  if p_id = v_actor and (p_role <> 'admin' or not p_active) then
    raise exception 'cannot_demote_self' using errcode = 'P0001';
  end if;
  if not p_active and exists (select 1 from public.students where teacher_id = p_id and active) then
    raise exception 'teacher_has_students' using errcode = 'P0001';
  end if;
  update public.staff_users set full_name = btrim(p_full_name), role = p_role, active = p_active where id = p_id;
  perform public.log_audit('admin', v_actor, 'staff.update', 'staff_user', p_id,
    jsonb_build_object('role', p_role, 'active', p_active));
end;
$$;

create or replace function public.admin_upsert_conference(
  p_id uuid, p_title text, p_description text, p_starts_on date, p_ends_on date)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := public.require_admin();
  v_id uuid;
  v_tz text := public.app_tz();
begin
  if p_id is null then
    insert into public.conferences (title, description, starts_on, ends_on, created_by)
    values (btrim(p_title), nullif(btrim(coalesce(p_description, '')), ''), p_starts_on, p_ends_on, v_actor)
    returning id into v_id;
  else
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
    if v_id is null then
      raise exception 'not_found' using errcode = 'P0001';
    end if;
  end if;
  perform public.log_audit('admin', v_actor, 'conference.upsert', 'conference', v_id, '{}'::jsonb);
  return v_id;
end;
$$;

create or replace function public.admin_set_conference_status(p_id uuid, p_status public.conference_status)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := public.require_admin();
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
  perform public.log_audit('admin', v_actor, 'conference.status', 'conference', p_id,
    jsonb_build_object('from', v_old, 'to', p_status));
end;
$$;

create or replace function public.admin_set_conference_teacher(
  p_conference_id uuid, p_teacher_id uuid, p_minutes int)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := public.require_admin();
begin
  if p_minutes is null or p_minutes < 5 or p_minutes > 120 then
    raise exception 'invalid_duration' using errcode = 'P0001';
  end if;
  if not exists (select 1 from public.staff_users where id = p_teacher_id and active) then
    raise exception 'teacher_inactive' using errcode = 'P0001';
  end if;
  insert into public.conference_teachers (conference_id, teacher_id, slot_duration_minutes)
  values (p_conference_id, p_teacher_id, p_minutes)
  on conflict (conference_id, teacher_id) do update set slot_duration_minutes = excluded.slot_duration_minutes;
  perform public.regenerate_slots(p_conference_id, p_teacher_id);
  perform public.log_audit('admin', v_actor, 'conference_teacher.set', 'conference', p_conference_id,
    jsonb_build_object('teacher_id', p_teacher_id, 'minutes', p_minutes));
end;
$$;

create or replace function public.admin_remove_conference_teacher(p_conference_id uuid, p_teacher_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := public.require_admin();
begin
  if exists (select 1 from public.appointments a join public.appointment_slots s on s.id = a.slot_id
             where s.conference_id = p_conference_id and s.teacher_id = p_teacher_id) then
    raise exception 'teacher_has_appointments' using errcode = 'P0001';
  end if;
  delete from public.appointment_slots where conference_id = p_conference_id and teacher_id = p_teacher_id;
  delete from public.conference_teachers where conference_id = p_conference_id and teacher_id = p_teacher_id;
  perform public.log_audit('admin', v_actor, 'conference_teacher.remove', 'conference', p_conference_id,
    jsonb_build_object('teacher_id', p_teacher_id));
end;
$$;

create or replace function public.admin_update_settings(
  p_school_name text, p_address text, p_waze_url text, p_logo_url text, p_contact_info text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := public.require_admin();
begin
  update public.settings set
    school_name = btrim(p_school_name),
    address = nullif(btrim(coalesce(p_address, '')), ''),
    waze_url = nullif(btrim(coalesce(p_waze_url, '')), ''),
    logo_url = nullif(btrim(coalesce(p_logo_url, '')), ''),
    contact_info = nullif(btrim(coalesce(p_contact_info, '')), '')
  where id;
  perform public.log_audit('admin', v_actor, 'settings.update', 'settings', null, '{}'::jsonb);
exception when check_violation then
  raise exception 'invalid_settings' using errcode = 'P0001';
end;
$$;

-- ---------- קודים אישיים ----------
create or replace function public.random_code4()
returns text
language plpgsql
volatile
security definer
set search_path = public, extensions, pg_temp
as $$
declare
  b bytea;
  n int;
begin
  -- דגימה דוחה (rejection sampling) למניעת הטיה
  loop
    b := gen_random_bytes(2);
    n := (get_byte(b, 0) << 8) | get_byte(b, 1);
    if n < 60000 then
      return lpad((n % 10000)::text, 4, '0');
    end if;
  end loop;
end;
$$;

create or replace function public.set_code_internal(p_student_id uuid, p_code text)
returns void
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
begin
  if p_code is null or p_code !~ '^[0-9]{4}$' then
    raise exception 'invalid_code' using errcode = 'P0001';
  end if;
  insert into public.student_codes (student_id, code_hash)
  values (p_student_id, crypt(p_code, gen_salt('bf', 8)))
  on conflict (student_id) do update set code_hash = excluded.code_hash;
  delete from public.rate_limits where key = 'pfail:st:' || p_student_id::text;
end;
$$;

create or replace function public.admin_set_student_code(p_student_id uuid, p_code text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := public.require_admin();
begin
  if not exists (select 1 from public.students where id = p_student_id) then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  perform public.set_code_internal(p_student_id, p_code);
  perform public.log_audit('admin', v_actor, 'code.set_manual', 'student', p_student_id, '{}'::jsonb);
end;
$$;

-- מחזיר את הקוד פעם אחת בלבד (לא נשמר בטקסט גלוי)
create or replace function public.admin_generate_student_code(p_student_id uuid)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := public.require_admin();
  v_code text := public.random_code4();
begin
  if not exists (select 1 from public.students where id = p_student_id) then
    raise exception 'not_found' using errcode = 'P0001';
  end if;
  perform public.set_code_internal(p_student_id, v_code);
  perform public.log_audit('admin', v_actor, 'code.generate', 'student', p_student_id, '{}'::jsonb);
  return v_code;
end;
$$;

create or replace function public.admin_generate_codes_bulk(p_overwrite boolean)
returns table (student_id uuid, full_name text, class_name text, teacher_name text, code text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := public.require_admin();
  r record;
  v_code text;
  v_n int := 0;
begin
  for r in
    select st.id, st.full_name, c.name as cname, t.full_name as tname
    from public.students st
    join public.classes c on c.id = st.class_id
    join public.staff_users t on t.id = st.teacher_id
    where st.active
      and (p_overwrite or not exists (select 1 from public.student_codes sc where sc.student_id = st.id))
    order by c.name, st.full_name
  loop
    v_code := public.random_code4();
    perform public.set_code_internal(r.id, v_code);
    student_id := r.id; full_name := r.full_name; class_name := r.cname; teacher_name := r.tname; code := v_code;
    v_n := v_n + 1;
    return next;
  end loop;
  perform public.log_audit('admin', v_actor, 'code.generate_bulk', 'student', null,
    jsonb_build_object('count', v_n, 'overwrite', p_overwrite));
end;
$$;

create or replace function public.admin_clear_student_code(p_student_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := public.require_admin();
begin
  if (select require_parent_code from public.settings where id)
     and exists (select 1 from public.students where id = p_student_id and active) then
    raise exception 'code_required_mode_on' using errcode = 'P0001';
  end if;
  delete from public.student_codes where student_id = p_student_id;
  perform public.log_audit('admin', v_actor, 'code.clear', 'student', p_student_id, '{}'::jsonb);
end;
$$;

-- הפעלת דרישת קוד: נחסמת אם יש תלמיד פעיל ללא קוד
create or replace function public.admin_set_require_code(p_require boolean)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := public.require_admin();
  v_missing int;
begin
  if p_require then
    select count(*) into v_missing from public.students st
    where st.active and not exists (select 1 from public.student_codes sc where sc.student_id = st.id);
    if v_missing > 0 then
      return jsonb_build_object('ok', false, 'error', 'students_missing_code', 'missing', v_missing);
    end if;
  end if;
  update public.settings set require_parent_code = p_require where id;
  perform public.log_audit('admin', v_actor, 'settings.require_code', 'settings', null,
    jsonb_build_object('require', p_require));
  return jsonb_build_object('ok', true);
end;
$$;

-- ---------- Dashboard ----------
create or replace function public.admin_dashboard(p_conference_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v jsonb;
begin
  perform public.require_admin();
  with base as (
    select st.id, st.class_id, c.name as class_name, st.teacher_id, t.full_name as teacher_name,
           (a.id is not null) as booked
    from public.students st
    join public.classes c on c.id = st.class_id
    join public.staff_users t on t.id = st.teacher_id
    join public.conference_teachers ct on ct.conference_id = p_conference_id and ct.teacher_id = st.teacher_id
    left join public.appointments a on a.student_id = st.id and a.conference_id = p_conference_id and a.status = 'booked'
    where st.active
  )
  select jsonb_build_object(
    'total', (select count(*) from base),
    'booked', (select count(*) from base where booked),
    'by_teacher', coalesce((select jsonb_agg(x order by x->>'name') from (
        select jsonb_build_object('id', teacher_id, 'name', teacher_name, 'total', count(*),
                                  'booked', count(*) filter (where booked)) as x
        from base group by teacher_id, teacher_name) q), '[]'::jsonb),
    'by_class', coalesce((select jsonb_agg(x order by x->>'name') from (
        select jsonb_build_object('id', class_id, 'name', class_name, 'total', count(*),
                                  'booked', count(*) filter (where booked)) as x
        from base group by class_id, class_name) q), '[]'::jsonb),
    'free_slots', (select count(*) from public.appointment_slots s
                   where s.conference_id = p_conference_id and s.status = 'available' and s.starts_at > now()
                     and not exists (select 1 from public.appointments a where a.slot_id = s.id and a.status = 'booked'))
  ) into v;
  return v;
end;
$$;

-- מדיניות שימור: מחיקת הערות ישנות (מנהל)
create or replace function public.admin_purge_old_notes(p_older_than_days int)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor uuid := public.require_admin();
  v_n int;
begin
  if p_older_than_days is null or p_older_than_days < 30 then
    raise exception 'invalid_days' using errcode = 'P0001';
  end if;
  delete from public.teacher_notes where updated_at < now() - make_interval(days => p_older_than_days);
  get diagnostics v_n = row_count;
  perform public.log_audit('admin', v_actor, 'notes.purge', 'teacher_note', null, jsonb_build_object('count', v_n));
  return v_n;
end;
$$;
