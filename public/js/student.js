// public/js/student.js
//
// PariksaRakshak student portal.
//
// Reliability additions:
// - Pre-exam device check.
// - Camera permission + real-frame probe.
// - Fullscreen capability check for ordinary-browser papers.
// - Pre-warms MediaPipe/model files so 60 students do not all begin a cold
//   download only after the exam has started.
// - Browser mode is blocked when required capabilities are missing.
// - "Either" mode automatically recommends SEB when browser mode is unsuitable.

import {
  supabase,
  callFunction,
  requireUser,
  signOut,
  escapeHtml,
} from "./supabaseClient.js";

import {
  INSTITUTE_NAME,
  SEB_CONFIG_FILE,
  PROCTOR_ENABLED,
} from "./config.js";

import {
  fullscreenSupported,
} from "./anticheat.js";

import {
  cameraProbe,
  warmupProctorAssets,
} from "./proctor.js";

let user;
let profile;

let busy = false;
let current = null;
let countdownTimer = null;

const examModes = new Map();

let deviceState = {
  checkedAt: 0,
  online: false,
  camera: false,
  fullscreen: false,
  assets: false,
  cameraMessage: "",
};

const DEVICE_CHECK_TTL_MS =
  10 * 60_000;

const msg =
  document.getElementById("portalMsg");

const list =
  document.getElementById("examList");

const codeInput =
  document.getElementById("examCode");

const startBtn =
  document.getElementById("startByCodeBtn");

const panel =
  document.getElementById("entryPanel");

boot();

async function boot() {
  const auth =
    await requireUser("student");

  if (!auth) return;

  ({ user, profile } = auth);

  document.getElementById(
    "instituteTag",
  ).textContent =
    INSTITUTE_NAME;

  document.getElementById(
    "whoami",
  ).textContent =
    `${profile.full_name || user.email}${
      profile.roll_no
        ? " · " + profile.roll_no
        : ""
    }`;

  document.getElementById(
    "signOutBtn",
  ).onclick =
    signOut;

  installDeviceCheck();

  startBtn.onclick = () =>
    startExam(codeInput.value);

  codeInput.addEventListener(
    "keydown",
    (e) => {
      if (e.key === "Enter") {
        startExam(codeInput.value);
      }
    },
  );

  document.getElementById(
    "againBtn",
  ).onclick =
    () =>
      current &&
      startExam(current.exam_code);

  window.addEventListener(
    "offline",
    () => markDeviceCheckStale("offline"),
  );

  window.addEventListener(
    "online",
    () => markDeviceCheckStale("online"),
  );

  await loadPapers();

  setInterval(
    loadPapers,
    60000,
  );
}

/* ══════════════ DEVICE CHECK ══════════════ */

function installDeviceCheck() {
  if (
    document.getElementById(
      "deviceCheckPanel",
    )
  ) {
    return;
  }

  const section =
    document.createElement("section");

  section.className = "panel";
  section.id = "deviceCheckPanel";
  section.style.marginTop = "1.25rem";

  section.innerHTML = `
    <div class="panel-head">
      <h2>Device check</h2>

      <span
        class="eyebrow"
        id="deviceCheckState"
      >not checked</span>

      <button
        class="btn small"
        id="deviceCheckBtn"
        style="margin-left:auto"
      >Run device check</button>
    </div>

    <div class="panel-body">
      <p
        class="muted"
        style="margin:.1rem 0 .8rem;font-size:.9rem"
      >
        Run this before the exam. It checks the camera and browser
        and also warms the local face-check files.
      </p>

      <div
        id="deviceCheckRows"
        style="display:grid;gap:.45rem"
      >
        ${deviceRow("network", "Internet / exam server")}
        ${deviceRow("camera", "Camera stream")}
        ${deviceRow("fullscreen", "Browser fullscreen")}
        ${deviceRow("assets", "Face-check files")}
      </div>

      <p
        id="deviceCheckMsg"
        class="notice hidden"
        style="margin-top:.8rem"
      ></p>
    </div>
  `;

  const hero =
    document.querySelector(
      ".student-hero",
    );

  if (hero) {
    hero.insertAdjacentElement(
      "afterend",
      section,
    );
  } else {
    document.querySelector(
      ".student-console",
    )?.prepend(section);
  }

  document.getElementById(
    "deviceCheckBtn",
  ).onclick =
    () => runDeviceCheck(
      "browser",
      true,
    );

  renderDeviceState();
}

function deviceRow(key, label) {
  return `
    <div
      data-device-row="${key}"
      style="display:flex;gap:.6rem;align-items:center"
    >
      <span
        class="tag"
        data-device-mark="${key}"
      >WAIT</span>

      <span>${label}</span>

      <span
        class="meta"
        data-device-detail="${key}"
        style="margin-left:auto;text-align:right"
      ></span>
    </div>
  `;
}

function setDeviceRow(
  key,
  state,
  detail = "",
) {
  const mark =
    document.querySelector(
      `[data-device-mark="${key}"]`,
    );

  const detailEl =
    document.querySelector(
      `[data-device-detail="${key}"]`,
    );

  if (mark) {
    mark.textContent =
      state === "ok"
        ? "PASS"
        : state === "warn"
        ? "CHECK"
        : state === "fail"
        ? "FAIL"
        : "WAIT";

    mark.className =
      `tag ${
        state === "ok"
          ? "pass"
          : state === "warn" ||
            state === "fail"
          ? "warn"
          : ""
      }`;
  }

  if (detailEl) {
    detailEl.textContent = detail;
  }
}

function renderDeviceState() {
  const stateEl =
    document.getElementById(
      "deviceCheckState",
    );

  if (!stateEl) return;

  if (!deviceState.checkedAt) {
    stateEl.textContent =
      "not checked";

    setDeviceRow(
      "network",
      "wait",
    );

    setDeviceRow(
      "camera",
      "wait",
    );

    setDeviceRow(
      "fullscreen",
      "wait",
    );

    setDeviceRow(
      "assets",
      "wait",
    );

    return;
  }

  setDeviceRow(
    "network",
    deviceState.online
      ? "ok"
      : "fail",
    deviceState.online
      ? "online"
      : "offline",
  );

  if (PROCTOR_ENABLED) {
    setDeviceRow(
      "camera",
      deviceState.camera
        ? "ok"
        : "fail",
      deviceState.camera
        ? "live frames verified"
        : deviceState.cameraMessage ||
          "camera unavailable",
    );

    setDeviceRow(
      "assets",
      deviceState.assets
        ? "ok"
        : "warn",
      deviceState.assets
        ? "cached / reachable"
        : "will retry during exam",
    );
  } else {
    setDeviceRow(
      "camera",
      "ok",
      "proctoring disabled",
    );

    setDeviceRow(
      "assets",
      "ok",
      "not required",
    );
  }

  setDeviceRow(
    "fullscreen",
    deviceState.fullscreen
      ? "ok"
      : "fail",
    deviceState.fullscreen
      ? "supported"
      : "use Chrome/Edge or SEB",
  );

  const coreReady =
    deviceState.online &&
    (
      !PROCTOR_ENABLED ||
      deviceState.camera
    );

  const browserReady =
    coreReady &&
    deviceState.fullscreen;

  stateEl.textContent =
    browserReady
      ? "READY"
      : coreReady
      ? "SEB READY"
      : "FIX REQUIRED";
}

function markDeviceCheckStale() {
  deviceState.checkedAt = 0;

  const stateEl =
    document.getElementById(
      "deviceCheckState",
    );

  if (stateEl) {
    stateEl.textContent =
      "check again";
  }
}

function deviceCheckFresh() {
  return (
    deviceState.checkedAt > 0 &&
    Date.now() -
      deviceState.checkedAt <
      DEVICE_CHECK_TTL_MS
  );
}

async function runDeviceCheck(
  requiredMode = "browser",
  force = false,
) {
  if (
    !force &&
    deviceCheckFresh()
  ) {
    return readinessForMode(
      requiredMode,
    );
  }

  const btn =
    document.getElementById(
      "deviceCheckBtn",
    );

  const stateEl =
    document.getElementById(
      "deviceCheckState",
    );

  const checkMsg =
    document.getElementById(
      "deviceCheckMsg",
    );

  if (btn) {
    btn.disabled = true;
    btn.textContent =
      "Checking…";
  }

  if (stateEl) {
    stateEl.textContent =
      "checking";
  }

  checkMsg?.classList.add(
    "hidden",
  );

  setDeviceRow(
    "network",
    "wait",
    "checking",
  );

  setDeviceRow(
    "camera",
    "wait",
    PROCTOR_ENABLED
      ? "opening camera"
      : "not required",
  );

  setDeviceRow(
    "fullscreen",
    "wait",
    "checking",
  );

  setDeviceRow(
    "assets",
    "wait",
    PROCTOR_ENABLED
      ? "warming cache"
      : "not required",
  );

  try {
    deviceState.online =
      navigator.onLine !== false;

    deviceState.fullscreen =
      fullscreenSupported();

    let assetsPromise =
      Promise.resolve({
        ok: true,
      });

    if (PROCTOR_ENABLED) {
      assetsPromise =
        warmupProctorAssets();

      try {
        await cameraProbe();

        deviceState.camera =
          true;

        deviceState.cameraMessage =
          "live frames verified";
      } catch (e) {
        deviceState.camera =
          false;

        const name =
          String(e?.name ?? "");

        deviceState.cameraMessage =
          name === "NotAllowedError"
            ? "permission denied"
            : name === "NotFoundError"
            ? "no camera found"
            : String(
                e?.message ||
                "camera unavailable",
              );
      }

      const assets =
        await assetsPromise;

      deviceState.assets =
        assets.ok === true;
    } else {
      deviceState.camera = true;
      deviceState.assets = true;
    }

    deviceState.checkedAt =
      Date.now();

    renderDeviceState();

    const ready =
      readinessForMode(
        requiredMode,
      );

    if (!ready.examReady) {
      showDeviceMessage(
        requiredMode === "browser" &&
        !deviceState.fullscreen
          ? "This machine cannot use the required ordinary-browser fullscreen mode. Use current Chrome/Edge or Safe Exam Browser."
          : "This machine is not ready yet. Fix the failed device check before starting the paper.",
        "error",
      );
    } else if (
      requiredMode === "either" &&
      !ready.browserReady
    ) {
      showDeviceMessage(
        "The camera is ready, but ordinary-browser mode is not. Use Safe Exam Browser for this paper.",
        "warn",
      );
    } else if (
      !deviceState.assets
    ) {
      showDeviceMessage(
        "Core checks passed. Face-check files could not be preloaded, but the exam will retry them automatically while keeping the camera live.",
        "warn",
      );
    } else {
      showDeviceMessage(
        "Device ready for the exam.",
        "ok",
      );
    }

    return ready;
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent =
        "Run device check";
    }
  }
}

function readinessForMode(mode) {
  const coreReady =
    deviceState.online &&
    (
      !PROCTOR_ENABLED ||
      deviceState.camera
    );

  const browserReady =
    coreReady &&
    deviceState.fullscreen;

  return {
    coreReady,
    browserReady,
    examReady:
      mode === "browser"
        ? browserReady
        : coreReady,
  };
}

function showDeviceMessage(
  text,
  kind = "",
) {
  const el =
    document.getElementById(
      "deviceCheckMsg",
    );

  if (!el) return;

  el.textContent = text;
  el.className =
    `notice ${kind}`;

  el.classList.remove(
    "hidden",
  );
}

/* ══════════════ WHAT IS OPEN ══════════════ */

async function loadPapers() {
  const { data, error } =
    await supabase
      .from("exams")
      .select(
        "id, title, exam_code, duration_min, starts_at, ends_at, delivery_mode",
      )
      .order(
        "starts_at",
        { ascending: true },
      );

  if (error) {
    list.innerHTML =
      `<p class="notice error">${
        escapeHtml(error.message)
      }</p>`;

    return;
  }

  examModes.clear();

  (data ?? []).forEach((exam) => {
    examModes.set(
      String(
        exam.exam_code ?? "",
      ).trim().toUpperCase(),
      exam.delivery_mode ?? "seb",
    );
  });

  const { data: mine } =
    await supabase
      .from("attempts")
      .select("exam_id, status")
      .eq(
        "student_id",
        user.id,
      );

  const status = {};

  (mine ?? []).forEach((a) => {
    status[a.exam_id] = a.status;
  });

  document.getElementById(
    "liveCount",
  ).textContent =
    data?.length
      ? `${data.length} open`
      : "nothing open";

  if (!data?.length) {
    list.innerHTML = `
      <p class="empty">
        No paper is open for you right now.
        It appears here the moment your teacher opens it.
      </p>
    `;

    return;
  }

  list.innerHTML = "";

  data.forEach((exam) => {
    const state =
      status[exam.id];

    const mode =
      exam.delivery_mode ??
      "seb";

    const card =
      document.createElement(
        "article",
      );

    card.className =
      "student-exam-card";

    card.innerHTML = `
      <div>
        <span class="tag blue">${
          escapeHtml(
            exam.exam_code,
          )
        }</span>

        <span class="tag ${
          mode === "browser"
            ? "warn"
            : mode === "either"
            ? ""
            : "pass"
        }">${
          mode === "browser"
            ? "this browser"
            : mode === "either"
            ? "either browser"
            : "locked browser"
        }</span>

        <h3>${
          escapeHtml(exam.title)
        }</h3>

        <p class="meta">
          ${
            exam.duration_min
          } minutes · closes ${
            when(exam.ends_at)
          }
        </p>
      </div>

      <div class="card-action"></div>
    `;

    const slot =
      card.querySelector(
        ".card-action",
      );

    if (state === "submitted") {
      slot.innerHTML =
        `<span class="tag pass">submitted</span>`;
    } else {
      const btn =
        document.createElement(
          "button",
        );

      btn.className = "btn";

      btn.textContent =
        state === "in_progress"
          ? "Resume"
          : "Start";

      btn.onclick =
        () =>
          startExam(
            exam.exam_code,
          );

      slot.appendChild(btn);
    }

    list.appendChild(card);
  });
}

/* ══════════════ ISSUE THE CODE ══════════════ */

async function startExam(rawCode) {
  if (busy) return;

  const examCode =
    String(rawCode || "")
      .trim()
      .toUpperCase();

  if (!examCode) {
    return show(
      "Type the exam code, or pick a paper above.",
    );
  }

  hide();
  setBusy(true);

  try {
    const knownMode =
      examModes.get(examCode);

    // Check the device before creating a five-minute one-time code
    // whenever we already know this paper's delivery mode.
    if (knownMode) {
      const readiness =
        await runDeviceCheck(
          knownMode,
          false,
        );

      if (!readiness.examReady) {
        return show(
          knownMode === "browser" &&
          !readiness.browserReady
            ? "This browser is not ready for the required fullscreen exam. Run Device check, fix the failed item, or use Safe Exam Browser where permitted."
            : "The device check failed. Fix the camera/network problem before starting the exam.",
        );
      }
    }

    const res =
      await callFunction(
        "create-seb-launch",
        {
          exam_code: examCode,
        },
      );

    if (res.error) {
      return show(res.error);
    }

    const mode =
      res.delivery_mode ??
      "seb";

    let readiness =
      readinessForMode(mode);

    // Typed exam codes can reach here before we know the mode.
    if (
      !knownMode ||
      !deviceCheckFresh()
    ) {
      readiness =
        await runDeviceCheck(
          mode,
          false,
        );
    }

    if (!readiness.examReady) {
      return show(
        mode === "browser"
          ? "The secure code was prepared, but this browser cannot safely start the paper. Fix the failed Device check before requesting a fresh code."
          : "The camera/device check failed. Fix it before requesting a fresh code.",
      );
    }

    current = {
      ...res,
      browser_ready:
        readiness.browserReady,
    };

    renderCode(current);
  } finally {
    setBusy(false);
  }
}

function renderCode(res) {
  const mode =
    res.delivery_mode ??
    "seb";

  // Remove an old secondary browser button when a new paper/mode is shown.
  document.getElementById(
    "openHereBtn",
  )?.remove();

  panel.classList.remove(
    "hidden",
  );

  document.getElementById(
    "entryCode",
  ).textContent =
    res.entry_code;

  document.getElementById(
    "entryHead",
  ).textContent =
    `${
      res.exam_title ??
      res.exam_code
    } — your secure code`;

  const openBtn =
    document.getElementById(
      "openExamBtn",
    );

  if (mode === "browser") {
    document.getElementById(
      "entrySteps",
    ).innerHTML = `
      <b>This paper runs in this browser.</b>
      Press the button below, then type
      <b>${
        escapeHtml(res.entry_code)
      }</b>
      into the exam window.
      The exam window will verify that fullscreen actually started
      before the attempt begins.
    `;

    openBtn.textContent =
      "Open the exam window";

    openBtn.onclick =
      () =>
        window.open(
          "exam.html",
          "_blank",
          "noopener",
        );
  } else if (mode === "either") {
    if (res.browser_ready) {
      document.getElementById(
        "entrySteps",
      ).innerHTML = `
        <b>You may use either browser.</b>
        Safe Exam Browser is stricter.
        Type
        <b>${
          escapeHtml(
            res.entry_code,
          )
        }</b>
        when the exam window asks.
      `;

      openBtn.textContent =
        "Open Safe Exam Browser";

      openBtn.onclick =
        () => launchSeb();

      addSecondaryOpen();
    } else {
      document.getElementById(
        "entrySteps",
      ).innerHTML = `
        <b>Use Safe Exam Browser on this machine.</b>
        The Device check found that ordinary-browser fullscreen
        is not suitable here.
        Type
        <b>${
          escapeHtml(
            res.entry_code,
          )
        }</b>
        when SEB asks.
      `;

      openBtn.textContent =
        "Open Safe Exam Browser";

      openBtn.onclick =
        () => launchSeb();
    }
  } else {
    document.getElementById(
      "entrySteps",
    ).innerHTML = `
      <b>This paper runs in Safe Exam Browser.</b>
      Press the button, approve
      <b>Open Safe Exam Browser</b>
      if your browser asks, then type
      <b>${
        escapeHtml(res.entry_code)
      }</b>
      when it asks for your code.
    `;

    openBtn.textContent =
      "Open Safe Exam Browser";

    openBtn.onclick =
      () => launchSeb();
  }

  startCountdown(
    res.expires_at,
  );

  panel.scrollIntoView({
    behavior: "smooth",
    block: "center",
  });
}

function addSecondaryOpen() {
  const actions =
    panel.querySelector(
      ".actions",
    );

  if (
    document.getElementById(
      "openHereBtn",
    )
  ) {
    return;
  }

  const btn =
    document.createElement(
      "button",
    );

  btn.className =
    "btn ghost";

  btn.id =
    "openHereBtn";

  btn.textContent =
    "Open in this browser instead";

  btn.onclick =
    () =>
      window.open(
        "exam.html",
        "_blank",
        "noopener",
      );

  actions.insertBefore(
    btn,
    document.getElementById(
      "againBtn",
    ),
  );
}

function launchSeb() {
  const url =
    new URL(
      `/seb/${SEB_CONFIG_FILE}`,
      location.origin,
    );

  url.protocol =
    location.protocol === "https:"
      ? "sebs:"
      : "seb:";

  window.location.href =
    url.toString();
}

function startCountdown(
  expiresAt,
) {
  clearInterval(
    countdownTimer,
  );

  const el =
    document.getElementById(
      "entryCountdown",
    );

  const end =
    new Date(
      expiresAt,
    ).getTime();

  const tick = () => {
    const left =
      end - Date.now();

    if (left <= 0) {
      clearInterval(
        countdownTimer,
      );

      el.textContent =
        "expired";

      document.getElementById(
        "entryCode",
      ).classList.add(
        "expired",
      );

      document.getElementById(
        "entrySteps",
      ).innerHTML = `
        <b>That code has expired.</b>
        Press <b>Get a new code</b>
        to receive another.
      `;

      return;
    }

    const m =
      Math.floor(
        left / 60000,
      );

    const s =
      Math.floor(
        (left % 60000) /
        1000,
      );

    el.textContent =
      `expires in ${m}:${
        String(s)
          .padStart(2, "0")
      }`;
  };

  tick();

  countdownTimer =
    setInterval(
      tick,
      1000,
    );
}

function setBusy(on) {
  busy = on;

  startBtn.disabled = on;

  startBtn.textContent =
    on
      ? "Working…"
      : "Start";

  list.querySelectorAll(
    "button",
  ).forEach((button) => {
    button.disabled = on;
  });
}

function show(
  text,
  kind = "error",
) {
  msg.textContent = text;
  msg.className =
    `notice ${kind}`;
  msg.classList.remove(
    "hidden",
  );
}

function hide() {
  msg.classList.add(
    "hidden",
  );
}

function when(v) {
  return new Date(v)
    .toLocaleString(
      [],
      {
        dateStyle: "medium",
        timeStyle: "short",
      },
    );
}
