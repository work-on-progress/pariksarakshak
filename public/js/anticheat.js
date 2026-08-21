// public/js/anticheat.js
// Machine enforcement belongs to Safe Exam Browser. This module proves the page
// really is running inside YOUR saved SEB configuration, adds a thin web-layer
// lock, and reports the focus events SEB cannot report for us.
import { supabase } from "./supabaseClient.js";
import {
  SUPABASE_URL, SUPABASE_ANON_KEY, ALLOW_DEV_BYPASS, STRICT_SEB_VERIFY,
} from "./config.js";

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

/* ── 1. THE DEV BYPASS ─────────────────────────────────────────────────
   Only ever on your own machine. Even with ALLOW_DEV_BYPASS left true by
   mistake, ?dev=1 does nothing on the deployed site. */
export function devBypassActive() {
  if (!ALLOW_DEV_BYPASS) return false;
  const local = ["localhost", "127.0.0.1", "::1"].includes(location.hostname);
  return local && new URLSearchParams(location.search).get("dev") === "1";
}

/* ── 2. IS THIS SAFE EXAM BROWSER? ─────────────────────────────────────
   Two levels. The weak check asks whether SEB is present, which a browser
   extension can fake. The strong check asks SEB for the Config Key hash of
   this exact URL and has the server compare it against the key of the file
   you built. A copied, edited or home-made .seb file fails that. */

export function sebPresent() {
  return typeof window.SafeExamBrowser !== "undefined" ||
         /SEB[\s/]/i.test(navigator.userAgent);
}

async function readSebEvidence() {
  const seb = window.SafeExamBrowser;
  if (!seb?.security) return null;

  // Some builds fill the key only after updateKeys(); newer ones have it ready.
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

/** Resolves true if the paper may open. Otherwise it replaces the page. */
export async function enforceSEBOrBlock() {
  if (devBypassActive()) return true;

  if (!sebPresent()) {
    blockPage("This page was not opened by Safe Exam Browser.");
    return false;
  }

  if (!STRICT_SEB_VERIFY) {
    console.warn("[PariksaRakshak] STRICT_SEB_VERIFY is off — SEB is not being verified against your configuration.");
    return true;
  }

  const evidence = await readSebEvidence();
  if (!evidence?.config_key_hash) {
    blockPage("Safe Exam Browser did not present a Config Key. Turn on the JavaScript API in the SEB configuration.");
    return false;
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
      blockPage("The exam server has no SEB Config Key yet. The administrator must run: supabase secrets set SEB_CONFIG_KEY=…");
      return false;
    }
    if (!res.ok || !data.ok) {
      blockPage(data.error || "Safe Exam Browser is not using the approved exam configuration.");
      return false;
    }
    return true;
  } catch {
    blockPage("Could not reach the exam server to verify Safe Exam Browser. Check the network and try again.");
    return false;
  }
}

function blockPage(detail) {
  document.body.className = "hall";
  document.body.innerHTML = `
    <div class="gate">
      <div class="gate-inner">
        <img src="assets/logo-mark.svg" alt="">
        <h1>Start this paper from the student portal</h1>
        <p>The paper opens only after you press <b>Start secure exam</b> in your
           normal browser and approve <b>Open Safe Exam Browser</b>.</p>
        <p class="notice error" style="margin-top:1rem;text-align:left">${escapeHtml(detail)}</p>
        <a class="btn" href="student.html" style="margin-top:1.2rem">Go to the student portal</a>
        <p class="meta" style="margin-top:1.4rem;color:var(--ink-3)">No attempt has been started.</p>
      </div>
    </div>`;
}

/* ── 3. WEB-LAYER LOCK ─────────────────────────────────────────────────
   Deterrence, not security. The real locks are SEB and the database. */
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
    const devtools = k === "f12" || (mod && e.shiftKey && ["i", "j", "c"].includes(k));
    if ((mod && ["c", "v", "x", "a", "p", "s", "u"].includes(k)) || devtools) {
      e.preventDefault();
      e.stopPropagation();
    }
  }, true);

  ["copy", "cut", "paste"].forEach((ev) =>
    document.addEventListener(ev, (e) => e.preventDefault(), true));
}

/* ── 4. FOCUS AND VISIBILITY ───────────────────────────────────────────── */
export function activateFocusMonitor() {
  let last = 0;
  const throttled = (type, detail) => {
    const now = Date.now();
    if (now - last < 2000) return;      // at most one event every two seconds
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

function escapeHtml(v) {
  return String(v ?? "").replace(/[&<>'"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" }[c]));
}
