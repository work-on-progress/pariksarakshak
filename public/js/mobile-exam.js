// public/js/mobile-exam.js
//
// Android Chrome / mobile reliability layer.
//
// This module is intentionally separate from exam.js. It adds:
// - Android Chrome compatibility status on the student Device Check panel
// - screen Wake Lock while the paper is visible
// - mobile-safe viewport handling, including the virtual keyboard
// - compact touch-friendly exam layout
// - Android Back-button/navigation guard while an attempt is in progress
// - small lifecycle helpers for app-switch/resume behaviour
//
// Important browser limitation:
// Android may suspend camera/video while Chrome is backgrounded. proctor.js
// immediately verifies/reconnects the camera when Chrome becomes visible again.

import {
  logIncident,
  sebPresent,
  isFullscreenActive,
} from "./anticheat.js";

const UA = navigator.userAgent || "";

const IS_ANDROID = /Android/i.test(UA);
const IS_ANDROID_WEBVIEW =
  IS_ANDROID &&
  (
    /\bwv\b/i.test(UA) ||
    /; wv\)/i.test(UA) ||
    (/Version\/4\.0/i.test(UA) && /Chrome\//i.test(UA))
  );

const IS_ANDROID_CHROME =
  IS_ANDROID &&
  /Chrome\/\d+/i.test(UA) &&
  !IS_ANDROID_WEBVIEW &&
  !/EdgA\//i.test(UA) &&
  !/OPR\//i.test(UA) &&
  !/SamsungBrowser\//i.test(UA);

const IS_MOBILE =
  IS_ANDROID ||
  window.matchMedia?.("(pointer: coarse)")?.matches ||
  Math.min(screen.width || innerWidth, screen.height || innerHeight) <= 700;

let wakeLock = null;
let wakeRetryTimer = null;
let backGuardInstalled = false;
let backGuardArmed = false;
let toastTimer = null;

boot();

function boot() {
  improveViewport();
  injectMobileStyles();

  if (document.querySelector(".student-console")) {
    installStudentCompatibilityStatus();
  }

  if (
    document.getElementById("codeScreen") ||
    document.getElementById("examScreen")
  ) {
    installExamLifecycle();
  }
}

/* ── ENVIRONMENT ────────────────────────────────────────────────────── */

function browserLabel() {
  if (IS_ANDROID_CHROME) return "Android Chrome";
  if (IS_ANDROID_WEBVIEW) return "Android in-app browser";
  if (IS_ANDROID) return "Android browser";
  return "desktop / non-Android";
}

function browserSuitableForMobileExam() {
  if (!IS_ANDROID) return true;
  return IS_ANDROID_CHROME;
}

/* ── VIEWPORT + MOBILE CSS ──────────────────────────────────────────── */

function improveViewport() {
  let meta = document.querySelector('meta[name="viewport"]');

  if (!meta) {
    meta = document.createElement("meta");
    meta.name = "viewport";
    document.head.appendChild(meta);
  }

  meta.content =
    "width=device-width, initial-scale=1, viewport-fit=cover";

  const update = () => {
    const vv = window.visualViewport;
    const height = vv?.height || window.innerHeight;

    document.documentElement.style.setProperty(
      "--pr-viewport-height",
      `${Math.max(320, Math.round(height))}px`,
    );

    const keyboardOpen =
      IS_MOBILE &&
      vv &&
      vv.height < window.innerHeight * 0.72;

    document.documentElement.classList.toggle(
      "pr-keyboard-open",
      Boolean(keyboardOpen),
    );
  };

  update();

  window.addEventListener("resize", update);

  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", update);
    window.visualViewport.addEventListener("scroll", update);
  }
}

function injectMobileStyles() {
  if (document.getElementById("prMobileExamCss")) return;

  const style = document.createElement("style");
  style.id = "prMobileExamCss";
  style.textContent = `
    html, body {
      min-height: 100%;
      min-height: var(--pr-viewport-height, 100dvh);
    }

    .gate {
      min-height: var(--pr-viewport-height, 100dvh);
      padding-top: max(1rem, env(safe-area-inset-top));
      padding-right: max(1rem, env(safe-area-inset-right));
      padding-bottom: max(1rem, env(safe-area-inset-bottom));
      padding-left: max(1rem, env(safe-area-inset-left));
    }

    button,
    .choice,
    input[type="radio"],
    input[type="checkbox"] {
      touch-action: manipulation;
    }

    @media (max-width: 700px), (pointer: coarse) {
      input,
      textarea,
      select {
        font-size: 16px !important;
      }

      .join-card {
        max-width: 100%;
      }

      input.code-entry {
        min-height: 58px;
        font-size: 1.5rem !important;
        letter-spacing: .28em;
      }

      .hall-bar {
        top: 0;
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto 58px;
        grid-template-rows: auto auto auto;
        gap: .3rem .5rem;
        align-items: center;
        padding:
          max(.45rem, env(safe-area-inset-top))
          max(.55rem, env(safe-area-inset-right))
          .45rem
          max(.55rem, env(safe-area-inset-left));
      }

      .hall-bar > img {
        display: none;
      }

      .hall-bar .paper-name {
        grid-column: 1;
        grid-row: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: .9rem;
      }

      #paperCode,
      #modeTag,
      .hall-bar .spacer {
        display: none;
      }

      #timer {
        grid-column: 2;
        grid-row: 1;
        justify-self: end;
        font-size: .9rem;
        padding: .26rem .45rem;
      }

      #cam {
        grid-column: 3;
        grid-row: 1 / 3;
        width: 54px;
        height: 42px;
        justify-self: end;
        align-self: start;
      }

      #camState {
        grid-column: 3;
        grid-row: 2;
        max-width: 58px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        text-align: center;
        font-size: .46rem;
      }

      #attention {
        grid-column: 1 / 3;
        grid-row: 2;
        min-width: 0;
        font-size: .62rem;
        line-height: 1.25;
      }

      #finishBtn {
        grid-column: 1 / 4;
        grid-row: 3;
        width: 100%;
        min-height: 42px;
        justify-content: center;
        padding: .46rem .7rem;
      }

      .paper-sheet {
        width: 100%;
        max-width: 100%;
        padding:
          .65rem
          max(.6rem, env(safe-area-inset-right))
          calc(5rem + env(safe-area-inset-bottom))
          max(.6rem, env(safe-area-inset-left));
        gap: .8rem;
      }

      .progress-strip {
        top: 8.2rem;
        gap: 3px;
        padding: .35rem 0;
      }

      .pip {
        width: 20px;
      }

      .qcard {
        padding: .9rem .85rem;
        border-radius: 10px;
      }

      .qcard > header {
        gap: .4rem;
        padding-bottom: .6rem;
        margin-bottom: .75rem;
      }

      .qcard .save-state {
        width: 100%;
        margin-left: 0;
      }

      .choice {
        min-height: 48px;
        padding: .7rem;
      }

      .blanks {
        display: grid;
        grid-template-columns: 1fr;
      }

      .blanks input {
        width: 100%;
        min-height: 46px;
      }

      textarea {
        min-height: 150px;
      }

      .CodeMirror {
        height: min(46dvh, 320px) !important;
        max-width: 100%;
        font-size: 13px !important;
      }

      .code-actions {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: .5rem;
      }

      .code-actions .btn {
        min-height: 44px;
        justify-content: center;
      }

      .code-actions .meta {
        grid-column: 1 / -1;
      }

      .verdict {
        max-height: 42dvh;
        overflow: auto;
        -webkit-overflow-scrolling: touch;
      }

      .test-compare {
        grid-template-columns: 1fr !important;
      }

      .student-console {
        padding-left: max(.75rem, env(safe-area-inset-left));
        padding-right: max(.75rem, env(safe-area-inset-right));
      }

      .student-code-row {
        grid-template-columns: 1fr;
      }

      .student-code-row .btn {
        width: 100%;
        min-height: 46px;
        justify-content: center;
      }

      .student-exam-card {
        align-items: stretch;
        flex-direction: column;
      }

      .student-exam-card .card-action,
      .student-exam-card .card-action .btn {
        width: 100%;
      }

      .student-exam-card .card-action .btn {
        min-height: 46px;
        justify-content: center;
      }

      #deviceCheckPanel .panel-head {
        flex-wrap: wrap;
      }

      #deviceCheckPanel #deviceCheckBtn {
        width: 100%;
        margin-left: 0 !important;
        justify-content: center;
      }

      [data-device-row] {
        align-items: flex-start !important;
        flex-wrap: wrap;
      }

      [data-device-detail] {
        width: 100%;
        margin-left: 0 !important;
        text-align: left !important;
      }
    }

    .pr-keyboard-open .progress-strip {
      position: static;
    }

    @media (max-width: 700px), (pointer: coarse) {
      .pr-keyboard-open .hall-bar {
        position: static;
        grid-template-rows: auto auto;
      }

      .pr-keyboard-open #cam {
        width: 42px;
        height: 32px;
      }

      .pr-keyboard-open #camState {
        display: none;
      }

      .pr-keyboard-open #finishBtn {
        grid-row: 2;
        grid-column: 2 / 4;
        width: auto;
      }

      .pr-keyboard-open #attention {
        grid-column: 1;
        grid-row: 2;
      }
    }
  `;

  document.head.appendChild(style);
}

/* ── STUDENT DEVICE CHECK EXTENSION ────────────────────────────────── */

function installStudentCompatibilityStatus() {
  const tryInstall = () => {
    const rows = document.getElementById("deviceCheckRows");
    if (!rows) return false;

    if (!document.getElementById("mobileBrowserCheckRow")) {
      const row = document.createElement("div");
      row.id = "mobileBrowserCheckRow";
      row.style.cssText =
        "display:flex;gap:.6rem;align-items:center;flex-wrap:wrap";

      const ok = browserSuitableForMobileExam();

      row.innerHTML = `
        <span class="tag ${ok ? "pass" : "warn"}">
          ${ok ? "PASS" : "FAIL"}
        </span>
        <span>Mobile / browser</span>
        <span class="meta" style="margin-left:auto;text-align:right">
          ${escapeHtml(browserLabel())}
        </span>
      `;

      rows.appendChild(row);
    }

    if (!document.getElementById("wakeLockCheckRow")) {
      const supported = "wakeLock" in navigator;
      const row = document.createElement("div");
      row.id = "wakeLockCheckRow";
      row.style.cssText =
        "display:flex;gap:.6rem;align-items:center;flex-wrap:wrap";

      row.innerHTML = `
        <span class="tag ${supported ? "pass" : "warn"}">
          ${supported ? "PASS" : "CHECK"}
        </span>
        <span>Screen wake lock</span>
        <span class="meta" style="margin-left:auto;text-align:right">
          ${supported ? "supported" : "keep screen awake manually"}
        </span>
      `;

      rows.appendChild(row);
    }

    if (IS_ANDROID && !IS_ANDROID_CHROME) {
      showAndroidBrowserWarning();
    }

    return true;
  };

  if (tryInstall()) return;

  const observer = new MutationObserver(() => {
    if (tryInstall()) {
      observer.disconnect();
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });

  setTimeout(() => observer.disconnect(), 15000);
}

function showAndroidBrowserWarning() {
  if (document.getElementById("androidChromeWarning")) return;

  const panel = document.getElementById("deviceCheckPanel");
  if (!panel) return;

  const body = panel.querySelector(".panel-body");
  if (!body) return;

  const note = document.createElement("p");
  note.id = "androidChromeWarning";
  note.className = "notice error";
  note.style.marginTop = ".8rem";
  note.textContent =
    "For mobile browser exams, open this site directly in Google Chrome on Android. Do not use an in-app browser such as WhatsApp/Instagram.";

  body.appendChild(note);
}

/* ── EXAM LIFECYCLE ────────────────────────────────────────────────── */

function installExamLifecycle() {
  const screen = document.getElementById("examScreen");

  if (screen) {
    const observer = new MutationObserver(() => {
      onPaperVisibilityChanged();
    });

    observer.observe(screen, {
      attributes: true,
      attributeFilter: ["class"],
    });
  }

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      // Android releases wake locks automatically in the background.
      wakeLock = null;
      return;
    }

    if (paperVisible()) {
      requestExamWakeLock();
    }
  });

  window.addEventListener("pageshow", () => {
    if (paperVisible()) {
      requestExamWakeLock();
    }
  });

  onPaperVisibilityChanged();
}

function paperVisible() {
  const screen = document.getElementById("examScreen");

  return Boolean(
    screen &&
    !screen.classList.contains("hidden")
  );
}

function onPaperVisibilityChanged() {
  const running = paperVisible();

  document.documentElement.classList.toggle(
    "pr-exam-running",
    running,
  );

  if (!running) {
    releaseWakeLock();
    return;
  }

  requestExamWakeLock();

  if (IS_ANDROID && !sebPresent()) {
    installBackNavigationGuard();

    if (!IS_ANDROID_CHROME) {
      showMobileToast(
        "For the most reliable mobile exam experience, use Google Chrome on Android.",
        5000,
      );
    }
  }
}

/* ── WAKE LOCK ─────────────────────────────────────────────────────── */

async function requestExamWakeLock() {
  clearTimeout(wakeRetryTimer);

  if (
    !paperVisible() ||
    document.hidden ||
    !("wakeLock" in navigator)
  ) {
    return false;
  }

  if (wakeLock && !wakeLock.released) {
    return true;
  }

  try {
    wakeLock = await navigator.wakeLock.request("screen");

    wakeLock.addEventListener("release", () => {
      wakeLock = null;

      if (paperVisible() && !document.hidden) {
        wakeRetryTimer = setTimeout(
          requestExamWakeLock,
          1200,
        );
      }
    });

    return true;
  } catch (e) {
    console.warn("[mobile exam] wake lock unavailable:", e);
    wakeLock = null;
    return false;
  }
}

async function releaseWakeLock() {
  clearTimeout(wakeRetryTimer);

  try {
    await wakeLock?.release?.();
  } catch {
    // Wake lock may already have been released by Android.
  }

  wakeLock = null;
}

/* ── ANDROID BACK NAVIGATION GUARD ─────────────────────────────────── */

function installBackNavigationGuard() {
  if (backGuardInstalled) return;
  backGuardInstalled = true;

  armBackGuard();

  window.addEventListener("popstate", () => {
    if (!paperVisible()) {
      backGuardArmed = false;
      return;
    }

    logIncident(
      "NAVIGATION_BACK_ATTEMPT",
      "browser/system Back used during active paper",
    ).catch(() => {});

    // Restore a same-document guard entry. This normally absorbs the Android
    // Back gesture/button while the paper is running.
    backGuardArmed = false;
    armBackGuard();

    showMobileToast(
      "Back navigation is blocked during the exam. Your attempt is still running.",
      3500,
    );
  });
}

function armBackGuard() {
  if (backGuardArmed || !paperVisible()) return;

  try {
    history.pushState(
      {
        ...(history.state || {}),
        prExamGuard: true,
      },
      "",
      location.href,
    );

    backGuardArmed = true;
  } catch (e) {
    console.warn("[mobile exam] back guard unavailable:", e);
  }
}

/* ── SMALL STATUS TOAST ────────────────────────────────────────────── */

function showMobileToast(text, duration = 3200) {
  let toast = document.getElementById("prMobileToast");

  if (!toast) {
    toast = document.createElement("div");
    toast.id = "prMobileToast";
    toast.style.cssText = `
      position:fixed;
      left:50%;
      bottom:max(1rem, env(safe-area-inset-bottom));
      transform:translateX(-50%);
      z-index:2147483646;
      width:min(92vw,520px);
      padding:.75rem .9rem;
      border-radius:10px;
      background:#12161c;
      color:white;
      box-shadow:0 10px 30px rgba(0,0,0,.3);
      font:600 .86rem/1.35 system-ui,sans-serif;
      text-align:center;
    `;

    document.body.appendChild(toast);
  }

  toast.textContent = text;
  toast.hidden = false;

  clearTimeout(toastTimer);

  toastTimer = setTimeout(() => {
    toast.hidden = true;
  }, duration);
}

/* ── HELPERS ───────────────────────────────────────────────────────── */

function escapeHtml(v) {
  return String(v ?? "").replace(
    /[&<>'"]/g,
    (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "'": "&#39;",
      '"': "&quot;",
    })[c],
  );
}
