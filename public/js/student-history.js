// public/js/student-history.js
//
// Student dashboard extension.
// Loaded automatically from config.js only on student.html.
//
// Shows:
//   - every exam the student attempted
//   - submitted / in-progress state
//   - marks and percentage after faculty releases results
//   - question-by-question review
//   - student's answer
//   - correct / wrong / partial
//   - correct answer for MCQ and cloze
//   - coding submitted code + tests passed + partial marks
//
// Hidden coding test input/output is never requested or displayed.

import { supabase, escapeHtml } from "./supabaseClient.js";

const root = document.querySelector(".student-console");

if (root) {
  bootHistory();
}

async function bootHistory() {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;

  installHistoryPanel();
  installResultDialog();

  document.getElementById("refreshHistoryBtn").onclick = loadHistory;

  await loadHistory();
}

function installHistoryPanel() {
  if (document.getElementById("attemptHistoryPanel")) return;

  const section = document.createElement("section");
  section.className = "panel";
  section.id = "attemptHistoryPanel";
  section.style.marginTop = "1.25rem";

  section.innerHTML = `
    <div class="panel-head">
      <h2>Attempt history</h2>
      <span class="eyebrow" id="historyCount">loading…</span>
      <button class="btn ghost tiny" id="refreshHistoryBtn" style="margin-left:auto">
        Refresh
      </button>
    </div>
    <div class="panel-body">
      <p class="muted" style="font-size:.9rem;margin-top:0">
        Submitted papers appear here permanently. Marks, correct answers and explanations
        become visible only after the paper has closed and the faculty releases the result.
      </p>
      <div id="attemptHistoryList">
        <p class="empty">Loading your attempts…</p>
      </div>
    </div>`;

  const help = document.querySelector(".seb-help");
  if (help) help.before(section);
  else root.appendChild(section);
}

function installResultDialog() {
  if (document.getElementById("studentResultDialog")) return;

  const dialog = document.createElement("dialog");
  dialog.id = "studentResultDialog";
  dialog.className = "flags-dialog";

  dialog.innerHTML = `
    <div class="panel flags-dialog-panel" style="max-width:1000px;width:min(96vw,1000px)">
      <div class="panel-head">
        <div>
          <h2 id="studentResultTitle">Attempt result</h2>
          <span class="eyebrow" id="studentResultScore"></span>
        </div>
        <button class="btn ghost tiny" id="closeStudentResult" style="margin-left:auto">
          Close
        </button>
      </div>
      <div class="panel-body" id="studentResultBody">
        <p class="empty">Loading…</p>
      </div>
    </div>`;

  document.body.appendChild(dialog);

  document.getElementById("closeStudentResult").onclick = () => {
    if (typeof dialog.close === "function") dialog.close();
    else dialog.removeAttribute("open");
  };
}

async function loadHistory() {
  const box = document.getElementById("attemptHistoryList");
  const count = document.getElementById("historyCount");

  box.innerHTML = `<p class="empty">Loading your attempts…</p>`;

  const { data, error } = await supabase.rpc("student_attempt_history");

  if (error) {
    box.innerHTML = `
      <p class="notice error">
        ${escapeHtml(error.message)}
        <br><span class="meta">Run migration 009 if Attempt History has not been installed yet.</span>
      </p>`;
    count.textContent = "unavailable";
    return;
  }

  const rows = data ?? [];
  count.textContent = rows.length
    ? `${rows.length} attempt${rows.length === 1 ? "" : "s"}`
    : "none yet";

  if (!rows.length) {
    box.innerHTML = `<p class="empty">You have not attempted a paper yet.</p>`;
    return;
  }

  box.innerHTML = rows.map((r) => {
    const released = r.result_released === true;
    const submitted = r.status === "submitted";

    const scoreBlock = released
      ? `
        <div style="text-align:right">
          <div style="font-size:1.25rem;font-weight:700">
            ${num(r.score)} / ${num(r.total_marks)}
          </div>
          <div class="meta">${num(r.percentage)}%</div>
        </div>`
      : `
        <div style="text-align:right">
          <span class="tag ${submitted ? "warn" : ""}">
            ${submitted ? "awaiting release" : escapeHtml(r.status.replaceAll("_", " "))}
          </span>
        </div>`;

    return `
      <article class="student-exam-card" style="margin-bottom:.7rem">
        <div>
          <span class="tag blue">${escapeHtml(r.exam_code)}</span>
          <span class="tag ${submitted ? "pass" : ""}">
            ${escapeHtml(r.status.replaceAll("_", " "))}
          </span>
          <h3>${escapeHtml(r.exam_title)}</h3>
          <p class="meta">
            Started ${when(r.started_at)}
            ${r.submitted_at ? ` · submitted ${when(r.submitted_at)}` : ""}
          </p>
        </div>

        <div class="card-action" style="display:flex;gap:.7rem;align-items:center">
          ${scoreBlock}
          ${
            released
              ? `<button class="btn ghost small"
                   data-view-attempt="${r.attempt_id}"
                   data-title="${escapeHtml(r.exam_title)}"
                   data-score="${num(r.score)} / ${num(r.total_marks)} · ${num(r.percentage)}%">
                   View result
                 </button>`
              : ""
          }
        </div>
      </article>`;
  }).join("");

  box.querySelectorAll("[data-view-attempt]").forEach((btn) => {
    btn.onclick = () => openAttemptResult(
      btn.dataset.viewAttempt,
      btn.dataset.title,
      btn.dataset.score,
    );
  });
}

async function openAttemptResult(attemptId, title, scoreText) {
  const dialog = document.getElementById("studentResultDialog");
  const body = document.getElementById("studentResultBody");

  document.getElementById("studentResultTitle").textContent = title || "Attempt result";
  document.getElementById("studentResultScore").textContent = scoreText || "";
  body.innerHTML = `<p class="empty">Loading question-by-question result…</p>`;

  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");

  const { data, error } = await supabase.rpc("student_attempt_result", {
    p_attempt_id: attemptId,
  });

  if (error) {
    body.innerHTML = `<p class="notice error">${escapeHtml(error.message)}</p>`;
    return;
  }

  const rows = data ?? [];

  if (!rows.length) {
    body.innerHTML = `<p class="empty">No questions were found for this attempt.</p>`;
    return;
  }

  body.innerHTML = `
    <div style="display:grid;gap:.8rem">
      ${rows.map(renderQuestionResult).join("")}
    </div>`;
}

function renderQuestionResult(r) {
  const label = outcomeLabel(r);
  const yourAnswer = formatYourAnswer(r);
  const correctAnswer = formatCorrectAnswer(r);

  return `
    <article style="
      border:1px solid var(--rule);
      border-radius:12px;
      padding:1rem;
      background:var(--card);
    ">
      <div style="display:flex;gap:.5rem;align-items:center;flex-wrap:wrap">
        <span class="tag">${escapeHtml(r.qtype)}</span>
        <span class="tag ${label.cls}">${escapeHtml(label.text)}</span>
        <span class="spacer"></span>
        <b>${num(r.awarded_marks)} / ${num(r.question_marks)} marks</b>
      </div>

      <h3 style="margin:.7rem 0 .45rem">
        Q${r.q_position}. ${escapeHtml(r.prompt)}
      </h3>

      ${
        r.code_snippet
          ? `<pre style="white-space:pre-wrap;overflow:auto"><code>${escapeHtml(r.code_snippet)}</code></pre>`
          : ""
      }

      <div style="
        display:grid;
        grid-template-columns:repeat(auto-fit,minmax(240px,1fr));
        gap:.8rem;
        margin-top:.8rem;
      ">
        <div style="border:1px solid var(--rule);border-radius:10px;padding:.8rem">
          <div class="eyebrow">Your answer</div>
          ${yourAnswer}
        </div>

        <div style="border:1px solid var(--rule);border-radius:10px;padding:.8rem">
          <div class="eyebrow">Correct answer / grading</div>
          ${correctAnswer}
        </div>
      </div>

      ${
        r.explanation
          ? `<p class="notice" style="margin-top:.8rem">
               <b>Explanation:</b> ${escapeHtml(r.explanation)}
             </p>`
          : ""
      }

      ${
        r.faculty_feedback
          ? `<p class="notice" style="margin-top:.8rem">
               <b>Faculty feedback:</b> ${escapeHtml(r.faculty_feedback)}
             </p>`
          : ""
      }
    </article>`;
}

function outcomeLabel(r) {
  const map = {
    correct: { text: "correct", cls: "pass" },
    partial: { text: "partially correct", cls: "warn" },
    wrong: { text: "wrong", cls: "hot" },
    unanswered: { text: "unanswered", cls: "warn" },
    evaluated: { text: "evaluated", cls: "pass" },
    pending: { text: "awaiting marking", cls: "warn" },
  };

  return map[r.outcome] ?? { text: r.outcome || "result", cls: "" };
}

function formatYourAnswer(r) {
  if (r.qtype === "coding") {
    const tests = `${Number(r.passed_tests ?? 0)} / ${Number(r.total_tests ?? 0)} tests passed`;
    return `
      <p><b>${escapeHtml(tests)}</b></p>
      ${
        r.submitted_code
          ? `<pre style="white-space:pre-wrap;overflow:auto"><code>${escapeHtml(r.submitted_code)}</code></pre>`
          : `<p class="muted">No code was submitted for marks.</p>`
      }`;
  }

  if (r.qtype === "cloze") {
    const answers = parseJsonArray(r.your_answer);
    return answers.length
      ? `<ol style="margin:.5rem 0 0">${answers.map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ol>`
      : `<p class="muted">No answer.</p>`;
  }

  if (r.qtype === "mcq") {
    if (!r.your_answer) return `<p class="muted">No answer.</p>`;

    const letter = String(r.your_answer).trim().toUpperCase();
    const option = findOption(r.options, letter);

    return `<p><b>${escapeHtml(letter)}</b>${option ? ` — ${escapeHtml(option)}` : ""}</p>`;
  }

  return r.your_answer
    ? `<p style="white-space:pre-wrap">${escapeHtml(r.your_answer)}</p>`
    : `<p class="muted">No answer.</p>`;
}

function formatCorrectAnswer(r) {
  if (r.qtype === "coding") {
    return `
      <p><b>${Number(r.passed_tests ?? 0)} / ${Number(r.total_tests ?? 0)}</b> tests passed.</p>
      <p class="muted">
        Coding marks are proportional to the total test cases passed.
        Hidden test inputs and expected outputs are never revealed.
      </p>`;
  }

  if (r.qtype === "cloze") {
    const answers = Array.isArray(r.correct_answers) ? r.correct_answers : [];
    return answers.length
      ? `<ol style="margin:.5rem 0 0">${answers.map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ol>`
      : `<p class="muted">No answer key stored.</p>`;
  }

  if (r.qtype === "mcq") {
    const letter = String(r.correct_key ?? "").trim().toUpperCase();
    const option = findOption(r.options, letter);

    return letter
      ? `<p><b>${escapeHtml(letter)}</b>${option ? ` — ${escapeHtml(option)}` : ""}</p>`
      : `<p class="muted">No answer key stored.</p>`;
  }

  if (r.qtype === "long") {
    return `
      <p class="muted">
        Long answers are evaluated by the faculty. There is no single stored correct answer
        unless the teacher added an explanation below.
      </p>`;
  }

  return `<p class="muted">No answer key stored.</p>`;
}

function findOption(options, letter) {
  if (!Array.isArray(options) || !letter) return "";

  const index = "ABCD".indexOf(letter);
  if (index < 0 || index >= options.length) return "";

  return String(options[index] ?? "").replace(/^[A-D]\)\s*/, "").trim();
}

function parseJsonArray(value) {
  if (!value) return [];

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map((x) => String(x)) : [String(parsed)];
  } catch {
    return [String(value)];
  }
}

function num(value) {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return "0";

  return Number.isInteger(n)
    ? String(n)
    : n.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function when(value) {
  if (!value) return "—";

  return new Date(value).toLocaleString([], {
    dateStyle: "medium",
    timeStyle: "short",
  });
}
