# 01 · How it fits together

## The whole system on one screen

```
┌────────────────────────  STUDENT MACHINE (LAB)  ─────────────────────────┐
│  NORMAL BROWSER            student.html — sign in, pick paper, press     │
│      │                     Start secure exam                             │
│      │  sebs://…/seb/pariksarakshak.seb?launch=<one-time token>          │
│      ▼                                                                   │
│  SAFE EXAM BROWSER, kiosk mode                                           │
│  ├─ blocks PrintScreen, Snipping Tool, Alt+Tab, Win+Tab, OBS, VMs        │
│  └─ opens  https://your-app.vercel.app/exam.html?launch=…                │
│         ├── anticheat.js  server-verifies the SEB Config Key             │
│         ├── exam.js       spends the token → signed in → paper opens     │
│         └── proctor.js    MediaPipe face check, entirely in the browser  │
└──────────┬───────────────────────────────────────────────────────────────┘
           │ HTTPS · anon key + the student's own token
           ▼
┌──────────────────────────────  SUPABASE  ────────────────────────────────┐
│  AUTH            email and password, roles: faculty | student            │
│  POSTGRES + RLS  exams · questions · test_cases · attempts · answers     │
│                  · incident_logs · profiles                             │
│  VIEW            student_questions — the paper with the keys removed     │
│  REALTIME        incident_logs INSERT ──► the console's live feed        │
│  FUNCTIONS       generate-questions  ──► Gemini                          │
│                  run-code            ──► Piston                          │
│                  manage-students     ──► auth admin API                  │
│                  create-seb-launch   ──► mints the launch token          │
│                  exchange-seb-launch ──► signs the student in inside SEB │
│                  verify-seb          ──► checks the SEB Config Key       │
│                  all six hold secrets; the browser never does            │
└──────────────────────────────────────────────────────────────────────────┘
           ▲
           │ HTTPS
┌──────────┴────────────┐        ┌────────────────────────┐
│ FACULTY BROWSER        │        │ VERCEL                 │
│ faculty.html           │        │ serves /public         │
│ papers · questions     │        │ plus security headers  │
│ students · room        │        │                        │
│ results                │        │                        │
└────────────────────────┘        └────────────────────────┘
```

## Why each piece sits where it does

| Concern | The insecure way | What this project does |
|---|---|---|
| Gemini key | Call Gemini from browser JavaScript — the key is in the network tab | The key is a Supabase secret; the browser calls a function, the function calls Gemini |
| Hidden test cases | Ship every test to the page and grade in JavaScript | Row-level security hides them, and the runner strips their content from the reply |
| Answer keys | Send `correct_key` with the question | Students read `student_questions`, a view that has no key columns at all |
| Trusting the score | The page computes marks and posts them | The page posts raw answers; Postgres and the code runner compute marks |
| Making student accounts | Faculty holds an admin key in the browser | A function with the service key does it, after checking the caller is faculty |
| Opening the locked browser | Hand out the `.seb` file and hope | A one-time, two-minute token per student per paper, spent inside SEB |
| Trusting that SEB is SEB | Read the user agent, which anything can fake | The server compares SEB's Config Key against the key of the file you built |
| Screen capture | JavaScript detection tricks | Safe Exam Browser, at the operating-system layer — the only method that holds |
| Face proctoring | Stream webcam video to a server | MediaPipe runs in the browser; only the event name is stored |

## What the free tiers give you

| Service | Free allowance | One 60-student exam uses | Verdict |
|---|---|---|---|
| Vercel Hobby | 100 GB bandwidth a month | roughly 300 MB | comfortable |
| Supabase Free | 500 MB database, 500k function calls, 2M realtime messages | under 20 MB, about 10 calls per student | comfortable |
| Piston public API | rate limited, a few requests a second | one run per test case, paced 250 ms apart | fine; see guide 03 for a large lab |
| Gemini free tier | a daily allowance on Flash models | one call per paper drafted | trivial |
| MediaPipe | open source, runs on the client | nothing | free |
| Safe Exam Browser | open source | nothing | free |

> Free Supabase projects pause after about seven days without traffic. Open the
> dashboard the day before any exam.

## One exam, end to end

1. **Drafting.** Faculty types a topic or pastes notes and picks the mix. Gemini
   returns structured JSON that always matches the database. Faculty edits, removes,
   adds their own by hand, then saves.
2. **Scheduling.** Faculty sets the open and close times and an exam code. The same
   `.seb` file is used for every exam ever.
3. **Sitting.** The student signs in on an ordinary browser, sees their papers,
   and presses **Start secure exam**. The browser offers to open Safe Exam
   Browser; SEB starts, the machine locks, the page proves its Config Key to the
   server, the one-time token signs the student in, and their chosen paper opens.
   They read the rules and begin. Question order is shuffled per student.
4. **Invigilation.** The face check samples twice a second locally. Anything that
   persists four seconds is logged, and the console shows it about a second later.
   The roster shows who is sitting, who has finished, and who has raised flags.
5. **Coding answers.** Run executes the visible tests. Submit executes every test on
   the server, and full marks require a clean sweep.
6. **Marking.** On submit, objective questions are graded instantly. Long answers
   wait for the teacher; marking one recomputes the total. Results export as CSV.

## Who may do what

| Role | Can | Cannot |
|---|---|---|
| `faculty` | Create and edit their own papers, enrol students, read attempts and incidents, grant extra time, unlock an attempt, mark long answers | See another teacher's papers |
| `student` | Read the sanitized paper of a live exam, write their own answers and incidents | Read answer keys, hidden tests, or anyone else's work |
| `service_role` | Everything — used only inside the Edge Functions | Ever appear in a browser |
