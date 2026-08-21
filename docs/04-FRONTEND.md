# 04 · The frontend

Five pages, no build step. Vercel serves `public/` exactly as it is, so what you
edit is what ships.

| File | Who opens it | What it does |
|---|---|---|
| `index.html` | anyone | Explains the system, signs people in, registers students, routes faculty and students to the right page |
| `student.html` | students, ordinary browser | Their papers, and the **Start secure exam** button that launches SEB |
| `faculty.html` | faculty | Papers, questions, students, the room, results |
| `exam.html` | students, inside SEB only | Rules, the paper, code runs, autosave, timer, submit |
| `setup.html` | you, once | Tests every layer and names what is broken |

## The only file you edit

`public/js/config.js` — the two Supabase values, your institute name, and these:

| Setting | Default | What it changes |
|---|---|---|
| `ALLOW_DEV_BYPASS` | `true` | `exam.html?dev=1` opens without SEB — **on localhost only**, never on the deployed site. Set false anyway before the first real exam |
| `SEB_CONFIG_FILE` | `pariksarakshak.seb` | The file in `public/seb/` the launch link points at |
| `STRICT_SEB_VERIFY` | `true` | Verify SEB's Config Key against the server secret. Off means a faked SEB is accepted |
| `LOCK_ON_FACE_LOSS` | `true` | Cover the paper while the camera sees nobody, or two people |
| `FACE_LOCK_MS` | `5000` | How long before the cover appears |
| `PROCTOR_ENABLED` | `true` | Turn the camera off entirely for a lab without webcams |
| `REQUIRE_CAMERA` | `false` | Warn the student when the camera will not open |
| `AUTOSAVE_DELAY_MS` | `600` | How long after typing stops answers are written |
| `FACE_GRACE_MS` | `4000` | How long a face problem must last before it is logged |
| `HEARTBEAT_MS` | `30000` | How often the exam page checks for granted extra time |
| `STUDENT_EMAIL_DOMAIN` | `exam.local` | The address bulk-created accounts get |

## The exam page, in order

0. If the address carries `?launch=…`, that one-time token is exchanged for a
   sign-in and wiped from the address bar. See guide 09.
1. `enforceSEBOrBlock()` — asks SEB for the Config Key of this URL and has the
   server verify it. Not SEB, or not *your* SEB configuration: no paper, no
   attempt created.
2. `activateWebLockdown()` — selection, right-click, drag, and the copy, cut,
   paste, print, save, select-all and devtools shortcuts.
3. Sign-in check, then the exam code.
4. The rules screen: duration, what is recorded, and a box the student must tick.
   Skipped when resuming an interrupted attempt.
5. The attempt is created — the database refuses if the exam is not live.
6. Questions load from the sanitized view and are shuffled per student.
7. Answers save after typing stops, retry on failure, and mark the progress strip.
8. A heartbeat every thirty seconds picks up extra time granted by faculty.
9. `grade_attempt` runs on submit and the page becomes a receipt.

## Question shuffling

Each student gets a deterministic order seeded from their user id and the exam id.
The same student always sees the same order, so a reload never rearranges the paper —
but the person at the next desk sees something different. Options within a multiple
choice question shuffle the same way. Turn either off per paper when you create it.

## The paper cover

When the camera cannot see a face, or sees more than one, the paper is covered
after five seconds with a plain explanation. The clock keeps running and the
answers stay saved — it is a cover, not a pause, and the student is told exactly
that. Turn it off with `LOCK_ON_FACE_LOSS = false` if your lab lighting makes it
trip on honest students; the incident is still logged either way.

## The anti-cheat layer, honestly

`anticheat.js` is the thinnest of the three layers. Shortcut blocking and selection
locks are deterrence — a determined student in a normal browser could defeat them,
which is exactly why the exam page refuses to run in one. The load-bearing parts are
Safe Exam Browser on the machine and row-level security in the database.

What the browser layer genuinely contributes: it **proves** SEB is running your
exact configuration (the Config Key check, not a user-agent guess), it **reports**
what SEB cannot
(window blur, tab hidden, full screen exited, throttled to one event every two
seconds), and it closes the accidental paths.

## Proctoring

The face detector samples twice a second. A condition must persist four seconds
before it is logged, so blinking, leaning, or reaching for water raises nothing.
While it persists it is re-reported every four seconds, which is what makes a
walk-out visible in the feed rather than a single line.

The video stream stays on the machine. Nothing is recorded, uploaded or stored —
only the event name.

## Making it yours

**Logo** — `public/assets/` holds `logo-mark.svg` (headers), `logo-lockup.svg`
(wordmark), `favicon.svg`, and your original artwork as `logo-original.svg`. The
first two read their colours from CSS variables, so they invert correctly on the
dark exam page.

**Colours** — every colour is a token at the top of `public/css/theme.css`. The
`:root` block is the paper surface; the `.hall` block is the exam page at night.
Change a token once and both follow.

```css
--blue: #184F95;   /* the brand blue from your logo — primary actions */
--seal: #B3352A;   /* the invigilator's stamp — incidents only */
--pass: #1D6B4F;   /* a test passed */
```

**Type** — Bricolage Grotesque for headings, Public Sans for body, JetBrains Mono
for codes, timers and the editor. If your lab blocks Google Fonts the stack falls
back to system faces and the layout holds. Allow `fonts.googleapis.com` and
`fonts.gstatic.com` in the SEB filter.

**Wording** — plain and active, and an action keeps its name through the flow: the
button says *Submit for marks*, so the receipt says *submitted*.
