-- ============================================================
--  PariksaRakshak — security hardening + one-time SEB launch tokens
--  Run AFTER 001_schema.sql. Safe to run again on an existing project.
--
--  Two things happen here:
--   1. The browser loses the ability to write anything it should not.
--      Students may add an answer; they may not touch marks or status.
--      Faculty actions that change marks or time now go through functions
--      that check ownership, instead of direct table writes.
--   2. The table behind the "Start secure exam" button is created. No
--      browser role can read or write it — only the Edge Functions can.
-- ============================================================

-- ============================================================
--  1. PROFILES — a student may fix their name, nothing else
-- ============================================================
revoke update on table public.profiles from authenticated;
grant update (full_name, roll_no) on table public.profiles to authenticated;

drop policy if exists "faculty update student profiles" on public.profiles;

-- ============================================================
--  2. ATTEMPTS — the browser may start one, and nothing more
-- ============================================================
revoke insert, update, delete on table public.attempts from authenticated;
grant  insert (exam_id, student_id) on table public.attempts to authenticated;

drop policy if exists "student own attempts"            on public.attempts;
drop policy if exists "student read own attempts"       on public.attempts;
drop policy if exists "student start live exam"         on public.attempts;
drop policy if exists "faculty update attempts of own exams" on public.attempts;

create policy "student read own attempts" on public.attempts
for select using (student_id = auth.uid());

create policy "student start live exam" on public.attempts
for insert with check (
  student_id = auth.uid()
  and exists (
    select 1 from public.exams e
    where e.id = exam_id
      and e.is_published
      and now() between e.starts_at and e.ends_at
  )
);

-- ============================================================
--  3. ANSWERS — the browser may write the answer, never the marks
-- ============================================================
revoke insert, update, delete on table public.answers from authenticated;
grant  insert (attempt_id, question_id, answer_text, code_submitted, updated_at)
  on table public.answers to authenticated;
grant  update (attempt_id, question_id, answer_text, code_submitted, updated_at)
  on table public.answers to authenticated;

drop policy if exists "student own answers"                on public.answers;
drop policy if exists "student read own answers"           on public.answers;
drop policy if exists "student insert answers during exam" on public.answers;
drop policy if exists "student update answers during exam" on public.answers;
drop policy if exists "faculty mark answers of own exams"  on public.answers;

create policy "student read own answers" on public.answers
for select using (
  exists (select 1 from public.attempts a
          where a.id = attempt_id and a.student_id = auth.uid())
);

-- The deadline includes any extra minutes the invigilator granted.
create policy "student insert answers during exam" on public.answers
for insert with check (
  exists (
    select 1
      from public.attempts a
      join public.exams e     on e.id = a.exam_id
      join public.questions q on q.id = question_id and q.exam_id = a.exam_id
     where a.id = attempt_id
       and a.student_id = auth.uid()
       and a.status = 'in_progress'
       and now() >= e.starts_at
       and now() <= least(
             e.ends_at,
             a.started_at + make_interval(mins => e.duration_min + coalesce(a.extra_minutes, 0)))
  )
);

create policy "student update answers during exam" on public.answers
for update using (
  exists (
    select 1
      from public.attempts a
      join public.exams e on e.id = a.exam_id
     where a.id = attempt_id
       and a.student_id = auth.uid()
       and a.status = 'in_progress'
       and now() <= least(
             e.ends_at,
             a.started_at + make_interval(mins => e.duration_min + coalesce(a.extra_minutes, 0)))
  )
) with check (
  exists (
    select 1
      from public.attempts a
      join public.exams e     on e.id = a.exam_id
      join public.questions q on q.id = question_id and q.exam_id = a.exam_id
     where a.id = attempt_id
       and a.student_id = auth.uid()
       and a.status = 'in_progress'
       and now() <= least(
             e.ends_at,
             a.started_at + make_interval(mins => e.duration_min + coalesce(a.extra_minutes, 0)))
  )
);

-- ============================================================
--  4. INCIDENTS — the log entry must match the writer's own attempt
-- ============================================================
drop policy if exists "student insert own incidents" on public.incident_logs;

create policy "student insert own incidents" on public.incident_logs
for insert with check (
  student_id = auth.uid()
  and exists (
    select 1 from public.attempts a
     where a.id = attempt_id
       and a.student_id = auth.uid()
       and a.exam_id = exam_id
  )
);

-- ============================================================
--  5. FACULTY ACTIONS — ownership checked inside the function
--     These replace direct table writes, so no browser role needs
--     permission to change marks, status or time.
-- ============================================================
create or replace function public.grant_extra_time(p_attempt_id uuid, p_minutes int)
returns int language plpgsql security definer set search_path = public as $$
declare v_new int;
begin
  if not exists (select 1 from attempts a join exams e on e.id = a.exam_id
                 where a.id = p_attempt_id and e.faculty_id = auth.uid()) then
    raise exception 'not your exam';
  end if;
  if p_minutes < -180 or p_minutes > 180 then
    raise exception 'minutes out of range';
  end if;

  update attempts
     set extra_minutes = greatest(0, coalesce(extra_minutes, 0) + p_minutes)
   where id = p_attempt_id
  returning extra_minutes into v_new;

  return v_new;
end $$;

create or replace function public.reopen_attempt(p_attempt_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from attempts a join exams e on e.id = a.exam_id
                 where a.id = p_attempt_id and e.faculty_id = auth.uid()) then
    raise exception 'not your exam';
  end if;

  update attempts
     set status = 'in_progress', submitted_at = null
   where id = p_attempt_id;
end $$;

create or replace function public.mark_long_answer(p_answer_id uuid, p_marks numeric)
returns numeric language plpgsql security definer set search_path = public as $$
declare
  v_attempt uuid;
  v_max numeric;
  v_total numeric;
begin
  select a.attempt_id, q.marks into v_attempt, v_max
    from answers a
    join questions q on q.id = a.question_id
    join attempts  t on t.id = a.attempt_id
    join exams     e on e.id = t.exam_id
   where a.id = p_answer_id
     and q.qtype = 'long'
     and e.faculty_id = auth.uid();

  if v_attempt is null then
    raise exception 'not your exam, or not a long answer';
  end if;

  update answers
     set auto_marks = case
           when p_marks is null then null
           else least(greatest(p_marks, 0), v_max) end
   where id = p_answer_id;

  select coalesce(sum(auto_marks), 0) into v_total
    from answers where attempt_id = v_attempt;

  update attempts set score = v_total where id = v_attempt;
  return v_total;
end $$;

grant execute on function public.grant_extra_time(uuid, int)     to authenticated;
grant execute on function public.reopen_attempt(uuid)            to authenticated;
grant execute on function public.mark_long_answer(uuid, numeric) to authenticated;

-- ============================================================
--  6. SECURE LAUNCH TOKENS
--     Minted when a student presses "Start secure exam" in a normal
--     browser, handed to Safe Exam Browser through the sebs:// link,
--     and spent once inside SEB. Two minutes, single use.
--     No browser role can see this table at all.
-- ============================================================
create table if not exists public.seb_launch_tokens (
  id          uuid primary key default gen_random_uuid(),
  token_hash  text not null unique,      -- only the hash is stored
  student_id  uuid not null references public.profiles(id) on delete cascade,
  exam_id     uuid not null references public.exams(id)    on delete cascade,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  used_at     timestamptz
);

create index if not exists seb_launch_tokens_student_exam_idx
  on public.seb_launch_tokens (student_id, exam_id);
create index if not exists seb_launch_tokens_expires_idx
  on public.seb_launch_tokens (expires_at);

alter table public.seb_launch_tokens enable row level security;
revoke all on table public.seb_launch_tokens from anon, authenticated;

-- Housekeeping, safe to run any time.
create or replace function public.purge_expired_launch_tokens()
returns int language sql security definer set search_path = public as $$
  with gone as (
    delete from public.seb_launch_tokens
     where expires_at < now() - interval '1 day'
     returning 1
  ) select count(*)::int from gone
$$;

-- ============================================================
--  Done. Check it landed:
--    select count(*) from pg_policies where schemaname = 'public';
--    select tablename from pg_tables where tablename = 'seb_launch_tokens';
-- ============================================================
