# 7 · Deployment checklist

Print this. Every unticked box is a way exam day can go wrong.

---

## Day 1 — the backend

### Morning: accounts and database
- [ ] GitHub, Vercel, Supabase and Google AI Studio accounts exist
- [ ] Supabase project created in Mumbai (ap-south-1)
- [ ] `supabase/migrations/001_schema.sql` ran with no errors
- [ ] `incident_logs` appears under Database → Publications → `supabase_realtime`
- [ ] Email confirmation turned off in Authentication
- [ ] Your account created and promoted to `faculty`
- [ ] Two test student accounts created
- [ ] As the `authenticated` role, `select correct_key from questions` returns nothing
- [ ] As the `authenticated` role, `select * from test_cases where is_hidden = true` returns nothing

### Afternoon: the drafting function
- [ ] Node.js and the Supabase CLI installed; `supabase login` and `supabase link` done
- [ ] Gemini key created and stored: `supabase secrets set GEMINI_API_KEY=…`
- [ ] `supabase functions deploy generate-questions` succeeded
- [ ] A test call returns exactly the counts requested
- [ ] Coding questions come back with two visible tests and three or more hidden ones

---

## Day 2 — the runner and the site

### Morning: the code runner
- [ ] `supabase functions deploy run-code` succeeded
- [ ] `run` mode executes only the visible tests and shows expected against actual
- [ ] `submit` mode runs everything, and hidden entries carry no `got` or `expected`
- [ ] Wrong code scores zero; fully correct code scores full marks, visible in `answers`
- [ ] Another student's `attempt_id` is refused with 403

### Afternoon: the frontend
- [ ] Repository pushed to GitHub
- [ ] `public/js/config.js` holds your project URL and anon key
- [ ] `grep -ri "service_role" public/` returns nothing
- [ ] Vercel project imported from GitHub, output directory `public`, deploy is green
- [ ] Security headers visible in DevTools → Network → Headers
- [ ] Sign in works; faculty lands on the console, students on the exam page
- [ ] A student can register from the landing page and gets `role = 'student'`
- [ ] Console: create a paper, draft questions, edit one, remove one, save
- [ ] Saved rows appear in `questions` and `test_cases`
- [ ] `exam.html?dev=1` in Chrome: join by code, all four question types render
- [ ] Typing shows "saved" beside the question, and a reload restores the answers
- [ ] Code editor loads the starter code; Run and Submit both work
- [ ] Cover the camera for five seconds — an incident appears on the console live
- [ ] Finish and submit returns a score, and answers can no longer be changed

---

## Day 3 — lockdown and rehearsal

### Morning: Safe Exam Browser
- [ ] SEB installed on the test machine and `pariksarakshak.seb` built
- [ ] All six checks in the SEB test protocol pass
- [ ] URL filter allows every domain listed in guide 6 — page fully styled, camera works
- [ ] **`ALLOW_DEV_BYPASS = false` in `config.js`, committed and redeployed**
- [ ] Ordinary Chrome now shows "Open this exam in Safe Exam Browser"

### Afternoon: dress rehearsal, two real students, real lab machines
- [ ] A 20-minute mock paper: two MCQs, one fill-in-the-blanks, one coding question
- [ ] Both students open the `.seb` file, sign in and finish the paper
- [ ] Deliberately misbehave — look away, bring a second face into frame. Both alerts
      reach the console within a few seconds
- [ ] Scores are correct; the CSV export opens cleanly in Excel
- [ ] The timer force-submits at 00:00
- [ ] Supabase dashboard opened today, so the project will not be paused tomorrow

---

## Exam-day runbook

1. **The day before.** Open the Supabase dashboard. Load the exam page inside SEB on one
   lab machine. Confirm every student has an account with a roll number.
2. **One hour before.** Create or check the paper: correct code, correct open and close
   times, questions saved. Write the exam code on the board.
3. **At the start.** Students double-click the `.seb` file. The invigilator holds the
   quit password and does not share it.
4. **During.** Watch the room panel. Treat an alert as a prompt to walk over and look,
   not as a verdict — the system reports, people decide.
5. **After.** Export the CSV. Mark long answers. Take a backup from Database → Backups.

---

## When something breaks

| What you see | Likely cause | What to do |
|---|---|---|
| "No live exam with that code" | not published, or outside the open window | check `starts_at` and `ends_at`; they are stored in UTC |
| The paper loads with no questions | same as above — the view only returns live papers | fix the times, or save questions to the right paper |
| Drafting fails with 502 | model name changed, or the free allowance is used up | check the model name in AI Studio, re-set the secret |
| Code runs time out | the public Piston API is busy | retry; if it persists, see guide 4.4 |
| The room panel stays silent | the table is not in the publication, or the channel did not subscribe | re-run the `alter publication` line; check the browser console |
| The exam page is unstyled inside SEB | a domain is missing from the URL filter | add it in the SEB Network tab |
| The camera is black inside SEB | camera not allowed in the SEB Security tab | allow it, and keep `camera=(self)` in `vercel.json` |
| Everyone is blocked at the SEB gate | the JavaScript API is off | turn it on in the SEB Browser tab |
| The site is suddenly unreachable | the free project paused after a quiet week | open the dashboard and wait about two minutes |

---

You now have an examination system that costs nothing to run, writes its own first
draft, keeps its answers where students cannot reach them, and shows you the room while
the paper is open. Invigilators still invigilate — the system reports, people decide.
