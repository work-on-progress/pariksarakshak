# 2 · Database and row-level security

The whole schema is in **`supabase/migrations/001_schema.sql`**. This guide explains
how to run it, what it does, and how to prove it holds.

## 2.1 Create the project

1. Go to https://supabase.com and choose **New project**.
2. Name it `pariksarakshak`. Region: **Mumbai (ap-south-1)** — closest to most Indian
   labs, which keeps the exam page responsive.
3. Set a strong database password and store it in a password manager.
4. Wait about two minutes for provisioning.
5. From **Project Settings → API**, copy three values:
   - **Project URL** — `https://abcd1234.supabase.co`
   - **anon public key** — goes in `public/js/config.js`
   - **service_role key** — goes nowhere near the frontend

## 2.2 Run the schema

Open **SQL Editor → New query**, paste the entire contents of
`supabase/migrations/001_schema.sql`, and press **Run**. It takes a few seconds.

If a statement fails, read the error — it names the exact line. The most common cause
is running the script twice; drop the affected object or start from a fresh project.

### What the script creates

| Table | Holds | Secrets in it |
|---|---|---|
| `profiles` | name, roll number, role | — |
| `exams` | title, code, open and close times, duration | — |
| `questions` | prompts, options, starter code | `correct_key`, `cloze_answers` |
| `test_cases` | inputs and expected outputs | every row where `is_hidden` is true |
| `attempts` | one per student per exam, status and score | — |
| `answers` | what the student typed, marks awarded | — |
| `incident_logs` | proctoring events | — |

Plus two things that carry most of the security:

- **`student_questions`** — a view of the paper for a live exam. The key columns are
  not selected, so there is nothing to leak. Students have no read policy on
  `questions` at all.
- **`grade_attempt(uuid)`** — a `security definer` function that compares stored
  answers against the keys and writes the score. The browser can call it, but cannot
  see what it compared against.

## 2.3 Prove it holds

Do this now, not on exam day. In **SQL Editor**, switch the role selector at the top
right to **authenticated**, then run each of these:

```sql
-- Must return nothing: students have no policy on this table.
select correct_key from public.questions limit 1;

-- Must return nothing: hidden rows are excluded by policy.
select * from public.test_cases where is_hidden = true;

-- Must return the paper WITHOUT correct_key or cloze_answers,
-- and only while an exam is published and inside its window.
select * from public.student_questions limit 5;
```

Any other result means the script did not finish. Fix it before going further.

## 2.4 Create accounts

**Authentication → Sign In / Providers:** keep Email enabled and turn **Confirm email
off**, so lab accounts work immediately.

Create your own account through the sign-in page or **Authentication → Users → Add
user**, then promote it:

```sql
update public.profiles
   set role = 'faculty', full_name = 'Your Name'
 where id = 'PASTE-THE-USER-UUID-HERE';
```

Students can register themselves from the landing page — the signup trigger forces
`role = 'student'`, so nobody can promote themselves. To create a whole class at once,
use **Add user** repeatedly, then fill in roll numbers:

```sql
update public.profiles set roll_no = '23BCS114', full_name = 'Student Name'
 where id = 'THE-UUID';
```

## 2.5 Useful queries during and after an exam

```sql
-- Who is in the room right now
select p.roll_no, p.full_name, a.started_at
  from attempts a join profiles p on p.id = a.student_id
 where a.exam_id = 'EXAM-UUID' and a.status = 'in_progress';

-- Incident count per student, worst first
select p.roll_no, p.full_name, i.event_type, count(*)
  from incident_logs i join profiles p on p.id = i.student_id
 where i.exam_id = 'EXAM-UUID'
 group by 1,2,3 order by 4 desc;

-- Marks sheet
select p.roll_no, p.full_name, a.score, a.status, a.submitted_at
  from attempts a join profiles p on p.id = a.student_id
 where a.exam_id = 'EXAM-UUID' order by p.roll_no;

-- Long answers waiting to be marked by hand
select p.roll_no, q.prompt, ans.answer_text
  from answers ans
  join attempts a on a.id = ans.attempt_id
  join profiles p on p.id = a.student_id
  join questions q on q.id = ans.question_id
 where q.qtype = 'long' and a.exam_id = 'EXAM-UUID';

-- Award marks for a long answer
update answers set auto_marks = 4 where id = 'ANSWER-UUID';
update attempts set score = (select sum(auto_marks) from answers where attempt_id = 'ATTEMPT-UUID')
 where id = 'ATTEMPT-UUID';
```

✅ **Done when** the schema runs clean, all three checks in §2.3 behave as described,
and one faculty account exists.

Next → [03 · Question drafting](03-GEMINI-EDGE-FUNCTION.md)
