// public/js/exam-accessibility.js
// Student accessibility + focus controls.
// No grading/security data is changed.

const KEY = "pariksarakshak:accessibility:v1";

const state = {
  scale: 1,
  contrast: false,
  reducedMotion: false,
  focus: false,
};

boot();

function boot() {
  restore();
  injectStyles();
  installControls();
  apply();

  window.addEventListener("keydown", onShortcut, true);
}

function restore() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || "{}");
    Object.assign(state, saved || {});
  } catch {
    // Accessibility preferences are non-critical.
  }
}

function persist() {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // Non-critical.
  }
}

function injectStyles() {
  if (document.getElementById("prAccessibilityCss")) return;

  const style = document.createElement("style");
  style.id = "prAccessibilityCss";
  style.textContent = `
    html {
      --pr-font-scale: 1;
    }

    .pr-exam-running .qcard .prompt,
    .pr-exam-running .choice,
    .pr-exam-running .qcard textarea,
    .pr-exam-running .qcard input {
      font-size: calc(1em * var(--pr-font-scale));
    }

    #prAccessibilityBar {
      position: fixed;
      right: 12px;
      bottom: max(12px, env(safe-area-inset-bottom));
      z-index: 900;
      display: flex;
      gap: 5px;
      align-items: center;
      padding: 6px;
      border: 1px solid var(--rule);
      border-radius: 12px;
      background: color-mix(in srgb, var(--card) 94%, transparent);
      box-shadow: var(--shadow);
      backdrop-filter: blur(10px);
    }

    #prAccessibilityBar button {
      min-width: 34px;
      min-height: 32px;
      padding: .3rem .45rem;
      border: 1px solid var(--rule);
      border-radius: 7px;
      background: var(--card-2);
      color: var(--ink);
      cursor: pointer;
      font: 600 .7rem var(--body);
    }

    #prAccessibilityBar button[aria-pressed="true"] {
      border-color: var(--blue);
      background: var(--blue-wash);
      color: var(--blue-deep);
    }

    html.pr-high-contrast .hall {
      --paper: #05070A;
      --card: #0B0F14;
      --card-2: #111821;
      --ink: #FFFFFF;
      --ink-2: #E3E9F0;
      --ink-3: #B6C0CC;
      --rule: #657180;
      --rule-soft: #34404D;
      --blue: #86BCFF;
      --blue-deep: #C9E0FF;
      --pass: #78E2B3;
      --warn: #FFD080;
      --seal: #FF8C80;
    }

    html.pr-reduced-motion *,
    html.pr-reduced-motion *::before,
    html.pr-reduced-motion *::after {
      animation-duration: .001ms !important;
      animation-iteration-count: 1 !important;
      scroll-behavior: auto !important;
      transition-duration: .001ms !important;
    }

    html.pr-focus-reading .qcard:not(.current-question) {
      opacity: .48;
      filter: saturate(.55);
    }

    html.pr-focus-reading .qcard.current-question {
      opacity: 1;
      filter: none;
    }

    @media (max-width: 700px), (pointer: coarse) {
      #prAccessibilityBar {
        right: 8px;
        bottom: max(8px, env(safe-area-inset-bottom));
        max-width: calc(100vw - 16px);
        overflow-x: auto;
      }

      #prAccessibilityBar button {
        flex: 0 0 auto;
      }
    }
  `;
  document.head.appendChild(style);
}

function installControls() {
  const examScreen = document.getElementById("examScreen");
  if (!examScreen || document.getElementById("prAccessibilityBar")) return;

  const bar = document.createElement("div");
  bar.id = "prAccessibilityBar";
  bar.setAttribute("aria-label", "Exam accessibility controls");

  bar.innerHTML = `
    <button type="button" data-a11y="smaller" title="Smaller text">A−</button>
    <button type="button" data-a11y="reset" title="Normal text">A</button>
    <button type="button" data-a11y="larger" title="Larger text">A+</button>
    <button type="button" data-a11y="contrast" title="High contrast">Contrast</button>
    <button type="button" data-a11y="focus" title="Focus reading mode">Focus</button>
    <button type="button" data-a11y="motion" title="Reduce motion">Motion</button>
  `;

  document.body.appendChild(bar);

  bar.querySelectorAll("button").forEach((button) => {
    button.onclick = () => change(button.dataset.a11y);
  });

  const observer = new MutationObserver(() => {
    bar.classList.toggle(
      "hidden",
      examScreen.classList.contains("hidden"),
    );
  });

  observer.observe(examScreen, {
    attributes: true,
    attributeFilter: ["class"],
  });

  bar.classList.toggle(
    "hidden",
    examScreen.classList.contains("hidden"),
  );

  syncButtons();
}

function change(action) {
  if (action === "smaller") {
    state.scale = Math.max(.88, Number(state.scale || 1) - .08);
  }

  if (action === "reset") {
    state.scale = 1;
  }

  if (action === "larger") {
    state.scale = Math.min(1.32, Number(state.scale || 1) + .08);
  }

  if (action === "contrast") {
    state.contrast = !state.contrast;
  }

  if (action === "focus") {
    state.focus = !state.focus;
  }

  if (action === "motion") {
    state.reducedMotion = !state.reducedMotion;
  }

  persist();
  apply();
}

function apply() {
  document.documentElement.style.setProperty(
    "--pr-font-scale",
    String(state.scale || 1),
  );

  document.documentElement.classList.toggle(
    "pr-high-contrast",
    Boolean(state.contrast),
  );

  document.documentElement.classList.toggle(
    "pr-reduced-motion",
    Boolean(state.reducedMotion),
  );

  document.documentElement.classList.toggle(
    "pr-focus-reading",
    Boolean(state.focus),
  );

  syncButtons();
}

function syncButtons() {
  const bar = document.getElementById("prAccessibilityBar");
  if (!bar) return;

  const set = (name, pressed) => {
    bar.querySelector(`[data-a11y="${name}"]`)
      ?.setAttribute("aria-pressed", String(Boolean(pressed)));
  };

  set("contrast", state.contrast);
  set("focus", state.focus);
  set("motion", state.reducedMotion);
}

function onShortcut(event) {
  if (!paperVisible()) return;

  // Do not hijack shortcuts while the student is typing or editing code.
  const target = event.target;
  if (
    target?.matches?.("input, textarea, select") ||
    target?.closest?.(".CodeMirror")
  ) {
    return;
  }

  if (!(event.ctrlKey && event.altKey)) return;

  if (event.key.toLowerCase() === "n") {
    event.preventDefault();
    moveQuestion(1);
  }

  if (event.key.toLowerCase() === "p") {
    event.preventDefault();
    moveQuestion(-1);
  }
}

function moveQuestion(delta) {
  const cards = [...document.querySelectorAll(".qcard")];
  if (!cards.length) return;

  let index = cards.findIndex((card) =>
    card.classList.contains("current-question"),
  );

  if (index < 0) index = 0;

  const next = Math.min(
    cards.length - 1,
    Math.max(0, index + delta),
  );

  cards[next].scrollIntoView({
    behavior: state.reducedMotion ? "auto" : "smooth",
    block: "start",
  });
}

function paperVisible() {
  const screen = document.getElementById("examScreen");
  return Boolean(screen && !screen.classList.contains("hidden"));
}
