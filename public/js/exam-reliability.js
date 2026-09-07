// public/js/exam-reliability.js
//
// Exam-window reliability guard.
//
// This file deliberately DOES NOT replace exam.js.
// It adds strict fullscreen gating around the existing exam flow:
//
// 1. In ordinary-browser mode, the first Start click is intercepted.
// 2. The browser must actually enter fullscreen.
// 3. Only then is the original exam.js Start handler allowed to run.
// 4. On a resumed attempt that opens without fullscreen, an overlay blocks
//    the paper until the student successfully enters fullscreen.
// 5. If fullscreen restoration fails later, the existing cover is kept open.
//
// Camera stream recovery itself lives in proctor.js.

import {
  sebPresent,
  fullscreenSupported,
  isFullscreenActive,
  requestFullscreen,
} from "./anticheat.js";

import {
  BROWSER_MODE,
} from "./config.js";

let allowOriginalStart = false;
let enteringFullscreen = false;

installSecureCodeInputGuard();
boot();


/* ── SECURE CODE INPUT RELIABILITY ────────────────────────────────────
   Some browsers/lab extensions can leave the six-digit field focusable but
   prevent the browser's normal text insertion. This guard writes digits
   directly into #entryCode while the code gate is visible. It does not affect
   any answer field after the paper opens.
*/
function installSecureCodeInputGuard() {
  const input = document.getElementById("entryCode");
  const screen = document.getElementById("codeScreen");

  if (!input || input.dataset.codeGuardInstalled === "1") {
    return;
  }

  input.dataset.codeGuardInstalled = "1";
  input.disabled = false;
  input.readOnly = false;
  input.inputMode = "numeric";
  input.autocomplete = "off";

  const gateVisible = () =>
    !screen || !screen.classList.contains("hidden");

  const writeValue = (next, caret = null) => {
    input.value = String(next ?? "")
      .replace(/\D/g, "")
      .slice(0, 6);

    const pos =
      caret === null
        ? input.value.length
        : Math.max(0, Math.min(Number(caret) || 0, input.value.length));

    try {
      input.setSelectionRange(pos, pos);
    } catch {
      // Some mobile browsers do not expose selection APIs for every input.
    }

    // Let exam.js see the same input event it expects.
    input.dispatchEvent(
      new Event("input", { bubbles: true }),
    );
  };

  input.addEventListener(
    "keydown",
    (e) => {
      if (!gateVisible()) return;

      // Physical keyboard number row / numpad.
      if (/^\d$/.test(e.key)) {
        e.preventDefault();
        e.stopPropagation();

        const start =
          input.selectionStart ?? input.value.length;
        const end =
          input.selectionEnd ?? start;

        const next =
          input.value.slice(0, start) +
          e.key +
          input.value.slice(end);

        writeValue(next, start + 1);
        return;
      }

      if (e.key === "Backspace") {
        e.preventDefault();
        e.stopPropagation();

        const start =
          input.selectionStart ?? input.value.length;
        const end =
          input.selectionEnd ?? start;

        if (start !== end) {
          writeValue(
            input.value.slice(0, start) +
              input.value.slice(end),
            start,
          );
        } else if (start > 0) {
          writeValue(
            input.value.slice(0, start - 1) +
              input.value.slice(end),
            start - 1,
          );
        }

        return;
      }

      if (e.key === "Delete") {
        e.preventDefault();
        e.stopPropagation();

        const start =
          input.selectionStart ?? input.value.length;
        const end =
          input.selectionEnd ?? start;

        if (start !== end) {
          writeValue(
            input.value.slice(0, start) +
              input.value.slice(end),
            start,
          );
        } else {
          writeValue(
            input.value.slice(0, start) +
              input.value.slice(start + 1),
            start,
          );
        }

        return;
      }

      // Keep navigation and Enter available.
      if (
        [
          "Tab",
          "Enter",
          "ArrowLeft",
          "ArrowRight",
          "Home",
          "End",
        ].includes(e.key)
      ) {
        return;
      }

      // Letters/symbols are intentionally ignored on the six-digit gate.
      if (
        e.key.length === 1 &&
        !e.ctrlKey &&
        !e.metaKey &&
        !e.altKey
      ) {
        e.preventDefault();
      }
    },
    true,
  );

  // Mobile/on-screen keyboards may send beforeinput without a useful keydown.
  input.addEventListener(
    "beforeinput",
    (e) => {
      if (!gateVisible()) return;

      if (
        e.inputType === "insertText" &&
        typeof e.data === "string" &&
        /^\d+$/.test(e.data)
      ) {
        e.preventDefault();

        const start =
          input.selectionStart ?? input.value.length;
        const end =
          input.selectionEnd ?? start;

        const next =
          input.value.slice(0, start) +
          e.data +
          input.value.slice(end);

        writeValue(next, start + e.data.length);
      }
    },
    true,
  );

  input.addEventListener(
    "paste",
    (e) => {
      if (!gateVisible()) return;

      const digits =
        e.clipboardData
          ?.getData("text")
          ?.replace(/\D/g, "")
          .slice(0, 6) ?? "";

      if (!digits) return;

      e.preventDefault();
      writeValue(digits);
    },
    true,
  );

  // Clicking the field should always make it writable/focused.
  input.addEventListener("pointerdown", () => {
    input.disabled = false;
    input.readOnly = false;
  });

  setTimeout(() => {
    if (gateVisible()) input.focus();
  }, 50);
}

function boot() {
  // Capture phase runs before exam.js' button onclick handler.
  document.addEventListener(
    "click",
    interceptStart,
    true,
  );

  document.addEventListener(
    "click",
    interceptFullscreenRestore,
    true,
  );

  const screen =
    document.getElementById(
      "examScreen",
    );

  if (screen) {
    new MutationObserver(
      () => {
        setTimeout(
          ensureVisibleExamFullscreen,
          0,
        );
      },
    ).observe(
      screen,
      {
        attributes: true,
        attributeFilter: ["class"],
      },
    );
  }

  window.addEventListener(
    "pageshow",
    () => {
      setTimeout(
        ensureVisibleExamFullscreen,
        100,
      );
    },
  );

  window.addEventListener(
    "focus",
    () => {
      setTimeout(
        ensureVisibleExamFullscreen,
        150,
      );
    },
  );
}

function browserFullscreenRequired() {
  return (
    !sebPresent() &&
    BROWSER_MODE.requireFullscreen
  );
}

async function interceptStart(e) {
  const btn =
    e.target.closest?.(
      "#startBtn",
    );

  if (!btn) return;

  if (
    !browserFullscreenRequired()
  ) {
    return;
  }

  if (allowOriginalStart) {
    allowOriginalStart = false;
    return;
  }

  if (isFullscreenActive()) {
    return;
  }

  // Prevent exam.js from creating the attempt until fullscreen is proven.
  e.preventDefault();
  e.stopImmediatePropagation();

  if (enteringFullscreen) {
    return;
  }

  if (!fullscreenSupported()) {
    showStartFullscreenMessage(
      "Fullscreen is not supported on this browser/device. Use current Chrome/Edge or Safe Exam Browser. The exam attempt has not started.",
      "error",
    );

    btn.disabled = false;
    btn.textContent =
      "Start the paper";

    return;
  }

  enteringFullscreen = true;

  const previous =
    btn.textContent;

  btn.disabled = true;
  btn.textContent =
    "Entering full screen…";

  showStartFullscreenMessage(
    "Entering fullscreen before the timer starts…",
    "",
  );

  const ok =
    await requestFullscreen();

  enteringFullscreen = false;

  if (
    !ok ||
    !isFullscreenActive()
  ) {
    btn.disabled = false;
    btn.textContent =
      previous ||
      "Start the paper";

    showStartFullscreenMessage(
      "Fullscreen could not be started. The exam has NOT started. Check browser permissions or use Safe Exam Browser.",
      "error",
    );

    return;
  }

  showStartFullscreenMessage(
    "Fullscreen ready. Opening paper…",
    "ok",
  );

  // Allow exactly one synthetic click through to exam.js.
  allowOriginalStart = true;

  btn.disabled = false;
  btn.click();
}

async function interceptFullscreenRestore(e) {
  const btn =
    e.target.closest?.(
      "#backToFs",
    );

  if (!btn) return;

  // Stop the core handler because it currently hides the cover even when
  // requestFullscreen() fails.
  e.preventDefault();
  e.stopImmediatePropagation();

  btn.disabled = true;
  btn.textContent =
    "Returning…";

  const ok =
    await requestFullscreen();

  if (
    ok &&
    isFullscreenActive()
  ) {
    const cover =
      document.getElementById(
        "cover",
      );

    cover?.classList.add(
      "hidden",
    );

    return;
  }

  btn.disabled = false;
  btn.textContent =
    "Try full screen again";

  const why =
    document.getElementById(
      "coverWhy",
    );

  if (why) {
    why.textContent =
      "Fullscreen could not be restored. The paper remains covered so the exam can continue safely. Try again, or ask the invigilator for help.";
  }
}

function examScreenVisible() {
  const screen =
    document.getElementById(
      "examScreen",
    );

  return Boolean(
    screen &&
    !screen.classList.contains(
      "hidden",
    ),
  );
}

function coreFullscreenCoverVisible() {
  const cover =
    document.getElementById(
      "cover",
    );

  return Boolean(
    cover &&
    !cover.classList.contains(
      "hidden",
    ),
  );
}

function ensureVisibleExamFullscreen() {
  if (
    !browserFullscreenRequired() ||
    !examScreenVisible() ||
    isFullscreenActive() ||
    coreFullscreenCoverVisible()
  ) {
    removeResumeGate();
    return;
  }

  showResumeGate();
}

function showResumeGate() {
  if (
    document.getElementById(
      "reliabilityFullscreenGate",
    )
  ) {
    return;
  }

  const gate =
    document.createElement(
      "div",
    );

  gate.id =
    "reliabilityFullscreenGate";

  gate.style.cssText = `
    position:fixed;
    inset:0;
    z-index:2147483647;
    display:grid;
    place-items:center;
    background:rgba(15,18,22,.96);
    padding:1.5rem;
  `;

  gate.innerHTML = `
    <div
      style="
        width:min(520px,100%);
        background:white;
        color:#181b1e;
        border-radius:18px;
        padding:1.5rem;
        box-shadow:0 24px 80px rgba(0,0,0,.35)
      "
    >
      <img
        src="assets/logo-mark.svg"
        alt=""
        width="44"
        height="44"
      >

      <h2 style="margin:.9rem 0 .5rem">
        Enter full screen to continue
      </h2>

      <p
        id="reliabilityFullscreenReason"
        style="line-height:1.55"
      >
        This browser paper must be in fullscreen.
        Your attempt and saved answers are still safe.
      </p>

      <button
        class="btn"
        id="reliabilityEnterFullscreen"
        style="margin-top:1rem"
      >
        Enter full screen
      </button>
    </div>
  `;

  document.body.appendChild(
    gate,
  );

  document.getElementById(
    "reliabilityEnterFullscreen",
  ).onclick =
    async () => {
      const btn =
        document.getElementById(
          "reliabilityEnterFullscreen",
        );

      const reason =
        document.getElementById(
          "reliabilityFullscreenReason",
        );

      if (!fullscreenSupported()) {
        reason.textContent =
          "Fullscreen is not supported here. Ask the invigilator to reopen the paper in Safe Exam Browser.";

        return;
      }

      btn.disabled = true;
      btn.textContent =
        "Entering…";

      const ok =
        await requestFullscreen();

      if (
        ok &&
        isFullscreenActive()
      ) {
        removeResumeGate();
        return;
      }

      btn.disabled = false;
      btn.textContent =
        "Try again";

      reason.textContent =
        "The browser refused fullscreen. The exam remains covered. Check browser permissions or ask the invigilator for help.";
    };
}

function removeResumeGate() {
  document.getElementById(
    "reliabilityFullscreenGate",
  )?.remove();
}

function showStartFullscreenMessage(
  text,
  kind = "",
) {
  const start =
    document.getElementById(
      "startBtn",
    );

  if (!start) return;

  let el =
    document.getElementById(
      "fullscreenStartMsg",
    );

  if (!el) {
    el =
      document.createElement(
        "p",
      );

    el.id =
      "fullscreenStartMsg";

    start.parentElement?.insertBefore(
      el,
      start,
    );
  }

  el.className =
    `notice ${kind}`;

  el.style.margin =
    ".8rem 0";

  el.textContent =
    text;
}
