-- ============================================================
-- PariksaRakshak — 006 · faculty management controls
-- ============================================================

-- Reset one student's attempt for one exam.
-- This allows a clean reattempt without deleting the student account.
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
  -- Only the faculty owner of this exam may reset attempts.
  if not exists (
    select 1
    from public.exams e
    where e.id = p_exam_id
      and e.faculty_id = auth.uid()
  ) then
    raise exception 'not allowed';
  end if;

  select id
  into v_attempt_id
  from public.attempts
  where exam_id = p_exam_id
    and student_id = p_student_id
  limit 1;

  if v_attempt_id is null then
    return true;
  end if;

  delete from public.answers
  where attempt_id = v_attempt_id;

  delete from public.incident_logs
  where attempt_id = v_attempt_id;

  delete from public.attempts
  where id = v_attempt_id;

  update public.seb_exam_sessions
  set revoked_at = now()
  where exam_id = p_exam_id
    and student_id = p_student_id
    and revoked_at is null;

  return true;
end;
$$;

revoke all on function public.reset_student_attempt(uuid, uuid) from public;
grant execute on function public.reset_student_attempt(uuid, uuid) to authenticated;


-- Remove one student account's application records.
-- Auth account deletion itself should stay in the server-side manage-students function.
create or replace function public.delete_student_record(
  p_student_id uuid
)
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
    select 1
    from public.profiles
    where id = p_student_id
      and role = 'faculty'
  ) then
    raise exception 'faculty accounts cannot be deleted here';
  end if;

  delete from public.incident_logs
  where student_id = p_student_id;

  delete from public.answers
  where attempt_id in (
    select id
    from public.attempts
    where student_id = p_student_id
  );

  delete from public.attempts
  where student_id = p_student_id;

  delete from public.seb_exam_sessions
  where student_id = p_student_id;

  delete from public.seb_launch_tokens
  where student_id = p_student_id;

  delete from public.profiles
  where id = p_student_id
    and role = 'student';

  return true;
end;
$$;

revoke all on function public.delete_student_record(uuid) from public;
grant execute on function public.delete_student_record(uuid) to authenticated;