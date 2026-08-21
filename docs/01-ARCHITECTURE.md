# 1 · Architecture and free-tier mapping

## 1.1 The whole system on one screen

```
┌────────────────────────  STUDENT MACHINE (LAB)  ─────────────────────────┐
│  SAFE EXAM BROWSER, kiosk mode                                           │
│  ├─ blocks PrintScreen, Snipping Tool, Alt+Tab, Win+Tab, OBS, VMs        │
│  └─ opens only  https://your-app.vercel.app/exam.html                    │
│         │                                                                │
│         ├── anticheat.js  verifies SEB, locks clipboard, reports focus   │
│         ├── proctor.js    MediaPipe face check, entirely in the browser  │
│         └── exam.js       paper, autosave, timer, code runs, submit      │
└──────────┬───────────────────────────────────────────────────────────────┘
           │ HTTPS · anon key + the student's own token
           ▼
┌──────────────────────────────  SUPABASE  ────────────────────────────────┐
│  AUTH            email + password, roles: faculty | student              │
│  POSTGRES + RLS  exams · questions · test_cases · attempts · answers     │
│                  · incident_logs                                        │
│  VIEW            student_questions — the paper with the keys removed     │
│  REALTIME        incident_logs INSERT ──► the console's live feed        │
│  EDGE FUNCTIONS  generate-questions ──► Gemini API                       │
│                  run-code           ──► Piston API                       │
│                  both hold the service role key; the browser never does  │
└──────────────────────────────────────────────────────────────────────────┘
           ▲
           │ HTTPS
┌──────────┴────────────┐        ┌────────────────────────┐
│ FACULTY BROWSER        │        │ VERCEL                 │
│ faculty.html           │        │ serves /public         │
│ papers · drafting      │        │ plus security headers  │
│ the room · results     │        │                        │
└────────────────────────┘        └────────────────────────┘
```

## 1.2 Why each piece sits where it does

| Concern | The insecure way | What this project does |
|---|---|---|
| Gemini key | Call Gemini from browser JavaScript — the key is in the network tab | The key is a Supabase secret; the browser calls an Edge Function, the function calls Gemini |
| Hidden test cases | Ship every test to the page and grade in JavaScript | RLS hides `is_hidden = true` rows, and the `run-code` function strips their content from the reply |
| Answer keys | Send `correct_key` with the question | Students read `student_questions`, a view that does not contain the key columns at all |
| Trusting the score | The page computes marks and posts them | The page posts raw answers; a Postgres function and the code runner compute marks |
| Screen capture | JavaScript "detection" tricks | Safe Exam Browser, at the operating-system layer — the only method that holds |
| Face proctoring | Stream webcam video to a server | MediaPipe runs in the browser; only the event name is stored |

## 1.3 What the free tiers give you

| Service | Free allowance | One 60-student exam uses | Verdict |
|---|---|---|---|
| Vercel Hobby | 100 GB bandwidth a month | roughly 300 MB | comfortable |
| Supabase Free | 500 MB database, 500k Edge Function calls, 2M realtime messages | under 20 MB, about 10 calls per student | comfortable |
| Piston public API | rate limited, a few requests a second | one run per test case, paced 250 ms apart | fine; see §4.4 if a lab is large |
| Gemini free tier | a daily request allowance on Flash models | one call per paper drafted | trivial |
| MediaPipe | open source, runs on the client | nothing | free |
| Safe Exam Browser | open source | nothing | free |

> Free Supabase projects pause after about seven days without traffic. Open the
> dashboard the day before any exam.

## 1.4 One exam, end to end

1. **Drafting.** Faculty types a topic or pastes notes and picks the mix. The Edge
   Function calls Gemini with a strict response schema, so the JSON always matches
   the database. Faculty edits, removes, redrafts, then saves.
2. **Scheduling.** Faculty sets the open and close times and an exam code such as
   `CSE423-U1`. The same `.seb` file is used for every exam.
3. **Sitting.** The student opens the `.seb` file, Safe Exam Browser loads the exam
   page, `anticheat.js` confirms SEB, the student signs in and enters the code.
4. **Invigilation.** `proctor.js` samples the camera twice a second locally. Anything
   that persists for four seconds is written to `incident_logs`, and the console
   shows it within about a second.
5. **Coding answers.** Run executes the visible tests. Submit executes every test on
   the server, and full marks require a clean sweep.
6. **Marking.** On submit, `grade_attempt` scores the objective questions. Coding
   marks are already stored. Long answers wait for the teacher. Results export as CSV.

## 1.5 Who may do what

| Role | Can | Cannot |
|---|---|---|
| `faculty` | Create and edit their own papers, read attempts and incidents for those papers | See another teacher's papers |
| `student` | Read the sanitized paper of a live exam, write their own answers and incidents | Read answer keys, hidden tests, or anyone else's work |
| `service_role` | Everything — used only inside Edge Functions | Ever appear in a browser |

Next → [02 · Database](02-SUPABASE-DATABASE.md)
