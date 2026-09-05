// public/js/config.js
// ══════════════════════════════════════════════════════════════════════════
// PariksaRakshak configuration
// ══════════════════════════════════════════════════════════════════════════

// Supabase → Project Settings → API
export const SUPABASE_URL = "https://kjogruyffpafslowruzz.supabase.co";
export const SUPABASE_ANON_KEY = "sb_publishable_x_7w42XZ09y6el8gdv4ojA_KTUxxTHg";

// The anon key is public by design. Never put the SERVICE ROLE KEY in public/.

export const INSTITUTE_NAME = "";
export const SUPPORT_NOTE =
  "Ask your invigilator if anything on this page does not work.";

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
// One genuine switch is counted once by anticheat.js even when blur and
// visibilitychange fire together.
//
// Switches 1–5: recorded.
// Switch 5: strong warning.
// Switch 6: automatic submission.
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
export const PDFJS_URL =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";

export const PDFJS_WORKER =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

export const MAMMOTH_URL =
  "https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js";

// ---- Page extensions ----------------------------------------------------
// Loaded after each page's normal module finishes evaluating.
// No HTML replacement is required.
if (typeof window !== "undefined") {
  setTimeout(() => {
    // Student dashboard: attempt history + released answer review.
    if (document.querySelector(".student-console")) {
      import("./student-history.js").catch((e) =>
        console.error("Student history could not load:", e)
      );
    }

    // Faculty console.
    if (
      document.getElementById("pane-results") &&
      document.getElementById("resultExam")
    ) {
      import("./faculty-results-release.js").catch((e) =>
        console.error("Result release control could not load:", e)
      );

      import("./faculty-extras.js").catch((e) =>
        console.error("Faculty exam-day enhancements could not load:", e)
      );
    }

    // Exam window.
    if (
      document.getElementById("codeScreen") ||
      document.getElementById("examScreen")
    ) {
      import("./exam-enhancements.js").catch((e) =>
        console.error("Exam enhancements could not load:", e)
      );

      // Strict fullscreen gate + resume protection.
      import("./exam-reliability.js").catch((e) =>
        console.error("Exam reliability guard could not load:", e)
      );
    }

    // Setup check.
    if (
      document.getElementById("checks") &&
      document.getElementById("runBtn")
    ) {
      import("./setup-enhancements.js").catch((e) =>
        console.error("Setup enhancements could not load:", e)
      );
    }
  }, 0);
}
