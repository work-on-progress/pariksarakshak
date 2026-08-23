# 02 · The database

Two scripts, run in order, both safe to re-run:

| Script | What it does |
|---|---|
| `001_schema.sql` | Every table, the security rules, the student view, grading |
| `003_seb_launch_and_hardening.sql` | Takes away write permissions the browser does not need, moves faculty actions behind ownership-checked functions, and creates the launch-token table |
| `004_seb_entry_codes.sql` | The six-digit entry codes and exam sessions |
| `005_delivery_mode_and_question_mix.sql` | Delivery modes, question difficulty and MCQ kinds, and the answer-saving fix |
| `002_demo_paper.sql` | Optional: a live demo paper to test with |

## What it builds

| Table | Holds | Secrets in it |
|---|---|---|
| `profiles` | name, roll number, role | — |
| `exams` | title, code, times, duration, instructions, shuffle settings | — |
| `questions` | prompts, options, starter code | `correct_key`, `cloze_answers` |
| `test_cases` | inputs and expected outputs | every row where `is_hidden` is true |
| `attempts` | one per student per exam, status, score, extra minutes | — |
| `answers` | what the student typed, marks awarded | — |
| `incident_logs` | proctoring events | — |

Plus the parts that carry the security:

- **`student_questions`** — the paper as a student sees it. The key columns are not
  selected, so there is nothing to leak. Students have no read policy on
  `questions` at all.
- **`grade_attempt(uuid)`** — compares stored answers against the keys and writes
  the score. Students may call it; they cannot see what it compared against.
- **`recompute_score(uuid)`** — recomputes a total from the stored marks. Kept for
  manual use; the console now calls `mark_long_answer`, which does both at once.
- **`attempt_guard()`** — a trigger that refuses to open an attempt when the exam
  is not published or not inside its window.

And after the hardening script, three functions that replace direct table writes,
each checking that the caller owns the exam before doing anything:

- **`grant_extra_time(attempt, minutes)`** — the +5 min button.
- **`reopen_attempt(attempt)`** — the Unlock button.
- **`mark_long_answer(answer, marks)`** — marking, clamped to the question's
  maximum, and it recomputes the total in the same call.

The point of moving these behind functions: the browser now has **no permission**
to write `score`, `status`, `auto_marks` or `extra_minutes` on any row, its own
included. A student cannot award themselves marks even by crafting the request by
hand, because the column grant does not exist for their role.

## Prove the rules hold

The setup page does this for you, but you can check by hand. In **SQL Editor**,
set the role selector at the top right to **authenticated**:

```sql
-- Must return nothing: students have no policy on this table.
select correct_key from public.questions limit 1;

-- Must return nothing: hidden rows are excluded by policy.
select * from public.test_cases where is_hidden = true;

-- Must return the paper WITHOUT correct_key or cloze_answers.
select * from public.student_questions limit 5;
```

## Useful queries

```sql
-- Who is in the room right now
select p.roll_no, p.full_name, a.started_at
  from attempts a join profiles p on p.id = a.student_id
 where a.exam_id = 'EXAM-UUID' and a.status = 'in_progress';

-- Incident tally, worst first
select p.roll_no, p.full_name, i.event_type, count(*)
  from incident_logs i join profiles p on p.id = i.student_id
 where i.exam_id = 'EXAM-UUID'
 group by 1,2,3 order by 4 desc;

-- Marks sheet
select p.roll_no, p.full_name, a.score, a.status, a.submitted_at
  from attempts a join profiles p on p.id = a.student_id
 where a.exam_id = 'EXAM-UUID' order by p.roll_no;

-- How each question performed, to spot a bad one
select q.position, q.qtype, round(avg(ans.auto_marks), 2) as avg_marks, q.marks
  from answers ans join questions q on q.id = ans.question_id
  join attempts a on a.id = ans.attempt_id
 where a.exam_id = 'EXAM-UUID'
 group by 1,2,4 order by 1;

-- Promote a second teacher
update public.profiles set role = 'faculty' where roll_no = 'STAFF01';

-- Give one student more time (the exam page picks it up within 30 seconds).
-- From SQL you are the owner, so a direct update works here; the console uses
-- grant_extra_time(), which checks that the caller owns the exam.
update public.attempts set extra_minutes = 15
 where id = 'ATTEMPT-UUID';

-- Clear out spent launch tokens (they expire on their own; this is tidying)
select public.purge_expired_launch_tokens();
```

## Backups

**Database → Backups** in Supabase, or from your machine:

```bash
supabase db dump -f backup-2026-08-21.sql
```

Take one after every exam. It is a single file and it fits anywhere.
