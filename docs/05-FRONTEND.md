# 5 · The frontend

Three pages, no build step. Vercel serves `public/` exactly as it is, so what you edit
is what ships.

## 5.1 The only file you must edit

`public/js/config.js`:

```javascript
export const SUPABASE_URL = "https://YOUR_PROJECT_REF.supabase.co";
export const SUPABASE_ANON_KEY = "YOUR_ANON_PUBLIC_KEY";
export const INSTITUTE_NAME = "Shri Khushal Das University";
export const ALLOW_DEV_BYPASS = true;   // set false before a real exam
```

The anon key belongs here. It is designed to be public — row-level security decides
what it can read. The service role key must never appear anywhere under `public/`.

## 5.2 The pages

| File | Who opens it | What it does |
|---|---|---|
| `index.html` | anyone | Explains the system, signs people in, registers students, routes faculty to the console and students to the exam page |
| `faculty.html` | faculty | Create papers, draft and edit questions, watch the room live, read and export results |
| `exam.html` | students, inside SEB | Join by code, sit the paper, run and submit code, autosave, timer, submit |

### The exam page, in order

1. `enforceSEBOrBlock()` — if this is not Safe Exam Browser, the page is replaced with
   a short instruction and no attempt is created.
2. `activateWebLockdown()` — selection, right-click, drag and the copy, cut, paste,
   print, save, select-all and devtools shortcuts are intercepted.
3. Sign-in check, then the exam code.
4. An attempt is created, or the existing one is resumed with previously saved answers
   restored.
5. `activateFocusMonitor()` and `startProctoring()` begin reporting.
6. Answers save 600 ms after typing stops, and a failed save retries by itself.
7. `grade_attempt` runs on submit, and the page is replaced by a receipt.

## 5.3 The anti-cheat layer, honestly

`anticheat.js` is the thinnest of the three layers. Shortcut blocking and selection
locks are deterrence — a determined student with a normal browser could defeat them,
which is exactly why the exam page refuses to run in one. The load-bearing parts are
Safe Exam Browser on the machine and row-level security in the database.

What the browser layer genuinely contributes:

- It **detects** SEB two ways: `window.SafeExamBrowser` (enable the JavaScript API in
  the SEB config) and the `SEB` marker in the user agent.
- It **reports** what SEB cannot: window blur, tab hidden, full screen exited, throttled
  to one event every two seconds so a restless student does not flood the feed.
- It removes the accidental paths — right-click copy, drag-select into another field.

## 5.4 Proctoring

`proctor.js` loads the MediaPipe face detector and samples the camera twice a second.
A condition must persist four seconds before it is logged, so blinking, leaning or
reaching for water does not raise an alert. While a condition persists it is
re-reported every four seconds, which is what makes a walk-out visible in the feed.

The video stream stays on the machine. Nothing is recorded, uploaded or stored — only
the event name, and the console shows it about a second later.

## 5.5 Making it yours

**Institute name** — `INSTITUTE_NAME` in `config.js`, used in the header and footer.

**Logo** — `public/assets/` holds three files. `logo-mark.svg` is the icon used in
headers, `logo-lockup.svg` is the horizontal version with the wordmark,
`favicon.svg` is the browser tab icon. The first two read their colours from CSS
variables, so they invert correctly on the dark exam page. The original artwork is
kept as `logo-original.svg`.

**Colours** — every colour is a token at the top of `public/css/theme.css`. The `:root`
block is the paper surface used by the landing page and console; the `.hall` block is
the night surface used by the exam page. Change a token once and both pages follow.

```css
--blue:  #184F95;   /* the brand blue from the logo — primary actions */
--seal:  #B3352A;   /* the invigilator's stamp — incidents only */
--pass:  #1D6B4F;   /* a test passed */
```

**Type** — three faces, loaded from Google Fonts: Bricolage Grotesque for headings,
Public Sans for body text, JetBrains Mono for codes, timers, seat labels and the code
editor. If your lab blocks Google Fonts, the stack falls back to system faces and the
layout still holds. Remember to allow `fonts.googleapis.com` and `fonts.gstatic.com`
in the SEB URL filter.

**Wording** — the copy is deliberately plain and active. Keep an action's name the same
through the whole flow: the button says *Submit for marks*, so the receipt says
*submitted*, not *sent* or *processed*.

## 5.6 Testing without a lab

Set `ALLOW_DEV_BYPASS = true` and open `exam.html?dev=1` in ordinary Chrome. Everything
works except the SEB gate and full-screen lock, so you can sit a whole paper at your
desk. Two things to remember:

- Chrome allows camera access on `localhost` and on any `https://` origin, so use the
  Vercel URL rather than `file://`.
- **Set `ALLOW_DEV_BYPASS = false` and redeploy before a real exam.** It is the first
  item on the Day 3 checklist for a reason.

Next → [06 · Safe Exam Browser](06-SEB-CONFIGURATION.md)
