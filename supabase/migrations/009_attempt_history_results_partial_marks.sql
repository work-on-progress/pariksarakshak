-- ============================================================
-- PariksaRakshak — 009
-- Student attempt history + released results + partial coding marks
--
-- What this adds:
--   1. Faculty-controlled result release.
--   2. Student attempt history across papers.
--   3. Secure result detail after release:
--        - question
--        - student's answer
--        - correct / wrong / partial
--        - correct answer for MCQ / cloze
--        - marks per question
--        - explanation when available
--        - submitted code + test count for coding
--        - hidden test inputs/outputs are NEVER returned
--   4. Coding partial credit:
--        marks = question marks × passed tests / total tests
--
-- Run AFTER migration 008.
-- Safe to run again.
-- ============================================================

-- ------------------------------------------------------------
-- 1. RESULT RELEASE STATE
-- ------------------------------------------------------------
alter table public.exams
  add column if not exists results_released boolean not null default false;

alter table public.exams
  add column if not exists results_released_at timestamptz;

-- Optional teacher feedback can be used later without another migration.
alter table public.answers
  add column if not exists faculty_feedback text;

-- ------------------------------------------------------------
-- 2. CODING PARTIAL MARKS
--
-- The current run-code function writes:
--   passed_tests
--   total_tests
--   auto_marks
--
-- This trigger is the final authority for coding marks. Even if a runner
-- sends 0 for a partially-correct solution, Postgres replaces it with the
-- proportional mark before the row is stored.
-- ------------------------------------------------------------
create or replace function public.apply_coding_partial_marks()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_qtype text;
  v_max_marks numeric;
  v_passed int;
  v_total int;
begin
  select q.qtype, q.marks
    into v_qtype, v_max_marks
    from public.questions q
   where q.id = new.question_id;

  if v_qtype = 'coding' then
    v_total := greatest(coalesce(new.total_tests, 0), 0);
    v_passed := greatest(coalesce(new.passed_tests, 0), 0);

    if v_total <= 0 then
      new.auto_marks := 0;
    else
      v_passed := least(v_passed, v_total);
      new.auto_marks := round(
        v_max_marks * v_passed::numeric / v_total::numeric,
        2
      );
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_coding_partial_marks on public.answers;

create trigger trg_coding_partial_marks
before insert or update of passed_tests, total_tests
on public.answers
for each row
execute function public.apply_coding_partial_marks();

-- Backfill coding answers already stored before this migration.
update public.answers a
   set auto_marks = round(
     q.marks
     * greatest(coalesce(a.passed_tests, 0), 0)::numeric
     / greatest(coalesce(a.total_tests, 0), 1)::numeric,
     2
   )
  from public.questions q
 where q.id = a.question_id
   and q.qtype = 'coding'
   and coalesce(a.total_tests, 0) > 0;

-- ------------------------------------------------------------
-- 3. FINAL GRADING
--
-- Recreate grade_attempt so coding is always proportional when the
-- whole paper is submitted.
-- ------------------------------------------------------------
create or replace function public.grade_attempt(p_attempt_id uuid)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  v_student uuid;
  v_total numeric := 0;
begin
  select a.student_id
    into v_student
    from public.attempts a
   where a.id = p_attempt_id;

  if v_student is distinct from auth.uid() then
    raise exception 'not your attempt';
  end if;

  -- MCQ: full mark only when correct.
  update public.answers a
     set auto_marks =
       case
         when upper(trim(a.answer_text)) = upper(trim(q.correct_key))
           then q.marks
         else 0
       end
    from public.questions q
   where a.question_id = q.id
     and a.attempt_id = p_attempt_id
     and q.qtype = 'mcq';

  -- Cloze: proportional credit per blank.
  update public.answers a
     set auto_marks = (
       select q.marks * (
         count(*) filter (
           where lower(trim(sa.val)) = lower(trim(ca.val))
         )
       )::numeric
       / greatest(jsonb_array_length(q.cloze_answers), 1)
       from jsonb_array_elements_text(
              coalesce(a.answer_text::jsonb, '[]'::jsonb)
            ) with ordinality sa(val, i)
       join jsonb_array_elements_text(q.cloze_answers)
            with ordinality ca(val, j)
         on sa.i = ca.j
     )
    from public.questions q
   where a.question_id = q.id
     and a.attempt_id = p_attempt_id
     and q.qtype = 'cloze';

  -- Coding: proportional credit by passed tests.
  update public.answers a
     set auto_marks =
       case
         when coalesce(a.total_tests, 0) <= 0 then 0
         else round(
           q.marks
           * least(
               greatest(coalesce(a.passed_tests, 0), 0),
               a.total_tests
             )::numeric
           / a.total_tests::numeric,
           2
         )
       end
    from public.questions q
   where a.question_id = q.id
     and a.attempt_id = p_attempt_id
     and q.qtype = 'coding';

  -- Long answers remain whatever the faculty awarded, or null until marked.
  select coalesce(sum(a.auto_marks), 0)
    into v_total
    from public.answers a
   where a.attempt_id = p_attempt_id;

  update public.attempts
     set score = v_total,
         status = 'submitted',
         submitted_at = now()
   where id = p_attempt_id;

  return v_total;
end;
$$;

revoke all on function public.grade_attempt(uuid) from public;
grant execute on function public.grade_attempt(uuid) to authenticated;

-- Recalculate old submitted totals using the newly-corrected coding marks.
update public.attempts t
   set score = (
     select coalesce(sum(a.auto_marks), 0)
       from public.answers a
      where a.attempt_id = t.id
   )
 where t.status = 'submitted';

-- ------------------------------------------------------------
-- 4. FACULTY: RELEASE / HIDE RESULTS
--
-- Results cannot be released before the paper closes.
-- If a submitted long answer exists and still has no marks, release is blocked.
-- ------------------------------------------------------------
create or replace function public.faculty_result_release_status(p_exam_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_exam public.exams%rowtype;
  v_pending bigint;
begin
  select e.*
    into v_exam
    from public.exams e
   where e.id = p_exam_id
     and e.faculty_id = auth.uid();

  if v_exam.id is null then
    raise exception 'not your exam';
  end if;

  select count(*)
    into v_pending
    from public.answers a
    join public.attempts t on t.id = a.attempt_id
    join public.questions q on q.id = a.question_id
   where t.exam_id = p_exam_id
     and t.status = 'submitted'
     and q.qtype = 'long'
     and a.answer_text is not null
     and trim(a.answer_text) <> ''
     and a.auto_marks is null;

  return jsonb_build_object(
    'exam_id', v_exam.id,
    'title', v_exam.title,
    'ends_at', v_exam.ends_at,
    'results_released', v_exam.results_released,
    'results_released_at', v_exam.results_released_at,
    'pending_long_answers', v_pending,
    'can_release',
      now() >= v_exam.ends_at
      and v_pending = 0
  );
end;
$$;

revoke all on function public.faculty_result_release_status(uuid) from public;
grant execute on function public.faculty_result_release_status(uuid) to authenticated;

create or replace function public.set_exam_results_released(
  p_exam_id uuid,
  p_release boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_exam public.exams%rowtype;
  v_pending bigint;
begin
  select e.*
    into v_exam
    from public.exams e
   where e.id = p_exam_id
     and e.faculty_id = auth.uid()
   for update;

  if v_exam.id is null then
    raise exception 'not your exam';
  end if;

  if p_release then
    if now() < v_exam.ends_at then
      raise exception 'results can be released only after the exam closes';
    end if;

    select count(*)
      into v_pending
      from public.answers a
      join public.attempts t on t.id = a.attempt_id
      join public.questions q on q.id = a.question_id
     where t.exam_id = p_exam_id
       and t.status = 'submitted'
       and q.qtype = 'long'
       and a.answer_text is not null
       and trim(a.answer_text) <> ''
       and a.auto_marks is null;

    if v_pending > 0 then
      raise exception '% long answer(s) are still unmarked', v_pending;
    end if;

    update public.exams
       set results_released = true,
           results_released_at = now()
     where id = p_exam_id;
  else
    update public.exams
       set results_released = false,
           results_released_at = null
     where id = p_exam_id;
  end if;

  return public.faculty_result_release_status(p_exam_id);
end;
$$;

revoke all on function public.set_exam_results_released(uuid, boolean) from public;
grant execute on function public.set_exam_results_released(uuid, boolean) to authenticated;

-- ------------------------------------------------------------
-- 5. STUDENT ATTEMPT HISTORY
--
-- Score is deliberately NULL until:
--   - the attempt is submitted,
--   - the faculty released results,
--   - and the exam closing time has passed.
-- ------------------------------------------------------------
create or replace function public.student_attempt_history()
returns table (
  attempt_id uuid,
  exam_id uuid,
  exam_code text,
  exam_title text,
  started_at timestamptz,
  submitted_at timestamptz,
  status text,
  result_released boolean,
  results_released_at timestamptz,
  score numeric,
  total_marks numeric,
  percentage numeric
)
language sql
stable
security definer
set search_path = public
as $$
  select
    a.id as attempt_id,
    e.id as exam_id,
    e.exam_code,
    e.title as exam_title,
    a.started_at,
    a.submitted_at,
    a.status,
    (
      e.results_released
      and now() >= e.ends_at
      and a.status = 'submitted'
    ) as result_released,
    case
      when e.results_released
       and now() >= e.ends_at
       and a.status = 'submitted'
      then e.results_released_at
      else null
    end as results_released_at,
    case
      when e.results_released
       and now() >= e.ends_at
       and a.status = 'submitted'
      then coalesce(a.score, 0)
      else null
    end as score,
    coalesce(tm.total_marks, 0) as total_marks,
    case
      when e.results_released
       and now() >= e.ends_at
       and a.status = 'submitted'
       and coalesce(tm.total_marks, 0) > 0
      then round(
        coalesce(a.score, 0) * 100 / tm.total_marks,
        2
      )
      else null
    end as percentage
  from public.attempts a
  join public.exams e
    on e.id = a.exam_id
  left join lateral (
    select coalesce(sum(q.marks), 0) as total_marks
      from public.questions q
     where q.exam_id = e.id
  ) tm on true
  where a.student_id = auth.uid()
  order by a.started_at desc;
$$;

revoke all on function public.student_attempt_history() from public;
grant execute on function public.student_attempt_history() to authenticated;

-- ------------------------------------------------------------
-- 6. STUDENT RESULT DETAIL
--
-- This is the ONLY route through which answer keys are returned to students.
-- It refuses access until the faculty releases the paper after it has closed.
--
-- Hidden coding test stdin / expected_out are not selected anywhere here.
-- ------------------------------------------------------------
create or replace function public.student_attempt_result(p_attempt_id uuid)
returns table (
  q_position int,
  question_id uuid,
  qtype text,
  prompt text,
  question_marks numeric,
  options jsonb,
  code_snippet text,
  language text,
  your_answer text,
  submitted_code text,
  passed_tests int,
  total_tests int,
  awarded_marks numeric,
  outcome text,
  correct_key text,
  correct_answers jsonb,
  explanation text,
  faculty_feedback text
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_allowed boolean;
begin
  select (
    a.student_id = auth.uid()
    and a.status = 'submitted'
    and e.results_released
    and now() >= e.ends_at
  )
    into v_allowed
    from public.attempts a
    join public.exams e on e.id = a.exam_id
   where a.id = p_attempt_id;

  if coalesce(v_allowed, false) = false then
    raise exception 'result is not available for this attempt';
  end if;

  return query
  select
    q.position as q_position,
    q.id as question_id,
    q.qtype,
    q.prompt,
    q.marks as question_marks,
    q.options,
    q.code_snippet,
    q.language,
    a.answer_text as your_answer,
    a.code_submitted as submitted_code,
    a.passed_tests,
    a.total_tests,
    coalesce(a.auto_marks, 0) as awarded_marks,
    case
      when q.qtype = 'long' then
        case
          when a.id is null then 'unanswered'
          when a.auto_marks is null then 'pending'
          else 'evaluated'
        end
      when a.id is null then 'unanswered'
      when coalesce(a.auto_marks, 0) >= q.marks then 'correct'
      when coalesce(a.auto_marks, 0) > 0 then 'partial'
      else 'wrong'
    end as outcome,
    case when q.qtype = 'mcq' then q.correct_key else null end as correct_key,
    case when q.qtype = 'cloze' then q.cloze_answers else null end as correct_answers,
    q.explanation,
    a.faculty_feedback
  from public.attempts t
  join public.questions q
    on q.exam_id = t.exam_id
  left join public.answers a
    on a.attempt_id = t.id
   and a.question_id = q.id
  where t.id = p_attempt_id
  order by q.position, q.id;
end;
$$;

revoke all on function public.student_attempt_result(uuid) from public;
grant execute on function public.student_attempt_result(uuid) to authenticated;

notify pgrst, 'reload schema';

-- ============================================================
-- Quick checks after running:
--
-- select results_released, results_released_at from public.exams limit 5;
--
-- A student should NOT be able to:
--   select correct_key from public.questions;
--
-- The student receives keys only through:
--   select * from public.student_attempt_result('<attempt-uuid>');
-- and only after the faculty releases the result.
-- ============================================================
