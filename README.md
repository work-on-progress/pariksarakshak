<p align="center">
  <img src="public/assets/logo-lockup.svg" alt="PariksaRakshak" width="420">
</p>

<p align="center">
  <b>Sealed examinations.</b><br>
  Locked browser or ordinary browser · server-side grading · live invigilation · ₹0 a month
</p>

---

## What this is

PariksaRakshak runs objective and coding examinations in a university lab.

A student signs in, sees their paper, and presses start. They are given a
six-digit code, the exam window opens, they type the code, and the paper is in
front of them — already signed in, with nothing else to type.

**Where that window opens is your choice, per paper.** Safe Exam Browser locks
the whole machine. An ordinary browser gives you full screen, no copy or paste,
switch logging, and a one-place-at-a-time lock. Or let students use whichever is
installed on the machine they are sitting at.

Underneath: answer keys and hidden test cases live where no browser can reach
them, question papers are built as a mix and can be written from your own notes
or imported from a paper you already have, students are enrolled in bulk, the
room is visible while the exam runs, and the paper is marked the moment it is
submitted.

Every part runs on a permanent free tier: Vercel, Supabase, the public Piston
API, the Gemini free tier, MediaPipe in the browser, and Safe Exam Browser.

## Read this first

**[CHANGES.md](CHANGES.md)** — what changed in this build, and the four things
you must do before the next exam. One of them is a migration that fixes answers
not saving.

## The guides

| Guide | For |
|---|---|
| [00 · Setup](docs/00-SETUP.md) | Empty account to working system, one sitting |
| [01 · Architecture](docs/01-ARCHITECTURE.md) | How it fits together, and the free-tier limits |
| [02 · Database](docs/02-DATABASE.md) | Tables, security rules, migrations, useful queries |
| [03 · Functions](docs/03-EDGE-FUNCTIONS.md) | All seven, and what each one holds |
| [04 · Frontend](docs/04-FRONTEND.md) | The pages, the settings, rebranding |
| [05 · Safe Exam Browser](docs/05-SAFE-EXAM-BROWSER.md) | Building the `.seb` file and its Config Key |
| [06 · Exam day](docs/06-EXAM-DAY-RUNBOOK.md) | Print this and keep it beside you |
| [07 · Troubleshooting](docs/07-TROUBLESHOOTING.md) | When something breaks |
| [08 · What to add next](docs/08-WHAT-TO-ADD-NEXT.md) | Deliberate omissions, and what they cost |
| [09 · The secure launch](docs/09-SECURE-LAUNCH.md) | How the entry code works, and what it does not protect |
| [10 · Browser mode](docs/10-BROWSER-MODE.md) | Papers without SEB: what is enforced, and what is not |
| [11 · Question builder](docs/11-QUESTION-BUILDER.md) | The mix, the four MCQ kinds, coding levels, importing your own paper |

## What you get

**Building a paper.** A mix built row by row — type, difficulty, how many, marks
each — with the total updating as you go. Seven types, including three that show
a program and ask what it prints, what is wrong with it, or what completes it.
One coding-level setting binds every program written, so a first-week paper
cannot come back full of comprehensions and recursion.

Questions can come from a topic, from your own notes as a PDF or Word file, or
from a question paper you already have. Files are read **in your browser** and
never uploaded. Imported questions are transcribed, not rewritten, and anything
without a marked answer is flagged and refuses to save until you set it.

**Students.** Paste a roll list, get accounts and printable password slips in one
step. Reset a forgotten password in fifteen seconds at the door.

**Starting the exam.** A five-minute, single-use six-digit code per student per
paper. It signs them in inside the exam window, so no password is retyped at a
desk with people behind them.

**Sitting the paper.** A rules screen that states the actual rules for that
delivery mode. Question order differs per student. Answers save as they are typed
and retry by themselves, and now say plainly what went wrong if they cannot.
Coding answers run against visible tests as often as the student likes;
submitting runs the hidden ones on the server.

**The room.** A roster of who is sitting, who has finished, who has not started,
and who has raised flags — most-flagged first. Live incidents as they happen.
Grant extra minutes or reopen a crashed paper with one button.

**Marks.** Objective and coding questions are graded on submit. Long answers get
a marking panel that recomputes totals as you type. Export as CSV.

**Verification.** `setup.html` tests the real system — keys, tables, whether
answer keys and hidden tests are actually unreachable, whether answers can be
written, whether Piston is reachable, all seven functions, the camera, and Safe
Exam Browser — and names the fix for anything red.

## Quick reference

```bash
# SQL Editor, in this order:
#   001_schema.sql
#   003_seb_launch_and_hardening.sql
#   004_seb_entry_codes.sql
#   005_delivery_mode_and_question_mix.sql
#   002_demo_paper.sql        (optional, gives you something to test with)

supabase link --project-ref YOUR_PROJECT_REF
supabase secrets set GEMINI_API_KEY=your-key
supabase secrets set SEB_CONFIG_KEY=key-from-the-SEB-Exam-tab

supabase functions deploy generate-questions
supabase functions deploy run-code
supabase functions deploy manage-students
supabase functions deploy create-seb-launch
supabase functions deploy exchange-seb-launch --no-verify-jwt
supabase functions deploy verify-seb          --no-verify-jwt
supabase functions deploy session-check       --no-verify-jwt
```

Vercel import settings: Framework **Other**, Build Command **empty**, Output
Directory **`public`**.

## Repository layout

```
pariksarakshak/
├── public/                     ← this folder is what Vercel serves
│   ├── index.html              ← landing page and sign in
│   ├── student.html            ← my papers, and the start button
│   ├── faculty.html            ← papers · questions · students · room · results
│   ├── exam.html               ← the paper, opened by a six-digit code
│   ├── setup.html              ← tests every layer and names the fix
│   ├── seb/                    ← the .seb file lives here and is served
│   ├── assets/                 ← logo mark, lockup, favicon
│   ├── css/  theme.css · landing.css · app.css
│   └── js/   config.js · supabaseClient.js · landing.js · student.js
│             faculty.js · exam.js · anticheat.js · proctor.js
│             setup.js · docimport.js
├── supabase/
│   ├── migrations/  001 schema · 002 demo paper · 003 hardening
│   │                004 entry codes · 005 delivery mode and question mix
│   └── functions/   generate-questions · run-code · manage-students
│                    create-seb-launch · exchange-seb-launch · verify-seb
│                    session-check
├── docs/                       ← the twelve guides
├── CHANGES.md                  ← what changed and what to do
└── vercel.json                 ← security headers, and .seb delivery
```

## The one rule

The **anon key** belongs in `public/js/config.js` — row-level security decides
what it may read. The **service key**, the **Gemini key** and the **SEB Config
Key** belong only in Supabase Edge Function secrets.

```bash
# run this before every push — it should print nothing
grep -rn "service_role" public/
```

## Before a real exam

- Run migrations 004 and 005. Answers do not save reliably without 005.
- `setup.html` green, especially **answers can actually be written** and
  **the code execution service is reachable**.
- For SEB papers: `SEB_CONFIG_KEY` set, matching the `.seb` file you published.
  Rebuild the file and you must set it again.
- Open your Supabase dashboard the day before: free projects pause after about a
  week of inactivity.
- Sit the paper yourself, end to end. Answer, reload, check it is still there.

MIT licensed. The system reports; people decide.
