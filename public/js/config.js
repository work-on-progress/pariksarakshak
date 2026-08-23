// public/js/config.js
// ══════════════════════════════════════════════════════════════════════════
//  THE ONLY FILE YOU EDIT.  Fill in the two Supabase values and you are done.
// ══════════════════════════════════════════════════════════════════════════

// Supabase → Project Settings → API
export const SUPABASE_URL = "https://kjogruyffpafslowruzz.supabase.co";
export const SUPABASE_ANON_KEY = "sb_publishable_x_7w42XZ09y6el8gdv4ojA_KTUxxTHg";

// The anon key above is meant to be public — row-level security decides what it
// can read. The SERVICE KEY (the other, longer one on the same settings page)
// must NEVER appear in this file or any file inside public/. It belongs only in
// Supabase Edge Function secrets.

// ---- Shown to people ----------------------------------------------------
export const INSTITUTE_NAME = "";
export const SUPPORT_NOTE = "Ask your invigilator if anything on this page does not work.";

// ---- Student accounts ---------------------------------------------------
// Bulk-created accounts get the address  <rollno>@<STUDENT_EMAIL_DOMAIN>.
// It never needs to receive mail, so a fake domain is fine and deliberate.
export const STUDENT_EMAIL_DOMAIN = "exam.local";

// ---- Safe Exam Browser launch -------------------------------------------
// The student portal builds  sebs://your-site/seb/<SEB_CONFIG_FILE>?launch=…
// so this must match the file you save into public/seb/.
export const SEB_CONFIG_FILE = "pariksarakshak.seb";

// true  → the exam page asks the server to verify SEB's Config Key, so a copied
//         or edited .seb file is rejected. This is the setting you want.
// false → falls back to checking only that SEB is present, which a determined
//         student can fake. Use it only until you have set the SEB_CONFIG_KEY
//         secret; the setup page keeps warning while it is off.
export const STRICT_SEB_VERIFY = true;

// ---- Exam behaviour -----------------------------------------------------
export const ALLOW_DEV_BYPASS = false;
export const PROCTOR_ENABLED = true;

// Camera still monitors and reports,
// but it NEVER hides or blocks the exam paper.
export const LOCK_ON_FACE_LOSS = false;

// Kept at 30 sec in case blocking is ever enabled again.
export const FACE_LOCK_MS = 30000;

export const AUTOSAVE_DELAY_MS = 600;

// Only record a face issue if it persists for 30 seconds.
export const FACE_GRACE_MS = 30000;

export const HEARTBEAT_MS = 30000;
