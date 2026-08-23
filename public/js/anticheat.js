// public/js/anticheat.js
//
// Two delivery modes, two honest levels of protection.
//
//   SEB papers      the operating system refuses the shortcut. The page proves
//                   it is running YOUR configuration by having the server check
//                   SEB's Config Key. Strong.
//
//   Browser papers  a web page cannot stop a screenshot, Alt+Tab, a second
//                   monitor or a phone. What it can do is make casual cheating
//                   awkward, notice when attention leaves, keep the paper open
//                   in only one place, and write all of it down. Deterrence
//                   plus a record — never call it more than that.
import { supabase } from "./supabaseClient.js";
import {
  SUPABASE_URL, SUPABASE_ANON_KEY, ALLOW_DEV_BYPASS, STRICT_SEB_VERIFY, BROWSER_MODE,
} from "./config.js";

let ctx = { attemptId: null, examId: null, studentId: null };
export function setIncidentContext(c) { ctx = { ...ctx, ...c }; }

export async function logIncident(event_type, detail = "") {
  if (!ctx.attemptId) return;
  const { error } = await supabase.from("incident_logs").insert({
    attempt_id: ctx.attemptId,
    exam_id: ctx.examId,
    student_id: ctx.studentId,
    event_type,
    detail: String(detail).slice(0, 300),
  });
  if (error) console.warn("[incident] not logged:", error.message);
}

/* ── 1. THE DEV BYPASS — localhost only, always ─────────────────────── */
export function devBypassActive() {
  if (!ALLOW_DEV_BYPASS) return false;
  const local = ["localhost", "127.0.0.1", "::1"].includes(location.hostname);
  return local && new URLSearchParams(location.search).get("dev") === "1";
}

/* ── 2. IS THIS SAFE EXAM BROWSER? ──────────────────────────────────── */
export function sebPresent() {
  return typeof window.SafeExamBrowser !== "undefined" ||
         /SEB[\s/]/i.test(navigator.userAgent);
}

async function readSebEvidence() {
  const seb = window.SafeExamBrowser;
  if (!seb?.security) return null;

  if (!seb.security.configKey && typeof seb.security.updateKeys === "function") {
    await new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      try { seb.security.updateKeys(finish); } catch { finish(); }
      setTimeout(finish, 1200);
    });
  }
  return {
    version: String(seb.version ?? ""),
    config_key_hash: String(seb.security.configKey ?? ""),
  };
}

/**
 * Decides whether this paper may open here.
 * @param {"seb"|"browser"|"either"} deliveryMode
 * @returns {Promise<{ok: boolean, mode?: "seb"|"browser", reason?: string}>}
 */
export async function checkDelivery(deliveryMode) {
  if (devBypassActive()) return { ok: true, mode: "browser" };

  const inSeb = sebPresent();

  if (deliveryMode === "browser") {
    // A browser paper opened inside SEB is fine — it is only stricter.
    return { ok: true, mode: inSeb ? "seb" : "browser" };
  }

  if (deliveryMode === "either" && !inSeb) {
    return { ok: true, mode: "browser" };
  }

  // From here on the paper requires Safe Exam Browser.
  if (!inSeb) {
    return { ok: false, reason: "This paper must be taken in Safe Exam Browser. Go back to the portal and press Start secure exam." };
  }
  if (!STRICT_SEB_VERIFY) {
    console.warn("[PariksaRakshak] STRICT_SEB_VERIFY is off — SEB is not being verified.");
    return { ok: true, mode: "seb" };
  }

  const evidence = await readSebEvidence();
  if (!evidence?.config_key_hash) {
    return { ok: false, reason: "Safe Exam Browser did not present a Config Key. Turn on the JavaScript API in the SEB configuration." };
  }

  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/verify-seb`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "apikey": SUPABASE_ANON_KEY },
      body: JSON.stringify({
        url: location.href.split("#")[0],
        config_key_hash: evidence.config_key_hash,
        version: evidence.version,
      }),
    });
    const data = await res.json().catch(() => ({}));

    if (res.status === 503 && data.code === "not_configured") {
      return { ok: false, reason: "The exam server has no SEB Config Key yet. The administrator must run: supabase secrets set SEB_CONFIG_KEY=…" };
    }
    if (!res.ok || !data.ok) {
      return { ok: false, reason: data.error || "Safe Exam Browser is not using the approved exam configuration." };
    }
    return { ok: true, mode: "seb" };
  } catch {
    return { ok: false, reason: "Could not reach the exam server to verify Safe Exam Browser. Check the network and try again." };
  }
}

/* ── 3. THE WEB-LAYER LOCK ──────────────────────────────────────────── */
export function activateWebLockdown({ blockCopyPaste = true, blockPrint = true } = {}) {
  const style = document.createElement("style");
  style.textContent = `
    ${blockCopyPaste ? `
      body { -webkit-user-select: none; user-select: none; }
      input, textarea, .CodeMirror, .CodeMirror * { -webkit-user-select: text; user-select: text; }
    ` : ""}
    ${blockPrint ? `
      @media print {
        body::before {
          content: "Printing is not allowed during an examination.";
          display: block; padding: 4rem; font-size: 1.5rem; text-align: center;
        }
        body > * { display: none !important; }
      }
    ` : ""}
  `;
  document.head.appendChild(style);

  if (!blockCopyPaste) return;

  document.addEventListener("contextmenu", (e) => e.preventDefault());
  document.addEventListener("dragstart", (e) => e.preventDefault());

  document.addEventListener("keydown", (e) => {
    const k = e.key.toLowerCase();
    const mod = e.ctrlKey || e.metaKey;
    const devtools = k === "f12" || (mod && e.shiftKey && ["i", "j", "c"].includes(k));
    if ((mod && ["c", "v", "x", "a", "p", "s", "u"].includes(k)) || devtools) {
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);

  ["copy", "cut", "paste"].forEach((ev) =>
    document.addEventListener(ev, (e) => e.preventDefault(), true));
}

/* ── 4. ATTENTION MONITOR ───────────────────────────────────────────────
   In SEB this is a backstop. In a browser paper it is the main signal, so
   the student is shown their own count — people behave differently when
   they can see that something is being written down. */
let switchCount = 0;
export const attentionCount = () => switchCount;

export function activateFocusMonitor({ onSwitch = null, warnAfter = 3, autoSubmitAfter = 0, onAutoSubmit = null } = {}) {
  // blur + visibilitychange usually fire for the same Alt+Tab. `away` makes
  // that one switch, not two incidents/counters.
  let away = false;
  let autoSubmitted = false;

  const recordSwitch = (type) => {
    if (away || autoSubmitted) return;
    away = true;
    switchCount++;

    const hitLimit = autoSubmitAfter > 0 && switchCount >= autoSubmitAfter;
    logIncident(
      type,
      `switch_count=${switchCount}${hitLimit ? "; auto_submit=true" : ""}`,
    );
    onSwitch?.(switchCount, warnAfter);

    if (hitLimit) {
      autoSubmitted = true;
      onAutoSubmit?.(switchCount);
    }
  };

  const returned = () => {
    if (!document.hidden) away = false;
  };

  window.addEventListener("blur", () => recordSwitch("WINDOW_BLUR"));
  window.addEventListener("focus", returned);
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) recordSwitch("TAB_HIDDEN");
    else returned();
  });

  // Fullscreen loss is still recorded, but it does not add a second tab-switch
  // count. The fullscreen cover handles bringing the student back.
  document.addEventListener("fullscreenchange", () => {
    if (!document.fullscreenElement) {
      logIncident("FULLSCREEN_EXIT", `switch_count=${switchCount}`);
    }
  });

  window.addEventListener("beforeunload", (e) => {
    e.preventDefault();
    e.returnValue = "";
  });
}

/* ── 5. FULLSCREEN ──────────────────────────────────────────────────────
   A page cannot force fullscreen back on by itself — the browser requires a
   click. So when fullscreen is lost the paper is covered by a panel with a
   button, and the cover clears the moment they press it. */
export async function requestFullscreen() {
  try {
    await document.documentElement.requestFullscreen?.();
    return true;
  } catch {
    return false;
  }
}

export function watchFullscreen(onLost, onBack) {
  document.addEventListener("fullscreenchange", () => {
    if (document.fullscreenElement) onBack?.();
    else onLost?.();
  });
}

/* ── 6. THE BLOCK SCREEN ────────────────────────────────────────────── */
export function renderBlocked(detail) {
  document.body.className = "hall";
  document.body.innerHTML = `
    <div class="gate">
      <div class="gate-inner">
        <img src="assets/logo-mark.svg" alt="">
        <h1>This paper cannot open here</h1>
        <p class="notice error" style="margin-top:1rem;text-align:left">${escapeHtml(detail)}</p>
        <a class="btn" href="student.html" style="margin-top:1.2rem">Back to my papers</a>
        <p class="meta" style="margin-top:1.4rem;color:var(--ink-3)">No attempt has been started.</p>
      </div>
    </div>`;
}

export const browserDefaults = BROWSER_MODE;

function escapeHtml(v) {
  return String(v ?? "").replace(/[&<>'"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[c]));
}
