-- ============================================================
-- PariksaRakshak — 007 · reliable deletion, visible coding examples,
--                         and safer faculty cleanup
-- Safe to run again.
-- ============================================================

-- 1. Deleting a paper must not be blocked by duplicated foreign keys on the
--    incident log. Attempts already cascade, but incident_logs.exam_id did not.
alter table public.incident_logs
  drop constraint if exists incident_logs_exam_id_fkey;
alter table public.incident_logs
  add constraint incident_logs_exam_id_fkey
  foreign key (exam_id) references public.exams(id) on delete cascade;

alter table public.incident_logs
  drop constraint if exists incident_logs_student_id_fkey;
alter table public.incident_logs
  add constraint incident_logs_student_id_fkey
  foreign key (student_id) references public.profiles(id) on delete cascade;

-- A faculty member may delete a question after attempts exist. Its answer rows
-- must disappear with it rather than blocking the operation.
alter table public.answers
  drop constraint if exists answers_question_id_fkey;
alter table public.answers
  add constraint answers_question_id_fkey
  foreign key (question_id) references public.questions(id) on delete cascade;

-- 2. Secure, explicit paper deletion. This keeps the browser from having to
--    know deletion order and remains faculty-owner-only.
create or replace function public.delete_exam_cascade(p_exam_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.exams e
    where e.id = p_exam_id and e.faculty_id = auth.uid()
  ) then
    raise exception 'not allowed';
  end if;

  delete from public.incident_logs where exam_id = p_exam_id;
  delete from public.answers
    where attempt_id in (select id from public.attempts where exam_id = p_exam_id);
  delete from public.attempts where exam_id = p_exam_id;
  delete from public.test_cases
    where question_id in (select id from public.questions where exam_id = p_exam_id);
  delete from public.questions where exam_id = p_exam_id;
  delete from public.seb_exam_sessions where exam_id = p_exam_id;
  delete from public.seb_launch_tokens where exam_id = p_exam_id;
  delete from public.exams where id = p_exam_id and faculty_id = auth.uid();
  return true;
end;
$$;

revoke all on function public.delete_exam_cascade(uuid) from public;
grant execute on function public.delete_exam_cascade(uuid) to authenticated;

-- 3. Existing coding questions sometimes have tests but every one is hidden.
--    Promote only the first two for questions that currently have ZERO visible
--    examples. Hidden tests after those remain server-only.
with ranked as (
  select
    tc.id,
    tc.question_id,
    row_number() over (partition by tc.question_id order by tc.position, tc.id) as rn,
    bool_or(tc.is_hidden = false) over (partition by tc.question_id) as has_visible
  from public.test_cases tc
  join public.questions q on q.id = tc.question_id
  where q.qtype = 'coding'
)
update public.test_cases tc
set is_hidden = false
from ranked r
where tc.id = r.id
  and r.has_visible = false
  and r.rn <= 2;

-- 4. Reassert the intended test-case boundary after previous hardening.
grant select, insert, update, delete on table public.test_cases to authenticated;
alter table public.test_cases enable row level security;

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
