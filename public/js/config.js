// public/js/config.js
// ══════════════════════════════════════════════════════════════════════════
//  THE ONLY FILE YOU EDIT. Fill in the two Supabase values and you are done.
// ══════════════════════════════════════════════════════════════════════════

// Supabase → Project Settings → API
export const SUPABASE_URL = "https://kjogruyffpafslowruzz.supabase.co";
export const SUPABASE_ANON_KEY = "sb_publishable_x_7w42XZ09y6el8gdv4ojA_KTUxxTHg";

// The anon key above is meant to be public — row-level security decides what it
// can read. The SERVICE KEY must NEVER appear in public/.

export const INSTITUTE_NAME = "";
export const SUPPORT_NOTE = "Ask your invigilator if anything on this page does not work.";

export const STUDENT_EMAIL_DOMAIN = "exam.local";

export const SEB_CONFIG_FILE = "pariksarakshak.seb";
export const STRICT_SEB_VERIFY = true;

export const ALLOW_DEV_BYPASS = false;
export const PROCTOR_ENABLED = true;
export const LOCK_ON_FACE_LOSS = false;
export const FACE_LOCK_MS = 30000;
export const AUTOSAVE_DELAY_MS = 600;
export const FACE_GRACE_MS = 30000;
export const HEARTBEAT_MS = 30000;

// ---- Browser-delivered papers -------------------------------------------
// A genuine switch away is recorded.
// The first five switches do NOT auto-submit.
// The SIXTH genuine switch ends an ordinary-browser attempt automatically.
export const BROWSER_MODE = {
  requireFullscreen: true,
  blockOnFullscreenExit: true,
  blockCopyPaste: true,
  blockPrint: true,
  warnOnTabSwitch: true,
  singleSession: true,
  autoSubmitAfterSwitches: 6,
};

// ---- Document import ----------------------------------------------------
export const PDFJS_URL = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
export const PDFJS_WORKER = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
export const MAMMOTH_URL = "https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js";

// ---- Page extensions ----------------------------------------------------
// These are loaded after the normal page modules finish evaluating.
// No HTML file needs to be changed.
if (typeof window !== "undefined") {
  setTimeout(() => {
    if (document.querySelector(".student-console")) {
      import("./student-history.js").catch((e) =>
        console.error("Student history could not load:", e)
      );
    }

    if (document.getElementById("pane-results") && document.getElementById("resultExam")) {
      import("./faculty-results-release.js").catch((e) =>
        console.error("Result release control could not load:", e)
      );
    }
  }, 0);
}
