# 00 · Set it all up in one sitting

Roughly 90 minutes, start to finish, done once. Work straight down the page.
Nothing here is optional and nothing is left for "day two".

**What you need open:** this file, the unzipped project folder, and a browser.

| Part | What you do | Minutes |
|---|---|---|
| A | Create the four free accounts | 10 |
| B | Build the database (two pastes) | 6 |
| C | Fill in two keys | 3 |
| D | Put the code on GitHub and Vercel | 15 |
| E | Deploy the six functions | 15 |
| F | Make yourself faculty, load the demo paper | 5 |
| G | Build the Safe Exam Browser file and publish it | 20 |
| H | Run the setup check — it tests everything | 5 |
| I | Sit the demo paper through the real launch | 10 |
| J | Enrol your students | 5 |

---

## A · Accounts

Create all four now, signing in **with GitHub** wherever it is offered — it saves
you a password each time.

1. **GitHub** — https://github.com
2. **Vercel** — https://vercel.com → *Continue with GitHub*
3. **Supabase** — https://supabase.com → *Continue with GitHub*
4. **Google AI Studio** — https://aistudio.google.com → **Get API key** → copy it somewhere safe

Also download **Safe Exam Browser** for Windows from
https://safeexambrowser.org/download_en.html and install it on the machine you
are working on. You will need it in part I.

---

## B · The database

1. In Supabase: **New project**. Name it `pariksarakshak`, region **Mumbai
   (ap-south-1)**, set a strong database password and save it.
2. Wait about two minutes for it to finish building.
3. Open **SQL Editor → New query**.
4. Open `supabase/migrations/001_schema.sql` from the project folder, select all,
   copy, paste into the editor, press **Run**.

You should see *Success. No rows returned.* That script creates every table, the
security rules, the student view that strips answer keys, and the grading
functions. It begins by dropping anything it is about to create, so if you ever
need to start over you can simply run it again.

5. **New query** again. Paste **`supabase/migrations/003_seb_launch_and_hardening.sql`**
   and **Run**. This one takes the write permissions the browser does not need,
   moves faculty actions behind ownership-checked functions, and creates the table
   behind the *Start secure exam* button. Both scripts are required.

6. **Project Settings → API.** Keep this tab open — you need two values from it
   in part C:
   - **Project URL**
   - **anon public** key

Ignore the `service_role` key for now. It has its own place in part E, and it must
never go anywhere near the website files.

7. **Authentication → Sign In / Providers → Email:** turn **Confirm email OFF**.
   Lab accounts must work the second they are made.

---

## C · Two keys

Open `public/js/config.js` in Notepad or any editor. Replace the two placeholders
with the values from step B5:

```javascript
export const SUPABASE_URL = "https://abcd1234.supabase.co";
export const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6...";
export const INSTITUTE_NAME = "Shri Khushal Das University";
```

While you are here, the rest of the file is worth a glance — camera on or off,
autosave delay, and the testing bypass you will switch off in part I. Leave the
defaults for now.

Save the file.

---

## D · GitHub, then Vercel

### Upload

1. https://github.com/new → name it `pariksarakshak` → **Private** is fine → do
   **not** add a README.
2. On the empty repository page click **uploading an existing file**.
3. Open your project folder, select **everything inside it** (not the folder
   itself), drag it into the browser, wait for the uploads to finish, then
   **Commit changes**.

> Drag-and-drop keeps folders but skips empty ones. If `supabase/functions/` looks
> empty afterwards, drag that one folder in again on its own.

If you have Git installed, this is the same thing in four lines:

```bash
cd pariksarakshak
git init && git add . && git commit -m "first upload"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/pariksarakshak.git
git push -u origin main
```

### Deploy

1. Vercel → **Add New → Project** → import `pariksarakshak`.
2. Framework Preset **Other**. Build Command **empty**. Output Directory
   **`public`**. Install Command **empty**.
3. **Deploy.** It takes under a minute; there is nothing to build.
4. Open the URL it gives you. The landing page should appear with the logo and
   the seating plan animating.

### Tell Supabase where the site lives

**Supabase → Authentication → URL Configuration:**
- Site URL: `https://your-app.vercel.app`
- Redirect URLs: add `https://your-app.vercel.app/**`

Every future change works like this: edit a file on GitHub, commit, and Vercel
redeploys in seconds.

---

## E · The six functions

These run on Supabase, not Vercel, and they hold the secrets. Install Node.js
from https://nodejs.org first if you do not have it, then in a terminal:

```bash
npm install -g supabase
supabase login
supabase link --project-ref YOUR_PROJECT_REF
```

`YOUR_PROJECT_REF` is the `abcd1234` part of your Supabase URL.

Store the Gemini key as a secret — never in a file:

```bash
supabase secrets set GEMINI_API_KEY=AIza...your-key...
```

Then, from inside the project folder, deploy all six. **The last two need
`--no-verify-jwt`** — they run before the student has a session inside SEB, so
Supabase must not demand one:

```bash
supabase functions deploy generate-questions
supabase functions deploy run-code
supabase functions deploy manage-students
supabase functions deploy create-seb-launch

supabase functions deploy exchange-seb-launch --no-verify-jwt
supabase functions deploy verify-seb          --no-verify-jwt
```

| Function | What it does | Why it cannot live in the browser |
|---|---|---|
| `generate-questions` | Drafts a paper with Gemini | Holds the Gemini key |
| `run-code` | Runs student code against every test | Reads hidden tests and writes marks |
| `manage-students` | Creates student accounts in bulk | Holds the service key |
| `create-seb-launch` | Mints the two-minute launch token | Writes a table no browser may touch |
| `exchange-seb-launch` | Signs the student in inside SEB | Holds the service key; runs before sign-in |
| `verify-seb` | Confirms SEB is using *your* configuration | Holds the Config Key secret |

> `--no-verify-jwt` does not mean unprotected. Both functions check their own
> evidence — a single-use token in one case, a cryptographic Config Key in the
> other. It only tells Supabase not to require a session that cannot exist yet.

---

## F · Become faculty, load the demo paper

1. Open your site, go to **Sign in**, choose **New student**, and register with
   your own email, name and any roll number. This creates the account.
2. Back in Supabase **SQL Editor**, promote it:

```sql
update public.profiles
   set role = 'faculty', full_name = 'Your Name'
 where id = (select id from auth.users order by created_at desc limit 1);
```

3. Load the demo paper: open `supabase/migrations/002_demo_paper.sql`, paste it
   into the SQL editor, **Run**. It creates a live paper with the code `DEMO-01`
   containing one of each question type, including a coding question with visible
   and hidden tests.

4. Sign in again on your site. You should land on the console.

---

## G · Safe Exam Browser, and the launch link

This is the part that turns "double-click a file" into "press a button". Full
detail is in `docs/05-SAFE-EXAM-BROWSER.md`; here is the path through it.

1. Open the **SEB Configuration Tool** (installed with SEB).
2. **General:** Start URL `https://your-app.vercel.app/exam.html`. Set an
   administrator password, and a **different** quit password. Only invigilators
   learn the quit password.
3. **Browser:** turn **Enable JavaScript API on**. Without it the page cannot
   prove it is SEB, and nobody gets in.
4. **Exam:** turn **Allow Query Parameter on**. Without it the launch token never
   reaches the page, and students would have to type the exam code by hand.
5. **Security:** kiosk mode **create new desktop**, virtual machines **off**,
   screen capture **off**, clipboard **blocked**, camera **allowed**.
6. **Applications:** add the prohibited process list from guide 05.
7. **Network → Filter:** allow your Vercel domain plus `*.supabase.co`,
   `cdn.jsdelivr.net`, `cdnjs.cloudflare.com`, `storage.googleapis.com`,
   `fonts.googleapis.com`, `fonts.gstatic.com`.
8. **File → Save As…** → save it as **`public/seb/pariksarakshak.seb`** inside
   the project folder. Commit that file so Vercel serves it — the *Start secure
   exam* button builds its link from that exact path.

### Then give the server the Config Key

On the **Exam** tab the tool shows a **Config Key** — 64 characters. That is what
lets the server tell your configuration apart from a copied or home-made one.

```bash
supabase secrets set SEB_CONFIG_KEY=<paste the 64-character key>
supabase functions deploy verify-seb --no-verify-jwt
```

Until this is set, the exam page blocks everybody and says exactly why. That is
the right direction to fail in, and the setup check flags it long before an exam.

> **Rebuild the .seb file later and the key changes.** Whenever you edit the
> configuration, set the secret again and redeploy `verify-seb`. Guide 07 lists
> the symptom, which is every student being blocked at once.

Finally, close the testing bypass. In `public/js/config.js`:

```javascript
export const ALLOW_DEV_BYPASS = false;
```

Commit it. (Even left `true`, it only works on `localhost` — but set it anyway.)

---

## H · The setup check

Open **`https://your-app.vercel.app/setup.html`**, press **Run the checks**, then
sign in on that page with your faculty account and run them once more.

It tests the real system: keys, tables, whether answer keys and hidden tests are
actually unreachable, realtime, all six functions, whether the `.seb` file is
published, whether the Config Key is set and correctly rejects a wrong one, the
camera, and Safe Exam Browser. Anything red names the fix.

**Do not continue past this point with a red row.** Every red row is a way exam
day goes wrong.

---

## I · Sit the demo paper through the real launch

Ten minutes here is worth more than any amount of reading. Do it on a machine
with SEB installed.

1. Open a **private window**, register a test student, and sign in.
2. You land on the **student portal**. The demo paper is listed.
3. Press **Start secure exam**. The browser asks *Open Safe Exam Browser?* —
   choose **Open**.
4. SEB starts, the machine locks, and the paper opens **already signed in**, with
   no code typed and no password retyped. That is the whole flow working.
5. Read the rules screen, tick the box, begin.
6. Answer the MCQ and the blanks. Watch "saved" appear beside each question.
7. On the coding question press **Run visible tests** with the unfinished starter
   code — it should fail. Then complete it (`print(sum(nums))`) and press **Submit
   for marks**. Every test passes, and hidden ones show only pass or fail, never
   their input.
8. Cover the camera. After five seconds the paper is covered with an explanation;
   uncover it and the paper comes straight back.
9. Submit. Quit SEB with the quit password.
10. On your own machine, open the console → **The room**. Your incident is there
    and the roster shows the attempt. Then **Results** → the score. Mark the long
    answer and watch the total change.

Two more things worth testing while you are here, because both will happen:

- Open `https://your-app.vercel.app/exam.html` directly in ordinary Chrome. It
  must refuse and point you back to the portal.
- Press **Start secure exam**, then wait three minutes before approving the
  prompt. The launch must fail as expired — that is the two-minute window doing
  its job.

---

## J · Enrol your students

In the console, open the **Students** tab. Paste your roll list, one per line:

```
23BCS114, Aarti Sharma
23BCS115, Rohit Verma
23BCS116, Simran Kaur
```

Press **Create accounts**. Every student gets an account and a generated password.
**Download the slips as CSV immediately** — the passwords are shown once and never
again. Print, cut, and hand them out at the door.

Forgotten password on exam day? Same tab, right-hand panel: type the roll number,
press **Reset**, read out the new one.

---

## Ready

You now have: a live site, a locked database, six deployed functions, a published
`.seb` file with its key on the server, and enrolled students.

To run a real exam, follow `docs/06-EXAM-DAY-RUNBOOK.md`. Making the paper takes
about ten minutes: **Papers** tab to create it, **Questions** tab to draft or write
the questions. Students do not need the code — the paper simply appears on their
portal when you open it.

One habit worth keeping: **open your Supabase dashboard the day before every
exam.** Free projects pause after about a week of no traffic, and waking one takes
two minutes you will not want to spend with sixty students waiting.
