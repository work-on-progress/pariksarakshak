// public/js/setup-enhancements.js
//
// Fixes the old Setup page's provider-specific Piston check.
// The project now uses the provider reported by run-code itself.
//
// Also checks:
// - migration 009 result/attempt history support
// - migration 010 readiness/emergency RPCs
// - browser switch limit is 6
//
// It does not replace setup.js.

import { supabase, callFunction } from "./supabaseClient.js";
import { BROWSER_MODE } from "./config.js";

let patchTimer = null;
let patching = false;

boot();

function boot() {
  const box = document.getElementById("checks");
  if (!box) return;

  new MutationObserver(schedulePatch).observe(box, {
    childList: true,
    subtree: true,
  });

  document.getElementById("runBtn")?.addEventListener("click", () => {
    setTimeout(schedulePatch, 300);
  });

  schedulePatch();
}

function schedulePatch() {
  clearTimeout(patchTimer);
  patchTimer = setTimeout(patchChecks, 250);
}

async function patchChecks() {
  if (patching) return;
  patching = true;

  try {
    await patchRunnerCard();
    await upsertResultFlowCard();
    await upsertReadinessCard();
    upsertSwitchLimitCard();
    recalcSummary();
  } finally {
    patching = false;
  }
}

async function patchRunnerCard() {
  const card = document.getElementById("chk-piston");
  if (!card) return;

  const res = await callFunction("run-code", { action: "ping" });

  if (res.ok) {
    setCard(
      card,
      "ok",
      "The code execution service is reachable",
      `${String(res.provider ?? "runner").toUpperCase()} is online. ${res.detail ?? ""}`.trim(),
    );
  } else {
    setCard(
      card,
      "fail",
      "The code execution service is reachable",
      res.error ?? res.detail ?? "The configured execution provider is offline.",
    );
  }
}

async function upsertResultFlowCard() {
  const card = ensureCard("result-flow", "Student attempt history and result release");

  const { error } = await supabase
    .from("exams")
    .select("results_released, results_released_at")
    .limit(1);

  if (error && /results_released/i.test(error.message ?? "")) {
    setCard(
      card,
      "fail",
      "Student attempt history and result release",
      "Migration 009 is missing. Run 009_attempt_history_results_partial_marks.sql.",
    );
    return;
  }

  const { error: rpcError } = await supabase.rpc("student_attempt_history");

  if (rpcError && /function|schema cache|could not find/i.test(rpcError.message ?? "")) {
    setCard(
      card,
      "fail",
      "Student attempt history and result release",
      "student_attempt_history() is missing. Re-run migration 009.",
    );
    return;
  }

  setCard(
    card,
    "ok",
    "Student attempt history and result release",
    "Result-release columns and the student history RPC are installed.",
  );
}

async function upsertReadinessCard() {
  const card = ensureCard("readiness-rpc", "Exam readiness and emergency controls");

  // A fake UUID should fail with "not your exam", but the function must exist.
  const { error } = await supabase.rpc("exam_readiness", {
    p_exam_id: "00000000-0000-0000-0000-000000000000",
  });

  if (
    error &&
    /function|schema cache|could not find/i.test(error.message ?? "")
  ) {
    setCard(
      card,
      "fail",
      "Exam readiness and emergency controls",
      "Migration 010 is missing. Run 010_exam_day_safety_and_controls.sql.",
    );
    return;
  }

  setCard(
    card,
    "ok",
    "Exam readiness and emergency controls",
    "Migration 010 RPCs are installed.",
  );
}

function upsertSwitchLimitCard() {
  const card = ensureCard("switch-limit", "Ordinary-browser tab-switch limit");

  const n = Number(BROWSER_MODE.autoSubmitAfterSwitches ?? 0);

  if (n === 6) {
    setCard(
      card,
      "ok",
      "Ordinary-browser tab-switch limit",
      "Six genuine switches are allowed; the 6th switch auto-submits. Blur + tab-hidden are deduplicated by anticheat.js.",
    );
  } else {
    setCard(
      card,
      "fail",
      "Ordinary-browser tab-switch limit",
      `config.js currently uses ${n || 0}. Set autoSubmitAfterSwitches to 6.`,
    );
  }
}

function ensureCard(id, title) {
  let el = document.getElementById(`chk-${id}`);

  if (!el) {
    el = document.createElement("div");
    el.className = "check";
    el.id = `chk-${id}`;
    el.innerHTML = `<span class="mark">…</span><div><b></b><span></span></div>`;
    document.getElementById("checks")?.appendChild(el);
  }

  if (el.querySelector("b").textContent !== title) {
    el.querySelector("b").textContent = title;
  }
  return el;
}

function setCard(el, state, title, detail) {
  const mark = state === "ok" ? "PASS" : state === "warn" ? "CHECK" : "FAIL";

  if (el.dataset.state !== state) el.dataset.state = state;
  if (el.querySelector(".mark").textContent !== mark) {
    el.querySelector(".mark").textContent = mark;
  }
  if (el.querySelector("b").textContent !== title) {
    el.querySelector("b").textContent = title;
  }
  if (el.querySelector("div span").textContent !== detail) {
    el.querySelector("div span").textContent = detail;
  }
}

function recalcSummary() {
  const cards = [...document.querySelectorAll("#checks .check")];
  const fails = cards.filter((c) => c.dataset.state === "fail").length;
  const warns = cards.filter((c) => c.dataset.state === "warn").length;
  const summary = document.getElementById("summary");

  if (!summary) return;

  const text = fails
    ? `${fails} to fix${warns ? `, ${warns} to look at` : ""}`
    : warns
    ? `All hard checks passed, ${warns} to look at`
    : "Everything passed — you are ready.";

  if (summary.textContent !== text) summary.textContent = text;
}
