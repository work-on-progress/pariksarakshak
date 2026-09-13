// public/js/faculty-advanced.js
// PariksaRakshak V4–V13 faculty operations and insights module.
// Loaded after faculty.js. Existing faculty workflows remain untouched.

import {
  supabase,
  requireUser,
  escapeHtml,
} from "./supabaseClient.js";

let auth = null;
let exams = [];
let activeExamId = "";
let healthRows = [];
let auditRows = [];
let analyticsRows = [];
let similarityRows = [];
let bankRows = [];
let healthTimer = null;

boot();

async function boot() {
  auth = await requireUser("faculty");
  if (!auth) return;

  installOperationsTab();
  installOperationsPane();
  await loadExamOptions();

  const first = exams[0]?.id ?? "";
  if (first) {
    activeExamId = first;
    syncExamSelectors(first);
  }

  wireOperations();
}

function installOperationsTab() {
  const tabs = document.querySelector(".tabs");
  if (!tabs || document.getElementById("tab-operations")) return;

  const btn = document.createElement("button");
  btn.id = "tab-operations";
  btn.type = "button";
  btn.setAttribute("aria-selected", "false");
  btn.textContent = "Operations";
  tabs.appendChild(btn);

  btn.onclick = () => showOperations();

  // The original faculty.js only knows its five original panes.
  // Hide our pane whenever one of those tabs is clicked.
  [...tabs.querySelectorAll("button:not(#tab-operations)")].forEach((old) => {
    old.addEventListener("click", () => {
      document.getElementById("pane-operations")?.classList.remove("active");
      btn.setAttribute("aria-selected", "false");
      stopHealthPolling();
    });
  });
}

function installOperationsPane() {
  const main = document.querySelector("main.console");
  if (!main || document.getElementById("pane-operations")) return;

  const pane = document.createElement("section");
  pane.className = "pane";
  pane.id = "pane-operations";

  pane.innerHTML = `
    <div class="ops-hero">
      <div>
        <span class="eyebrow">Exam control center</span>
        <h1>Operations & insights</h1>
        <p>
          Live student health, audit evidence, emergency actions,
          question bank, analytics, reports and coding-similarity review.
        </p>
      </div>
      <div class="ops-live-pill" id="opsLivePill">● Ready</div>
    </div>

    <div class="ops-toolbar panel">
      <div class="panel-body">
        <label class="field">
          <span>Paper</span>
          <select id="opsExam"></select>
        </label>
        <div class="actions">
          <button class="btn" id="opsRefresh">Refresh now</button>
          <button class="btn ghost" id="opsAttendanceCsv">Attendance / health CSV</button>
          <button class="btn ghost" id="opsAuditCsv">Audit CSV</button>
          <button class="btn ghost" id="opsAnalyticsCsv">Analytics CSV</button>
          <button class="btn ghost" id="opsPrintReport">Printable report</button>
        </div>
        <p id="opsMessage" class="notice hidden"></p>
      </div>
    </div>

    <div class="ops-subtabs" role="tablist">
      <button data-ops-view="health" aria-selected="true">Live health</button>
      <button data-ops-view="audit" aria-selected="false">Audit trail</button>
      <button data-ops-view="bank" aria-selected="false">Question bank</button>
      <button data-ops-view="analytics" aria-selected="false">Analytics</button>
      <button data-ops-view="similarity" aria-selected="false">Code similarity</button>
    </div>

    <section class="ops-view active" id="ops-view-health">
      <div class="ops-stat-grid" id="opsHealthStats"></div>

      <div class="panel">
        <div class="panel-head">
          <h2>Students right now</h2>
          <span class="meta" id="opsHealthUpdated"></span>
        </div>
        <div class="panel-body">
          <div class="ops-table-wrap">
            <table class="results ops-table">
              <thead>
                <tr>
                  <th>Student</th>
                  <th>Status</th>
                  <th>Connection</th>
                  <th>Last save</th>
                  <th>Events</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody id="opsHealthBody"></tbody>
            </table>
          </div>
        </div>
      </div>
    </section>

    <section class="ops-view" id="ops-view-audit">
      <div class="panel">
        <div class="panel-head">
          <h2>Submission & recovery audit</h2>
          <span class="meta">Newest first</span>
        </div>
        <div class="panel-body">
          <div class="ops-audit-feed" id="opsAuditFeed"></div>
        </div>
      </div>
    </section>

    <section class="ops-view" id="ops-view-bank">
      <div class="panel">
        <div class="panel-head">
          <h2>Question bank</h2>
          <span class="meta" id="opsBankCount"></span>
        </div>
        <div class="panel-body">
          <div class="ops-bank-toolbar">
            <label class="field">
              <span>Search bank</span>
              <input id="opsBankSearch" placeholder="prompt, topic or tag">
            </label>
            <label class="field">
              <span>Type</span>
              <select id="opsBankType">
                <option value="">All types</option>
                <option value="mcq">Multiple choice</option>
                <option value="cloze">Fill the blanks</option>
                <option value="long">Long answer</option>
                <option value="coding">Coding</option>
              </select>
            </label>
            <label class="field">
              <span>Target paper</span>
              <select id="opsBankTargetExam"></select>
            </label>
          </div>

          <div class="actions" style="margin-bottom:1rem">
            <button class="btn" id="opsBankImportExam">
              Save all questions from selected paper to bank
            </button>
          </div>

          <div id="opsBankList" class="ops-bank-list"></div>
        </div>
      </div>
    </section>

    <section class="ops-view" id="ops-view-analytics">
      <div class="ops-stat-grid" id="opsResultStats"></div>
      <div class="panel">
        <div class="panel-head">
          <h2>Question-level performance</h2>
          <span class="meta">Submitted attempts</span>
        </div>
        <div class="panel-body">
          <div class="ops-table-wrap">
            <table class="results ops-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Question</th>
                  <th>Type</th>
                  <th>Responses</th>
                  <th>Average</th>
                  <th>Full marks</th>
                  <th>Zero marks</th>
                </tr>
              </thead>
              <tbody id="opsAnalyticsBody"></tbody>
            </table>
          </div>
        </div>
      </div>
    </section>

    <section class="ops-view" id="ops-view-similarity">
      <div class="panel">
        <div class="panel-head">
          <h2>Coding similarity review</h2>
          <span class="tag warn">review aid only</span>
        </div>
        <div class="panel-body">
          <p class="muted">
            Similarity is a heuristic to help faculty review submissions.
            It is not a cheating verdict and should never be used alone.
          </p>
          <div class="actions" style="margin-bottom:1rem">
            <button class="btn" id="opsRunSimilarity">Run similarity review</button>
            <label class="field ops-threshold-field">
              <span>Show pairs above</span>
              <select id="opsSimilarityThreshold">
                <option value="0.90">90%</option>
                <option value="0.85">85%</option>
                <option value="0.80" selected>80%</option>
                <option value="0.75">75%</option>
                <option value="0.70">70%</option>
              </select>
            </label>
          </div>
          <div id="opsSimilarityList"></div>
        </div>
      </div>
    </section>
  `;

  main.appendChild(pane);
}

async function loadExamOptions() {
  const { data, error } = await supabase
    .from("exams")
    .select("id, exam_code, title, starts_at, ends_at, is_published")
    .order("starts_at", { ascending: false });

  if (error) {
    showMessage(error.message, "error");
    return;
  }

  exams = data ?? [];

  const html = exams.length
    ? exams
        .map(
          (e) =>
            `<option value="${e.id}">${escapeHtml(e.exam_code)} — ${escapeHtml(e.title)}</option>`,
        )
        .join("")
    : `<option value="">No papers available</option>`;

  ["opsExam", "opsBankTargetExam"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = html;
  });
}

function syncExamSelectors(id) {
  ["opsExam", "opsBankTargetExam"].forEach((key) => {
    const el = document.getElementById(key);
    if (el && [...el.options].some((o) => o.value === id)) {
      el.value = id;
    }
  });
}

function wireOperations() {
  document.getElementById("opsExam").onchange = async (e) => {
    activeExamId = e.target.value;
    syncExamSelectors(activeExamId);
    await refreshAll();
  };

  document.getElementById("opsRefresh").onclick = refreshAll;
  document.getElementById("opsAttendanceCsv").onclick = exportAttendanceHealth;
  document.getElementById("opsAuditCsv").onclick = exportAudit;
  document.getElementById("opsAnalyticsCsv").onclick = exportAnalytics;
  document.getElementById("opsPrintReport").onclick = printReport;

  document.querySelectorAll("[data-ops-view]").forEach((btn) => {
    btn.onclick = () => {
      const name = btn.dataset.opsView;
      document.querySelectorAll("[data-ops-view]").forEach((b) =>
        b.setAttribute("aria-selected", String(b === btn)),
      );
      document.querySelectorAll(".ops-view").forEach((view) =>
        view.classList.toggle("active", view.id === `ops-view-${name}`),
      );

      if (name === "bank") loadQuestionBank();
      if (name === "analytics") loadAnalytics();
    };
  });

  document.getElementById("opsBankSearch").oninput = renderQuestionBank;
  document.getElementById("opsBankType").onchange = renderQuestionBank;
  document.getElementById("opsBankImportExam").onclick = importCurrentExamToBank;
  document.getElementById("opsRunSimilarity").onclick = runSimilarityReview;
}

async function showOperations() {
  document.querySelectorAll(".tabs button").forEach((b) =>
    b.setAttribute("aria-selected", String(b.id === "tab-operations")),
  );
  document.querySelectorAll(".pane").forEach((p) =>
    p.classList.toggle("active", p.id === "pane-operations"),
  );

  if (!activeExamId && exams.length) {
    activeExamId = exams[0].id;
    syncExamSelectors(activeExamId);
  }

  await refreshAll();
  startHealthPolling();
}

function startHealthPolling() {
  stopHealthPolling();
  healthTimer = setInterval(async () => {
    if (
      document.getElementById("pane-operations")?.classList.contains("active")
      && activeExamId
    ) {
      await Promise.all([loadHealth(false), loadAudit(false)]);
    }
  }, 8000);
}

function stopHealthPolling() {
  clearInterval(healthTimer);
  healthTimer = null;
}

async function refreshAll() {
  if (!activeExamId) return;

  showMessage("Refreshing operations data…", "");
  await Promise.all([
    loadHealth(),
    loadAudit(),
    loadAnalytics(),
    loadQuestionBank(),
  ]);
  showMessage("", "");
}

async function loadHealth(showStamp = true) {
  if (!activeExamId) return;

  const { data, error } = await supabase.rpc("faculty_attempt_health", {
    p_exam_id: activeExamId,
  });

  if (error) {
    healthRows = [];
    renderHealth(error);
    return;
  }

  healthRows = data ?? [];
  renderHealth();

  if (showStamp) {
    document.getElementById("opsHealthUpdated").textContent =
      `updated ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;
  }
}

function renderHealth(error = null) {
  const now = Date.now();

  const active = healthRows.filter((r) => r.status === "in_progress");
  const online = active.filter((r) => secondsSince(r.last_heartbeat_at) <= 45);
  const offline = active.filter((r) => secondsSince(r.last_heartbeat_at) > 45);
  const submitted = healthRows.filter((r) => r.status === "submitted");
  const saveErrors = active.filter((r) => r.last_save_error);
  const camera = healthRows.filter((r) => Number(r.camera_event_count || 0) > 0);
  const highSwitch = healthRows.filter((r) => Number(r.switch_count || 0) >= 3);

  const stats = [
    ["Active", active.length, "blue"],
    ["Online", online.length, "pass"],
    ["Offline", offline.length, offline.length ? "warn" : ""],
    ["Submitted", submitted.length, "pass"],
    ["Save issues", saveErrors.length, saveErrors.length ? "seal" : ""],
    ["Camera flags", camera.length, camera.length ? "warn" : ""],
    ["High switch count", highSwitch.length, highSwitch.length ? "seal" : ""],
  ];

  document.getElementById("opsHealthStats").innerHTML = stats
    .map(
      ([label, value, kind]) => `
        <div class="ops-stat ${kind}">
          <b>${value}</b>
          <span>${label}</span>
        </div>`,
    )
    .join("");

  const pill = document.getElementById("opsLivePill");
  pill.textContent =
    active.length && online.length === 0
      ? "● Attention needed"
      : active.length
      ? `● ${online.length}/${active.length} active online`
      : "● No active students";
  pill.dataset.state =
    active.length && online.length === 0 ? "warn" : "ok";

  const body = document.getElementById("opsHealthBody");

  if (error) {
    body.innerHTML = `
      <tr><td colspan="6">
        <p class="notice error">
          ${escapeHtml(error.message || "Migration 011 may not be installed yet.")}
        </p>
      </td></tr>`;
    return;
  }

  body.innerHTML = healthRows.length
    ? healthRows
        .map((r) => {
          const age = secondsSince(r.last_heartbeat_at);
          const connected =
            r.status === "in_progress" && age <= 45;
          const connectionText =
            r.status !== "in_progress"
              ? "closed"
              : connected
              ? `online · ${ageText(r.last_heartbeat_at)}`
              : `offline · ${ageText(r.last_heartbeat_at)}`;

          const lastSave =
            r.last_save_error
              ? `ERROR · ${r.last_save_error}`
              : r.last_save_at
              ? ageText(r.last_save_at)
              : "no save reported";

          const who =
            escapeHtml(r.full_name || r.roll_no || "Student");
          const roll = escapeHtml(r.roll_no || "");

          return `
            <tr>
              <td>
                <b>${who}</b>
                ${roll ? `<div class="meta">${roll}</div>` : ""}
              </td>
              <td>
                <span class="tag ${r.status === "submitted" ? "pass" : r.status === "flagged" ? "seal" : "blue"}">
                  ${escapeHtml(r.status)}
                </span>
              </td>
              <td>
                <span class="ops-connection ${connected ? "online" : r.status === "in_progress" ? "offline" : ""}">
                  ${escapeHtml(connectionText)}
                </span>
              </td>
              <td>
                <span class="${r.last_save_error ? "ops-error-text" : ""}">
                  ${escapeHtml(lastSave)}
                </span>
              </td>
              <td>
                <span class="meta">
                  ${Number(r.incident_count || 0)} total ·
                  ${Number(r.switch_count || 0)} switches ·
                  ${Number(r.camera_event_count || 0)} camera
                </span>
              </td>
              <td>
                <div class="ops-row-actions">
                  ${
                    r.status === "in_progress"
                      ? `
                        <button class="btn ghost tiny" data-ops-extra="${r.attempt_id}">+5 min</button>
                        <button class="btn danger tiny" data-ops-force="${r.attempt_id}">Force submit</button>
                      `
                      : `
                        <button class="btn ghost tiny" data-ops-reopen="${r.attempt_id}">Reopen</button>
                      `
                  }
                  <button
                    class="btn ghost tiny"
                    data-ops-reset="${r.student_id}"
                    data-ops-name="${who}">
                    Reset
                  </button>
                </div>
              </td>
            </tr>`;
        })
        .join("")
    : `<tr><td colspan="6" class="empty">No attempts for this paper yet.</td></tr>`;

  body.querySelectorAll("[data-ops-extra]").forEach((btn) => {
    btn.onclick = () => grantExtra(btn.dataset.opsExtra);
  });

  body.querySelectorAll("[data-ops-force]").forEach((btn) => {
    btn.onclick = () => forceSubmit(btn.dataset.opsForce);
  });

  body.querySelectorAll("[data-ops-reopen]").forEach((btn) => {
    btn.onclick = () => reopenAttempt(btn.dataset.opsReopen);
  });

  body.querySelectorAll("[data-ops-reset]").forEach((btn) => {
    btn.onclick = () =>
      resetAttempt(
        btn.dataset.opsReset,
        btn.dataset.opsName || "student",
      );
  });
}

async function grantExtra(attemptId) {
  if (!confirm("Add 5 minutes to this student's attempt?")) return;

  const { error } = await supabase.rpc("grant_extra_time", {
    p_attempt_id: attemptId,
    p_minutes: 5,
  });

  if (error) return showMessage(error.message, "error");

  await supabase.rpc("log_attempt_event", {
    p_attempt_id: attemptId,
    p_event_type: "FACULTY_EXTRA_TIME",
    p_detail: { minutes: 5 },
  });

  showMessage("5 minutes added.", "ok");
  loadHealth();
}

async function forceSubmit(attemptId) {
  if (
    !confirm(
      "Force submit this attempt now? The student's paper will close and current server-known marks will be finalized.",
    )
  ) return;

  await supabase.rpc("log_attempt_event", {
    p_attempt_id: attemptId,
    p_event_type: "FACULTY_FORCE_SUBMIT_REQUESTED",
    p_detail: {},
  });

  const { error } = await supabase.rpc("force_submit_attempt", {
    p_attempt_id: attemptId,
  });

  if (error) return showMessage(error.message, "error");

  await supabase.rpc("log_attempt_event", {
    p_attempt_id: attemptId,
    p_event_type: "FACULTY_FORCE_SUBMIT_COMPLETED",
    p_detail: {},
  });

  showMessage("Attempt force-submitted.", "ok");
  refreshAll();
}

async function reopenAttempt(attemptId) {
  if (!confirm("Reopen this submitted attempt for the student?")) return;

  const { error } = await supabase.rpc("reopen_attempt", {
    p_attempt_id: attemptId,
  });

  if (error) return showMessage(error.message, "error");

  await supabase.rpc("log_attempt_event", {
    p_attempt_id: attemptId,
    p_event_type: "FACULTY_REOPENED_ATTEMPT",
    p_detail: {},
  });

  showMessage("Attempt reopened.", "ok");
  refreshAll();
}

async function resetAttempt(studentId, label) {
  if (
    !confirm(
      `Reset ${label}'s attempt?\n\nAnswers, incidents, audit events and the attempt record for this paper will be removed. The student can take the paper again.`,
    )
  ) return;

  const { error } = await supabase.rpc("reset_student_attempt", {
    p_exam_id: activeExamId,
    p_student_id: studentId,
  });

  if (error) return showMessage(error.message, "error");

  showMessage("Attempt reset. Student may reattempt.", "ok");
  refreshAll();
}

async function loadAudit(showStamp = true) {
  if (!activeExamId) return;

  const { data, error } = await supabase.rpc("faculty_audit_feed", {
    p_exam_id: activeExamId,
    p_limit: 300,
  });

  if (error) {
    auditRows = [];
    document.getElementById("opsAuditFeed").innerHTML = `
      <p class="notice error">${escapeHtml(error.message)}</p>`;
    return;
  }

  auditRows = data ?? [];
  renderAudit();
}

function renderAudit() {
  const feed = document.getElementById("opsAuditFeed");

  feed.innerHTML = auditRows.length
    ? auditRows
        .map((row) => {
          const detail =
            row.detail && Object.keys(row.detail).length
              ? `<code>${escapeHtml(JSON.stringify(row.detail))}</code>`
              : "";
          return `
            <div class="ops-audit-item">
              <span class="ops-audit-dot"></span>
              <div>
                <b>${escapeHtml(prettyEvent(row.event_type))}</b>
                <span>
                  ${escapeHtml(row.full_name || row.roll_no || "Student")}
                  ${row.roll_no ? ` · ${escapeHtml(row.roll_no)}` : ""}
                </span>
                ${detail}
              </div>
              <time>${escapeHtml(formatDateTime(row.created_at))}</time>
            </div>`;
        })
        .join("")
    : `<p class="empty">No audit events yet.</p>`;
}

async function loadAnalytics() {
  if (!activeExamId) return;

  const [qRes, sRes] = await Promise.all([
    supabase.rpc("exam_question_analytics", {
      p_exam_id: activeExamId,
    }),
    supabase.rpc("exam_result_stats", {
      p_exam_id: activeExamId,
    }),
  ]);

  if (qRes.error) {
    analyticsRows = [];
    document.getElementById("opsAnalyticsBody").innerHTML = `
      <tr><td colspan="7">
        <p class="notice error">${escapeHtml(qRes.error.message)}</p>
      </td></tr>`;
    return;
  }

  analyticsRows = qRes.data ?? [];
  renderAnalytics(sRes.data, sRes.error);
}

function renderAnalytics(stats, statsError) {
  const statBox = document.getElementById("opsResultStats");

  if (statsError) {
    statBox.innerHTML = `
      <p class="notice error">${escapeHtml(statsError.message)}</p>`;
  } else {
    const values = [
      ["Attempts", stats?.attempts ?? 0],
      ["Submitted", stats?.submitted ?? 0],
      ["Active", stats?.active ?? 0],
      ["Average", stats?.average ?? "—"],
      ["Highest", stats?.highest ?? "—"],
      ["Lowest", stats?.lowest ?? "—"],
      ["Passed", stats?.passed ?? 0],
      ["Pending long", stats?.pending_long_answers ?? 0],
    ];

    statBox.innerHTML = values
      .map(
        ([label, value]) => `
          <div class="ops-stat">
            <b>${escapeHtml(String(value))}</b>
            <span>${escapeHtml(label)}</span>
          </div>`,
      )
      .join("");
  }

  document.getElementById("opsAnalyticsBody").innerHTML =
    analyticsRows.length
      ? analyticsRows
          .map((r) => `
            <tr>
              <td class="num">${r.position}</td>
              <td>
                <div class="ops-question-text">
                  ${escapeHtml(r.prompt)}
                </div>
              </td>
              <td><span class="tag">${escapeHtml(r.qtype)}</span></td>
              <td class="num">${r.responses}</td>
              <td class="num">
                ${
                  r.average_marks === null
                    ? "—"
                    : `${r.average_marks}/${r.marks} (${r.average_percent ?? 0}%)`
                }
              </td>
              <td class="num">${r.full_mark_responses}</td>
              <td class="num">${r.zero_mark_responses}</td>
            </tr>`)
          .join("")
      : `<tr><td colspan="7" class="empty">No analytics available yet.</td></tr>`;
}

async function loadQuestionBank() {
  const { data, error } = await supabase
    .from("question_bank")
    .select("*")
    .order("created_at", { ascending: false });

  if (error) {
    bankRows = [];
    document.getElementById("opsBankList").innerHTML =
      `<p class="notice error">${escapeHtml(error.message)}</p>`;
    return;
  }

  bankRows = data ?? [];
  renderQuestionBank();
}

function renderQuestionBank() {
  const query = (
    document.getElementById("opsBankSearch")?.value || ""
  ).trim().toLowerCase();
  const type = document.getElementById("opsBankType")?.value || "";

  const filtered = bankRows.filter((row) => {
    if (type && row.qtype !== type) return false;
    if (!query) return true;

    return [
      row.prompt,
      row.topic,
      ...(row.tags || []),
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
      .includes(query);
  });

  document.getElementById("opsBankCount").textContent =
    `${bankRows.length} saved`;

  const list = document.getElementById("opsBankList");

  list.innerHTML = filtered.length
    ? filtered
        .map((row) => `
          <article class="ops-bank-card">
            <header>
              <span class="tag">${escapeHtml(row.qtype)}</span>
              ${
                row.difficulty
                  ? `<span class="tag diff-${escapeHtml(row.difficulty)}">${escapeHtml(row.difficulty)}</span>`
                  : ""
              }
              <span class="tag">${row.marks} marks</span>
              <span class="spacer"></span>
              <button class="btn ghost tiny" data-bank-use="${row.id}">
                Add to selected paper
              </button>
              <button class="btn ghost tiny" data-bank-delete="${row.id}">
                Delete
              </button>
            </header>
            <p>${escapeHtml(row.prompt)}</p>
            ${
              row.topic
                ? `<div class="meta">Topic: ${escapeHtml(row.topic)}</div>`
                : ""
            }
            ${
              row.tags?.length
                ? `<div class="ops-tags">${row.tags.map((t) => `<span>${escapeHtml(t)}</span>`).join("")}</div>`
                : ""
            }
          </article>`)
        .join("")
    : `<p class="empty">No bank questions match this filter.</p>`;

  list.querySelectorAll("[data-bank-use]").forEach((btn) => {
    btn.onclick = () => addBankQuestionToExam(btn.dataset.bankUse);
  });

  list.querySelectorAll("[data-bank-delete]").forEach((btn) => {
    btn.onclick = () => deleteBankQuestion(btn.dataset.bankDelete);
  });
}

async function importCurrentExamToBank() {
  if (!activeExamId) return;

  const exam = exams.find((e) => e.id === activeExamId);
  if (
    !confirm(
      `Save all questions from ${exam?.exam_code ?? "this paper"} into your reusable question bank?`,
    )
  ) return;

  const { data: qs, error } = await supabase
    .from("questions")
    .select("*")
    .eq("exam_id", activeExamId)
    .order("position");

  if (error) return showMessage(error.message, "error");
  if (!qs?.length) return showMessage("This paper has no questions.", "warn");

  const codingIds = qs.filter((q) => q.qtype === "coding").map((q) => q.id);
  const testsByQuestion = {};

  if (codingIds.length) {
    const { data: tests, error: testError } = await supabase
      .from("test_cases")
      .select("*")
      .in("question_id", codingIds)
      .order("position");

    if (testError) return showMessage(testError.message, "error");

    (tests ?? []).forEach((t) => {
      (testsByQuestion[t.question_id] ||= []).push({
        stdin: t.stdin,
        expected_out: t.expected_out,
        is_hidden: t.is_hidden,
        position: t.position,
      });
    });
  }

  const rows = qs.map((q) => ({
    faculty_id: auth.user.id,
    source_question_id: q.id,
    qtype: q.qtype,
    difficulty: q.difficulty ?? null,
    mcq_kind: q.mcq_kind ?? null,
    marks: q.marks,
    prompt: q.prompt,
    options: q.options,
    correct_key: q.correct_key,
    cloze_answers: q.cloze_answers,
    code_snippet: q.code_snippet ?? null,
    language: q.language,
    func_signature: q.func_signature,
    starter_code: q.starter_code,
    test_cases: testsByQuestion[q.id] ?? [],
    topic: exam?.title ?? null,
    tags: [exam?.exam_code].filter(Boolean),
  }));

  const { error: insertError } = await supabase
    .from("question_bank")
    .insert(rows);

  if (insertError) return showMessage(insertError.message, "error");

  showMessage(`${rows.length} questions saved to the bank.`, "ok");
  loadQuestionBank();
}

async function addBankQuestionToExam(bankId) {
  const targetExamId =
    document.getElementById("opsBankTargetExam").value;

  if (!targetExamId) return showMessage("Select a target paper.", "warn");

  const bank = bankRows.find((r) => r.id === bankId);
  if (!bank) return;

  const targetExam = exams.find((e) => e.id === targetExamId);

  if (
    !confirm(
      `Add this ${bank.qtype} question to ${targetExam?.exam_code ?? "the selected paper"}?`,
    )
  ) return;

  const { data: existing, error: posError } = await supabase
    .from("questions")
    .select("position")
    .eq("exam_id", targetExamId)
    .order("position", { ascending: false })
    .limit(1);

  if (posError) return showMessage(posError.message, "error");

  const nextPosition = Number(existing?.[0]?.position ?? 0) + 1;

  const { data: inserted, error } = await supabase
    .from("questions")
    .insert({
      exam_id: targetExamId,
      qtype: bank.qtype,
      difficulty: bank.difficulty,
      mcq_kind: bank.mcq_kind,
      position: nextPosition,
      marks: bank.marks,
      prompt: bank.prompt,
      options: bank.options,
      correct_key: bank.correct_key,
      cloze_answers: bank.cloze_answers,
      code_snippet: bank.code_snippet,
      language: bank.language,
      func_signature: bank.func_signature,
      starter_code: bank.starter_code,
    })
    .select("id")
    .single();

  if (error) return showMessage(error.message, "error");

  if (bank.qtype === "coding" && Array.isArray(bank.test_cases)) {
    const testRows = bank.test_cases.map((t, index) => ({
      question_id: inserted.id,
      stdin: String(t.stdin ?? ""),
      expected_out: String(t.expected_out ?? ""),
      is_hidden: t.is_hidden !== false,
      position: Number(t.position ?? index + 1),
    }));

    if (testRows.length) {
      const { error: testError } = await supabase
        .from("test_cases")
        .insert(testRows);

      if (testError) return showMessage(testError.message, "error");
    }
  }

  showMessage("Question added to the selected paper.", "ok");
}

async function deleteBankQuestion(bankId) {
  if (!confirm("Delete this reusable question from your bank?")) return;

  const { error } = await supabase
    .from("question_bank")
    .delete()
    .eq("id", bankId);

  if (error) return showMessage(error.message, "error");
  loadQuestionBank();
}

async function runSimilarityReview() {
  if (!activeExamId) return;

  const button = document.getElementById("opsRunSimilarity");
  button.disabled = true;
  button.textContent = "Comparing…";

  try {
    const { data: questions, error: qError } = await supabase
      .from("questions")
      .select("id, position, prompt")
      .eq("exam_id", activeExamId)
      .eq("qtype", "coding")
      .order("position");

    if (qError) throw qError;

    if (!questions?.length) {
      similarityRows = [];
      return renderSimilarity();
    }

    const qIds = questions.map((q) => q.id);

    const { data: answers, error: aError } = await supabase
      .from("answers")
      .select("attempt_id, question_id, code_submitted")
      .in("question_id", qIds);

    if (aError) throw aError;

    const attemptIds = [...new Set((answers ?? []).map((a) => a.attempt_id))];

    const { data: attempts, error: atError } = attemptIds.length
      ? await supabase
          .from("attempts")
          .select("id, student_id")
          .in("id", attemptIds)
      : { data: [], error: null };

    if (atError) throw atError;

    const studentIds = [...new Set((attempts ?? []).map((a) => a.student_id))];

    const { data: profiles, error: pError } = studentIds.length
      ? await supabase
          .from("profiles")
          .select("id, full_name, roll_no")
          .in("id", studentIds)
      : { data: [], error: null };

    if (pError) throw pError;

    const attemptMap = Object.fromEntries(
      (attempts ?? []).map((a) => [a.id, a.student_id]),
    );
    const profileMap = Object.fromEntries(
      (profiles ?? []).map((p) => [p.id, p]),
    );
    const questionMap = Object.fromEntries(
      questions.map((q) => [q.id, q]),
    );

    const threshold =
      Number(document.getElementById("opsSimilarityThreshold").value) || 0.8;

    const byQuestion = {};

    (answers ?? [])
      .filter((a) => normalizeCode(a.code_submitted).length >= 30)
      .forEach((a) => {
        (byQuestion[a.question_id] ||= []).push(a);
      });

    const pairs = [];

    Object.entries(byQuestion).forEach(([questionId, rows]) => {
      for (let i = 0; i < rows.length; i++) {
        for (let j = i + 1; j < rows.length; j++) {
          const a = rows[i];
          const b = rows[j];

          const score = codeSimilarity(
            a.code_submitted,
            b.code_submitted,
          );

          if (score < threshold) continue;

          const sa = profileMap[attemptMap[a.attempt_id]] || {};
          const sb = profileMap[attemptMap[b.attempt_id]] || {};
          const q = questionMap[questionId] || {};

          pairs.push({
            score,
            questionId,
            position: q.position,
            prompt: q.prompt,
            a: sa,
            b: sb,
          });
        }
      }
    });

    similarityRows = pairs
      .sort((x, y) => y.score - x.score)
      .slice(0, 50);

    renderSimilarity();
  } catch (e) {
    showMessage(e.message || String(e), "error");
  } finally {
    button.disabled = false;
    button.textContent = "Run similarity review";
  }
}

function renderSimilarity() {
  const box = document.getElementById("opsSimilarityList");

  box.innerHTML = similarityRows.length
    ? similarityRows
        .map((r) => `
          <div class="ops-similarity-card">
            <div class="ops-similarity-score">
              ${Math.round(r.score * 100)}%
            </div>
            <div>
              <b>
                Q${r.position ?? "?"} ·
                ${escapeHtml(r.a.full_name || r.a.roll_no || "Student A")}
                ↔
                ${escapeHtml(r.b.full_name || r.b.roll_no || "Student B")}
              </b>
              <p>${escapeHtml(r.prompt || "Coding question")}</p>
              <span class="meta">
                ${escapeHtml(r.a.roll_no || "")}
                ${r.a.roll_no && r.b.roll_no ? " · " : ""}
                ${escapeHtml(r.b.roll_no || "")}
              </span>
            </div>
          </div>`)
        .join("")
    : `<p class="empty">
         No coding pairs above the selected similarity threshold.
       </p>`;
}

function normalizeCode(code) {
  return String(code ?? "")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/.*$/gm, " ")
    .replace(/#.*$/gm, " ")
    .replace(/["'`][^"'`]*["'`]/g, " STR ")
    .replace(/\b\d+(?:\.\d+)?\b/g, " NUM ")
    .replace(/\s+/g, "")
    .toLowerCase();
}

function grams(text, size = 4) {
  const out = new Set();
  if (text.length < size) {
    if (text) out.add(text);
    return out;
  }
  for (let i = 0; i <= text.length - size; i++) {
    out.add(text.slice(i, i + size));
  }
  return out;
}

function codeSimilarity(a, b) {
  const aa = normalizeCode(a);
  const bb = normalizeCode(b);

  if (!aa || !bb) return 0;
  if (aa === bb) return 1;

  const ga = grams(aa);
  const gb = grams(bb);

  let intersection = 0;
  ga.forEach((g) => {
    if (gb.has(g)) intersection++;
  });

  const union = ga.size + gb.size - intersection;
  const jaccard = union ? intersection / union : 0;

  const lengthRatio =
    Math.min(aa.length, bb.length) / Math.max(aa.length, bb.length);

  return 0.85 * jaccard + 0.15 * lengthRatio;
}

function exportAttendanceHealth() {
  if (!healthRows.length) return showMessage("No health rows to export.", "warn");

  downloadCsvLocal(
    `${currentExamCode()}-attendance-health.csv`,
    [
      "Roll",
      "Name",
      "Attempt Status",
      "Started",
      "Submitted",
      "Last Heartbeat",
      "Last Save",
      "Save Error",
      "Incident Count",
      "Switch Count",
      "Camera Events",
      "Score",
      "Extra Minutes",
    ],
    healthRows.map((r) => [
      r.roll_no,
      r.full_name,
      r.status,
      r.started_at,
      r.submitted_at,
      r.last_heartbeat_at,
      r.last_save_at,
      r.last_save_error,
      r.incident_count,
      r.switch_count,
      r.camera_event_count,
      r.score,
      r.extra_minutes,
    ]),
  );
}

function exportAudit() {
  if (!auditRows.length) return showMessage("No audit events to export.", "warn");

  downloadCsvLocal(
    `${currentExamCode()}-audit.csv`,
    ["Time", "Roll", "Name", "Event", "Detail", "Attempt ID"],
    auditRows.map((r) => [
      r.created_at,
      r.roll_no,
      r.full_name,
      r.event_type,
      JSON.stringify(r.detail || {}),
      r.attempt_id,
    ]),
  );
}

function exportAnalytics() {
  if (!analyticsRows.length) return showMessage("No analytics to export.", "warn");

  downloadCsvLocal(
    `${currentExamCode()}-question-analytics.csv`,
    [
      "Position",
      "Type",
      "Question",
      "Marks",
      "Responses",
      "Graded Responses",
      "Average Marks",
      "Average Percent",
      "Full Mark Responses",
      "Zero Mark Responses",
    ],
    analyticsRows.map((r) => [
      r.position,
      r.qtype,
      r.prompt,
      r.marks,
      r.responses,
      r.graded_responses,
      r.average_marks,
      r.average_percent,
      r.full_mark_responses,
      r.zero_mark_responses,
    ]),
  );
}

async function printReport() {
  if (!activeExamId) return;

  await Promise.all([loadHealth(), loadAudit(), loadAnalytics()]);

  const exam = exams.find((e) => e.id === activeExamId);
  const win = window.open("", "_blank", "noopener,noreferrer");

  if (!win) {
    return showMessage("Allow pop-ups to open the printable report.", "warn");
  }

  const studentRows = healthRows
    .map((r) => `
      <tr>
        <td>${escapeHtml(r.roll_no || "")}</td>
        <td>${escapeHtml(r.full_name || "")}</td>
        <td>${escapeHtml(r.status || "")}</td>
        <td>${escapeHtml(r.last_save_at ? formatDateTime(r.last_save_at) : "—")}</td>
        <td>${Number(r.incident_count || 0)}</td>
        <td>${r.score ?? "—"}</td>
      </tr>`)
    .join("");

  const questionRows = analyticsRows
    .map((r) => `
      <tr>
        <td>${r.position}</td>
        <td>${escapeHtml(r.qtype)}</td>
        <td>${escapeHtml(r.prompt)}</td>
        <td>${r.responses}</td>
        <td>${r.average_percent ?? "—"}%</td>
      </tr>`)
    .join("");

  win.document.write(`
    <!doctype html>
    <html>
    <head>
      <title>${escapeHtml(exam?.exam_code || "Exam")} report</title>
      <style>
        body{font-family:Arial,sans-serif;color:#111;margin:32px}
        h1{margin-bottom:4px}
        .meta{color:#555;margin-bottom:24px}
        table{width:100%;border-collapse:collapse;margin:16px 0 28px}
        th,td{border:1px solid #bbb;padding:7px;text-align:left;font-size:12px;vertical-align:top}
        th{background:#eee}
        @media print{button{display:none}}
      </style>
    </head>
    <body>
      <h1>${escapeHtml(exam?.title || "Exam report")}</h1>
      <div class="meta">
        ${escapeHtml(exam?.exam_code || "")} ·
        Generated ${escapeHtml(new Date().toLocaleString())}
      </div>

      <h2>Attendance / attempt health</h2>
      <table>
        <thead>
          <tr><th>Roll</th><th>Name</th><th>Status</th><th>Last save</th><th>Events</th><th>Score</th></tr>
        </thead>
        <tbody>${studentRows || `<tr><td colspan="6">No attempts</td></tr>`}</tbody>
      </table>

      <h2>Question analytics</h2>
      <table>
        <thead>
          <tr><th>#</th><th>Type</th><th>Question</th><th>Responses</th><th>Average %</th></tr>
        </thead>
        <tbody>${questionRows || `<tr><td colspan="5">No analytics</td></tr>`}</tbody>
      </table>

      <button onclick="window.print()">Print / Save PDF</button>
    </body>
    </html>
  `);

  win.document.close();
}

function downloadCsvLocal(filename, headers, rows) {
  const quote = (value) => {
    const s = String(value ?? "");
    return `"${s.replace(/"/g, '""')}"`;
  };

  const csv = [
    headers.map(quote).join(","),
    ...rows.map((row) => row.map(quote).join(",")),
  ].join("\r\n");

  const blob = new Blob([csv], {
    type: "text/csv;charset=utf-8",
  });

  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();

  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function showMessage(text, kind = "") {
  const el = document.getElementById("opsMessage");
  if (!el) return;

  el.textContent = text || "";
  el.className = `notice ${kind}`.trim();
  el.classList.toggle("hidden", !text);
}

function currentExamCode() {
  return exams.find((e) => e.id === activeExamId)?.exam_code || "exam";
}

function secondsSince(iso) {
  if (!iso) return Number.POSITIVE_INFINITY;
  return Math.max(
    0,
    Math.floor((Date.now() - new Date(iso).getTime()) / 1000),
  );
}

function ageText(iso) {
  if (!iso) return "never";
  const sec = secondsSince(iso);
  if (sec < 10) return "just now";
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  return `${hr}h ago`;
}

function formatDateTime(iso) {
  return iso
    ? new Date(iso).toLocaleString([], {
        day: "2-digit",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      })
    : "";
}

function prettyEvent(value) {
  return String(value ?? "")
    .toLowerCase()
    .split("_")
    .map((x) => x ? x[0].toUpperCase() + x.slice(1) : x)
    .join(" ");
}
