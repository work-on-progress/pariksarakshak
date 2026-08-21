# 4 · Code runner — the `run-code` function

The code is in **`supabase/functions/run-code/index.ts`**. It executes a student's
program against the test cases and decides the marks. The browser is never trusted
with either job.

## 4.1 How the hidden tests stay hidden

```
Student page                  run-code (server)                Piston
────────────                  ─────────────────                ──────
POST {attempt_id,             1 who is this? (token)
      question_id,            2 is this their attempt,
      code, mode}               still in progress, exam open?
                              3 read ALL tests with the
                                service role key           ──►  execute
                              4 compare stdout             ◄──  stdout
                              5 write marks to `answers`
   ◄────────────────────      6 reply with verdicts only
{passed: 6, total: 7,
 results: [
   {name:"Example 1", pass:true, got:"3", expected:"3"},
   {name:"Hidden test 3", pass:false}      ← nothing else
 ]}
```

Two independent walls, and both must hold:

- **The database** refuses to return `is_hidden = true` rows to a student token.
- **The function** builds hidden entries with only a name and a pass flag, so even a
  bug elsewhere cannot leak the input or the expected output.

## 4.2 The two modes

| Mode | Runs | Shows | Writes marks |
|---|---|---|---|
| `run` | visible tests only | input, expected, actual output, errors | no |
| `submit` | every test | pass or fail for hidden ones | yes |

Full marks require every test to pass. To award partial credit instead, change one
line in the function:

```typescript
auto_marks: allPassed ? Number(q.marks) : 0,
// becomes
auto_marks: Number(q.marks) * passed / tests.length,
```

## 4.3 Deploy

```bash
supabase functions deploy run-code
```

Languages are mapped at the top of the file. Python, C, C++, Java and JavaScript are
configured; add more from the Piston runtime list by copying a line in `LANG_MAP`.

## 4.4 Rate limits and a lab of sixty

The public Piston API is shared, so the function runs tests one at a time with a
250 ms pause. A seven-test submission takes roughly three to five seconds — fine,
because students press Submit at different moments.

If a whole lab submits at once and you see timeouts, you have three options, in order
of effort:

1. Stagger the closing time, or ask students to submit as they finish rather than all
   at the end.
2. Reduce hidden tests from five to three per question.
3. Self-host Piston with Docker on a free VM and change `PISTON_URL`. Same code, same
   cost, no shared rate limit.

## 4.5 Verify the protection yourself

While testing in an ordinary browser with `?dev=1`:

1. Open DevTools → Network.
2. Press **Submit for marks** on a coding question.
3. Open the `run-code` response. Hidden entries must read exactly
   `{"name":"Hidden test 2","pass":false,"hidden":true}` — no `got`, no `expected`,
   no `stdin`.
4. In SQL Editor as the `authenticated` role, run
   `select * from test_cases where is_hidden = true;` — nothing comes back.

## 4.6 Writing coding questions by hand

The drafting function prefers stdin/stdout problems because they work identically in
every language. If you add a question yourself:

- Put the input parsing in `starter_code` and leave a clear `# TODO`.
- Make `expected_out` byte-exact. Trailing spaces cause false failures; the runner
  trims the end of each line's output and the expected value, nothing more.
- Mark two test cases `is_hidden = false` and show them in the prompt as worked
  examples, so students know the format.
- Put the awkward cases in the hidden set: empty input, the largest allowed size,
  negatives, duplicates, a single element.

Next → [05 · Frontend](05-FRONTEND.md)
