-- =====================================================================
-- מערכת זימון אסיפות הורים – ישיבת שבילי התורה
-- Migration 1: schema, constraints, indexes
-- =====================================================================
create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
create extension if not exists btree_gist with schema extensions;

set search_path = public, extensions;

-- ---------- enums ----------
create type public.staff_role as enum ('admin', 'teacher');
create type public.conference_status as enum ('draft', 'open', 'closed', 'archived');
-- 'retired' = סלוט שהוצא משימוש אך נשמר בגלל היסטוריית תורים מבוטלים
create type public.slot_status as enum ('available', 'blocked', 'retired');
create type public.appointment_status as enum ('booked', 'cancelled');

-- ---------- Israeli ID helpers ----------
-- מחזיר 9 ספרות (עם אפסים מובילים) אם המספר תקין לפי ספרת ביקורת, אחרת NULL
create or replace function public.normalize_israeli_id(p text)
returns text
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
  d text;
  s int := 0;
  x int;
  i int;
begin
  if p is null then
    return null;
  end if;
  d := regexp_replace(p, '[[:space:]\-]', '', 'g');
  if d !~ '^[0-9]{5,9}$' then
    return null;
  end if;
  d := lpad(d, 9, '0');
  if d = '000000000' then
    return null;
  end if;
  for i in 1..9 loop
    x := substr(d, i, 1)::int * (case when i % 2 = 1 then 1 else 2 end);
    if x > 9 then
      x := x - 9;
    end if;
    s := s + x;
  end loop;
  if s % 10 <> 0 then
    return null;
  end if;
  return d;
end;
$$;

-- ---------- tables ----------
create table public.staff_users (
  id uuid primary key default gen_random_uuid(),
  national_id_normalized text not null unique
    check (national_id_normalized = public.normalize_israeli_id(national_id_normalized)),
  auth_user_id uuid unique references auth.users (id) on delete set null,
  full_name text not null check (char_length(btrim(full_name)) between 2 and 100),
  role public.staff_role not null default 'teacher',
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.classes (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (char_length(btrim(name)) between 1 and 60),
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table public.students (
  id uuid primary key default gen_random_uuid(),
  national_id_normalized text not null unique
    check (national_id_normalized = public.normalize_israeli_id(national_id_normalized)),
  full_name text not null check (char_length(btrim(full_name)) between 2 and 100),
  class_id uuid not null references public.classes (id) on delete restrict,
  teacher_id uuid not null references public.staff_users (id) on delete restrict,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index students_teacher_idx on public.students (teacher_id) where active;
create index students_class_idx on public.students (class_id);

-- קודים אישיים להורים: hash בלבד (bcrypt דרך pgcrypto). אין הרשאת קריאה לאף תפקיד לקוח.
create table public.student_codes (
  student_id uuid primary key references public.students (id) on delete cascade,
  code_hash text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.conferences (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(btrim(title)) between 2 and 120),
  description text check (description is null or char_length(description) <= 1000),
  starts_on date not null,
  ends_on date not null,
  status public.conference_status not null default 'draft',
  created_by uuid references public.staff_users (id) on delete set null,
  created_at timestamptz not null default now(),
  check (ends_on >= starts_on),
  check (ends_on - starts_on <= 120)
);

create table public.conference_teachers (
  conference_id uuid not null references public.conferences (id) on delete cascade,
  teacher_id uuid not null references public.staff_users (id) on delete restrict,
  slot_duration_minutes int not null default 10 check (slot_duration_minutes between 5 and 120),
  primary key (conference_id, teacher_id)
);
create index conference_teachers_teacher_idx on public.conference_teachers (teacher_id);

create table public.availability_windows (
  id uuid primary key default gen_random_uuid(),
  conference_id uuid not null,
  teacher_id uuid not null,
  start_at timestamptz not null,
  end_at timestamptz not null,
  created_by uuid references public.staff_users (id) on delete set null,
  created_at timestamptz not null default now(),
  check (end_at > start_at),
  check (end_at - start_at <= interval '16 hours'),
  foreign key (conference_id, teacher_id)
    references public.conference_teachers (conference_id, teacher_id) on delete cascade,
  -- אין חפיפה בין חלונות זמינות של אותו רב (גם בין אסיפות)
  constraint availability_no_overlap
    exclude using gist (teacher_id with =, tstzrange(start_at, end_at, '[)') with &&)
);
create index availability_conf_teacher_idx on public.availability_windows (conference_id, teacher_id);

create table public.blocked_windows (
  id uuid primary key default gen_random_uuid(),
  conference_id uuid not null,
  teacher_id uuid not null,
  start_at timestamptz not null,
  end_at timestamptz not null,
  reason text check (reason is null or char_length(reason) <= 200),
  created_by uuid references public.staff_users (id) on delete set null,
  created_at timestamptz not null default now(),
  check (end_at > start_at),
  foreign key (conference_id, teacher_id)
    references public.conference_teachers (conference_id, teacher_id) on delete cascade
);
create index blocked_conf_teacher_idx on public.blocked_windows (conference_id, teacher_id);

create table public.appointment_slots (
  id uuid primary key default gen_random_uuid(),
  conference_id uuid not null,
  teacher_id uuid not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status public.slot_status not null default 'available',
  created_at timestamptz not null default now(),
  check (ends_at > starts_at),
  foreign key (conference_id, teacher_id)
    references public.conference_teachers (conference_id, teacher_id) on delete restrict,
  -- מניעת חפיפות בין סלוטים פעילים של אותו רב
  constraint slots_no_overlap
    exclude using gist (teacher_id with =, tstzrange(starts_at, ends_at, '[)') with &&)
    where (status <> 'retired')
);
-- UNIQUE(teacher_id, starts_at) לסלוטים פעילים (סלוט 'retired' נשמר רק להיסטוריה)
create unique index slots_teacher_start_uq on public.appointment_slots (teacher_id, starts_at)
  where status <> 'retired';
create index slots_conf_teacher_idx on public.appointment_slots (conference_id, teacher_id, starts_at);

create table public.appointments (
  id uuid primary key default gen_random_uuid(),
  conference_id uuid not null references public.conferences (id) on delete restrict,
  student_id uuid not null references public.students (id) on delete restrict,
  slot_id uuid not null references public.appointment_slots (id) on delete restrict,
  status public.appointment_status not null default 'booked',
  booked_at timestamptz not null default now(),
  booked_by_type text not null check (booked_by_type in ('parent', 'teacher', 'admin')),
  changed_by uuid references public.staff_users (id) on delete set null,
  cancelled_at timestamptz,
  replaced_by uuid references public.appointments (id) on delete set null,
  updated_at timestamptz not null default now(),
  check ((status = 'cancelled') = (cancelled_at is not null))
);
-- הזמנה פעילה אחת לתלמיד בכל אסיפה
create unique index appointments_one_active_per_student
  on public.appointments (student_id, conference_id) where status = 'booked';
-- הזמנה פעילה אחת לסלוט
create unique index appointments_one_active_per_slot
  on public.appointments (slot_id) where status = 'booked';
create index appointments_conf_idx on public.appointments (conference_id, status);
create index appointments_student_idx on public.appointments (student_id);

create table public.teacher_notes (
  id uuid primary key default gen_random_uuid(),
  appointment_id uuid not null references public.appointments (id) on delete cascade,
  teacher_id uuid not null references public.staff_users (id) on delete cascade,
  note_text text not null check (char_length(note_text) <= 2000),
  updated_at timestamptz not null default now(),
  unique (appointment_id, teacher_id)
);

create table public.audit_logs (
  id bigint generated always as identity primary key,
  actor_id uuid,
  actor_type text not null check (actor_type in ('parent', 'teacher', 'admin', 'system')),
  action text not null,
  entity_type text not null,
  entity_id uuid,
  created_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);
create index audit_logs_created_idx on public.audit_logs (created_at desc);
create index audit_logs_entity_idx on public.audit_logs (entity_type, entity_id);

create table public.settings (
  id boolean primary key default true check (id),
  school_name text not null default 'ישיבת שבילי התורה' check (char_length(school_name) between 2 and 120),
  address text check (address is null or char_length(address) <= 300),
  waze_url text check (waze_url is null or waze_url ~ '^https://(www\.|ul\.)?waze\.com/[^[:space:]<>"]*$'),
  logo_url text check (logo_url is null or logo_url ~ '^(https://[^[:space:]<>"]+|\./[A-Za-z0-9_./-]+)$'),
  contact_info text check (contact_info is null or char_length(contact_info) <= 300),
  timezone text not null default 'Asia/Jerusalem' check (timezone = 'Asia/Jerusalem'),
  require_parent_code boolean not null default false,
  updated_at timestamptz not null default now()
);
insert into public.settings (id) values (true);

-- ---------- security / parent access (server-only tables) ----------
create table public.parent_sessions (
  token_hash text primary key,
  student_id uuid not null references public.students (id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index parent_sessions_expires_idx on public.parent_sessions (expires_at);

create table public.rate_limits (
  key text primary key,
  window_start timestamptz not null default now(),
  count int not null default 0
);

create table public.security_events (
  id bigint generated always as identity primary key,
  kind text not null,
  ip_hash text,
  student_id uuid,
  created_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb
);
create index security_events_created_idx on public.security_events (created_at desc);

-- ---------- updated_at triggers ----------
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger students_touch before update on public.students
  for each row execute function public.touch_updated_at();
create trigger student_codes_touch before update on public.student_codes
  for each row execute function public.touch_updated_at();
create trigger appointments_touch before update on public.appointments
  for each row execute function public.touch_updated_at();
create trigger teacher_notes_touch before update on public.teacher_notes
  for each row execute function public.touch_updated_at();
create trigger settings_touch before update on public.settings
  for each row execute function public.touch_updated_at();

-- תלמיד חייב להיות משויך לאיש צוות פעיל
create or replace function public.students_check_teacher()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if new.active and not exists (
    select 1 from public.staff_users s where s.id = new.teacher_id and s.active
  ) then
    raise exception 'teacher_inactive' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger students_check_teacher_trg before insert or update of teacher_id, active on public.students
  for each row execute function public.students_check_teacher();

-- התור חייב להתאים לאסיפה של הסלוט
create or replace function public.appointments_check_conf()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1 from public.appointment_slots s
    where s.id = new.slot_id and s.conference_id = new.conference_id
  ) then
    raise exception 'slot_conference_mismatch' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
create trigger appointments_check_conf_trg before insert or update of slot_id, conference_id on public.appointments
  for each row execute function public.appointments_check_conf();
