// public/js/anticheat.js
//
// Two delivery modes, two honest levels of protection.
//
// SEB papers:
//   The operating system blocks normal escape routes and the server verifies
//   that the approved SEB configuration is running.
//
// Browser papers:
//   A web page cannot stop screenshots, a phone, a second monitor or every
//   operating-system shortcut. It can require fullscreen, record focus loss,
//   keep one live session and auto-submit on the configured switch limit.

import { supabase } from "./supabaseClient.js";

import {
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  ALLOW_DEV_BYPASS,
  STRICT_SEB_VERIFY,
  BROWSER_MODE,
} from "./config.js";

let ctx = {
  attemptId: null,
  examId: null,
  studentId: null,
};

export function setIncidentContext(c) {
  ctx = { ...ctx, ...c };
}

export async function logIncident(
  event_type,
  detail = "",
) {
  if (!ctx.attemptId) return;

  const { error } =
    await supabase
      .from("incident_logs")
      .insert({
        attempt_id: ctx.attemptId,
        exam_id: ctx.examId,
        student_id: ctx.studentId,
        event_type,
        detail: String(detail).slice(0, 300),
      });

  if (error) {
    console.warn(
      "[incident] not logged:",
      error.message,
    );
  }
}

/* ── 1. DEV BYPASS ─────────────────────────────────────────────────── */

export function devBypassActive() {
  if (!ALLOW_DEV_BYPASS) return false;

  const local =
    ["localhost", "127.0.0.1", "::1"]
      .includes(location.hostname);

  return (
    local &&
    new URLSearchParams(location.search)
      .get("dev") === "1"
  );
}

/* ── 2. SAFE EXAM BROWSER ──────────────────────────────────────────── */

export function sebPresent() {
  return (
    typeof window.SafeExamBrowser !== "undefined" ||
    /SEB[\s/]/i.test(navigator.userAgent)
  );
}

async function readSebEvidence() {
  const seb = window.SafeExamBrowser;

  if (!seb?.security) return null;

  if (
    !seb.security.configKey &&
    typeof seb.security.updateKeys === "function"
  ) {
    await new Promise((resolve) => {
      let done = false;

      const finish = () => {
        if (!done) {
          done = true;
          resolve();
        }
      };

      try {
        seb.security.updateKeys(finish);
      } catch {
        finish();
      }

      setTimeout(finish, 1200);
    });
  }

  return {
    version: String(seb.version ?? ""),
    config_key_hash:
      String(seb.security.configKey ?? ""),
  };
}

/* ── 3. FULLSCREEN CAPABILITY ──────────────────────────────────────── */

export function isFullscreenActive() {
  return Boolean(
    document.fullscreenElement ||
    document.webkitFullscreenElement ||
    document.msFullscreenElement,
  );
}

export function fullscreenSupported() {
  const el = document.documentElement;

  const request =
    el.requestFullscreen ||
    el.webkitRequestFullscreen ||
    el.msRequestFullscreen;

  if (typeof request !== "function") {
    return false;
  }

  if (document.fullscreenEnabled === false) {
    return false;
  }

  if (document.webkitFullscreenEnabled === false) {
    return false;
  }

  return true;
}

function addFullscreenChangeListener(handler) {
  document.addEventListener(
    "fullscreenchange",
    handler,
  );

  // Older Safari/WebKit.
  document.addEventListener(
    "webkitfullscreenchange",
    handler,
  );
}

/**
 * Requests fullscreen and verifies that it ACTUALLY became active.
 * Returning true only means document.fullscreenElement is present.
 */
export async function requestFullscreen() {
  if (isFullscreenActive()) {
    return true;
  }

  if (!fullscreenSupported()) {
    return false;
  }

  const el = document.documentElement;

  const fn =
    el.requestFullscreen ||
    el.webkitRequestFullscreen ||
    el.msRequestFullscreen;

  try {
    const result = fn.call(el);

    if (result?.then) {
      await result;
    }

    // Let the browser publish fullscreenElement/fullscreenchange.
    await new Promise((resolve) =>
      setTimeout(resolve, 80)
    );

    return isFullscreenActive();
  } catch (e) {
    console.warn(
      "[fullscreen] request rejected:",
      e,
    );

    return false;
  }
}

export function watchFullscreen(
  onLost,
  onBack,
) {
  let last = isFullscreenActive();

  addFullscreenChangeListener(() => {
    const now = isFullscreenActive();

    if (now === last) return;
    last = now;

    if (now) {
      onBack?.();
    } else {
      onLost?.();
    }
  });
}

/**
 * Decides whether a paper may open in this environment.
 *
 * For ordinary-browser delivery, fullscreen CAPABILITY is required before
 * the attempt can proceed. Actual fullscreen entry is verified on Start.
 */
export async function checkDelivery(
  deliveryMode,
) {
  if (devBypassActive()) {
    return {
      ok: true,
      mode: "browser",
    };
  }

  const inSeb = sebPresent();

  if (deliveryMode === "browser") {
    if (
      !inSeb &&
      BROWSER_MODE.requireFullscreen &&
      !fullscreenSupported()
    ) {
      return {
        ok: false,
        reason:
          "This browser cannot provide the fullscreen mode required for this paper. Use current Chrome/Edge or reopen the paper in Safe Exam Browser.",
      };
    }

    // A browser paper opened inside SEB is fine — it is stricter.
    return {
      ok: true,
      mode: inSeb ? "seb" : "browser",
    };
  }

  if (
    deliveryMode === "either" &&
    !inSeb
  ) {
    if (
      BROWSER_MODE.requireFullscreen &&
      !fullscreenSupported()
    ) {
      return {
        ok: false,
        reason:
          "Fullscreen is not available in this browser. Go back and open this paper with Safe Exam Browser instead.",
      };
    }

    return {
      ok: true,
      mode: "browser",
    };
  }

  // From here on the paper requires Safe Exam Browser.
  if (!inSeb) {
    return {
      ok: false,
      reason:
        "This paper must be taken in Safe Exam Browser. Go back to the portal and press Start secure exam.",
    };
  }

  if (!STRICT_SEB_VERIFY) {
    console.warn(
      "[PariksaRakshak] STRICT_SEB_VERIFY is off — SEB is not being verified.",
    );

    return {
      ok: true,
      mode: "seb",
    };
  }

  const evidence =
    await readSebEvidence();

  if (!evidence?.config_key_hash) {
    return {
      ok: false,
      reason:
        "Safe Exam Browser did not present a Config Key. Turn on the JavaScript API in the SEB configuration.",
    };
  }

  try {
    const res = await fetch(
      `${SUPABASE_URL}/functions/v1/verify-seb`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: SUPABASE_ANON_KEY,
        },
        body: JSON.stringify({
          url: location.href.split("#")[0],
          config_key_hash:
            evidence.config_key_hash,
          version: evidence.version,
        }),
      },
    );

    const data =
      await res.json().catch(() => ({}));

    if (
      res.status === 503 &&
      data.code === "not_configured"
    ) {
      return {
        ok: false,
        reason:
          "The exam server has no SEB Config Key yet. The administrator must configure SEB_CONFIG_KEY.",
      };
    }

    if (!res.ok || !data.ok) {
      return {
        ok: false,
        reason:
          data.error ||
          "Safe Exam Browser is not using the approved exam configuration.",
      };
    }

    return {
      ok: true,
      mode: "seb",
    };
  } catch {
    return {
      ok: false,
      reason:
        "Could not reach the exam server to verify Safe Exam Browser. Check the network and try again.",
    };
  }
}

/* ── 4. WEB-LAYER LOCKDOWN ─────────────────────────────────────────── */

export function activateWebLockdown({
  blockCopyPaste = true,
  blockPrint = true,
} = {}) {
  const style =
    document.createElement("style");

  style.textContent = `
    ${
      blockCopyPaste
        ? `
      body {
        -webkit-user-select: none;
        user-select: none;
      }

      input,
      textarea,
      .CodeMirror,
      .CodeMirror * {
        -webkit-user-select: text;
        user-select: text;
      }
    `
        : ""
    }

    ${
      blockPrint
        ? `
      @media print {
        body::before {
          content: "Printing is not allowed during an examination.";
          display: block;
          padding: 4rem;
          font-size: 1.5rem;
          text-align: center;
        }

        body > * {
          display: none !important;
        }
      }
    `
        : ""
    }
  `;

  document.head.appendChild(style);

  if (!blockCopyPaste) return;

  document.addEventListener(
    "contextmenu",
    (e) => e.preventDefault(),
  );

  document.addEventListener(
    "dragstart",
    (e) => e.preventDefault(),
  );

  document.addEventListener(
    "keydown",
    (e) => {
      const k = e.key.toLowerCase();
      const mod =
        e.ctrlKey || e.metaKey;

      const devtools =
        k === "f12" ||
        (
          mod &&
          e.shiftKey &&
          ["i", "j", "c"].includes(k)
        );

      if (
        (
          mod &&
          ["c", "v", "x", "a", "p", "s", "u"]
            .includes(k)
        ) ||
        devtools
      ) {
        e.preventDefault();
        e.stopPropagation();
      }
    },
    true,
  );

  ["copy", "cut", "paste"]
    .forEach((eventName) => {
      document.addEventListener(
        eventName,
        (e) => e.preventDefault(),
        true,
      );
    });
}

/* ── 5. ATTENTION MONITOR ──────────────────────────────────────────── */

let switchCount = 0;

export const attentionCount =
  () => switchCount;

export function activateFocusMonitor({
  onSwitch = null,
  warnAfter = 3,
  autoSubmitAfter = 0,
  onAutoSubmit = null,
} = {}) {
  // blur + visibilitychange normally fire for the same Alt+Tab.
  // `away` ensures that becomes one switch, not two.
  let away = false;
  let autoSubmitted = false;

  const recordSwitch = (type) => {
    if (away || autoSubmitted) {
      return;
    }

    away = true;
    switchCount++;

    const hitLimit =
      autoSubmitAfter > 0 &&
      switchCount >= autoSubmitAfter;

    logIncident(
      type,
      `switch_count=${switchCount}${
        hitLimit
          ? "; auto_submit=true"
          : ""
      }`,
    );

    onSwitch?.(
      switchCount,
      warnAfter,
    );

    if (hitLimit) {
      autoSubmitted = true;
      onAutoSubmit?.(switchCount);
    }
  };

  const returned = () => {
    if (!document.hidden) {
      away = false;
    }
  };

  window.addEventListener(
    "blur",
    () => recordSwitch("WINDOW_BLUR"),
  );

  window.addEventListener(
    "focus",
    returned,
  );

  document.addEventListener(
    "visibilitychange",
    () => {
      if (document.hidden) {
        recordSwitch("TAB_HIDDEN");
      } else {
        returned();
      }
    },
  );

  let lastFullscreen =
    isFullscreenActive();

  addFullscreenChangeListener(() => {
    const now =
      isFullscreenActive();

    if (now === lastFullscreen) {
      return;
    }

    lastFullscreen = now;

    if (!now) {
      logIncident(
        "FULLSCREEN_EXIT",
        `switch_count=${switchCount}`,
      );
    }
  });

  window.addEventListener(
    "beforeunload",
    (e) => {
      e.preventDefault();
      e.returnValue = "";
    },
  );
}

/* ── 6. BLOCK SCREEN ───────────────────────────────────────────────── */

export function renderBlocked(detail) {
  document.body.className = "hall";

  document.body.innerHTML = `
    <div class="gate">
      <div class="gate-inner">
        <img src="assets/logo-mark.svg" alt="">
        <h1>This paper cannot open here</h1>

        <p
          class="notice error"
          style="margin-top:1rem;text-align:left"
        >${escapeHtml(detail)}</p>

        <a
          class="btn"
          href="student.html"
          style="margin-top:1.2rem"
        >Back to my papers</a>

        <p
          class="meta"
          style="margin-top:1.4rem;color:var(--ink-3)"
        >No attempt has been started.</p>
      </div>
    </div>
  `;
}

export const browserDefaults =
  BROWSER_MODE;

function escapeHtml(v) {
  return String(v ?? "")
    .replace(
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
