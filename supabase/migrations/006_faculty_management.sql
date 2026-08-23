-- ============================================================
-- PariksaRakshak — 006 · faculty management and secure reattempts
-- Safe to run again.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Faculty can manage question rows, while students still cannot
--    read secret answer columns directly. RLS is the real boundary.
-- ------------------------------------------------------------
grant select, insert, update, delete on table public.questions to authenticated;
grant select, insert, update, delete on table public.test_cases to authenticated;

alter table public.questions enable row level security;
alter table public.test_cases enable row level security;

drop policy if exists "faculty own questions" on public.questions;
drop policy if exists "faculty manage own questions" on public.questions;
create policy "faculty manage own questions"
on public.questions
for all
to authenticated
using (
  exists (
    select 1 from public.exams e
    where e.id = questions.exam_id
      and e.faculty_id = auth.uid()
  )
)
with check (
  exists (
    select 1 from public.exams e
    where e.id = questions.exam_id
      and e.faculty_id = auth.uid()
  )
);

drop policy if exists "faculty own test cases" on public.test_cases;
create policy "faculty own test cases"
on public.test_cases
for all
to authenticated
using (
  exists (
    select 1
    from public.questions q
    join public.exams e on e.id = q.exam_id
    where q.id = test_cases.question_id
      and e.faculty_id = auth.uid()
  )
)
with check (
  exists (
    select 1
    from public.questions q
    join public.exams e on e.id = q.exam_id
    where q.id = test_cases.question_id
      and e.faculty_id = auth.uid()
  )
);

-- Keep only visible test cases readable by students.
drop policy if exists "students read visible tests only" on public.test_cases;
create policy "students read visible tests only"
on public.test_cases
for select
to authenticated
using (
  public.my_role() = 'student'
  and is_hidden = false
  and exists (
    select 1
    from public.questions q
    join public.exams e on e.id = q.exam_id
    where q.id = test_cases.question_id
      and e.is_published
      and now() between e.starts_at and e.ends_at
  )
);

-- ------------------------------------------------------------
-- 2. Helper used by answer RLS without exposing public.questions
--    directly to students.
-- ------------------------------------------------------------
create or replace function public.question_belongs_to_exam(
  p_question_id uuid,
  p_exam_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.questions q
    where q.id = p_question_id
      and q.exam_id = p_exam_id
  );
$$;

revoke all on function public.question_belongs_to_exam(uuid, uuid) from public;
grant execute on function public.question_belongs_to_exam(uuid, uuid) to authenticated;

-- Reassert answer policies using the helper.
drop policy if exists "student insert answers during exam" on public.answers;
create policy "student insert answers during exam"
on public.answers
for insert
to authenticated
with check (
  exists (
    select 1
    from public.attempts a
    join public.exams e on e.id = a.exam_id
    where a.id = attempt_id
      and a.student_id = auth.uid()
      and a.status = 'in_progress'
      and now() >= e.starts_at
      and now() <= least(
        e.ends_at,
        a.started_at + make_interval(mins => e.duration_min + coalesce(a.extra_minutes, 0))
      )
      and public.question_belongs_to_exam(question_id, a.exam_id)
  )
);

drop policy if exists "student update answers during exam" on public.answers;
create policy "student update answers during exam"
on public.answers
for update
to authenticated
using (
  exists (
    select 1
    from public.attempts a
    join public.exams e on e.id = a.exam_id
    where a.id = attempt_id
      and a.student_id = auth.uid()
      and a.status = 'in_progress'
      and now() <= least(
        e.ends_at,
        a.started_at + make_interval(mins => e.duration_min + coalesce(a.extra_minutes, 0))
      )
  )
)
with check (
  exists (
    select 1
    from public.attempts a
    join public.exams e on e.id = a.exam_id
    where a.id = attempt_id
      and a.student_id = auth.uid()
      and a.status = 'in_progress'
      and now() <= least(
        e.ends_at,
        a.started_at + make_interval(mins => e.duration_min + coalesce(a.extra_minutes, 0))
      )
      and public.question_belongs_to_exam(question_id, a.exam_id)
  )
);

-- ------------------------------------------------------------
-- 3. Reset a single student's attempt for a single paper.
--    This is the normal "allow reattempt" action.
-- ------------------------------------------------------------
create or replace function public.reset_student_attempt(
  p_exam_id uuid,
  p_student_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_attempt_id uuid;
begin
  if not exists (
    select 1
    from public.exams e
    where e.id = p_exam_id
      and e.faculty_id = auth.uid()
  ) then
    raise exception 'not allowed';
  end if;

  select id into v_attempt_id
  from public.attempts
  where exam_id = p_exam_id
    and student_id = p_student_id
  limit 1;

  if v_attempt_id is not null then
    delete from public.answers where attempt_id = v_attempt_id;
    delete from public.incident_logs where attempt_id = v_attempt_id;
    delete from public.attempts where id = v_attempt_id;
  end if;

  update public.seb_exam_sessions
  set revoked_at = now()
  where exam_id = p_exam_id
    and student_id = p_student_id
    and revoked_at is null;

  delete from public.seb_launch_tokens
  where exam_id = p_exam_id
    and student_id = p_student_id;

  return true;
end;
$$;

revoke all on function public.reset_student_attempt(uuid, uuid) from public;
grant execute on function public.reset_student_attempt(uuid, uuid) to authenticated;

-- ------------------------------------------------------------
-- 4. Optional DB-only student cleanup helper.
--    The website uses manage-students Edge Function for full Auth deletion.
-- ------------------------------------------------------------
create or replace function public.delete_student_record(p_student_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if public.my_role() <> 'faculty' then
    raise exception 'not allowed';
  end if;

  if exists (
    select 1 from public.profiles
    where id = p_student_id and role = 'faculty'
  ) then
    raise exception 'faculty accounts cannot be deleted here';
  end if;

  delete from public.answers
  where attempt_id in (
    select id from public.attempts where student_id = p_student_id
  );

  delete from public.incident_logs where student_id = p_student_id;
  delete from public.attempts where student_id = p_student_id;
  delete from public.seb_exam_sessions where student_id = p_student_id;
  delete from public.seb_launch_tokens where student_id = p_student_id;
  delete from public.profiles where id = p_student_id and role = 'student';

  return true;
end;
$$;

revoke all on function public.delete_student_record(uuid) from public;
grant execute on function public.delete_student_record(uuid) to authenticated;
