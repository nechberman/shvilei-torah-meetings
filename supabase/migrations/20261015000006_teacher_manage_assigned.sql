-- =====================================================================
-- Migration 6: רב יכול לערוך ולמחוק גם אסיפה שההנהלה פתחה ושויך אליה,
-- בתנאי שהוא הרב היחיד באסיפה (כדי לא לפגוע בתורים של רבנים אחרים).
-- אסיפה משותפת לכמה רבנים – רק מי שיצר אותה או מנהל.
-- =====================================================================
set search_path = public, extensions;

create or replace function public.can_manage_conference(p_conference_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select public.is_admin()
    or exists (select 1 from public.conferences c
               where c.id = p_conference_id and c.created_by = public.current_staff_id())
    or (
      exists (select 1 from public.conference_teachers ct
              where ct.conference_id = p_conference_id and ct.teacher_id = public.current_staff_id())
      and not exists (select 1 from public.conference_teachers ct
                      where ct.conference_id = p_conference_id and ct.teacher_id <> public.current_staff_id())
    )
$$;

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
  if not public.can_manage_conference(p_conference_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  return v_me;
end;
$$;

-- האסיפות של הרב (או כל האסיפות למנהל) עם סימון האם מותר לו לנהל אותן
create or replace function public.staff_my_conferences()
returns table (id uuid, title text, description text, starts_on date, ends_on date,
               status public.conference_status, created_by uuid, can_manage boolean, teacher_count bigint)
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  v_me uuid := public.require_staff();
begin
  return query
    select c.id, c.title, c.description, c.starts_on, c.ends_on, c.status, c.created_by,
           public.can_manage_conference(c.id),
           (select count(*) from public.conference_teachers x where x.conference_id = c.id)
    from public.conferences c
    where exists (select 1 from public.conference_teachers ct where ct.conference_id = c.id and ct.teacher_id = v_me)
    order by c.starts_on desc;
end;
$$;

revoke execute on function public.can_manage_conference(uuid) from public, anon, authenticated;
revoke execute on function public.require_conference_owner(uuid) from public, anon, authenticated;
revoke execute on function public.staff_my_conferences() from public, anon;
grant execute on function public.staff_my_conferences() to authenticated;
