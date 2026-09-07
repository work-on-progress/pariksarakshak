// public/js/exam-enhancements.js
//
// Exam-page safety and clarity enhancements.
//
// HOTFIX:
// The previous version installed the submission summary while the exam was still
// on the six-digit entry screen. Its global MutationObserver then repeatedly
// rewrote "Preparing submission summary…", creating an endless mutation loop.
// That could starve the browser event loop and make the entry-code field and
// buttons appear completely unresponsive.
//
// This version:
// - does NOT install/update the submission summary until the actual paper is visible
// - schedules observer work instead of running it recursively inside mutations
// - never writes the same "preparing" text repeatedly
// - keeps the existing switch counter and final-submit retry behaviour

import { supabase } from "./supabaseClient.js";
import { BROWSER_MODE, AUTOSAVE_DELAY_MS } from "./config.js";

let currentAttemptId = null;
let retryStarted = false;
let attentionBusy = false;
let capturingAttempt = false;
let refreshQueued = false;

boot();

function boot() {
  const observer = new MutationObserver(() => {
    scheduleRefresh();
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class", "data-ok"],
  });

  // Run once after the current module stack is complete.
  scheduleRefresh();

  // Also refresh on focus in case the page was backgrounded while state changed.
  window.addEventListener("focus", scheduleRefresh);
}

function scheduleRefresh() {
  if (refreshQueued) return;
  refreshQueued = true;

  setTimeout(async () => {
    refreshQueued = false;

    patchSwitchCounter();

    // IMPORTANT: do not create/update the submission summary on the code gate.
    if (paperIsVisible()) {
      installSubmissionSummary();
      updateSubmissionSummary();
      await captureCurrentAttempt();
    }

    detectReceiptAndRetry();
  }, 0);
}

function paperIsVisible() {
  const examScreen = document.getElementById("examScreen");
  return Boolean(
    examScreen &&
    !examScreen.classList.contains("hidden")
  );
}

function patchSwitchCounter() {
  if (attentionBusy) return;

  const el = document.getElementById("attention");
  if (!el || el.classList.contains("hidden")) return;

  const text = el.textContent || "";
  const match = text.match(/(\d+)\s+switch/i);

  if (!match) return;

  const count = Number(match[1]);
  const limit = Number(BROWSER_MODE.autoSubmitAfterSwitches || 0);

  if (!limit) return;

  const desired =
    count >= limit
      ? `${count} / ${limit} switches · limit reached · submitting`
      : count === limit - 1
      ? `WARNING · switches away: ${count} / ${limit} · next switch auto-submits`
      : `Switches away: ${count} / ${limit} · recorded`;

  if (el.textContent === desired) return;

  attentionBusy = true;
  el.textContent = desired;

  if (count >= limit - 1) {
    el.className = "attention hot";
  }

  queueMicrotask(() => {
    attentionBusy = false;
  });
}

function installSubmissionSummary() {
  if (!paperIsVisible()) return;

  const finishBtn = document.getElementById("finishBtn");
  if (!finishBtn || document.getElementById("submissionSummary")) return;

  const box = document.createElement("div");
  box.id = "submissionSummary";
  box.className = "notice";
  box.style.cssText = "margin:.8rem 0;font-size:.9rem";

  finishBtn.parentElement?.insertBefore(box, finishBtn);
}

function updateSubmissionSummary() {
  if (!paperIsVisible()) return;

  const box = document.getElementById("submissionSummary");
  if (!box) return;

  const cards = [...document.querySelectorAll(".qcard")];

  if (!cards.length) {
    const preparing = "Preparing submission summary…";

    // Critical: only write when the value actually changes.
    if (box.textContent !== preparing) {
      box.textContent = preparing;
    }

    return;
  }

  const pips = [...document.querySelectorAll("#progress .pip")];
  const answered = pips.filter((p) => p.classList.contains("done")).length;
  const total = cards.length;
  const blank = Math.max(total - answered, 0);

  const codingCards = cards.filter((card) =>
    [...card.querySelectorAll(".tag")].some(
      (tag) => tag.textContent.trim().toLowerCase() === "coding",
    ),
  );

  const codingSubmitted = codingCards.filter((card) =>
    [...card.querySelectorAll(".save-state")].some((s) =>
      /submitted\s*·/i.test(s.textContent || ""),
    ),
  ).length;

  const signature =
    `${answered}|${total}|${blank}|${codingSubmitted}|${codingCards.length}`;

  if (box.dataset.signature === signature) return;

  box.dataset.signature = signature;

  box.innerHTML = `
    <b>Before final submit:</b>
    ${answered} / ${total} answered ·
    ${blank} blank ·
    coding submitted for marks ${codingSubmitted} / ${codingCards.length}
    ${
      blank > 0 || codingSubmitted < codingCards.length
        ? `<br><span style="font-weight:600">Review the unfinished items before pressing Final Submit.</span>`
        : `<br><span style="font-weight:600">Everything appears answered/submitted.</span>`
    }`;
}

async function captureCurrentAttempt() {
  if (currentAttemptId || capturingAttempt || !paperIsVisible()) return;

  capturingAttempt = true;

  try {
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) return;

    const { data } = await supabase
      .from("attempts")
      .select("id, started_at")
      .eq("student_id", user.id)
      .eq("status", "in_progress")
      .order("started_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    currentAttemptId = data?.id ?? null;
  } finally {
    capturingAttempt = false;
  }
}

function detectReceiptAndRetry() {
  if (retryStarted || !currentAttemptId) return;

  const h1 = document.querySelector(".gate h1");
  if (!h1 || h1.textContent.trim() !== "Paper submitted") return;

  retryStarted = true;
  verifyFinalSubmission();
}

async function verifyFinalSubmission() {
  // Allow the core submit path to finish first.
  await sleep(AUTOSAVE_DELAY_MS + 900);

  for (let attemptNo = 1; attemptNo <= 3; attemptNo++) {
    const { data: row } = await supabase
      .from("attempts")
      .select("status, score")
      .eq("id", currentAttemptId)
      .maybeSingle();

    if (row?.status === "submitted") {
      addReceiptState(
        "Submission confirmed by the server.",
        "ok",
      );
      return;
    }

    const { error } = await supabase.rpc("grade_attempt", {
      p_attempt_id: currentAttemptId,
    });

    if (!error) {
      const { data: after } = await supabase
        .from("attempts")
        .select("status")
        .eq("id", currentAttemptId)
        .maybeSingle();

      if (after?.status === "submitted") {
        addReceiptState(
          `Submission confirmed after automatic retry ${attemptNo}.`,
          "ok",
        );
        return;
      }
    }

    await sleep(900 * attemptNo);
  }

  addReceiptState(
    "IMPORTANT: The server has not confirmed the final submission after 3 retries. Do not rely on this screen alone — tell the invigilator before leaving.",
    "error",
  );
}

function addReceiptState(text, kind) {
  const gate = document.querySelector(".gate-inner");
  if (!gate) return;

  let el = document.getElementById("submissionServerState");

  if (!el) {
    el = document.createElement("p");
    el.id = "submissionServerState";
    gate.appendChild(el);
  }

  el.className = `notice ${kind}`;
  el.style.marginTop = "1rem";
  el.textContent = text;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
