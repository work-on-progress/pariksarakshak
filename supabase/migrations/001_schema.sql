-- ============================================================
-- PariksaRakshak — full schema, row-level security and grading
-- Run once in Supabase → SQL Editor → New query.
-- ============================================================

-- ---------- 0. PROFILES ----------
create table public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  full_name   text not null default '',
  roll_no     text,
  role        text not null default 'student' check (role in ('student','faculty')),
  created_at  timestamptz not null default now()
);

-- A profile is created for every new account. The role is forced to 'student'
-- here so nobody can sign themselves up as faculty; promote from SQL instead.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, full_name, roll_no, role)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name',''),
    new.raw_user_meta_data->>'roll_no',
    'student'
  );
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

create or replace function public.my_role()
returns text language sql stable security definer set search_path = public as $$
  select role from public.profiles where id = auth.uid()
$$;

-- ---------- 1. EXAMS ----------
create table public.exams (
  id            uuid primary key default gen_random_uuid(),
  faculty_id    uuid not null references public.profiles(id),
  title         text not null,
  exam_code     text not null unique,
  duration_min  int  not null default 60,
  starts_at     timestamptz not null,
  ends_at       timestamptz not null,
  is_published  boolean not null default false,
  created_at    timestamptz not null default now()
);

-- ---------- 2. QUESTIONS ----------
create table public.questions (
  id             uuid primary key default gen_random_uuid(),
  exam_id        uuid not null references public.exams(id) on delete cascade,
  qtype          text not null check (qtype in ('mcq','cloze','long','coding')),
  position       int  not null default 1,
  marks          numeric not null default 1,
  prompt         text not null,
  options        jsonb,          -- MCQ choices
  correct_key    text,           -- SECRET
  cloze_answers  jsonb,          -- SECRET
  language       text,
  func_signature text,
  starter_code   text,
  created_at     timestamptz not null default now()
);
create index on public.questions (exam_id, position);

-- ---------- 3. TEST CASES ----------
create table public.test_cases (
  id           uuid primary key default gen_random_uuid(),
  question_id  uuid not null references public.questions(id) on delete cascade,
  stdin        text not null default '',
  expected_out text not null,
  is_hidden    boolean not null default true,   -- SECRET when true
  position     int not null default 1
);
create index on public.test_cases (question_id);

-- ---------- 4. ATTEMPTS ----------
create table public.attempts (
  id           uuid primary key default gen_random_uuid(),
  exam_id      uuid not null references public.exams(id) on delete cascade,
  student_id   uuid not null references public.profiles(id),
  started_at   timestamptz not null default now(),
  submitted_at timestamptz,
  score        numeric,
  status       text not null default 'in_progress'
               check (status in ('in_progress','submitted','flagged')),
  unique (exam_id, student_id)
);

-- ---------- 5. ANSWERS ----------
create table public.answers (
  id             uuid primary key default gen_random_uuid(),
  attempt_id     uuid not null references public.attempts(id) on delete cascade,
  question_id    uuid not null references public.questions(id),
  answer_text    text,
  code_submitted text,
  passed_tests   int,
  total_tests    int,
  auto_marks     numeric,
  updated_at     timestamptz not null default now(),
  unique (attempt_id, question_id)
);

-- ---------- 6. INCIDENT LOGS ----------
create table public.incident_logs (
  id          uuid primary key default gen_random_uuid(),
  attempt_id  uuid not null references public.attempts(id) on delete cascade,
  exam_id     uuid not null references public.exams(id),
  student_id  uuid not null references public.profiles(id),
  event_type  text not null check (event_type in
              ('MULTIPLE_FACES_DETECTED','NO_FACE_DETECTED','WINDOW_BLUR',
               'FULLSCREEN_EXIT','SEB_CHECK_FAILED','TAB_HIDDEN')),
  detail      text,
  created_at  timestamptz not null default now()
);
create index on public.incident_logs (exam_id, created_at desc);

alter publication supabase_realtime add table public.incident_logs;

-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
alter table public.profiles      enable row level security;
alter table public.exams         enable row level security;
alter table public.questions     enable row level security;
alter table public.test_cases    enable row level security;
alter table public.attempts      enable row level security;
alter table public.answers       enable row level security;
alter table public.incident_logs enable row level security;

-- profiles
create policy "read own profile"   on public.profiles for select using (id = auth.uid());
create policy "update own profile" on public.profiles for update using (id = auth.uid());
create policy "faculty read all profiles" on public.profiles for select
  using (public.my_role() = 'faculty');

-- exams
create policy "faculty full access own exams" on public.exams for all
  using (faculty_id = auth.uid()) with check (faculty_id = auth.uid());
create policy "students read live exams" on public.exams for select
  using (is_published and now() between starts_at and ends_at);

-- questions: faculty only. Students never touch this table.
create policy "faculty own questions" on public.questions for all
  using (exists (select 1 from public.exams e
                 where e.id = exam_id and e.faculty_id = auth.uid()))
  with check (exists (select 1 from public.exams e
                 where e.id = exam_id and e.faculty_id = auth.uid()));

-- The student-facing view. correct_key and cloze_answers are not in it.
create or replace view public.student_questions
with (security_invoker = off) as
  select q.id, q.exam_id, q.qtype, q.position, q.marks, q.prompt,
         q.options, q.language, q.func_signature, q.starter_code,
         case when q.qtype = 'cloze'
              then jsonb_array_length(q.cloze_answers) end as blank_count
  from public.questions q
  join public.exams e on e.id = q.exam_id
  where e.is_published and now() between e.starts_at and e.ends_at;

grant select on public.student_questions to authenticated;

-- test cases
create policy "faculty own test cases" on public.test_cases for all
  using (exists (select 1 from public.questions q join public.exams e on e.id = q.exam_id
                 where q.id = question_id and e.faculty_id = auth.uid()))
  with check (exists (select 1 from public.questions q join public.exams e on e.id = q.exam_id
                 where q.id = question_id and e.faculty_id = auth.uid()));
create policy "students read visible tests only" on public.test_cases for select
  using (is_hidden = false
         and exists (select 1 from public.questions q join public.exams e on e.id = q.exam_id
                     where q.id = question_id and e.is_published
                       and now() between e.starts_at and e.ends_at));

-- attempts
create policy "student own attempts" on public.attempts for all
  using (student_id = auth.uid()) with check (student_id = auth.uid());
create policy "faculty read attempts of own exams" on public.attempts for select
  using (exists (select 1 from public.exams e
                 where e.id = exam_id and e.faculty_id = auth.uid()));

-- answers: writable only while the attempt is in progress
create policy "student own answers" on public.answers for all
  using (exists (select 1 from public.attempts a
                 where a.id = attempt_id and a.student_id = auth.uid()
                   and a.status = 'in_progress'))
  with check (exists (select 1 from public.attempts a
                 where a.id = attempt_id and a.student_id = auth.uid()
                   and a.status = 'in_progress'));
create policy "faculty read answers of own exams" on public.answers for select
  using (exists (select 1 from public.attempts a join public.exams e on e.id = a.exam_id
                 where a.id = attempt_id and e.faculty_id = auth.uid()));

-- incidents
create policy "student insert own incidents" on public.incident_logs for insert
  with check (student_id = auth.uid());
create policy "faculty read incidents of own exams" on public.incident_logs for select
  using (exists (select 1 from public.exams e
                 where e.id = exam_id and e.faculty_id = auth.uid()));

-- ============================================================
-- GRADING — runs on the server, compares against the secrets
-- ============================================================
create or replace function public.grade_attempt(p_attempt_id uuid)
returns numeric language plpgsql security definer set search_path = public as $$
declare
  v_student uuid;
  v_total numeric := 0;
begin
  select student_id into v_student from attempts where id = p_attempt_id;
  if v_student is distinct from auth.uid() then
    raise exception 'not your attempt';
  end if;

  -- multiple choice
  update answers a set auto_marks =
    case when upper(trim(a.answer_text)) = upper(trim(q.correct_key))
         then q.marks else 0 end
  from questions q
  where a.question_id = q.id and a.attempt_id = p_attempt_id and q.qtype = 'mcq';

  -- fill in the blanks: proportional credit, case and space insensitive
  update answers a set auto_marks = (
      select q.marks * (
        count(*) filter (where lower(trim(sa.val)) = lower(trim(ca.val)))
      )::numeric / greatest(jsonb_array_length(q.cloze_answers), 1)
      from jsonb_array_elements_text(coalesce(a.answer_text::jsonb, '[]'::jsonb))
           with ordinality sa(val, i)
      join jsonb_array_elements_text(q.cloze_answers)
           with ordinality ca(val, j) on sa.i = ca.j
  )
  from questions q
  where a.question_id = q.id and a.attempt_id = p_attempt_id and q.qtype = 'cloze';

  -- coding marks were written by the run-code function; long answers stay null

  select coalesce(sum(auto_marks), 0) into v_total
  from answers where attempt_id = p_attempt_id;

  update attempts
     set score = v_total, status = 'submitted', submitted_at = now()
   where id = p_attempt_id;

  return v_total;
end $$;

grant execute on function public.grade_attempt(uuid) to authenticated;
