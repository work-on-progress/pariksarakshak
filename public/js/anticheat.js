// public/js/anticheat.js
// Three jobs: verify Safe Exam Browser, close the casual web-layer loopholes,
// and report focus events. The real enforcement is SEB (machine) and RLS
// (database) — this file is the thin layer between them.
import { supabase } from "./supabaseClient.js";
import { ALLOW_DEV_BYPASS } from "./config.js";

let ctx = { attemptId: null, examId: null, studentId: null };
export function setIncidentContext(c) { ctx = { ...ctx, ...c }; }

export async function logIncident(event_type, detail = "") {
  if (!ctx.attemptId) return;
  await supabase.from("incident_logs").insert({
    attempt_id: ctx.attemptId,
    exam_id: ctx.examId,
    student_id: ctx.studentId,
    event_type,
    detail: String(detail).slice(0, 300),
  });
}

/* ── 1. IS THIS SAFE EXAM BROWSER? ─────────────────────────────────────
   Two independent signals: the SEB JavaScript API object (enable it in the
   SEB config → Browser tab) and the SEB marker in the user agent. */
export function isRunningInSEB() {
  const jsApi = typeof window.SafeExamBrowser !== "undefined";
  const ua = /SEB[\s/]/i.test(navigator.userAgent);
  return jsApi || ua;
}

export function devBypassActive() {
  return ALLOW_DEV_BYPASS &&
         new URLSearchParams(location.search).get("dev") === "1";
}

/** Returns true if the page may continue; otherwise replaces the page. */
export function enforceSEBOrBlock() {
  if (devBypassActive()) return true;
  if (isRunningInSEB()) return true;

  document.body.className = "hall";
  document.body.innerHTML = `
    <div class="gate">
      <div class="gate-inner">
        <img src="assets/logo-mark.svg" alt="">
        <h1>Open this exam in Safe Exam Browser</h1>
        <p>The paper will not load in an ordinary browser. Double-click the
           <b>.seb</b> file your department gave you — it opens this page with
           the machine locked.</p>
        <p class="meta" style="margin-top:1.5rem">No attempt has been started.
           Ask the invigilator if the file is missing.</p>
      </div>
    </div>`;
  logIncident("SEB_CHECK_FAILED", navigator.userAgent);
  return false;
}

/* ── 2. WEB-LAYER LOCK ──────────────────────────────────────────────── */
export function activateWebLockdown() {
  const style = document.createElement("style");
  style.textContent = `
    body { -webkit-user-select: none; user-select: none; }
    input, textarea, .CodeMirror, .CodeMirror * { -webkit-user-select: text; user-select: text; }
  `;
  document.head.appendChild(style);

  document.addEventListener("contextmenu", (e) => e.preventDefault());
  document.addEventListener("dragstart", (e) => e.preventDefault());

  document.addEventListener("keydown", (e) => {
    const k = e.key.toLowerCase();
    const mod = e.ctrlKey || e.metaKey;
    const blockedWithMod = ["c", "v", "x", "a", "p", "s", "u"];
    const devtools = k === "f12" || (mod && e.shiftKey && ["i", "j", "c"].includes(k));
    if ((mod && blockedWithMod.includes(k)) || devtools) {
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);

  ["copy", "cut", "paste"].forEach((ev) =>
    document.addEventListener(ev, (e) => e.preventDefault(), true));
}

/* ── 3. FOCUS AND VISIBILITY ────────────────────────────────────────── */
export function activateFocusMonitor() {
  let last = 0;
  const throttled = (type, detail) => {
    const now = Date.now();
    if (now - last < 2000) return;      // one event per two seconds, at most
    last = now;
    logIncident(type, detail);
  };
  window.addEventListener("blur", () => throttled("WINDOW_BLUR"));
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) throttled("TAB_HIDDEN");
  });
  document.addEventListener("fullscreenchange", () => {
    if (!document.fullscreenElement) throttled("FULLSCREEN_EXIT");
  });
}
