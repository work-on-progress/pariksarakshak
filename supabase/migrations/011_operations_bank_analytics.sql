-- ============================================================
-- PariksaRakshak — 011
-- Operations dashboard, attempt health, audit trail, question bank
-- and question-level analytics.
--
-- Run AFTER 010_exam_day_safety_and_controls.sql.
-- Safe to run more than once.
-- ============================================================

-- ------------------------------------------------------------
-- 1. LIVE ATTEMPT HEALTH
-- ------------------------------------------------------------
alter table public.attempts
  add column if not exists last_heartbeat_at timestamptz,
  add column if not exists last_save_at timestamptz,
  add column if not exists last_save_error text;

create index if not exists attempts_exam_health_idx
  on public.attempts (exam_id, status, last_heartbeat_at desc);

-- Student-safe heartbeat/save-health updater.
create or replace function public.touch_attempt_health(
  p_attempt_id uuid,
  p_saved boolean default false,
  p_save_error text default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_student uuid;
  v_status text;
begin
  select student_id, status
    into v_student, v_status
    from public.attempts
   where id = p_attempt_id;

  if v_student is distinct from auth.uid() then
    raise exception 'not your attempt';
  end if;

  if v_status is distinct from 'in_progress' then
    return false;
  end if;

  update public.attempts
     set last_heartbeat_at = now(),
         last_save_at = case when p_saved then now() else last_save_at end,
         last_save_error = case
           when p_saved then null
           when p_save_error is not null then left(p_save_error, 600)
           else last_save_error
         end
   where id = p_attempt_id;

  return true;
end;
$$;

revoke all on function public.touch_attempt_health(uuid, boolean, text) from public;
grant execute on function public.touch_attempt_health(uuid, boolean, text) to authenticated;

-- ------------------------------------------------------------
-- 2. SUBMISSION / RECOVERY AUDIT TRAIL
-- ------------------------------------------------------------
create table if not exists public.attempt_audit_events (
  id          bigint generated always as identity primary key,
  attempt_id  uuid not null references public.attempts(id) on delete cascade,
  exam_id     uuid not null references public.exams(id) on delete cascade,
  student_id  uuid not null references public.profiles(id) on delete cascade,
  event_type  text not null,
  detail      jsonb not null default '{}'::jsonb,
  created_at  timestamptz not null default now()
);

create index if not exists attempt_audit_exam_created_idx
  on public.attempt_audit_events (exam_id, created_at desc);

create index if not exists attempt_audit_attempt_created_idx
  on public.attempt_audit_events (attempt_id, created_at desc);

alter table public.attempt_audit_events enable row level security;

drop policy if exists "faculty read audit of own exams"
  on public.attempt_audit_events;

create policy "faculty read audit of own exams"
on public.attempt_audit_events
for select
using (
  exists (
    select 1
      from public.exams e
     where e.id = attempt_audit_events.exam_id
       and e.faculty_id = auth.uid()
  )
);

-- No browser writes directly. This function validates the caller.
create or replace function public.log_attempt_event(
  p_attempt_id uuid,
  p_event_type text,
  p_detail jsonb default '{}'::jsonb
)
returns bigint
language plpgsql
security definer
set search_path = public
as $$
declare
  v_attempt public.attempts%rowtype;
  v_faculty uuid;
  v_id bigint;
begin
  select *
    into v_attempt
    from public.attempts
   where id = p_attempt_id;

  if v_attempt.id is null then
    raise exception 'attempt not found';
  end if;

  select faculty_id
    into v_faculty
    from public.exams
   where id = v_attempt.exam_id;

  if auth.uid() is distinct from v_attempt.student_id
     and auth.uid() is distinct from v_faculty then
    raise exception 'not allowed';
  end if;

  insert into public.attempt_audit_events (
    attempt_id,
    exam_id,
    student_id,
    event_type,
    detail
  )
  values (
    v_attempt.id,
    v_attempt.exam_id,
    v_attempt.student_id,
    left(coalesce(nullif(trim(p_event_type), ''), 'UNKNOWN'), 80),
    coalesce(p_detail, '{}'::jsonb)
  )
  returning id into v_id;

  return v_id;
end;
$$;

revoke all on function public.log_attempt_event(uuid, text, jsonb) from public;
grant execute on function public.log_attempt_event(uuid, text, jsonb) to authenticated;

-- ------------------------------------------------------------
-- 3. FACULTY HEALTH VIEW RPC
-- ------------------------------------------------------------
create or replace function public.faculty_attempt_health(
  p_exam_id uuid
)
returns table (
  attempt_id uuid,
  student_id uuid,
  roll_no text,
  full_name text,
  status text,
  started_at timestamptz,
  submitted_at timestamptz,
  score numeric,
  extra_minutes int,
  last_heartbeat_at timestamptz,
  last_save_at timestamptz,
  last_save_error text,
  incident_count bigint,
  switch_count bigint,
  camera_event_count bigint
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1
      from public.exams e
     where e.id = p_exam_id
       and e.faculty_id = auth.uid()
  ) then
    raise exception 'not your exam';
  end if;

  return query
  select
    a.id,
    a.student_id,
    p.roll_no,
    p.full_name,
    a.status,
    a.started_at,
    a.submitted_at,
    a.score,
    coalesce(a.extra_minutes, 0),
    a.last_heartbeat_at,
    a.last_save_at,
    a.last_save_error,
    count(i.id)::bigint,
    count(i.id) filter (
      where i.event_type in ('WINDOW_BLUR','TAB_HIDDEN','FULLSCREEN_EXIT')
    )::bigint,
    count(i.id) filter (
      where i.event_type in ('NO_FACE_DETECTED','MULTIPLE_FACES_DETECTED')
    )::bigint
  from public.attempts a
  join public.profiles p on p.id = a.student_id
  left join public.incident_logs i on i.attempt_id = a.id
  where a.exam_id = p_exam_id
  group by
    a.id, a.student_id, p.roll_no, p.full_name, a.status,
    a.started_at, a.submitted_at, a.score, a.extra_minutes,
    a.last_heartbeat_at, a.last_save_at, a.last_save_error
  order by
    case when a.status = 'in_progress' then 0 else 1 end,
    p.roll_no nulls last,
    p.full_name;
end;
$$;

revoke all on function public.faculty_attempt_health(uuid) from public;
grant execute on function public.faculty_attempt_health(uuid) to authenticated;

-- ------------------------------------------------------------
-- 4. QUESTION BANK
-- ------------------------------------------------------------
create table if not exists public.question_bank (
  id                 uuid primary key default gen_random_uuid(),
  faculty_id         uuid not null references public.profiles(id) on delete cascade,
  source_question_id uuid references public.questions(id) on delete set null,
  qtype              text not null check (qtype in ('mcq','cloze','long','coding')),
  difficulty         text,
  mcq_kind           text,
  marks              numeric not null default 1,
  prompt             text not null,
  options            jsonb,
  correct_key        text,
  cloze_answers      jsonb,
  code_snippet       text,
  language           text,
  func_signature     text,
  starter_code       text,
  test_cases         jsonb not null default '[]'::jsonb,
  topic              text,
  tags               text[] not null default '{}'::text[],
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create index if not exists question_bank_faculty_created_idx
  on public.question_bank (faculty_id, created_at desc);

create index if not exists question_bank_faculty_type_idx
  on public.question_bank (faculty_id, qtype);

alter table public.question_bank enable row level security;

drop policy if exists "faculty own question bank"
  on public.question_bank;

create policy "faculty own question bank"
on public.question_bank
for all
using (faculty_id = auth.uid())
with check (
  faculty_id = auth.uid()
  and public.my_role() = 'faculty'
);

grant select, insert, update, delete on public.question_bank to authenticated;

-- ------------------------------------------------------------
-- 5. QUESTION-LEVEL ANALYTICS
-- ------------------------------------------------------------
create or replace function public.exam_question_analytics(
  p_exam_id uuid
)
returns table (
  question_id uuid,
  "position" int,
  qtype text,
  prompt text,
  marks numeric,
  responses bigint,
  graded_responses bigint,
  average_marks numeric,
  average_percent numeric,
  full_mark_responses bigint,
  zero_mark_responses bigint
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1
      from public.exams e
     where e.id = p_exam_id
       and e.faculty_id = auth.uid()
  ) then
    raise exception 'not your exam';
  end if;

  return query
  select
    q.id,
    q.position,
    q.qtype,
    q.prompt,
    q.marks,
    count(ans.id) filter (
      where (
        nullif(trim(coalesce(ans.answer_text, '')), '') is not null
        or nullif(trim(coalesce(ans.code_submitted, '')), '') is not null
      )
    )::bigint as responses,
    count(ans.auto_marks)::bigint as graded_responses,
    round(avg(ans.auto_marks), 2) as average_marks,
    case
      when q.marks > 0 and avg(ans.auto_marks) is not null
      then round(avg(ans.auto_marks) * 100 / q.marks, 2)
      else null
    end as average_percent,
    count(ans.auto_marks) filter (
      where ans.auto_marks >= q.marks
    )::bigint as full_mark_responses,
    count(ans.auto_marks) filter (
      where ans.auto_marks = 0
    )::bigint as zero_mark_responses
  from public.questions q
  left join public.attempts a
    on a.exam_id = q.exam_id
   and a.status = 'submitted'
  left join public.answers ans
    on ans.attempt_id = a.id
   and ans.question_id = q.id
  where q.exam_id = p_exam_id
  group by q.id, q.position, q.qtype, q.prompt, q.marks
  order by q.position;
end;
$$;

revoke all on function public.exam_question_analytics(uuid) from public;
grant execute on function public.exam_question_analytics(uuid) to authenticated;

-- ------------------------------------------------------------
-- 6. AUDIT FEED RPC WITH STUDENT LABELS
-- ------------------------------------------------------------
create or replace function public.faculty_audit_feed(
  p_exam_id uuid,
  p_limit int default 300
)
returns table (
  id bigint,
  attempt_id uuid,
  student_id uuid,
  roll_no text,
  full_name text,
  event_type text,
  detail jsonb,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1
      from public.exams e
     where e.id = p_exam_id
       and e.faculty_id = auth.uid()
  ) then
    raise exception 'not your exam';
  end if;

  return query
  select
    ev.id,
    ev.attempt_id,
    ev.student_id,
    p.roll_no,
    p.full_name,
    ev.event_type,
    ev.detail,
    ev.created_at
  from public.attempt_audit_events ev
  join public.profiles p on p.id = ev.student_id
  where ev.exam_id = p_exam_id
  order by ev.created_at desc
  limit least(greatest(coalesce(p_limit, 300), 1), 1000);
end;
$$;

revoke all on function public.faculty_audit_feed(uuid, int) from public;
grant execute on function public.faculty_audit_feed(uuid, int) to authenticated;

-- ------------------------------------------------------------
-- 7. OPTIONAL REALTIME FOR AUDIT EVENTS
-- ------------------------------------------------------------
do $$
begin
  if not exists (
    select 1
      from pg_publication_tables
     where pubname = 'supabase_realtime'
       and schemaname = 'public'
       and tablename = 'attempt_audit_events'
  ) then
    alter publication supabase_realtime
      add table public.attempt_audit_events;
  end if;
end $$;

-- ------------------------------------------------------------
-- 8. INITIALIZE HEALTH FOR EXISTING IN-PROGRESS ATTEMPTS
-- ------------------------------------------------------------
update public.attempts
   set last_heartbeat_at = coalesce(last_heartbeat_at, started_at)
 where status = 'in_progress'
   and last_heartbeat_at is null;
