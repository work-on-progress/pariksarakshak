<p align="center">
  <img src="public/assets/logo-lockup.svg" alt="PariksaRakshak" width="420">
</p>

<p align="center">
  <b>Sealed examinations.</b><br>
  Safe Exam Browser lockdown · server-side grading · live invigilation · ₹0 a month
</p>

---

## What this is

PariksaRakshak runs objective and coding examinations in a university lab. It locks
each machine with Safe Exam Browser, keeps answer keys and hidden test cases in the
database where no browser can reach them, drafts question papers from your lecture
notes, and shows you the room while the exam is running.

Every part runs on a permanent free tier: Vercel, Supabase, the public Piston API,
the Gemini free tier, MediaPipe in the browser, and Safe Exam Browser itself.

## Follow the guides in order

| # | Guide | What you build |
|---|-------|----------------|
| 0 | [Upload and deploy](docs/00-UPLOAD-AND-DEPLOY.md) | The zip into GitHub, then live on Vercel |
| 1 | [Architecture](docs/01-ARCHITECTURE.md) | How the pieces fit and what the free tiers allow |
| 2 | [Database](docs/02-SUPABASE-DATABASE.md) | Tables, row-level security, server-side grading |
| 3 | [Question drafting](docs/03-GEMINI-EDGE-FUNCTION.md) | The Gemini Edge Function |
| 4 | [Code runner](docs/04-PISTON-CODE-RUNNER.md) | Secure grading of coding answers |
| 5 | [Frontend](docs/05-FRONTEND.md) | The three pages, the anti-cheat layer, how to rebrand |
| 6 | [Safe Exam Browser](docs/06-SEB-CONFIGURATION.md) | The `.seb` file that locks a lab |
| 7 | [Deployment checklist](docs/07-DEPLOYMENT-CHECKLIST.md) | Three days from empty repo to a real exam |

## Quick start

```bash
# 1. Push this folder to GitHub, then import the repo at vercel.com.
#    Framework preset: Other. Output directory: public

# 2. Create a Supabase project, open SQL Editor and run:
#    supabase/migrations/001_schema.sql

# 3. Put your project URL and anon key in public/js/config.js

# 4. Deploy the two Edge Functions:
npm install -g supabase
supabase login
supabase link --project-ref YOUR_PROJECT_REF
supabase secrets set GEMINI_API_KEY=your-key
supabase functions deploy generate-questions
supabase functions deploy run-code
```

Then follow [docs/07-DEPLOYMENT-CHECKLIST.md](docs/07-DEPLOYMENT-CHECKLIST.md) —
it verifies every security claim above with a test you can actually run.

## Repository layout

```
pariksarakshak/
├── public/                     ← this folder is what Vercel serves
│   ├── index.html              ← landing page and sign in
│   ├── faculty.html            ← console: papers, drafting, the room, results
│   ├── exam.html               ← the paper, locked to Safe Exam Browser
│   ├── assets/                 ← logo mark, lockup, favicon
│   ├── css/  theme.css · landing.css · app.css
│   └── js/   config.js · supabaseClient.js · landing.js
│             faculty.js · exam.js · anticheat.js · proctor.js
├── supabase/
│   ├── migrations/001_schema.sql
│   └── functions/generate-questions/ · run-code/
├── seb/                        ← your built .seb file goes here
├── docs/                       ← the seven guides
└── vercel.json                 ← security headers
```

## The one rule

Two keys exist. The **anon key** belongs in `public/js/config.js` — row-level security
decides what it may read. The **service role key** and the **Gemini key** belong only
in Supabase Edge Function secrets. If either ever appears under `public/`, rotate it
immediately.

```bash
# run this before every push
grep -ri "service_role" public/ && echo "STOP — remove that key"
```

## Before a real exam

- Set `ALLOW_DEV_BYPASS = false` in `public/js/config.js` and redeploy.
- Open your Supabase dashboard the day before: free projects pause after about a
  week of inactivity.
- Keep the SEB quit password with the invigilator, not with the students.

MIT licensed. Built for classroom use — invigilators still invigilate.
