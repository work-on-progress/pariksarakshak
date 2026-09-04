// public/js/exam-enhancements.js
//
// Exam-page safety and clarity enhancements.
//
// The core exam.js still owns the exam and marking.
// This extension only adds:
// - visible "switches n / 6" wording
// - strong warning at 5 / 6
// - answered / blank / coding-submitted summary near Final Submit
// - retry of grade_attempt if the final submission RPC had a transient failure
//
// The actual auto-submit threshold remains enforced by exam.js + anticheat.js
// using BROWSER_MODE.autoSubmitAfterSwitches.

import { supabase } from "./supabaseClient.js";
import { BROWSER_MODE, AUTOSAVE_DELAY_MS } from "./config.js";

let currentAttemptId = null;
let retryStarted = false;
let attentionBusy = false;
let capturingAttempt = false;

boot();

function boot() {
  const observer = new MutationObserver(() => {
    patchSwitchCounter();
    installSubmissionSummary();
    updateSubmissionSummary();
    captureCurrentAttempt();
    detectReceiptAndRetry();
  });

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["class"],
  });

  patchSwitchCounter();
  installSubmissionSummary();
  captureCurrentAttempt();
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
  const finishBtn = document.getElementById("finishBtn");
  if (!finishBtn || document.getElementById("submissionSummary")) return;

  const box = document.createElement("div");
  box.id = "submissionSummary";
  box.className = "notice";
  box.style.cssText = "margin:.8rem 0;font-size:.9rem";

  finishBtn.parentElement?.insertBefore(box, finishBtn);
  updateSubmissionSummary();

  const area = document.getElementById("questionArea");
  if (area) {
    new MutationObserver(updateSubmissionSummary).observe(area, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["class", "data-ok"],
    });
  }
}

function updateSubmissionSummary() {
  const box = document.getElementById("submissionSummary");
  if (!box) return;

  const cards = [...document.querySelectorAll(".qcard")];
  if (!cards.length) {
    box.textContent = "Preparing submission summary…";
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

  const signature = `${answered}|${total}|${blank}|${codingSubmitted}|${codingCards.length}`;
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
  if (currentAttemptId || capturingAttempt) return;

  const examScreen = document.getElementById("examScreen");
  if (!examScreen || examScreen.classList.contains("hidden")) return;

  capturingAttempt = true;

  try {
    const { data: { user } } = await supabase.auth.getUser();
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
