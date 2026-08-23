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
export const STUDENT_EMAIL_DOMAIN = "exam.local";

// ---- Safe Exam Browser launch -------------------------------------------
export const SEB_CONFIG_FILE = "pariksarakshak.seb";
export const STRICT_SEB_VERIFY = true;

// ---- Exam behaviour -----------------------------------------------------
export const ALLOW_DEV_BYPASS = false;
export const PROCTOR_ENABLED = true;
export const LOCK_ON_FACE_LOSS = false;
export const FACE_LOCK_MS = 30000;
export const AUTOSAVE_DELAY_MS = 600;
export const FACE_GRACE_MS = 30000;
export const HEARTBEAT_MS = 30000;

// ---- Browser-delivered papers -------------------------------------------
export const BROWSER_MODE = {
  requireFullscreen: true,
  blockOnFullscreenExit: true,
  blockCopyPaste: true,
  blockPrint: true,
  warnOnTabSwitch: true,
  singleSession: true,
  // Exactly three genuine switches away end an ordinary-browser attempt.
  autoSubmitAfterSwitches: 3,
};

// ---- Document import ----------------------------------------------------
export const PDFJS_URL = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
export const PDFJS_WORKER = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
export const MAMMOTH_URL = "https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js";
