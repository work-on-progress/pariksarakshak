-- ============================================================
--  PariksaRakshak — 004 · six-digit entry codes and exam sessions
--  Run AFTER 003_seb_launch_and_hardening.sql.
-- ============================================================

alter table public.seb_launch_tokens
  add column if not exists entry_code text;

drop index if exists seb_launch_tokens_entry_code_live_idx;

create unique index seb_launch_tokens_entry_code_live_idx
  on public.seb_launch_tokens (entry_code)
  where used_at is null;

create index if not exists seb_launch_tokens_entry_code_idx
  on public.seb_launch_tokens (entry_code);

create table if not exists public.seb_exam_sessions (
  id           uuid primary key default gen_random_uuid(),
  session_hash text not null unique,
  student_id   uuid not null references public.profiles(id) on delete cascade,
  exam_id      uuid not null references public.exams(id) on delete cascade,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  revoked_at   timestamptz,
  last_seen_at timestamptz
);

create index if not exists seb_exam_sessions_student_exam_idx
  on public.seb_exam_sessions (student_id, exam_id);

create index if not exists seb_exam_sessions_live_idx
  on public.seb_exam_sessions (exam_id)
  where revoked_at is null;

alter table public.seb_launch_tokens enable row level security;
alter table public.seb_exam_sessions enable row level security;

revoke all on table public.seb_launch_tokens from anon, authenticated;
revoke all on table public.seb_exam_sessions from anon, authenticated;

create or replace function public.purge_expired_launch_tokens()
returns int language sql security definer set search_path = public as $$
  with gone as (
    delete from public.seb_launch_tokens
    where expires_at < now() - interval '1 day'
    returning 1
  )
  select count(*)::int from gone
$$;

create or replace function public.purge_old_exam_sessions()
returns int language sql security definer set search_path = public as $$
  with gone as (
    delete from public.seb_exam_sessions
    where expires_at < now() - interval '2 days'
    returning 1
  )
  select count(*)::int from gone
$$;