// public/js/faculty-extras.js
//
// PariksaRakshak faculty exam-day enhancements.
//
// Adds without replacing faculty.js:
// - clear Publish/Stop Entry vs Release Result wording
// - READY / FIX readiness badges for every paper
// - code-runner ONLINE/OFFLINE pre-exam check
// - Release Result directly from Papers
// - Release all eligible closed results
// - Duplicate paper
// - Force Submit one student
// - Submit all active attempts
// - richer result statistics and score / total / percentage
//
// SQL migration 010 is required for the new RPCs.

import { supabase, callFunction, escapeHtml } from "./supabaseClient.js";

const papersPane = document.getElementById("pane-papers");
const examList = document.getElementById("examList");
const roster = document.getElementById("roster");
const resultExam = document.getElementById("resultExam");
const resultsTable = document.getElementById("resultsTable");

let paperRefreshTimer = null;
let resultRefreshTimer = null;
let runnerHealth = null;
let runnerHealthAt = 0;

if (papersPane) boot();

function boot() {
  installPaperControlPanel();
  installRoomEmergencyButton();
  installEnhancedResultStats();

  const examObserver = examList
    ? new MutationObserver(() => schedulePaperRefresh())
    : null;
  examObserver?.observe(examList, { childList: true, subtree: true });

  const rosterObserver = roster
    ? new MutationObserver(() => addForceSubmitButtons())
    : null;
  rosterObserver?.observe(roster, { childList: true, subtree: true });

  const resultObserver = resultsTable
    ? new MutationObserver(() => scheduleResultRefresh())
    : null;
  resultObserver?.observe(resultsTable, { childList: true, subtree: true });

  resultExam?.addEventListener("change", () => {
    setTimeout(refreshResultStats, 80);
  });

  document.getElementById("tab-results")?.addEventListener("click", () => {
    setTimeout(refreshResultStats, 120);
  });

  document.getElementById("tab-papers")?.addEventListener("click", () => {
    setTimeout(refreshPaperExtras, 120);
  });

  schedulePaperRefresh();
  scheduleResultRefresh();
}

function installPaperControlPanel() {
  if (document.getElementById("examDayControlPanel")) return;

  const panel = document.createElement("div");
  panel.className = "panel";
  panel.id = "examDayControlPanel";
  panel.style.marginBottom = "1rem";

  panel.innerHTML = `
    <div class="panel-head">
      <h2>Exam-day control</h2>
      <span class="eyebrow" id="examDayState">not checked</span>
      <button class="btn small" id="runExamDayCheck" style="margin-left:auto">
        Run full pre-exam check
      </button>
    </div>
    <div class="panel-body">
      <div style="display:flex;gap:.5rem;flex-wrap:wrap;margin-bottom:.8rem">
        <span class="tag blue">PUBLISH EXAM = students may enter</span>
        <span class="tag warn">STOP ENTRY = no new entry</span>
        <span class="tag pass">RELEASE RESULT = marks + answer review visible</span>
      </div>

      <p class="muted" style="font-size:.9rem;margin:.4rem 0">
        Publishing and releasing results are separate actions. A closed or unpublished
        paper does not automatically expose answer keys.
      </p>

      <div class="actions" style="margin-top:.8rem">
        <button class="btn ghost small" id="releaseEligibleResults">
          Release all eligible closed results
        </button>
        <span class="meta" id="runnerHealthLabel">Code runner: not checked</span>
      </div>

      <p class="notice hidden" id="examDayMsg" style="margin-top:.8rem"></p>
    </div>`;

  const split = papersPane.querySelector(".split");
  if (split) papersPane.insertBefore(panel, split);
  else papersPane.prepend(panel);

  document.getElementById("runExamDayCheck").onclick = runFullExamDayCheck;
  document.getElementById("releaseEligibleResults").onclick = releaseEligibleResults;
}

function schedulePaperRefresh() {
  clearTimeout(paperRefreshTimer);
  paperRefreshTimer = setTimeout(refreshPaperExtras, 120);
}

async function refreshPaperExtras() {
  if (!examList) return;

  const { data: exams, error } = await supabase
    .from("exams")
    .select("id, exam_code, title, starts_at, ends_at, is_published, results_released, results_released_at")
    .order("starts_at", { ascending: false });

  if (error) return;

  const byId = Object.fromEntries((exams ?? []).map((e) => [e.id, e]));

  const rows = [...examList.querySelectorAll(".list-row")];

  await Promise.all(rows.map(async (row) => {
    const edit = row.querySelector("[data-edit-exam]");
    if (!edit) return;

    const examId = edit.dataset.editExam;
    const exam = byId[examId];
    if (!exam) return;

    const tools = edit.parentElement;
    if (!tools) return;

    // Clarify the existing publish button wording.
    const toggle = tools.querySelector("[data-toggle]");
    if (toggle) {
      const published = exam.is_published === true;
      const toggleText = published ? "Stop entry" : "Publish exam";
      const toggleTitle = published
        ? "Stops new students entering. It does NOT release marks."
        : "Allows students to enter during the paper's time window.";

      if (toggle.textContent !== toggleText) toggle.textContent = toggleText;
      if (toggle.title !== toggleTitle) toggle.title = toggleTitle;
    }

    let ready = null;
    const { data: readiness } = await supabase.rpc("exam_readiness", {
      p_exam_id: examId,
    });
    ready = readiness ?? null;

    upsertTag(
      tools,
      `ready-tag-${examId}`,
      ready?.ready ? "READY" : "FIX BEFORE EXAM",
      ready?.ready ? "pass" : "warn",
      ready
        ? readinessTitle(ready)
        : "Run migration 010 to enable readiness checks.",
    );

    upsertTag(
      tools,
      `result-tag-${examId}`,
      exam.results_released ? "RESULT RELEASED" : "RESULT HIDDEN",
      exam.results_released ? "pass" : "",
      exam.results_released
        ? "Students can see marks and answer review after the paper has closed."
        : "Marks and correct answers are hidden from students.",
    );

    let releaseBtn = tools.querySelector(`[data-extra-release="${examId}"]`);
    if (!releaseBtn) {
      releaseBtn = document.createElement("button");
      releaseBtn.className = "btn ghost tiny";
      releaseBtn.dataset.extraRelease = examId;
      tools.insertBefore(releaseBtn, tools.querySelector("[data-del]") ?? null);
    }

    const ended = new Date(exam.ends_at).getTime() <= Date.now();
    const releaseText = exam.results_released ? "Hide result" : "Release result";
    const releaseDisabled = !exam.results_released && !ended;
    const releaseTitle = !ended && !exam.results_released
      ? "Results can only be released after the paper closes."
      : "";

    if (releaseBtn.textContent !== releaseText) releaseBtn.textContent = releaseText;
    releaseBtn.disabled = releaseDisabled;
    if (releaseBtn.title !== releaseTitle) releaseBtn.title = releaseTitle;

    releaseBtn.onclick = async () => {
      const next = !exam.results_released;
      if (!confirm(
        next
          ? `Release marks and correct-answer review for ${exam.exam_code}?`
          : `Hide released results for ${exam.exam_code}?`,
      )) return;

      const { error: releaseError } = await supabase.rpc(
        "set_exam_results_released",
        {
          p_exam_id: examId,
          p_release: next,
        },
      );

      if (releaseError) {
        alert(releaseError.message);
        return;
      }

      await refreshPaperExtras();
    };

    let duplicateBtn = tools.querySelector(`[data-extra-duplicate="${examId}"]`);
    if (!duplicateBtn) {
      duplicateBtn = document.createElement("button");
      duplicateBtn.className = "btn ghost tiny";
      duplicateBtn.dataset.extraDuplicate = examId;
      duplicateBtn.textContent = "Duplicate";
      tools.insertBefore(duplicateBtn, tools.querySelector("[data-del]") ?? null);
    }

    duplicateBtn.onclick = async () => {
      const code = prompt(
        "New exam code",
        `${exam.exam_code}_COPY`,
      );
      if (code === null) return;

      const title = prompt(
        "New paper title",
        `${exam.title} — Copy`,
      );
      if (title === null) return;

      const { error: duplicateError } = await supabase.rpc("duplicate_exam", {
        p_exam_id: examId,
        p_new_code: code.trim().toUpperCase(),
        p_new_title: title.trim(),
      });

      if (duplicateError) {
        alert(`Could not duplicate paper: ${duplicateError.message}`);
        return;
      }

      alert(
        "Paper duplicated as a DRAFT. Its default time is tomorrow; edit the paper before publishing.",
      );
      location.reload();
    };
  }));
}

function upsertTag(parent, id, text, cls, title = "") {
  let el = document.getElementById(id);

  if (!el) {
    el = document.createElement("span");
    el.id = id;
    parent.insertBefore(el, parent.firstChild);
  }

  const className = `tag ${cls || ""}`;
  if (el.className !== className) el.className = className;
  if (el.textContent !== text) el.textContent = text;
  if (el.title !== title) el.title = title;
}

function readinessTitle(r) {
  const parts = [
    `${r.question_count ?? 0} questions`,
    `${r.total_marks ?? 0} marks`,
  ];

  if (Number(r.missing_mcq_keys ?? 0) > 0) {
    parts.push(`${r.missing_mcq_keys} MCQ key(s) missing`);
  }

  if (Number(r.missing_cloze_keys ?? 0) > 0) {
    parts.push(`${r.missing_cloze_keys} cloze key(s) missing`);
  }

  if (Number(r.broken_coding_questions ?? 0) > 0) {
    parts.push(`${r.broken_coding_questions} coding question(s) have broken tests`);
  }

  if (Number(r.coding_questions_under_5_tests ?? 0) > 0) {
    parts.push(`${r.coding_questions_under_5_tests} coding question(s) have fewer than 5 tests`);
  }

  return parts.join(" · ");
}

async function getRunnerHealth(force = false) {
  const fresh = Date.now() - runnerHealthAt < 30000;
  if (!force && fresh && runnerHealth) return runnerHealth;

  const res = await callFunction("run-code", { action: "ping" });

  runnerHealth = res;
  runnerHealthAt = Date.now();

  const label = document.getElementById("runnerHealthLabel");
  if (label) {
    if (res.ok) {
      label.textContent =
        `Code runner: ONLINE · ${res.provider ?? "provider"} · ${res.detail ?? "reachable"}`;
      label.style.fontWeight = "600";
    } else {
      label.textContent =
        `Code runner: OFFLINE · ${res.error ?? res.detail ?? "provider unavailable"}`;
      label.style.fontWeight = "700";
    }
  }

  return res;
}

async function runFullExamDayCheck() {
  const btn = document.getElementById("runExamDayCheck");
  const state = document.getElementById("examDayState");

  btn.disabled = true;
  btn.textContent = "Checking…";
  state.textContent = "checking";

  try {
    const runner = await getRunnerHealth(true);

    const { data: exams } = await supabase
      .from("exams")
      .select("id, exam_code, title, starts_at, ends_at, is_published")
      .order("starts_at", { ascending: true });

    const relevant = (exams ?? []).filter((e) =>
      e.is_published &&
      new Date(e.ends_at).getTime() > Date.now(),
    );

    const results = [];
    for (const e of relevant) {
      const { data, error } = await supabase.rpc("exam_readiness", {
        p_exam_id: e.id,
      });

      results.push({
        exam: e,
        readiness: data,
        error,
      });
    }

    const notReady = results.filter((r) => !r.readiness?.ready || r.error);
    const warnings = results.filter(
      (r) => Number(r.readiness?.coding_questions_under_5_tests ?? 0) > 0,
    );

    if (!runner.ok) {
      state.textContent = "BLOCKED";
      showExamDayMsg(
        `Code runner is OFFLINE. Do not use coding questions until it is online. ${
          runner.error ?? runner.detail ?? ""
        }`,
        "error",
      );
      return;
    }

    if (notReady.length) {
      state.textContent = "FIX REQUIRED";
      showExamDayMsg(
        `Runner is online, but ${notReady.length} published/upcoming paper(s) are not ready: ` +
        notReady.map((r) => escapeHtml(r.exam.exam_code)).join(", "),
        "error",
      );
      return;
    }

    state.textContent = "READY";
    showExamDayMsg(
      relevant.length
        ? `Runner online. ${relevant.length} published/upcoming paper(s) passed the hard readiness checks.${
            warnings.length
              ? ` ${warnings.length} paper(s) have coding questions with fewer than 5 tests — review them.`
              : ""
          }`
        : "Runner online. There is no published/upcoming paper to check.",
      warnings.length ? "warn" : "ok",
    );
  } finally {
    btn.disabled = false;
    btn.textContent = "Run full pre-exam check";
    await refreshPaperExtras();
  }
}

async function releaseEligibleResults() {
  if (!confirm(
    "Release every closed paper that has no unmarked submitted long answers?",
  )) return;

  const { data, error } = await supabase.rpc("release_all_closed_results");

  if (error) {
    showExamDayMsg(error.message, "error");
    return;
  }

  showExamDayMsg(
    `${Number(data ?? 0)} closed paper(s) released to students.`,
    "ok",
  );

  await refreshPaperExtras();
  await refreshResultStats();
}

function showExamDayMsg(text, kind = "") {
  const el = document.getElementById("examDayMsg");
  if (!el) return;

  el.textContent = text;
  el.className = `notice ${kind}`;
  el.classList.remove("hidden");
}

/* ============================================================
   ROOM — emergency submit
   ============================================================ */

function installRoomEmergencyButton() {
  const refresh = document.getElementById("refreshRoom");
  if (!refresh || document.getElementById("forceSubmitAllBtn")) return;

  const btn = document.createElement("button");
  btn.className = "btn ghost tiny";
  btn.id = "forceSubmitAllBtn";
  btn.textContent = "Submit all active";
  btn.title = "Emergency action: submits every active attempt for the selected paper.";

  refresh.parentElement.insertBefore(btn, refresh);

  btn.onclick = async () => {
    const examId = document.getElementById("roomExam")?.value;
    if (!examId) return;

    if (!confirm(
      "EMERGENCY ACTION\n\nForce-submit every active student on this paper now?",
    )) return;

    const { data, error } = await supabase.rpc("force_submit_all_attempts", {
      p_exam_id: examId,
    });

    if (error) {
      alert(error.message);
      return;
    }

    alert(`${Number(data ?? 0)} active attempt(s) submitted.`);
    document.getElementById("refreshRoom")?.click();
  };
}

function addForceSubmitButtons() {
  if (!roster) return;

  roster.querySelectorAll("[data-extra]").forEach((extraBtn) => {
    const attemptId = extraBtn.dataset.extra;
    if (!attemptId) return;

    const tools = extraBtn.parentElement;
    if (!tools) return;

    if (tools.querySelector(`[data-force-submit="${attemptId}"]`)) return;

    const btn = document.createElement("button");
    btn.className = "btn ghost tiny";
    btn.dataset.forceSubmit = attemptId;
    btn.textContent = "Force submit";

    tools.insertBefore(btn, tools.querySelector("[data-reset-attempt]") ?? null);

    btn.onclick = async () => {
      if (!confirm(
        "Force-submit this student's current answers now?\n\nThis ends their attempt.",
      )) return;

      btn.disabled = true;
      btn.textContent = "Submitting…";

      const { error } = await supabase.rpc("force_submit_attempt", {
        p_attempt_id: attemptId,
      });

      if (error) {
        alert(error.message);
        btn.disabled = false;
        btn.textContent = "Force submit";
        return;
      }

      document.getElementById("refreshRoom")?.click();
    };
  });
}

/* ============================================================
   RESULTS — richer statistics
   ============================================================ */

function installEnhancedResultStats() {
  const pane = document.getElementById("pane-results");
  if (!pane || document.getElementById("enhancedResultStats")) return;

  const panel = document.createElement("div");
  panel.className = "panel";
  panel.id = "enhancedResultStats";
  panel.style.margin = ".9rem 0 1rem";

  panel.innerHTML = `
    <div class="panel-head">
      <h2>Result summary</h2>
      <span class="eyebrow" id="resultReleaseMini"></span>
      <button class="btn ghost tiny" id="setPassPercentage" style="margin-left:auto">
        Set pass %
      </button>
    </div>
    <div class="panel-body">
      <div class="stats" id="enhancedResultStatsBody">
        <div><strong>—</strong><span>total marks</span></div>
      </div>
    </div>`;

  const stack = pane.querySelector(".stack");
  if (stack) pane.insertBefore(panel, stack);
  else pane.appendChild(panel);

  document.getElementById("setPassPercentage").onclick = async () => {
    const examId = resultExam?.value;
    if (!examId) return;

    const current = await getResultStats(examId);
    if (!current) return;

    const next = prompt(
      "Pass percentage",
      String(current.pass_percentage ?? 40),
    );

    if (next === null) return;

    const n = Number(next);
    if (!Number.isFinite(n) || n < 0 || n > 100) {
      alert("Enter a percentage from 0 to 100.");
      return;
    }

    const { error } = await supabase
      .from("exams")
      .update({ pass_percentage: n })
      .eq("id", examId);

    if (error) {
      alert(error.message);
      return;
    }

    await refreshResultStats();
  };
}

function scheduleResultRefresh() {
  clearTimeout(resultRefreshTimer);
  resultRefreshTimer = setTimeout(refreshResultStats, 100);
}

async function getResultStats(examId) {
  const { data, error } = await supabase.rpc("exam_result_stats", {
    p_exam_id: examId,
  });

  if (error) return null;
  return data;
}

async function refreshResultStats() {
  if (!resultExam?.value) return;

  const stats = await getResultStats(resultExam.value);
  if (!stats) return;

  const body = document.getElementById("enhancedResultStatsBody");
  const release = document.getElementById("resultReleaseMini");

  if (release) {
    release.textContent = stats.results_released
      ? "released to students"
      : "hidden from students";
  }

  if (body) {
    body.innerHTML = `
      <div><strong>${num(stats.total_marks)}</strong><span>total marks</span></div>
      <div><strong>${stats.submitted ?? 0}</strong><span>submitted</span></div>
      <div><strong>${stats.active ?? 0}</strong><span>active</span></div>
      <div><strong>${stats.average == null ? "—" : num(stats.average)}</strong><span>average</span></div>
      <div><strong>${stats.highest == null ? "—" : num(stats.highest)}</strong><span>highest</span></div>
      <div><strong>${stats.passed ?? 0}</strong><span>passed ≥ ${num(stats.pass_percentage)}%</span></div>
      <div><strong>${stats.failed ?? 0}</strong><span>failed</span></div>
      <div><strong>${stats.pending_long_answers ?? 0}</strong><span>long answers pending</span></div>`;
  }

  enhanceScoreCells(Number(stats.total_marks ?? 0));
}

function enhanceScoreCells(totalMarks) {
  if (!resultsTable || totalMarks <= 0) return;

  resultsTable.querySelectorAll("tbody tr").forEach((tr) => {
    const scoreCell = tr.querySelector("td:nth-child(3)");
    if (!scoreCell || scoreCell.dataset.enhancedScore === "1") return;

    const raw = scoreCell.textContent.trim();
    if (raw === "") return;

    const score = Number(raw);
    if (!Number.isFinite(score)) return;

    const pct = score * 100 / totalMarks;

    scoreCell.innerHTML = `
      <b>${num(score)} / ${num(totalMarks)}</b><br>
      <span class="meta">${num(pct)}%</span>`;

    scoreCell.dataset.enhancedScore = "1";
  });
}

function num(value) {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return "0";

  return Number.isInteger(n)
    ? String(n)
    : n.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}
