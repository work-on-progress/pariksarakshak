# 0 · Upload to GitHub and go live

Start here. Twenty minutes from the zip file to a working URL.

## 0.1 Unzip

Extract `pariksarakshak.zip`. You should see this at the top level — if you see a single
folder containing all of it, that is fine too, just use that folder as your project root.

```
pariksarakshak/
├── public/          ← Vercel serves this
├── supabase/        ← schema and the two Edge Functions
├── docs/            ← these guides
├── seb/             ← your .seb file goes here later
├── vercel.json
├── README.md
├── LICENSE
└── .gitignore
```

## 0.2 Put your keys in before uploading

Open `public/js/config.js` and fill in the two values from
**Supabase → Project Settings → API**:

```javascript
export const SUPABASE_URL = "https://abcd1234.supabase.co";
export const SUPABASE_ANON_KEY = "eyJhbGciOi...";
export const INSTITUTE_NAME = "Shri Khushal Das University";
export const ALLOW_DEV_BYPASS = true;
```

The anon key is meant to be public — row-level security controls what it can read.
Never put the `service_role` key in this file.

Haven't created the Supabase project yet? Follow
[02 · Database](02-SUPABASE-DATABASE.md) first, then come back.

## 0.3 Upload to GitHub

### The simple way, no command line

1. Go to https://github.com/new. Name the repository `pariksarakshak`.
   Choose **Private** if you prefer. Do **not** tick "Add a README" — you already have one.
2. On the empty repository page, click **uploading an existing file**.
3. Open the extracted folder, select **everything inside it** (not the folder itself) and
   drag it into the browser window. Wait for all files to finish uploading.
4. Write "first upload" in the commit box and click **Commit changes**.

> GitHub's drag-and-drop keeps folder structure, but it skips empty folders and files
> starting with a dot. If `.gitignore` did not upload, that is harmless.
> If `supabase/functions/` looks empty, upload that folder again on its own.

### With Git, if you have it

```bash
cd pariksarakshak
git init
git add .
git commit -m "first upload"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/pariksarakshak.git
git push -u origin main
```

## 0.4 Deploy on Vercel

1. Go to https://vercel.com and sign in **with GitHub**.
2. **Add New → Project**, and import the `pariksarakshak` repository.
3. Settings to use:

   | Field | Value |
   |---|---|
   | Framework Preset | **Other** |
   | Root Directory | leave as is (the repository root) |
   | Build Command | leave empty |
   | Output Directory | **`public`** |
   | Install Command | leave empty |

4. Click **Deploy**. It takes under a minute — there is nothing to build.
5. Open the URL Vercel gives you. You should see the landing page with the
   PariksaRakshak mark and the hall plan animating.

From now on, every push to `main` redeploys automatically. To edit a file directly on
GitHub: open it, press the pencil icon, change it, commit. Vercel picks it up in seconds.

## 0.5 Point Supabase at your site

**Supabase → Authentication → URL Configuration:**

- **Site URL:** `https://your-app.vercel.app`
- **Redirect URLs:** add `https://your-app.vercel.app/**`

## 0.6 Check it worked

- [ ] The landing page loads, styled, with the logo in the header
- [ ] Sign in with your faculty account opens the console
- [ ] `https://your-app.vercel.app/exam.html` shows "Open this exam in Safe Exam Browser"
- [ ] `https://your-app.vercel.app/exam.html?dev=1` shows the exam-code screen instead

If the page loads unstyled, the output directory is wrong — set it to `public` in
**Vercel → Settings → Build and Deployment** and redeploy.

If sign-in reports an invalid key, `public/js/config.js` still holds the placeholder.

Next → [01 · Architecture](01-ARCHITECTURE.md), or jump to
[07 · Deployment checklist](07-DEPLOYMENT-CHECKLIST.md) to work straight through.
