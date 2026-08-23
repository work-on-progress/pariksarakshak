-- ============================================================
-- PariksaRakshak — 008 · reopen attempts + LeetCode-style coding workflow
-- Safe to run more than once.
-- ============================================================

-- 1. Reopen a submitted attempt WITHOUT deleting its answers.
create or replace function public.reopen_attempt(p_attempt_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_exam_id uuid;
  v_student_id uuid;
begin
  select a.exam_id, a.student_id
    into v_exam_id, v_student_id
  from public.attempts a
  join public.exams e on e.id = a.exam_id
  where a.id = p_attempt_id
    and e.faculty_id = auth.uid();

  if v_exam_id is null then
    raise exception 'not allowed';
  end if;

  update public.attempts
     set status = 'in_progress',
         submitted_at = null,
         score = null
   where id = p_attempt_id;

  update public.seb_exam_sessions
     set revoked_at = now()
   where exam_id = v_exam_id
     and student_id = v_student_id
     and revoked_at is null;

  return true;
end;
$$;

revoke all on function public.reopen_attempt(uuid) from public;
grant execute on function public.reopen_attempt(uuid) to authenticated;


-- 2. Existing coding questions: normalize visible/hidden tests.
with ranked as (
  select
    tc.id,
    tc.question_id,
    row_number() over (
      partition by tc.question_id
      order by tc.position, tc.id
    ) as rn,
    count(*) over (partition by tc.question_id) as total
  from public.test_cases tc
  join public.questions q on q.id = tc.question_id
  where q.qtype = 'coding'
)
update public.test_cases tc
set is_hidden = case
  when r.total >= 5 then r.rn > 4
  when r.total = 4 then r.rn > 3
  when r.total = 3 then r.rn > 2
  when r.total = 2 then r.rn > 1
  else false
end
from ranked r
where tc.id = r.id;


-- 3. Future coding tests: positions 1..4 visible, position 5+ hidden.
create or replace function public.normalise_coding_test_visibility()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_qtype text;
begin
  select q.qtype into v_qtype
  from public.questions q
  where q.id = new.question_id;

  if v_qtype = 'coding' then
    new.is_hidden := coalesce(new.position, 1) > 4;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_normalise_coding_test_visibility
  on public.test_cases;

create trigger trg_normalise_coding_test_visibility
before insert or update of question_id, position, is_hidden
on public.test_cases
for each row
execute function public.normalise_coding_test_visibility();


-- 4. Faculty diagnostic for coding-test coverage.
-- Use q_position instead of position because POSITION is SQL syntax.
create or replace function public.coding_test_health(p_exam_id uuid)
returns table (
  question_id uuid,
  q_position int,
  prompt text,
  total_tests bigint,
  visible_tests bigint,
  hidden_tests bigint
)
language sql
stable
security definer
set search_path = public
as $$
  select
    q.id,
    q.position,
    q.prompt,
    count(tc.id) as total_tests,
    count(tc.id) filter (where tc.is_hidden = false) as visible_tests,
    count(tc.id) filter (where tc.is_hidden = true) as hidden_tests
  from public.questions q
  join public.exams e on e.id = q.exam_id
  left join public.test_cases tc on tc.question_id = q.id
  where q.exam_id = p_exam_id
    and q.qtype = 'coding'
    and e.faculty_id = auth.uid()
  group by q.id, q.position, q.prompt
  order by q.position;
$$;

revoke all on function public.coding_test_health(uuid) from public;
grant execute on function public.coding_test_health(uuid) to authenticated;

notify pgrst, 'reload schema';