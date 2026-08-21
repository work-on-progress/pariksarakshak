// public/js/faculty.js
import { supabase, callFunction, requireUser, signOut } from "./supabaseClient.js";
import { INSTITUTE_NAME } from "./config.js";

let user, profile;
let draft = null;          // questions returned by the model, before saving
let exams = [];
const names = {};          // student_id → { full_name, roll_no }

boot();

async function boot() {
  const auth = await requireUser("faculty");
  if (!auth) return;
  ({ user, profile } = auth);

  document.getElementById("instituteTag").textContent = INSTITUTE_NAME;
  document.getElementById("whoami").textContent = profile.full_name || user.email;
  document.getElementById("signOutBtn").onclick = signOut;

  document.getElementById("createExam").onclick = createExam;
  document.getElementById("genBtn").onclick = draftQuestions;
  document.getElementById("saveBtn").onclick = saveDraft;
  document.getElementById("clearBtn").onclick = clearDraft;
  document.getElementById("exportBtn").onclick = exportCsv;
  document.getElementById("resultExam").onchange = loadResults;

  await loadExams();
  subscribeToRoom();
}

/* ══════════════ PAPERS ══════════════ */
async function loadExams() {
  const { data } = await supabase.from("exams").select("*").order("starts_at", { ascending: false });
  exams = data ?? [];

  document.getElementById("examCount").textContent =
    exams.length ? `${exams.length} on file` : "none yet";

  const options = exams.map((e) => `<option value="${e.id}">${e.exam_code} — ${e.title}</option>`).join("");
  document.getElementById("examSelect").innerHTML = options || `<option value="">Create a paper first</option>`;
  document.getElementById("resultExam").innerHTML = options || `<option value="">No papers yet</option>`;

  document.getElementById("examList").innerHTML = exams.length ? exams.map((e) => {
    const live = new Date(e.starts_at) <= new Date() && new Date() <= new Date(e.ends_at);
    return `<div class="exam-row">
      <span class="code">${e.exam_code}</span>
      <span>
        <span class="title">${escapeHtml(e.title)}</span><br>
        <span class="when">${fmt(e.starts_at)} → ${fmt(e.ends_at)} · ${e.duration_min} min</span>
      </span>
      <span style="margin-left:auto" class="tag ${live ? "pass" : ""}">${live ? "live now" : "closed"}</span>
    </div>`;
  }).join("") : `<p class="muted" style="font-size:.9rem">No papers yet. Create one above.</p>`;

  if (exams.length) loadResults();
}

async function createExam() {
  const title = value("title"), code = value("code").toUpperCase();
  const starts = value("starts"), ends = value("ends"), dur = Number(value("dur"));

  if (!title || !code || !starts || !ends) {
    return note("examMsg", "Fill in the title, code and both times before creating the paper.", "error");
  }
  if (new Date(ends) <= new Date(starts)) {
    return note("examMsg", "The closing time must be after the opening time.", "error");
  }

  const { error } = await supabase.from("exams").insert({
    faculty_id: user.id, title, exam_code: code,
    starts_at: new Date(starts).toISOString(),
    ends_at: new Date(ends).toISOString(),
    duration_min: dur, is_published: true,
  });

  if (error) {
    return note("examMsg",
      error.code === "23505" ? "That exam code is already in use. Pick another." : error.message, "error");
  }
  note("examMsg", `Paper created. Students join with the code ${code}.`, "ok");
  ["title", "code"].forEach((id) => (document.getElementById(id).value = ""));
  loadExams();
}

/* ══════════════ QUESTION DRAFTING ══════════════ */
async function draftQuestions() {
  const examId = value("examSelect");
  if (!examId) return note("genMsg", "Create a paper first, then draft questions for it.", "error");
  if (!value("topic") && !value("sourceText")) {
    return note("genMsg", "Give a topic, or paste the lecture notes to draw from.", "error");
  }

  const btn = document.getElementById("genBtn");
  btn.disabled = true; btn.textContent = "Drafting…";
  note("genMsg", "Writing questions. This takes a few seconds.", "");

  const res = await callFunction("generate-questions", {
    topic: value("topic"),
    source_text: value("sourceText"),
    distribution: {
      mcq: +value("nMcq"), cloze: +value("nCloze"),
      long: +value("nLong"), coding: +value("nCode"),
    },
  });

  btn.disabled = false; btn.textContent = "Draft questions";

  if (res.error) return note("genMsg", res.error, "error");

  draft = res.questions ?? [];
  note("genMsg", `${draft.length} questions drafted. Edit anything, then save.`, "ok");
  renderDraft();
}

function renderDraft() {
  const box = document.getElementById("preview");
  document.getElementById("saveBtn").classList.toggle("hidden", !draft?.length);
  document.getElementById("clearBtn").classList.toggle("hidden", !draft?.length);

  if (!draft?.length) { box.innerHTML = ""; return; }

  box.innerHTML = "";
  draft.forEach((q, i) => {
    const el = document.createElement("div");
    el.className = "qprev";
    el.dataset.type = q.qtype;
    el.innerHTML = `
      <header>
        <b>Q${i + 1} · ${q.qtype.toUpperCase()} · ${q.marks}m</b>
        <button class="drop">Remove</button>
      </header>
      <textarea rows="3"></textarea>
      ${q.qtype === "mcq" ? `<p class="answer">Key ${q.correct_key} — ${(q.options ?? []).join("   ")}</p>` : ""}
      ${q.qtype === "cloze" ? `<p class="answer">Answers: ${(q.cloze_answers ?? []).join(", ")}</p>` : ""}
      ${q.qtype === "coding" ? `<p class="tests">${(q.test_cases ?? []).length} tests · ${(q.test_cases ?? []).filter((t) => !t.is_hidden).length} shown to students, rest hidden</p>` : ""}`;
    const ta = el.querySelector("textarea");
    ta.value = q.prompt;
    ta.oninput = () => { q.prompt = ta.value; };
    el.querySelector(".drop").onclick = () => { draft.splice(i, 1); renderDraft(); };
    box.appendChild(el);
  });
}

function clearDraft() {
  draft = null;
  renderDraft();
  note("genMsg", "Draft discarded.", "");
}

async function saveDraft() {
  const exam_id = value("examSelect");
  if (!exam_id || !draft?.length) return;

  const btn = document.getElementById("saveBtn");
  btn.disabled = true; btn.textContent = "Saving…";

  // Where the new questions start, so numbering continues instead of restarting.
  const { count } = await supabase.from("questions")
    .select("id", { count: "exact", head: true }).eq("exam_id", exam_id);
  let position = (count ?? 0) + 1;
  let saved = 0;

  for (const q of draft) {
    const { data: row, error } = await supabase.from("questions").insert({
      exam_id, qtype: q.qtype, position: position++, marks: q.marks, prompt: q.prompt,
      options: q.options?.length ? q.options : null,
      correct_key: q.correct_key || null,
      cloze_answers: q.cloze_answers?.length ? q.cloze_answers : null,
      language: q.language || null,
      func_signature: q.func_signature || null,
      starter_code: q.starter_code || null,
    }).select("id").single();

    if (error) {
      btn.disabled = false; btn.textContent = "Save to paper";
      return note("genMsg", `Stopped after ${saved} questions: ${error.message}`, "error");
    }

    if (q.qtype === "coding" && q.test_cases?.length) {
      await supabase.from("test_cases").insert(q.test_cases.map((t, idx) => ({
        question_id: row.id, stdin: t.stdin, expected_out: t.expected_out,
        is_hidden: t.is_hidden, position: idx + 1,
      })));
    }
    saved++;
  }

  btn.disabled = false; btn.textContent = "Save to paper";
  draft = null;
  renderDraft();
  note("genMsg", `${saved} questions added to the paper.`, "ok");
}

/* ══════════════ THE ROOM (REALTIME) ══════════════ */
const SEVERITY = {
  MULTIPLE_FACES_DETECTED: "high",
  SEB_CHECK_FAILED: "high",
  NO_FACE_DETECTED: "mid",
  FULLSCREEN_EXIT: "mid",
  WINDOW_BLUR: "low",
  TAB_HIDDEN: "low",
};
const WORDING = {
  MULTIPLE_FACES_DETECTED: "more than one face in frame",
  NO_FACE_DETECTED: "no face in frame",
  WINDOW_BLUR: "window lost focus",
  TAB_HIDDEN: "tab hidden",
  FULLSCREEN_EXIT: "left full screen",
  SEB_CHECK_FAILED: "opened outside Safe Exam Browser",
};

function subscribeToRoom() {
  const feed = document.getElementById("feed");
  const state = document.getElementById("liveState");

  supabase.channel("room")
    .on("postgres_changes",
      { event: "INSERT", schema: "public", table: "incident_logs" },
      async ({ new: row }) => {
        const who = await nameOf(row.student_id);
        const exam = exams.find((e) => e.id === row.exam_id);
        feed.querySelector(".feed-empty")?.remove();
        const item = document.createElement("div");
        item.className = "feed-item";
        item.dataset.sev = SEVERITY[row.event_type] ?? "low";
        item.innerHTML = `
          <span class="who">${escapeHtml(who.full_name || "Unknown")}</span>
          <span class="meta" style="letter-spacing:.08em">${escapeHtml(who.roll_no || "")}</span>
          <span>${WORDING[row.event_type] ?? row.event_type}</span>
          <span class="at">${exam ? exam.exam_code + " · " : ""}${new Date(row.created_at).toLocaleTimeString()}</span>`;
        feed.prepend(item);
        while (feed.children.length > 60) feed.lastElementChild.remove();
      })
    .subscribe((status) => {
      state.textContent = status === "SUBSCRIBED" ? "watching live" : status.toLowerCase();
    });
}

async function nameOf(id) {
  if (names[id]) return names[id];
  const { data } = await supabase.from("profiles")
    .select("full_name, roll_no").eq("id", id).single();
  names[id] = data ?? {};
  return names[id];
}

/* ══════════════ RESULTS ══════════════ */
let resultRows = [];

async function loadResults() {
  const examId = value("resultExam");
  const box = document.getElementById("resultsTable");
  if (!examId) { box.innerHTML = ""; return; }

  const { data } = await supabase.from("attempts")
    .select("student_id, score, status, submitted_at").eq("exam_id", examId);

  if (!data?.length) {
    resultRows = [];
    box.innerHTML = `<p class="muted" style="font-size:.9rem">No one has sat this paper yet.</p>`;
    return;
  }

  resultRows = [];
  for (const a of data) {
    const who = await nameOf(a.student_id);
    resultRows.push({
      roll: who.roll_no ?? "", name: who.full_name ?? "",
      score: a.score ?? "", status: a.status,
      submitted: a.submitted_at ? new Date(a.submitted_at).toLocaleString() : "",
    });
  }
  resultRows.sort((x, y) => String(x.roll).localeCompare(String(y.roll)));

  box.innerHTML = `<table class="results">
    <thead><tr><th>Roll</th><th>Name</th><th>Score</th><th>Status</th></tr></thead>
    <tbody>${resultRows.map((r) => `<tr>
      <td class="num">${escapeHtml(r.roll)}</td>
      <td>${escapeHtml(r.name)}</td>
      <td class="num">${r.score}</td>
      <td><span class="tag ${r.status === "submitted" ? "pass" : ""}">${r.status.replace("_", " ")}</span></td>
    </tr>`).join("")}</tbody></table>`;
}

function exportCsv() {
  if (!resultRows.length) return;
  const exam = exams.find((e) => e.id === value("resultExam"));
  const csv = ["Roll,Name,Score,Status,Submitted"]
    .concat(resultRows.map((r) =>
      [r.roll, r.name, r.score, r.status, r.submitted].map(csvCell).join(",")))
    .join("\n");
  const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `${exam?.exam_code ?? "results"}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

const csvCell = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;

/* ══════════════ SMALL HELPERS ══════════════ */
function value(id) { return document.getElementById(id).value.trim(); }

function note(id, text, kind) {
  const el = document.getElementById(id);
  el.textContent = text;
  el.className = `notice ${kind ?? ""}`;
  el.classList.toggle("hidden", !text);
}

function fmt(iso) {
  return new Date(iso).toLocaleString([], {
    day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
  });
}

function escapeHtml(s = "") {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
