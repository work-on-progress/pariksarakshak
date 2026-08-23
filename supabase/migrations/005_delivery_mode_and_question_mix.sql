-- ============================================================
--  PariksaRakshak — 005 · delivery mode, richer questions,
--                          and the fix for "not saved — retrying"
--
--  Run AFTER 004. Safe to run again.
--
--  Three things happen here:
--    1. THE SAVE FIX. The browser was refused permission to write some of
--       the columns an upsert touches, so every answer after the first
--       failed with a 403 that the page reported as a network problem.
--    2. Papers can now be delivered in Safe Exam Browser, in an ordinary
--       browser, or either — the teacher chooses per paper.
--    3. Questions carry a difficulty, an MCQ kind, and an optional code
--       snippet, so a paper can be built as a mix rather than a lump.
-- ============================================================

-- ============================================================
--  1. THE SAVE FIX
--
--  Why it broke: saving an answer is an upsert. On the second save of the
--  same question Postgres runs the UPDATE half, which writes every column
--  the request names — including attempt_id and question_id. Those were
--  granted for INSERT only. Postgres refused the UPDATE, PostgREST
--  returned 403, and the exam page printed "not saved — retrying".
--
--  The grants below cover both halves. Nothing dangerous is opened up:
--  the row-level policies still decide *which* rows may be touched, and
--  score, status and auto_marks remain ungranted, so no browser can write
--  a mark under any circumstances.
-- ============================================================
revoke insert, update, delete on table public.answers from authenticated;

grant insert (attempt_id, question_id, answer_text, code_submitted, updated_at)
  on table public.answers to authenticated;
grant update (attempt_id, question_id, answer_text, code_submitted, updated_at)
  on table public.answers to authenticated;

-- Marks columns are deliberately absent from both grants:
--   passed_tests, total_tests, auto_marks  → written only by run-code
--   attempts.score, attempts.status        → written only by grade_attempt

-- Re-assert the policies with the deadline that includes granted extra time,
-- in case an earlier version without it is still in place.
drop policy if exists "student read own answers"           on public.answers;
drop policy if exists "student insert answers during exam" on public.answers;
drop policy if exists "student update answers during exam" on public.answers;
drop policy if exists "student own answers"                on public.answers;

create policy "student read own answers" on public.answers
for select using (
  exists (select 1 from public.attempts a
           where a.id = attempt_id and a.student_id = auth.uid())
);

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
    select 1 from public.attempts a
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
--  2. DELIVERY MODE
--     seb     — Safe Exam Browser only, the machine is locked
--     browser — an ordinary browser, with what a web page can enforce
--     either  — the student may use whichever is available
-- ============================================================
alter table public.exams
  add column if not exists delivery_mode text not null default 'seb';

alter table public.exams drop constraint if exists exams_delivery_mode_check;
alter table public.exams add constraint exams_delivery_mode_check
  check (delivery_mode in ('seb', 'browser', 'either'));

-- How many focus losses before the page warns the student. 0 = never warn.
alter table public.exams
  add column if not exists browser_warn_after int not null default 3;

-- ============================================================
--  3. RICHER QUESTIONS
-- ============================================================
alter table public.questions
  add column if not exists difficulty text not null default 'medium';

alter table public.questions drop constraint if exists questions_difficulty_check;
alter table public.questions add constraint questions_difficulty_check
  check (difficulty in ('easy', 'medium', 'hard'));

-- For multiple choice, what kind of question it is:
--   theory — a plain conceptual question
--   output — here is a program, what does it print
--   error  — here is a program, what is wrong with it
--   blank  — here is a program with ____ in it, what completes it
alter table public.questions
  add column if not exists mcq_kind text not null default 'theory';

alter table public.questions drop constraint if exists questions_mcq_kind_check;
alter table public.questions add constraint questions_mcq_kind_check
  check (mcq_kind in ('theory', 'output', 'error', 'blank'));

-- The program shown above a code-based multiple choice question. Kept apart
-- from the prompt so the exam page can render it as code, not prose.
alter table public.questions
  add column if not exists code_snippet text;

-- Why this option is right, shown to the student after results are released.
alter table public.questions
  add column if not exists explanation text;

create index if not exists questions_exam_difficulty_idx
  on public.questions (exam_id, difficulty);

-- ------------------------------------------------------------
--  The student view has to carry the new fields, minus the answers.
--  Dropping and recreating is safe: it is a view, not data.
-- ------------------------------------------------------------
drop view if exists public.student_questions;

create view public.student_questions
with (security_invoker = off) as
  select q.id, q.exam_id, q.qtype, q.position, q.marks, q.prompt,
         q.options, q.language, q.func_signature, q.starter_code,
         q.difficulty, q.mcq_kind, q.code_snippet,
         case when q.qtype = 'cloze'
              then jsonb_array_length(q.cloze_answers) end as blank_count
  from public.questions q
  join public.exams e on e.id = q.exam_id
  where e.is_published and now() between e.starts_at and e.ends_at;

grant select on public.student_questions to authenticated;

-- correct_key, cloze_answers and explanation are deliberately not selected.

-- ============================================================
--  4. A paper's shape at a glance — used by the console
-- ============================================================
create or replace function public.exam_blueprint(p_exam_id uuid)
returns table (qtype text, mcq_kind text, difficulty text, n bigint, marks numeric)
language sql stable security definer set search_path = public as $$
  select q.qtype, q.mcq_kind, q.difficulty, count(*), sum(q.marks)
    from public.questions q
    join public.exams e on e.id = q.exam_id
   where q.exam_id = p_exam_id
     and e.faculty_id = auth.uid()
   group by 1, 2, 3
   order by 1, 3
$$;

grant execute on function public.exam_blueprint(uuid) to authenticated;

-- ============================================================
--  Check it landed:
--    select delivery_mode from public.exams limit 1;
--    select difficulty, mcq_kind from public.questions limit 1;
--    select * from public.student_questions limit 1;   -- must have no keys
-- ============================================================
