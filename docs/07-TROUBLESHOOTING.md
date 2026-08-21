# 07 · When something breaks

Start with `setup.html`. It tests the real system and names the fix for most of
what follows.

## Setting up

| What you see | Cause | Fix |
|---|---|---|
| Landing page loads unstyled | Output directory is wrong | Vercel → Settings → Build and Deployment → Output Directory = `public`, redeploy |
| "Invalid API key" on sign in | `config.js` still has placeholders | Paste the project URL and anon key, commit, wait for the redeploy |
| Setup check: tables do not exist | The schema never ran | SQL Editor → paste `001_schema.sql` → Run |
| Setup check: realtime did not connect | The table is not in the publication | Re-run `alter publication supabase_realtime add table public.incident_logs;` |
| Setup check: a function is not deployed | Missing deploy step | `supabase functions deploy <name>` from the project folder |
| Setup check: exchange deployed with JWT checking on | Missing flag | `supabase functions deploy exchange-seb-launch --no-verify-jwt` |
| Setup check: no Config Key on the server | Secret never set | Read the key from the SEB Exam tab, then `supabase secrets set SEB_CONFIG_KEY=…` and redeploy `verify-seb` |
| Setup check: the .seb file is missing | Never built, or not committed | Build it (guide 05), save to `public/seb/`, commit so Vercel serves it |
| `supabase link` refuses | Wrong project ref | It is the `abcd1234` part of your Supabase URL |
| Sign-up says "email not confirmed" | Confirmation is still on | Authentication → Sign In / Providers → Email → Confirm email off |

## Writing the paper

| What you see | Cause | Fix |
|---|---|---|
| Drafting fails, 502, model not available | Google renamed the free model | `supabase secrets set GEMINI_MODEL=<current model>` then redeploy the function |
| Drafting fails, allowance used up | Free daily quota | Wait for the reset, or draft fewer questions per call |
| Fewer questions than asked for | The model trimmed a long request | Ask for fewer at a time and draft twice |
| "Only faculty accounts can draft" | Account is still a student | Run the promote query in guide 00, part F |
| Blanks question rejected | Blanks and answers do not match | The prompt needs one `____` per answer in the `A | B` list |

## The secure launch

| What you see | Cause | Fix |
|---|---|---|
| Nothing happens on **Start secure exam** | Safe Exam Browser is not installed on that machine | Install SEB, or move the student to a spare machine |
| "The configuration has not been published yet" | `public/seb/pariksarakshak.seb` is missing on the site | Commit the file; check `https://your-site/seb/pariksarakshak.seb` downloads |
| SEB opens but asks for the exam code | **Allow Query Parameter** is off in the SEB Exam tab | Turn it on, rebuild, reset `SEB_CONFIG_KEY`, redeploy `verify-seb` |
| "That secure launch has expired" | More than two minutes passed, or the link was already used | Press start again. This is the feature working |
| **Every** student blocked at once, after you edited the `.seb` file | Rebuilding changes the Config Key | Set `SEB_CONFIG_KEY` to the new key and redeploy `verify-seb` |
| "SEB did not present a Config Key" | **Enable JavaScript API** is off in the SEB Browser tab | Turn it on and rebuild |
| "The exam server has no SEB Config Key yet" | The secret was never set | `supabase secrets set SEB_CONFIG_KEY=…`, redeploy `verify-seb` |
| Students reach the paper in ordinary Chrome | `STRICT_SEB_VERIFY` is false, or the bypass is on and they are on localhost | Set `STRICT_SEB_VERIFY = true` and `ALLOW_DEV_BYPASS = false`, redeploy |

## During the exam

| What you see | Cause | Fix |
|---|---|---|
| "No live exam with that code" | Not published, or outside the window | Papers tab → check the times and the Publish button. Times are stored in UTC and shown in your local time |
| Paper opens with no questions | Questions were saved to a different paper | Questions tab → check the selector at the top |
| Everyone blocked at the SEB gate | JavaScript API off, or the Config Key does not match this build | See the secure launch table above |
| Page unstyled inside SEB | A domain is missing from the URL filter | Add the list from guide 05 |
| Camera black inside SEB | Camera not allowed in SEB | SEB Security tab → allow camera; keep `camera=(self)` in `vercel.json` |
| Code runs time out | Public Piston is busy | Retry; then see guide 03 on pacing and self-hosting |
| A student is stuck on a submitted paper | Crash after submit | The room tab → **Unlock**, then they press **Resume in SEB** |
| The paper went dark mid-exam | The camera cover, after five seconds without a face | It clears by itself. Turn it off with `LOCK_ON_FACE_LOSS = false` if the lighting is poor |
| Extra time granted but the timer did not change | The page re-reads every 30 seconds | Wait half a minute; no reload needed |
| The room shows nothing | No attempts yet, or wrong paper selected | Check the selector; the roster only shows the chosen paper |
| Site suddenly unreachable | Free project paused after a quiet week | Open the dashboard, wait about two minutes |

## Marks

| What you see | Cause | Fix |
|---|---|---|
| Score lower than expected | Long answers are not marked yet | Results tab → mark them; the total updates as you type |
| Coding question scored zero despite "mostly working" | Full marks need every test to pass | Deliberate. To change it, see guide 03 |
| Coding answers all fail on one test | The expected output has a stray space or newline | Questions tab → Edit → fix the test case |
| A student has no row at all | They never started | Check the roster: "not started" counts enrolled students without an attempt |

## Reading a number wrongly

Two failure modes worth naming, because both look like evidence:

**A high flag count is not proof.** A student sitting near a window, wearing a cap,
or with a dim webcam can trip `NO_FACE_DETECTED` repeatedly while doing nothing
wrong. Use the count to decide where to walk, and decide with your own eyes.

**A low flag count is not innocence.** Nothing here detects a phone under the desk
or a person out of frame. The camera check catches what it catches; the invigilator
catches the rest. The system is a second pair of eyes, not a replacement for the
first.
