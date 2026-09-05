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

boot();

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
