// public/js/faculty-results-release.js
//
// Faculty Results-tab extension.
// Loaded automatically from config.js only on faculty.html.
//
// Adds:
//   - result release status
//   - Release results to students
//   - Hide released results
//
// Security is enforced by SQL migration 009, not by this button:
// results cannot be released before the paper closes, and submitted long
// answers with missing marks block release.

import { supabase, escapeHtml } from "./supabaseClient.js";

const pane = document.getElementById("pane-results");
const examSelect = document.getElementById("resultExam");

if (pane && examSelect) {
  bootReleaseControl();
}

function bootReleaseControl() {
  installControl();

  examSelect.addEventListener("change", refreshReleaseStatus);

  const observer = new MutationObserver(() => {
    if (examSelect.value) refreshReleaseStatus();
  });

  observer.observe(examSelect, {
    childList: true,
    subtree: true,
  });

  document.getElementById("tab-results")?.addEventListener("click", () => {
    setTimeout(refreshReleaseStatus, 50);
  });

  document.getElementById("releaseResultsBtn").onclick = toggleRelease;

  setTimeout(refreshReleaseStatus, 500);

  setInterval(() => {
    if (pane.classList.contains("active")) refreshReleaseStatus();
  }, 15000);
}

function installControl() {
  if (document.getElementById("resultReleasePanel")) return;

  const panel = document.createElement("div");
  panel.className = "panel";
  panel.id = "resultReleasePanel";
  panel.style.margin = ".9rem 0 1.1rem";

  panel.innerHTML = `
    <div class="panel-head">
      <h2>Student result release</h2>
      <span class="eyebrow" id="releaseState">checking…</span>
      <button class="btn small" id="releaseResultsBtn" style="margin-left:auto" disabled>
        Release results
      </button>
    </div>
    <div class="panel-body">
      <p id="releaseHelp" class="muted" style="margin:0">
        Students can see that they submitted a paper, but marks and answer keys stay hidden
        until you explicitly release the result after the exam closes.
      </p>
      <p id="releaseMsg" class="notice hidden" style="margin-top:.8rem"></p>
    </div>`;

  const firstStack = pane.querySelector(".stack");
  if (firstStack) pane.insertBefore(panel, firstStack);
  else pane.appendChild(panel);
}

async function refreshReleaseStatus() {
  const examId = examSelect.value;
  const btn = document.getElementById("releaseResultsBtn");
  const state = document.getElementById("releaseState");
  const help = document.getElementById("releaseHelp");

  hideMsg();

  if (!examId) {
    state.textContent = "no paper";
    btn.disabled = true;
    help.textContent = "Choose a paper first.";
    return;
  }

  const { data, error } = await supabase.rpc("faculty_result_release_status", {
    p_exam_id: examId,
  });

  if (error) {
    state.textContent = "migration needed";
    btn.disabled = true;
    help.innerHTML =
      `Could not read release status: ${escapeHtml(error.message)}. ` +
      `Run migration <b>009</b> first.`;
    return;
  }

  const info = data ?? {};
  const released = info.results_released === true;
  const pending = Number(info.pending_long_answers ?? 0);
  const ended = new Date(info.ends_at).getTime() <= Date.now();

  state.textContent = released ? "released to students" : "hidden from students";

  btn.dataset.released = String(released);
  btn.textContent = released
    ? "Hide results from students"
    : "Release results to students";

  if (released) {
    btn.disabled = false;
    btn.className = "btn ghost small";

    help.innerHTML =
      `Students can now see marks, correct/wrong answers, correct answers and explanations. ` +
      `Released ${info.results_released_at ? new Date(info.results_released_at).toLocaleString() : "now"}.`;
    return;
  }

  btn.className = "btn small";

  if (!ended) {
    btn.disabled = true;
    help.innerHTML =
      `This paper closes <b>${escapeHtml(new Date(info.ends_at).toLocaleString())}</b>. ` +
      `Result release is locked until then.`;
    return;
  }

  if (pending > 0) {
    btn.disabled = true;
    help.innerHTML =
      `<b>${pending}</b> submitted long answer${pending === 1 ? "" : "s"} still need marks. ` +
      `Mark them first, then release the result.`;
    return;
  }

  btn.disabled = false;
  help.textContent =
    "The paper has closed and all submitted long answers are marked. You can release results now.";
}

async function toggleRelease() {
  const examId = examSelect.value;
  if (!examId) return;

  const btn = document.getElementById("releaseResultsBtn");
  const currentlyReleased = btn.dataset.released === "true";
  const next = !currentlyReleased;

  const question = next
    ? "Release marks and answer review to students now?"
    : "Hide these released results from students again?";

  if (!confirm(question)) return;

  btn.disabled = true;
  btn.textContent = next ? "Releasing…" : "Hiding…";

  const { data, error } = await supabase.rpc("set_exam_results_released", {
    p_exam_id: examId,
    p_release: next,
  });

  if (error) {
    showMsg(error.message, "error");
    await refreshReleaseStatus();
    return;
  }

  showMsg(
    data?.results_released
      ? "Results released. Students can now open their question-by-question review."
      : "Results hidden from students.",
    "ok",
  );

  await refreshReleaseStatus();
}

function showMsg(text, kind = "") {
  const el = document.getElementById("releaseMsg");
  el.textContent = text;
  el.className = `notice ${kind}`;
  el.classList.remove("hidden");
}

function hideMsg() {
  const el = document.getElementById("releaseMsg");
  if (el) el.classList.add("hidden");
}
