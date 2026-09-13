-- ============================================================
-- PariksaRakshak — 012
-- Advanced question authoring, rich text, reference answers and
-- server-selected visible coding examples.
--
-- Run AFTER the corrected 011 migration.
-- Safe to run again.
-- ============================================================

-- ------------------------------------------------------------
-- 1. QUESTION AUTHORING FIELDS
-- ------------------------------------------------------------
alter table public.questions
  add column if not exists prompt_html text,
  add column if not exists explanation_html text,
  add column if not exists input_format text,
  add column if not exists output_format text,
  add column if not exists constraints_text text,
  add column if not exists reference_solution text,
  add column if not exists reference_answer text,
  add column if not exists reference_answer_html text,
  add column if not exists marking_rubric text,
  add column if not exists marking_rubric_html text,
  add column if not exists topic text,
  add column if not exists subtopic text,
  add column if not exists bloom_level text,
  add column if not exists estimated_minutes int,
  add column if not exists tags text[] not null default '{}'::text[];

alter table public.questions
  drop constraint if exists questions_bloom_level_check;

alter table public.questions
  add constraint questions_bloom_level_check
  check (
    bloom_level is null
    or bloom_level in ('remember','understand','apply','analyze','evaluate','create')
  );

alter table public.questions
  drop constraint if exists questions_estimated_minutes_check;

alter table public.questions
  add constraint questions_estimated_minutes_check
  check (
    estimated_minutes is null
    or (estimated_minutes >= 1 and estimated_minutes <= 240)
  );

create index if not exists questions_exam_topic_idx
  on public.questions (exam_id, topic);

create index if not exists questions_tags_gin_idx
  on public.questions using gin (tags);

-- ------------------------------------------------------------
-- 2. KEEP QUESTION BANK COMPATIBLE WITH THE NEW AUTHORING FIELDS
-- ------------------------------------------------------------
do $$
begin
  if to_regclass('public.question_bank') is not null then
    alter table public.question_bank
      add column if not exists prompt_html text,
      add column if not exists explanation text,
      add column if not exists explanation_html text,
      add column if not exists input_format text,
      add column if not exists output_format text,
      add column if not exists constraints_text text,
      add column if not exists reference_solution text,
      add column if not exists reference_answer text,
      add column if not exists reference_answer_html text,
      add column if not exists marking_rubric text,
      add column if not exists marking_rubric_html text,
      add column if not exists subtopic text,
      add column if not exists bloom_level text,
      add column if not exists estimated_minutes int;
  end if;
end $$;

-- ------------------------------------------------------------
-- 3. STUDENT QUESTION VIEW
--
-- Only student-safe authoring fields are exposed. Answer rationale,
-- reference solutions, reference answers and rubrics remain absent.
-- ------------------------------------------------------------
drop view if exists public.student_questions;

create view public.student_questions
with (security_invoker = off) as
  select
    q.id,
    q.exam_id,
    q.qtype,
    q.position,
    q.marks,
    q.prompt,
    q.prompt_html,
    q.options,
    q.language,
    q.func_signature,
    q.starter_code,
    q.difficulty,
    q.mcq_kind,
    q.code_snippet,
    q.input_format,
    q.output_format,
    q.constraints_text,
    q.topic,
    q.subtopic,
    q.bloom_level,
    q.estimated_minutes,
    q.tags,
    case
      when q.qtype = 'cloze'
      then jsonb_array_length(q.cloze_answers)
    end as blank_count
  from public.questions q
  join public.exams e on e.id = q.exam_id
  where e.is_published
    and now() between e.starts_at and e.ends_at;

grant select on public.student_questions to authenticated;

-- ------------------------------------------------------------
-- 4. SERVER-SIDE RANDOM SAMPLE TEST SELECTION
--
-- Faculty saves every coding test as hidden first. This RPC randomly exposes
-- one or two rows. Students can query only those rows through the existing RLS.
-- Hidden tests never have to be sent to the student browser.
-- ------------------------------------------------------------
create or replace function public.randomize_visible_test_cases(
  p_question_id uuid
)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_total int := 0;
  v_visible int := 0;
begin
  if not exists (
    select 1
      from public.questions q
      join public.exams e on e.id = q.exam_id
     where q.id = p_question_id
       and q.qtype = 'coding'
       and e.faculty_id = auth.uid()
  ) then
    raise exception 'not your coding question';
  end if;

  select count(*)::int
    into v_total
    from public.test_cases
   where question_id = p_question_id;

  if v_total <= 0 then
    return 0;
  end if;

  -- Hide everything first; then expose exactly one or two random samples.
  update public.test_cases
     set is_hidden = true
   where question_id = p_question_id;

  v_visible := least(v_total, 1 + floor(random() * 2)::int);

  update public.test_cases tc
     set is_hidden = false
   where tc.id in (
     select t.id
       from public.test_cases t
      where t.question_id = p_question_id
      order by random()
      limit v_visible
   );

  return v_visible;
end;
$$;

revoke all on function public.randomize_visible_test_cases(uuid) from public;
grant execute on function public.randomize_visible_test_cases(uuid) to authenticated;

-- ------------------------------------------------------------
-- 5. QUICK SAFETY CHECK
-- ------------------------------------------------------------
-- Student-safe view must NOT contain:
--   correct_key, cloze_answers, explanation, explanation_html,
--   reference_solution, reference_answer, reference_answer_html,
--   marking_rubric, marking_rubric_html.
-- ------------------------------------------------------------
