-- ============================================================
-- PariksaRakshak — 010
-- Exam-day readiness, emergency controls, duplication and result stats
--
-- Run AFTER 009_attempt_history_results_partial_marks.sql.
-- Safe to run again.
-- ============================================================

-- ------------------------------------------------------------
-- 1. PASS PERCENTAGE FOR RESULT STATISTICS
-- ------------------------------------------------------------
alter table public.exams
  add column if not exists pass_percentage numeric not null default 40;

alter table public.exams
  drop constraint if exists exams_pass_percentage_check;

alter table public.exams
  add constraint exams_pass_percentage_check
  check (pass_percentage >= 0 and pass_percentage <= 100);

-- ------------------------------------------------------------
-- 2. INTERNAL SCORE RECALCULATION
--
-- Used by faculty emergency Force Submit actions.
-- It does NOT expose answer keys to the browser.
-- ------------------------------------------------------------
create or replace function public.recalculate_attempt_marks_internal(
  p_attempt_id uuid
)
returns numeric
language plpgsql
security definer
set search_path = public
as $$
declare
  v_total numeric := 0;
begin
  -- MCQ
  update public.answers a
     set auto_marks =
       case
         when upper(trim(coalesce(a.answer_text, '')))
            = upper(trim(coalesce(q.correct_key, '')))
          and coalesce(q.correct_key, '') <> ''
         then q.marks
         else 0
       end
    from public.questions q
   where a.question_id = q.id
     and a.attempt_id = p_attempt_id
     and q.qtype = 'mcq';

  -- Fill in the blanks: proportional credit.
  update public.answers a
     set auto_marks = (
       select q.marks * (
         count(*) filter (
           where lower(trim(sa.val)) = lower(trim(ca.val))
         )
       )::numeric
       / greatest(jsonb_array_length(q.cloze_answers), 1)
       from jsonb_array_elements_text(
              coalesce(nullif(a.answer_text, '')::jsonb, '[]'::jsonb)
            ) with ordinality sa(val, i)
       join jsonb_array_elements_text(coalesce(q.cloze_answers, '[]'::jsonb))
            with ordinality ca(val, j)
         on sa.i = ca.j
     )
    from public.questions q
   where a.question_id = q.id
     and a.attempt_id = p_attempt_id
     and q.qtype = 'cloze';

  -- Coding: proportional test-case credit.
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

  -- Long answers keep the faculty mark already present in auto_marks.
  select coalesce(sum(a.auto_marks), 0)
    into v_total
    from public.answers a
   where a.attempt_id = p_attempt_id;

  update public.attempts
     set score = v_total
   where id = p_attempt_id;

  return v_total;
end;
$$;

revoke all on function public.recalculate_attempt_marks_internal(uuid) from public;
revoke all on function public.recalculate_attempt_marks_internal(uuid) from anon;
revoke all on function public.recalculate_attempt_marks_internal(uuid) from authenticated;

-- ------------------------------------------------------------
-- 3. FORCE SUBMIT ONE STUDENT
-- ------------------------------------------------------------
create or replace function public.force_submit_attempt(
  p_attempt_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_attempt public.attempts%rowtype;
  v_score numeric;
begin
  select a.*
    into v_attempt
    from public.attempts a
    join public.exams e on e.id = a.exam_id
   where a.id = p_attempt_id
     and e.faculty_id = auth.uid()
   for update;

  if v_attempt.id is null then
    raise exception 'not your exam or attempt not found';
  end if;

  v_score := public.recalculate_attempt_marks_internal(v_attempt.id);

  update public.attempts
     set status = 'submitted',
         submitted_at = coalesce(submitted_at, now()),
         score = v_score
   where id = v_attempt.id;

  update public.seb_exam_sessions
     set revoked_at = coalesce(revoked_at, now())
   where exam_id = v_attempt.exam_id
     and student_id = v_attempt.student_id
     and revoked_at is null;

  return jsonb_build_object(
    'ok', true,
    'attempt_id', v_attempt.id,
    'student_id', v_attempt.student_id,
    'exam_id', v_attempt.exam_id,
    'score', v_score
  );
end;
$$;

revoke all on function public.force_submit_attempt(uuid) from public;
grant execute on function public.force_submit_attempt(uuid) to authenticated;

-- ------------------------------------------------------------
-- 4. FORCE SUBMIT ALL ACTIVE STUDENTS IN ONE PAPER
-- ------------------------------------------------------------
create or replace function public.force_submit_all_attempts(
  p_exam_id uuid
)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row record;
  v_count int := 0;
  v_score numeric;
begin
  if not exists (
    select 1
      from public.exams e
     where e.id = p_exam_id
       and e.faculty_id = auth.uid()
  ) then
    raise exception 'not your exam';
  end if;

  for v_row in
    select a.id, a.student_id
      from public.attempts a
     where a.exam_id = p_exam_id
       and a.status = 'in_progress'
     for update
  loop
    v_score := public.recalculate_attempt_marks_internal(v_row.id);

    update public.attempts
       set status = 'submitted',
           submitted_at = coalesce(submitted_at, now()),
           score = v_score
     where id = v_row.id;

    v_count := v_count + 1;
  end loop;

  update public.seb_exam_sessions
     set revoked_at = coalesce(revoked_at, now())
   where exam_id = p_exam_id
     and revoked_at is null;

  return v_count;
end;
$$;

revoke all on function public.force_submit_all_attempts(uuid) from public;
grant execute on function public.force_submit_all_attempts(uuid) to authenticated;

-- ------------------------------------------------------------
-- 5. EXAM READINESS
--
-- A paper is hard-blocked from READY when:
--   - no questions
--   - zero marks
--   - missing MCQ answer keys
--   - missing cloze answer keys
--   - coding question has fewer than 2 runnable tests
--   - coding question has no visible test
--
-- Fewer than 5 coding tests is a warning, not a hard blocker.
-- ------------------------------------------------------------
create or replace function public.exam_readiness(
  p_exam_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_exam public.exams%rowtype;
  v_questions bigint := 0;
  v_total_marks numeric := 0;
  v_coding bigint := 0;
  v_broken_coding bigint := 0;
  v_low_test_coding bigint := 0;
  v_missing_mcq bigint := 0;
  v_missing_cloze bigint := 0;
  v_ready boolean := false;
begin
  select e.*
    into v_exam
    from public.exams e
   where e.id = p_exam_id
     and e.faculty_id = auth.uid();

  if v_exam.id is null then
    raise exception 'not your exam';
  end if;

  select
    count(*),
    coalesce(sum(q.marks), 0),
    count(*) filter (where q.qtype = 'coding'),
    count(*) filter (
      where q.qtype = 'mcq'
        and coalesce(trim(q.correct_key), '') = ''
    ),
    count(*) filter (
      where q.qtype = 'cloze'
        and (
          q.cloze_answers is null
          or jsonb_array_length(q.cloze_answers) = 0
        )
    )
  into
    v_questions,
    v_total_marks,
    v_coding,
    v_missing_mcq,
    v_missing_cloze
  from public.questions q
  where q.exam_id = p_exam_id;

  select
    count(*) filter (
      where coalesce(tc.total_tests, 0) < 2
         or coalesce(tc.visible_tests, 0) < 1
    ),
    count(*) filter (
      where coalesce(tc.total_tests, 0) < 5
    )
  into
    v_broken_coding,
    v_low_test_coding
  from public.questions q
  left join lateral (
    select
      count(*) as total_tests,
      count(*) filter (where t.is_hidden = false) as visible_tests
    from public.test_cases t
    where t.question_id = q.id
  ) tc on true
  where q.exam_id = p_exam_id
    and q.qtype = 'coding';

  v_ready :=
    v_questions > 0
    and v_total_marks > 0
    and v_missing_mcq = 0
    and v_missing_cloze = 0
    and v_broken_coding = 0
    and v_exam.ends_at > v_exam.starts_at;

  return jsonb_build_object(
    'exam_id', v_exam.id,
    'exam_code', v_exam.exam_code,
    'title', v_exam.title,
    'is_published', v_exam.is_published,
    'results_released', v_exam.results_released,
    'starts_at', v_exam.starts_at,
    'ends_at', v_exam.ends_at,
    'delivery_mode', v_exam.delivery_mode,
    'question_count', v_questions,
    'total_marks', v_total_marks,
    'coding_questions', v_coding,
    'broken_coding_questions', v_broken_coding,
    'coding_questions_under_5_tests', v_low_test_coding,
    'missing_mcq_keys', v_missing_mcq,
    'missing_cloze_keys', v_missing_cloze,
    'ready', v_ready
  );
end;
$$;

revoke all on function public.exam_readiness(uuid) from public;
grant execute on function public.exam_readiness(uuid) to authenticated;

-- ------------------------------------------------------------
-- 6. RESULT STATISTICS
-- ------------------------------------------------------------
create or replace function public.exam_result_stats(
  p_exam_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_exam public.exams%rowtype;
  v_total_marks numeric := 0;
  v_attempts bigint := 0;
  v_submitted bigint := 0;
  v_active bigint := 0;
  v_scored bigint := 0;
  v_passed bigint := 0;
  v_avg numeric;
  v_high numeric;
  v_low numeric;
  v_pending_long bigint := 0;
begin
  select e.*
    into v_exam
    from public.exams e
   where e.id = p_exam_id
     and e.faculty_id = auth.uid();

  if v_exam.id is null then
    raise exception 'not your exam';
  end if;

  select coalesce(sum(q.marks), 0)
    into v_total_marks
    from public.questions q
   where q.exam_id = p_exam_id;

  select
    count(*),
    count(*) filter (where a.status = 'submitted'),
    count(*) filter (where a.status = 'in_progress')
  into v_attempts, v_submitted, v_active
  from public.attempts a
  where a.exam_id = p_exam_id;

  select
    count(*),
    avg(a.score),
    max(a.score),
    min(a.score),
    count(*) filter (
      where v_total_marks > 0
        and (a.score * 100 / v_total_marks) >= v_exam.pass_percentage
    )
  into v_scored, v_avg, v_high, v_low, v_passed
  from public.attempts a
  where a.exam_id = p_exam_id
    and a.status = 'submitted'
    and a.score is not null;

  select count(*)
    into v_pending_long
    from public.answers ans
    join public.attempts a on a.id = ans.attempt_id
    join public.questions q on q.id = ans.question_id
   where a.exam_id = p_exam_id
     and a.status = 'submitted'
     and q.qtype = 'long'
     and ans.answer_text is not null
     and trim(ans.answer_text) <> ''
     and ans.auto_marks is null;

  return jsonb_build_object(
    'exam_id', v_exam.id,
    'exam_code', v_exam.exam_code,
    'total_marks', v_total_marks,
    'pass_percentage', v_exam.pass_percentage,
    'attempts', v_attempts,
    'submitted', v_submitted,
    'active', v_active,
    'scored', v_scored,
    'passed', v_passed,
    'failed', greatest(v_scored - v_passed, 0),
    'average', case when v_avg is null then null else round(v_avg, 2) end,
    'highest', v_high,
    'lowest', v_low,
    'pending_long_answers', v_pending_long,
    'results_released', v_exam.results_released,
    'results_released_at', v_exam.results_released_at
  );
end;
$$;

revoke all on function public.exam_result_stats(uuid) from public;
grant execute on function public.exam_result_stats(uuid) to authenticated;

-- ------------------------------------------------------------
-- 7. RELEASE ALL ELIGIBLE CLOSED RESULTS
--
-- Skips papers that still have an unmarked submitted long answer.
-- ------------------------------------------------------------
create or replace function public.release_all_closed_results()
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count int := 0;
begin
  update public.exams e
     set results_released = true,
         results_released_at = coalesce(e.results_released_at, now())
   where e.faculty_id = auth.uid()
     and e.ends_at <= now()
     and e.results_released = false
     and not exists (
       select 1
         from public.answers ans
         join public.attempts a on a.id = ans.attempt_id
         join public.questions q on q.id = ans.question_id
        where a.exam_id = e.id
          and a.status = 'submitted'
          and q.qtype = 'long'
          and ans.answer_text is not null
          and trim(ans.answer_text) <> ''
          and ans.auto_marks is null
     );

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.release_all_closed_results() from public;
grant execute on function public.release_all_closed_results() to authenticated;

-- ------------------------------------------------------------
-- 8. DUPLICATE A PAPER
--
-- Copies questions and coding tests.
-- Does NOT copy attempts, answers, incidents or result-release state.
-- The duplicate is a DRAFT scheduled for tomorrow; edit its times before use.
-- ------------------------------------------------------------
create or replace function public.duplicate_exam(
  p_exam_id uuid,
  p_new_code text,
  p_new_title text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_exam public.exams%rowtype;
  v_new_exam_id uuid;
  v_q record;
  v_new_question_id uuid;
  v_start timestamptz;
  v_end timestamptz;
begin
  select e.*
    into v_exam
    from public.exams e
   where e.id = p_exam_id
     and e.faculty_id = auth.uid();

  if v_exam.id is null then
    raise exception 'not your exam';
  end if;

  if coalesce(trim(p_new_code), '') = '' then
    raise exception 'new exam code is required';
  end if;

  if coalesce(trim(p_new_title), '') = '' then
    raise exception 'new title is required';
  end if;

  v_start := date_trunc('minute', now() + interval '1 day');
  v_end := v_start + make_interval(mins => greatest(v_exam.duration_min, 5));

  insert into public.exams (
    faculty_id,
    title,
    exam_code,
    duration_min,
    starts_at,
    ends_at,
    is_published,
    delivery_mode,
    browser_warn_after,
    instructions,
    shuffle_questions,
    shuffle_options,
    results_released,
    results_released_at,
    pass_percentage
  )
  values (
    auth.uid(),
    trim(p_new_title),
    upper(trim(p_new_code)),
    v_exam.duration_min,
    v_start,
    v_end,
    false,
    v_exam.delivery_mode,
    v_exam.browser_warn_after,
    v_exam.instructions,
    v_exam.shuffle_questions,
    v_exam.shuffle_options,
    false,
    null,
    v_exam.pass_percentage
  )
  returning id into v_new_exam_id;

  for v_q in
    select q.*
      from public.questions q
     where q.exam_id = p_exam_id
     order by q.position, q.id
  loop
    insert into public.questions (
      exam_id,
      qtype,
      position,
      marks,
      prompt,
      options,
      correct_key,
      cloze_answers,
      language,
      func_signature,
      starter_code,
      difficulty,
      mcq_kind,
      code_snippet,
      explanation
    )
    values (
      v_new_exam_id,
      v_q.qtype,
      v_q.position,
      v_q.marks,
      v_q.prompt,
      v_q.options,
      v_q.correct_key,
      v_q.cloze_answers,
      v_q.language,
      v_q.func_signature,
      v_q.starter_code,
      v_q.difficulty,
      v_q.mcq_kind,
      v_q.code_snippet,
      v_q.explanation
    )
    returning id into v_new_question_id;

    insert into public.test_cases (
      question_id,
      stdin,
      expected_out,
      is_hidden,
      position
    )
    select
      v_new_question_id,
      t.stdin,
      t.expected_out,
      t.is_hidden,
      t.position
    from public.test_cases t
    where t.question_id = v_q.id
    order by t.position;
  end loop;

  return v_new_exam_id;
end;
$$;

revoke all on function public.duplicate_exam(uuid, text, text) from public;
grant execute on function public.duplicate_exam(uuid, text, text) to authenticated;

notify pgrst, 'reload schema';
