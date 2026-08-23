# What changed, and what you have to do

This build takes the project you had and does six things. Read the first section
even if you read nothing else — one of them is a bug that was losing answers.

---

## The short version

| # | What | Why it mattered |
|---|---|---|
| 1 | **Answers now save** | The failure was a permissions bug, not the network |
| 2 | **Papers can run in an ordinary browser** | You choose per paper: locked browser, ordinary browser, or either |
| 3 | **The six-digit code work is now in the repository** | It only existed inside your live Supabase project |
| 4 | **A real question builder** | Difficulty mix, four kinds of MCQ, coding levels, and PDF/Word import |
| 5 | **The code runner reports honestly** | "Failed to fetch" now tells you what actually broke |
| 6 | **Documentation cleaned up** | Two generations of guides were sitting side by side |

---

## What you must do, in order

Four steps. About twenty minutes.

### 1 · Run two migrations

Supabase → **SQL Editor** → **New query** → paste → **Run**. Both are safe to
re-run, and both are needed.

```
supabase/migrations/004_seb_entry_codes.sql
supabase/migrations/005_delivery_mode_and_question_mix.sql
```

004 writes down what you already applied by hand. 005 contains the answer-saving
fix and everything new.

### 2 · Redeploy the functions

```bash
supabase functions deploy generate-questions
supabase functions deploy run-code
supabase functions deploy create-seb-launch
supabase functions deploy exchange-seb-launch --no-verify-jwt
supabase functions deploy session-check       --no-verify-jwt
```

`session-check` is new. `--no-verify-jwt` on the last two is not optional — they
answer before the student has a session, and Supabase will reject them otherwise.

### 3 · Push the files

Everything under `public/` and `supabase/`. Vercel redeploys in seconds.

Your `public/js/config.js` keeps your existing Supabase URL and key. New settings
were added below them; the defaults are the ones you want.

### 4 · Run the setup check

Open `setup.html` and press **Run the checks**, then sign in as faculty and run
them again. Four checks are new:

- **Answers can actually be written** — proves migration 005 landed
- **The code execution service is reachable** — pings Piston and tells you
  whether coding questions will work at all
- **The single-session guard is deployed**
- The SEB checks now say which of them apply to browser papers

Nothing red before an exam.

---

## 1 · The answer-saving bug

**What was happening.** Saving an answer is an upsert. The first save on a
question runs INSERT and succeeded. The second runs UPDATE, which writes every
column the request names — including `attempt_id` and `question_id`. Those were
granted for INSERT only. Postgres refused, PostgREST returned 403, and the page
printed "not saved — retrying".

**Why it looked like a network problem.** The old `exam.js` caught the error and
threw it away. Every failure looked identical, so a permissions error and a dead
connection produced the same message — which is why the SEB network was suspected
when the questions had already loaded down that same connection.

**What changed.**

- Migration 005 grants those columns for both INSERT and UPDATE. The dangerous
  columns stay ungranted: no browser can write `auto_marks`, `score`, `status`,
  `passed_tests` or `total_tests` under any circumstances.
- The policy deadline now includes granted extra time. Previously a student given
  +5 minutes was locked out of saving at the original deadline.
- The exam page shows the real Postgres code and message, in a banner and in the
  console, and says outright when it looks like a permissions problem rather than
  the network.

**Test it:** answer a question, reload the page, and check the answer is still
there. Then answer it again — the second save is the one that used to fail.

---

## 2 · Browser mode

When you create a paper you now choose where it is sat:

- **Locked browser** — Safe Exam Browser, as before
- **Ordinary browser** — Chrome or Edge
- **Either** — students use whichever is installed

The student's route is the same in all three: sign in, press start, receive a
six-digit code, type it into the exam window.

**What browser mode enforces:** full screen with a cover when they leave it, no
copy or paste or right-click or selection, no printing, tab and window switching
logged and counted and shown live to you, a visible counter in the student's
corner, a warning before the tab closes, and the camera check. Plus one thing
worth more than the rest — **the paper can only be open in one place**. Opening
it elsewhere locks the first copy within thirty seconds.

**What it cannot do, and you should say so to students:** it cannot stop a
screenshot, Alt+Tab, a second monitor, a second computer, or a phone. It cannot
tell who is typing. Browser mode is honour system plus a record. It works when a
human being is walking the room.

`docs/10-BROWSER-MODE.md` covers all of it, including the settings.

> One setting left deliberately off: `autoSubmitAfterSwitches`. A student whose
> laptop shows a notification would have their paper submitted. Reading the log
> afterwards is fairer and costs you five minutes.

---

## 3 · The missing migration

`entry_code` and `seb_exam_sessions` were referenced by four files and existed in
no migration — the SQL lived only inside your live project. Rebuilding from the
repository would have produced a system that silently could not issue codes.

It is now `004_seb_entry_codes.sql`, written to match what your project already
has, so running it changes nothing and rebuilding reproduces it exactly.

It also adds two things that were missing: a **partial unique index** so a
six-digit code is unique only while it is live (the same digits can be reused
later in the day), and `last_seen_at`, which the single-session guard uses.

---

## 4 · The question builder

The Questions tab is now three steps.

**Where the questions come from.** A topic; your notes; or a paper you already
have. PDFs and Word files are read **in your browser** — nothing is uploaded and
nothing is stored. A scanned PDF is detected and you are told plainly that the
words are pictures.

**The mix.** A table you build row by row: type, difficulty, count, marks each.
The summary updates as you build — *12 questions · 22 marks · 5 easy, 5 medium,
2 hard*. Three presets to start from.

Seven types, including the ones you asked for:

| Type | What it is |
|---|---|
| MCQ — theory | A question in words |
| MCQ — what does this code print | A program, and four plausible outputs |
| MCQ — find the mistake | A program with one defect, and four candidate defects |
| MCQ — complete the code | A program with `____`, and four things that could fill it |
| Fill in the blanks | As before |
| Long answer | As before |
| Coding problem | As before |

**Coding level** — beginner, intermediate or advanced — binds every program
written anywhere in the paper. Beginner explicitly forbids comprehensions,
lambda, recursion, dictionaries, sets and imported modules, and requires problems
solvable in about ten lines. This is the setting that stops a first-week paper
asking about `functools.reduce`.

**Importing an existing paper.** Two buttons. *Read them here* is a parser that
runs in your browser, instantly and free, and handles numbered questions with
lettered options and a marked answer. *Read them with AI* is for messier
documents, and the prompt is blunt that this is transcription: reproduce what is
written, invent nothing, never guess an unmarked answer.

Anything without a marked answer is flagged **answer missing** and the console
**refuses to save** until you click the correct option. A paper that silently
marks the wrong answer correct is worse than no paper.

**Read the code-based questions before saving.** A model asked "what does this
print" is sometimes confidently wrong — it is exactly the kind of question it
gets wrong. You are the check.

> **Useful tomorrow:** code-based MCQs need no execution service. If Piston is
> unreachable, they give you code-flavoured questions that still grade correctly.

`docs/11-QUESTION-BUILDER.md` has the detail.

---

## 5 · The code runner

`Failed to fetch` means the request never came back with usable headers — a
transport failure, not a rejection. The runner now:

- returns CORS headers on **every** path, including the ones that throw
- answers `{"action":"ping"}` without needing an attempt, and reports whether
  Piston itself is reachable
- retries once on a timeout or a rate limit, and passes Piston's own error text
  through instead of swallowing it
- distinguishes "your code is wrong" from "the service is down", and **records
  nothing** when the service is down, so nobody is marked zero for an outage
- respects granted extra time when deciding whether the paper is still open

The setup page now pings it, so you know before an exam rather than during one.

---

## 6 · Documentation

Removed seven files from the older generation that had been sitting alongside
their replacements: `00-UPLOAD-AND-DEPLOY`, `02-SUPABASE-DATABASE`,
`03-GEMINI-EDGE-FUNCTION`, `04-PISTON-CODE-RUNNER`, `05-FRONTEND`,
`06-SEB-CONFIGURATION`, `07-DEPLOYMENT-CHECKLIST`.

Two new: `10-BROWSER-MODE.md`, `11-QUESTION-BUILDER.md`. Updated: the database,
functions and troubleshooting guides, and the README.

---

## Every file that changed

**New**

```
supabase/migrations/004_seb_entry_codes.sql
supabase/migrations/005_delivery_mode_and_question_mix.sql
supabase/functions/session-check/index.ts
public/js/docimport.js
docs/10-BROWSER-MODE.md
docs/11-QUESTION-BUILDER.md
CHANGES.md
```

**Rewritten**

```
public/js/exam.js          mode-aware, code entry, visible save errors
public/js/faculty.js       mix builder, import, delivery mode
public/js/student.js       mode-aware start, code panel with countdown
public/js/anticheat.js     two modes; browser lockdown; fullscreen cover
public/faculty.html        the three-step Questions tab, mode picker
public/exam.html           code screen, mode tag, save banner
public/student.html        the code panel
supabase/functions/generate-questions/index.ts   mix, MCQ kinds, import
supabase/functions/run-code/index.ts             diagnostics and retries
```

**Edited**

```
public/js/config.js        BROWSER_MODE, import CDNs; your keys untouched
public/js/setup.js         four new checks
public/css/app.css         styles for the new interface
supabase/functions/create-seb-launch/index.ts    returns delivery_mode
supabase/functions/exchange-seb-launch/index.ts  returns delivery_mode
vercel.json                .seb delivery, no-cache on JS
docs/02, docs/03, docs/07, README.md
```

---

## For tomorrow, specifically

1. Run both migrations. **This is the one that must not be skipped.**
2. Redeploy the five functions.
3. Push, and run the setup check until nothing is red.
4. If **the code execution service is reachable** comes back red, do not put
   coding questions on tomorrow's paper. Use *what does this code print* and
   *find the mistake* instead — same skill, no execution needed.
5. Create the paper as **ordinary browser** if SEB is still fighting you. It is a
   real option, not a fallback, as long as you are in the room.
6. Sit the paper yourself, end to end, before the students do. Answer a question,
   reload, check it is still there. That single test is what proves the save bug
   is gone on your machine, with your database.
