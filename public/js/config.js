// public/js/config.js
// ── The only file you edit after cloning. ──────────────────────────────
// The anon key is designed to be public: row-level security decides what it
// can read. NEVER put the service_role key here — it belongs only in
// Supabase Edge Function secrets.

export const SUPABASE_URL = "https://YOUR_PROJECT_REF.supabase.co";
export const SUPABASE_ANON_KEY = "YOUR_ANON_PUBLIC_KEY";

// Shown in the header and footer.
export const INSTITUTE_NAME = "Shri Khushal Das University";

// Set to false before a real exam. When true, exam.html can be opened in a
// normal browser with ?dev=1 for testing.
export const ALLOW_DEV_BYPASS = true;
