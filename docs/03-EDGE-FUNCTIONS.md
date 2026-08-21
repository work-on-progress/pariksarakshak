# 03 · The six functions

All six live in `supabase/functions/`, run on Supabase, and hold the secrets that
must never reach a browser.

```bash
supabase functions deploy <name>

# these two run before the student has a session inside SEB:
supabase functions deploy exchange-seb-launch --no-verify-jwt
supabase functions deploy verify-seb          --no-verify-jwt
```

| Function | Holds | Called by |
|---|---|---|
| `generate-questions` | the Gemini key | faculty console |
| `run-code` | the service key, hidden tests | the exam page |
| `manage-students` | the service key | faculty console |
| `create-seb-launch` | the service key | the student portal |
| `exchange-seb-launch` | the service key | the exam page, inside SEB |
| `verify-seb` | the SEB Config Key | the exam page, on every load |

---

## `generate-questions` — drafting a paper

**What it does.** Checks the caller is faculty, builds a prompt from your topic and
notes, calls Gemini with a strict `responseSchema` so the reply is always valid JSON
in the exact shape the database expects, and hands the draft back for you to edit.
Nothing is written to the database until you press **Save to paper**.

**Changing what it writes.** Everything you would want to change is the `prompt`
string in the file:

| To change | Edit |
|---|---|
| Marks per type | the mark values listed in the prompt |
| Difficulty wording | the console already sends easy / moderate / hard |
| Number of hidden tests | the "5 to 7 test cases" sentence |
| Question language | the console sends English by default; the prompt honours anything you pass as `question_language` |
| Style rules | add a line, e.g. "Aim at first-year students; avoid trick questions" |

**If the model name changes.** Google renames free models occasionally. You do not
need to edit the file:

```bash
supabase secrets set GEMINI_MODEL=gemini-2.5-flash
supabase functions deploy generate-questions
```

**Lecture PDFs.** Do not upload files. Copy the text out and paste it into the
**Lecture notes** box; the prompt tells the model to stay inside that text. Anything
past roughly 30,000 characters is trimmed, so paste one unit at a time.

---

## `run-code` — grading coding answers

```
Student page                run-code (server)              Piston
────────────                ─────────────────              ──────
POST {attempt_id,           1 who is this?
      question_id,          2 their attempt? in progress?
      code, mode}             exam open?
                            3 read ALL tests with the
                              service key             ──►  execute
                            4 compare stdout          ◄──  stdout
                            5 write marks to `answers`
   ◄──────────────────      6 reply with verdicts only
{passed: 6, total: 7,
 results: [
   {name:"Example 1", pass:true, got:"3", expected:"3"},
   {name:"Hidden test 3", pass:false}     ← nothing else
 ]}
```

Two independent walls protect hidden tests, and both must hold: the database
refuses those rows to a student token, and the function builds hidden entries with
only a name and a pass flag.

| Mode | Runs | Shows | Writes marks |
|---|---|---|---|
| `run` | visible tests only | input, expected, actual, errors | no |
| `submit` | every test | pass or fail for hidden ones | yes |

**Partial credit.** Full marks currently need every test to pass. To award
proportionally, change one line:

```typescript
auto_marks: allPassed ? Number(q.marks) : 0,
// becomes
auto_marks: Number(q.marks) * passed / tests.length,
```

**Rate limits.** The public Piston API is shared, so tests run one at a time with a
250 ms pause. A seven-test submission takes three to five seconds, which is fine
because students submit at different moments. If a whole lab submits at once and you
see timeouts, in order of effort: ask students to submit as they finish; cut hidden
tests from five to three; or self-host Piston with Docker and point the function at
it — no code change needed:

```bash
supabase secrets set PISTON_URL=https://your-piston-host/api/v2/piston/execute
supabase functions deploy run-code
```

**Languages.** Python, C, C++, Java and JavaScript are mapped at the top of the
file. Add more by copying a line in `LANG_MAP`.

---

## `manage-students` — accounts in bulk

**What it does.** Takes a roll list, creates an auth account for each student with a
generated password, writes the name and roll number into their profile, and returns
the list of logins **once**. It also resets a single password on request.

Addresses are built as `<rollno>@<STUDENT_EMAIL_DOMAIN>` from `config.js`. That
address never needs to receive mail — the accounts exist only to sign in — so a
domain like `exam.local` is deliberate, not a mistake.

Passwords avoid look-alike characters (no `0`/`O`, no `1`/`l`), because a student
will be typing one off a paper slip with an invigilator watching.

**The one rule.** Download the CSV as soon as the accounts are made. The passwords
are not stored anywhere in readable form and cannot be shown again — only reset.


---

## `create-seb-launch` — the Start button

Checks that the caller is a student, that the paper is published and open, and
that they have not already submitted it. Then mints 32 random bytes, stores only
the SHA-256 hash with a two-minute expiry, deletes any earlier unused token for
the same student and paper, and returns the raw token once.

## `exchange-seb-launch` — signing in inside SEB

Runs with `--no-verify-jwt`, because inside SEB there is no session yet — that is
the entire point of it. It defends itself instead: it claims the token hash with a
single `update … where used_at is null and expires_at > now()`, so the database
picks exactly one winner even if the link is used twice at once. Then it confirms
the paper is still open and returns a one-time magic-link token, which the exam
page spends immediately and wipes from the address bar.

## `verify-seb` — is this really your configuration?

Also `--no-verify-jwt`, and it holds one secret: `SEB_CONFIG_KEY`. The exam page
sends the current URL and the Config Key hash that SEB reports for it. The
function recomputes `sha256(url + key)` and compares in constant time.

```bash
supabase secrets set SEB_CONFIG_KEY=<the 64-character key from the SEB Exam tab>
supabase functions deploy verify-seb --no-verify-jwt
```

If the secret is missing the function replies `not_configured`, and the exam page
blocks everyone with that exact message rather than quietly letting them through.
Rebuild the `.seb` file and the key changes — set the secret again, or every
student is blocked at once.