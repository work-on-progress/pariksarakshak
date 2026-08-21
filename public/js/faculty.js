// public/js/faculty.js
import {
  supabase, callFunction, requireUser, signOut, downloadCsv, escapeHtml,
} from "./supabaseClient.js";
import { INSTITUTE_NAME, STUDENT_EMAIL_DOMAIN } from "./config.js";

let user, profile;
let exams = [];
let draft = null;             // AI questions awaiting approval
let editingQuestionId = null; // set while editing an existing question
let credentials = [];         // freshly created student logins
let resultRows = [];
const names = {};             // student_id → profile

boot();

async function boot() {
  const auth = await requireUser("faculty");
  if (!auth) return;
  ({ user, profile } = auth);

  document.getElementById("instituteTag").textContent = INSTITUTE_NAME;
  document.getElementById("whoami").textContent = profile.full_name || user.email;
  document.getElementById("signOutBtn").onclick = signOut;

  setUpTabs();
  wirePapers();
  wireQuestions();
  wireStudents();
  wireRoom();
  wireResults();

  await loadExams();
  subscribeToRoom();
  loadStudents();
}

/* ══════════════ TABS ══════════════ */
const PANES = ["papers", "questions", "students", "room", "results"];
function setUpTabs() {
  PANES.forEach((name) => {
    document.getElementById(`tab-${name}`).onclick = () => {
      PANES.forEach((p) => {
        document.getElementById(`tab-${p}`).setAttribute("aria-selected", String(p === name));
        document.getElementById(`pane-${p}`).classList.toggle("active", p === name);
      });
      if (name === "questions") loadQuestions();
      if (name === "room") loadRoom();
      if (name === "results") loadResults();
    };
  });
}

function note(id, text, kind) {
  const el = document.getElementById(id);
  el.textContent = text;
  el.className = `notice ${kind ?? ""}`;
  el.classList.toggle("hidden", !text);
}
const val = (id) => document.getElementById(id).value.trim();
const fmt = (iso) => new Date(iso).toLocaleString([], {
  day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
});
const isLive = (e) => e.is_published &&
  new Date(e.starts_at) <= new Date() && new Date() <= new Date(e.ends_at);

/* ══════════════ 1. PAPERS ══════════════ */
function wirePapers() {
  document.getElementById("createExam").onclick = createExam;
}

async function loadExams() {
  const { data } = await supabase.from("exams").select("*").order("starts_at", { ascending: false });
  exams = data ?? [];
  document.getElementById("examCount").textContent = exams.length ? `${exams.length} on file` : "none yet";

  const options = exams.map((e) =>
    `<option value="${e.id}">${escapeHtml(e.exam_code)} — ${escapeHtml(e.title)}</option>`).join("");
  ["examSelect", "roomExam", "resultExam"].forEach((id) => {
    const sel = document.getElementById(id);
    const keep = sel.value;
    sel.innerHTML = options || `<option value="">Create a paper first</option>`;
    if (keep) sel.value = keep;
  });

  document.getElementById("examList").innerHTML = exams.length
    ? exams.map((e) => `
      <div class="list-row">
        <span class="code">${escapeHtml(e.exam_code)}</span>
        <span>
          <span class="title">${escapeHtml(e.title)}</span><br>
          <span class="when">${fmt(e.starts_at)} → ${fmt(e.ends_at)} · ${e.duration_min} min</span>
        </span>
        <span style="margin-left:auto;display:flex;gap:.4rem;align-items:center">
          <span class="tag ${isLive(e) ? "pass" : ""}">${isLive(e) ? "live now" : e.is_published ? "closed" : "draft"}</span>
          <button class="btn ghost tiny" data-toggle="${e.id}">${e.is_published ? "Unpublish" : "Publish"}</button>
          <button class="btn ghost tiny" data-del="${e.id}">Delete</button>
        </span>
      </div>`).join("")
    : `<p class="empty">No papers yet. Create one on the left.</p>`;

  document.querySelectorAll("[data-toggle]").forEach((b) => {
    b.onclick = async () => {
      const e = exams.find((x) => x.id === b.dataset.toggle);
      await supabase.from("exams").update({ is_published: !e.is_published }).eq("id", e.id);
      loadExams();
    };
  });
  document.querySelectorAll("[data-del]").forEach((b) => {
    b.onclick = async () => {
      const e = exams.find((x) => x.id === b.dataset.del);
      if (!confirm(`Delete ${e.exam_code} with all its questions and attempts? This cannot be undone.`)) return;
      await supabase.from("exams").delete().eq("id", e.id);
      loadExams();
    };
  });
}

async function createExam() {
  const title = val("title"), code = val("code").toUpperCase();
  const starts = val("starts"), ends = val("ends"), dur = Number(val("dur"));

  if (!title || !code || !starts || !ends) {
    return note("examMsg", "Fill in the title, code and both times before creating the paper.", "error");
  }
  if (new Date(ends) <= new Date(starts)) {
    return note("examMsg", "The closing time must be after the opening time.", "error");
  }

  const { error } = await supabase.from("exams").insert({
    faculty_id: user.id, title, exam_code: code,
    instructions: val("instructions") || undefined,
    starts_at: new Date(starts).toISOString(),
    ends_at: new Date(ends).toISOString(),
    duration_min: dur,
    is_published: true,
    shuffle_questions: document.getElementById("shuffleQ").checked,
    shuffle_options: document.getElementById("shuffleO").checked,
  });

  if (error) {
    return note("examMsg",
      error.code === "23505" ? "That exam code is already in use. Pick another." : error.message, "error");
  }
  note("examMsg", `Paper created. Students join with the code ${code}.`, "ok");
  ["title", "code", "instructions"].forEach((id) => (document.getElementById(id).value = ""));
  loadExams();
}

/* ══════════════ 2. QUESTIONS ══════════════ */
function wireQuestions() {
  document.getElementById("examSelect").onchange = loadQuestions;
  document.getElementById("genBtn").onclick = draftQuestions;
  document.getElementById("saveBtn").onclick = saveDraft;
  document.getElementById("clearBtn").onclick = () => { draft = null; renderDraft(); note("genMsg", "", ""); };
  document.getElementById("mType").onchange = switchManualType;
  document.getElementById("addTest").onclick = () => addTestRow();
  document.getElementById("mSave").onclick = saveManual;
  document.getElementById("mCancel").onclick = resetManualForm;
  switchManualType();
  addTestRow("1 2 3", "6", false);
  addTestRow("", "", true);
}

async function draftQuestions() {
  const examId = val("examSelect");
  if (!examId) return note("genMsg", "Create a paper first, then draft questions for it.", "error");
  if (!val("topic") && !val("sourceText")) {
    return note("genMsg", "Give a topic, or paste the lecture notes to draw from.", "error");
  }

  const btn = document.getElementById("genBtn");
  btn.disabled = true; btn.textContent = "Drafting…";
  note("genMsg", "Writing questions. This takes a few seconds.", "");

  const res = await callFunction("generate-questions", {
    topic: val("topic"),
    source_text: val("sourceText"),
    difficulty: val("difficulty"),
    language: val("codeLang"),
    distribution: {
      mcq: +val("nMcq"), cloze: +val("nCloze"),
      long: +val("nLong"), coding: +val("nCode"),
    },
  });

  btn.disabled = false; btn.textContent = "Draft questions";
  if (res.error) return note("genMsg", res.error, "error");

  draft = res.questions ?? [];
  note("genMsg", `${draft.length} questions drafted. Read them, edit anything, then save.`, "ok");
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
      <header><b>Q${i + 1} · ${q.qtype.toUpperCase()} · ${q.marks}m</b>
        <button class="drop">Remove</button></header>
      <textarea rows="3"></textarea>
      ${q.qtype === "mcq" ? `<p class="answer">Key ${escapeHtml(q.correct_key)} — ${(q.options ?? []).map(escapeHtml).join("   ")}</p>` : ""}
      ${q.qtype === "cloze" ? `<p class="answer">Answers: ${(q.cloze_answers ?? []).map(escapeHtml).join(", ")}</p>` : ""}
      ${q.qtype === "coding" ? `<p class="tests">${(q.test_cases ?? []).length} tests · ${(q.test_cases ?? []).filter((t) => !t.is_hidden).length} shown to students, rest hidden</p>` : ""}`;
    const ta = el.querySelector("textarea");
    ta.value = q.prompt;
    ta.oninput = () => { q.prompt = ta.value; };
    el.querySelector(".drop").onclick = () => { draft.splice(i, 1); renderDraft(); };
    box.appendChild(el);
  });
}

async function saveDraft() {
  const exam_id = val("examSelect");
  if (!exam_id || !draft?.length) return;

  const btn = document.getElementById("saveBtn");
  btn.disabled = true; btn.textContent = "Saving…";

  let position = await nextPosition(exam_id);
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
      await supabase.from("test_cases").insert(q.test_cases.map((t, i) => ({
        question_id: row.id, stdin: t.stdin, expected_out: t.expected_out,
        is_hidden: t.is_hidden, position: i + 1,
      })));
    }
    saved++;
  }

  btn.disabled = false; btn.textContent = "Save to paper";
  draft = null;
  renderDraft();
  note("genMsg", `${saved} questions added to the paper.`, "ok");
  loadQuestions();
}

async function nextPosition(exam_id) {
  const { count } = await supabase.from("questions")
    .select("id", { count: "exact", head: true }).eq("exam_id", exam_id);
  return (count ?? 0) + 1;
}

/* ---- the by-hand editor ---- */
function switchManualType() {
  const t = val("mType");
  document.getElementById("mMcqBox").classList.toggle("hidden", t !== "mcq");
  document.getElementById("mClozeBox").classList.toggle("hidden", t !== "cloze");
  document.getElementById("mCodingBox").classList.toggle("hidden", t !== "coding");
  const marks = document.getElementById("mMarks");
  if (!editingQuestionId) marks.value = t === "coding" ? 10 : t === "long" ? 5 : 1;
}

function addTestRow(stdin = "", expected = "", hidden = true) {
  const row = document.createElement("div");
  row.className = "testrow";
  row.innerHTML = `
    <input placeholder="input" value="${escapeHtml(stdin)}">
    <input placeholder="expected output" value="${escapeHtml(expected)}">
    <label><input type="checkbox" ${hidden ? "checked" : ""}> hidden</label>
    <button class="btn ghost tiny">×</button>`;
  row.querySelector("button").onclick = () => row.remove();
  document.getElementById("mTests").appendChild(row);
}

function readTestRows() {
  return [...document.querySelectorAll("#mTests .testrow")].map((r, i) => {
    const [stdin, expected] = r.querySelectorAll("input[type='text'], input:not([type])");
    return {
      stdin: stdin.value,
      expected_out: expected.value,
      is_hidden: r.querySelector("input[type='checkbox']").checked,
      position: i + 1,
    };
  }).filter((t) => t.expected_out !== "");
}

async function saveManual() {
  const exam_id = val("examSelect");
  if (!exam_id) return note("mMsg", "Pick a paper at the top first.", "error");

  const qtype = val("mType");
  const prompt = val("mPrompt");
  if (!prompt) return note("mMsg", "Write the question first.", "error");

  const row = {
    exam_id, qtype, marks: Number(val("mMarks")) || 1, prompt,
    options: null, correct_key: null, cloze_answers: null,
    language: null, starter_code: null,
  };

  if (qtype === "mcq") {
    const opts = ["A", "B", "C", "D"]
      .map((L) => ({ L, text: val("mOpt" + L) }))
      .filter((o) => o.text);
    if (opts.length < 2) return note("mMsg", "Give at least two options.", "error");
    row.options = opts.map((o) => `${o.L}) ${o.text}`);
    row.correct_key = val("mKey");
    if (!opts.some((o) => o.L === row.correct_key)) {
      return note("mMsg", `Option ${row.correct_key} is empty — pick a filled option as the answer.`, "error");
    }
  }

  if (qtype === "cloze") {
    const answers = val("mCloze").split("|").map((s) => s.trim()).filter(Boolean);
    const blanks = (prompt.match(/____/g) ?? []).length;
    if (!answers.length) return note("mMsg", "List the answers, separated by |.", "error");
    if (blanks !== answers.length) {
      return note("mMsg", `The question has ${blanks} blanks (____) but you gave ${answers.length} answers.`, "error");
    }
    row.cloze_answers = answers;
  }

  if (qtype === "coding") {
    row.language = val("mLang");
    row.starter_code = document.getElementById("mStarter").value;
    const tests = readTestRows();
    if (tests.length < 2) return note("mMsg", "Add at least two test cases with an expected output.", "error");
    if (!tests.some((t) => !t.is_hidden)) {
      return note("mMsg", "Leave at least one test visible so students see the format.", "error");
    }
    row._tests = tests;
  }

  const tests = row._tests;
  delete row._tests;

  if (editingQuestionId) {
    const { error } = await supabase.from("questions").update(row).eq("id", editingQuestionId);
    if (error) return note("mMsg", error.message, "error");
    if (qtype === "coding") {
      await supabase.from("test_cases").delete().eq("question_id", editingQuestionId);
      await supabase.from("test_cases").insert(
        tests.map((t) => ({ ...t, question_id: editingQuestionId })));
    }
    note("mMsg", "Question updated.", "ok");
  } else {
    row.position = await nextPosition(exam_id);
    const { data, error } = await supabase.from("questions").insert(row).select("id").single();
    if (error) return note("mMsg", error.message, "error");
    if (qtype === "coding") {
      await supabase.from("test_cases").insert(
        tests.map((t) => ({ ...t, question_id: data.id })));
    }
    note("mMsg", "Question added to the paper.", "ok");
  }

  resetManualForm();
  loadQuestions();
}

function resetManualForm() {
  editingQuestionId = null;
  document.getElementById("manualHead").textContent = "Write one by hand";
  document.getElementById("mSave").textContent = "Add to paper";
  document.getElementById("mCancel").classList.add("hidden");
  ["mPrompt", "mOptA", "mOptB", "mOptC", "mOptD", "mCloze", "mStarter"]
    .forEach((id) => (document.getElementById(id).value = ""));
  document.getElementById("mTests").innerHTML = "";
  addTestRow("", "", false);
  addTestRow("", "", true);
  switchManualType();
}

async function loadQuestions() {
  const exam_id = val("examSelect");
  const box = document.getElementById("questionList");
  if (!exam_id) { box.innerHTML = `<p class="empty">Create a paper first.</p>`; return; }

  const { data: qs } = await supabase.from("questions")
    .select("*, test_cases(count)").eq("exam_id", exam_id).order("position");

  const total = (qs ?? []).reduce((s, q) => s + Number(q.marks), 0);
  document.getElementById("qCount").textContent =
    qs?.length ? `${qs.length} questions · ${total} marks` : "empty";

  if (!qs?.length) { box.innerHTML = `<p class="empty">No questions yet. Draft some, or write one by hand.</p>`; return; }

  box.innerHTML = qs.map((q, i) => `
    <div class="list-row">
      <span class="tag ${{ mcq: "blue", cloze: "warn", long: "", coding: "pass" }[q.qtype]}">${q.qtype}</span>
      <span>
        <span class="title">Q${i + 1}. ${escapeHtml(q.prompt.slice(0, 90))}${q.prompt.length > 90 ? "…" : ""}</span><br>
        <span class="when">${q.marks} marks${q.qtype === "coding" ? ` · ${q.test_cases?.[0]?.count ?? 0} tests` : ""}</span>
      </span>
      <span class="tools" style="margin-left:auto;display:flex;gap:.3rem">
        <button class="btn ghost tiny" data-edit="${q.id}">Edit</button>
        <button class="btn ghost tiny" data-qdel="${q.id}">Delete</button>
      </span>
    </div>`).join("");

  box.querySelectorAll("[data-edit]").forEach((b) => {
    b.onclick = () => editQuestion(qs.find((q) => q.id === b.dataset.edit));
  });
  box.querySelectorAll("[data-qdel]").forEach((b) => {
    b.onclick = async () => {
      if (!confirm("Delete this question?")) return;
      await supabase.from("questions").delete().eq("id", b.dataset.qdel);
      loadQuestions();
    };
  });
}

async function editQuestion(q) {
  editingQuestionId = q.id;
  document.getElementById("manualHead").textContent = "Editing a question";
  document.getElementById("mSave").textContent = "Save changes";
  document.getElementById("mCancel").classList.remove("hidden");

  document.getElementById("mType").value = q.qtype;
  document.getElementById("mMarks").value = q.marks;
  document.getElementById("mPrompt").value = q.prompt;
  switchManualType();

  if (q.qtype === "mcq") {
    const opts = Array.isArray(q.options) ? q.options : [];
    ["A", "B", "C", "D"].forEach((L, i) => {
      document.getElementById("mOpt" + L).value =
        (opts[i] ?? "").replace(/^[A-D]\)\s*/, "");
    });
    document.getElementById("mKey").value = q.correct_key ?? "A";
  }
  if (q.qtype === "cloze") {
    document.getElementById("mCloze").value = (q.cloze_answers ?? []).join(" | ");
  }
  if (q.qtype === "coding") {
    document.getElementById("mLang").value = q.language ?? "python";
    document.getElementById("mStarter").value = q.starter_code ?? "";
    const { data: tests } = await supabase.from("test_cases")
      .select("*").eq("question_id", q.id).order("position");
    document.getElementById("mTests").innerHTML = "";
    (tests ?? []).forEach((t) => addTestRow(t.stdin, t.expected_out, t.is_hidden));
  }
  document.getElementById("mPrompt").scrollIntoView({ behavior: "smooth", block: "center" });
}

/* ══════════════ 3. STUDENTS ══════════════ */
function wireStudents() {
  document.getElementById("createStudents").onclick = createStudents;
  document.getElementById("downloadCreds").onclick = () =>
    downloadCsv("student-logins.csv", ["Roll", "Name", "Email", "Password"],
      credentials.map((c) => [c.roll_no, c.full_name, c.email, c.password]));
  document.getElementById("resetPw").onclick = resetPassword;
}

async function createStudents() {
  const lines = document.getElementById("rollList").value
    .split("\n").map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return note("studentMsg", "Paste the roll list first.", "error");

  const students = lines.map((l) => {
    const [roll, ...rest] = l.split(",");
    return { roll_no: (roll ?? "").trim(), full_name: rest.join(",").trim() };
  });

  const btn = document.getElementById("createStudents");
  btn.disabled = true; btn.textContent = "Creating…";
  note("studentMsg", `Creating ${students.length} accounts. This takes a moment.`, "");

  const res = await callFunction("manage-students", {
    action: "create", students, email_domain: STUDENT_EMAIL_DOMAIN,
  });

  btn.disabled = false; btn.textContent = "Create accounts";
  if (res.error) return note("studentMsg", res.error, "error");

  credentials = res.created ?? [];
  const skipped = res.skipped ?? [];
  note("studentMsg",
    `${credentials.length} accounts created${skipped.length ? `, ${skipped.length} skipped` : ""}. ` +
    `Download the slips now — the passwords are not shown again.`,
    skipped.length ? "warn" : "ok");

  document.getElementById("downloadCreds").classList.toggle("hidden", !credentials.length);
  const box = document.getElementById("creds");
  box.classList.remove("hidden");
  box.textContent = [
    ...credentials.map((c) => `${c.roll_no.padEnd(12)} ${c.email.padEnd(28)} ${c.password}`),
    ...skipped.map((s) => `${(s.roll_no || "?").padEnd(12)} SKIPPED — ${s.reason}`),
  ].join("\n");

  loadStudents();
}

async function resetPassword() {
  const roll = val("resetRoll");
  if (!roll) return note("resetMsg", "Type the roll number.", "error");
  const res = await callFunction("manage-students", { action: "reset_password", roll_no: roll });
  if (res.error) return note("resetMsg", res.error, "error");
  note("resetMsg", `${res.full_name || roll} — new password: ${res.password}`, "ok");
}

async function loadStudents() {
  const { data } = await supabase.from("profiles")
    .select("id, full_name, roll_no, role").eq("role", "student").order("roll_no");
  document.getElementById("studentCount").textContent = data?.length ? `${data.length} enrolled` : "none yet";
  document.getElementById("studentList").innerHTML = data?.length
    ? data.map((s) => `<div class="roster-row">
        <span class="roll">${escapeHtml(s.roll_no ?? "—")}</span>
        <span>${escapeHtml(s.full_name ?? "")}</span></div>`).join("")
    : `<p class="empty">No students yet. Create them on the left.</p>`;
}

/* ══════════════ 4. THE ROOM ══════════════ */
const SEVERITY = {
  MULTIPLE_FACES_DETECTED: "high", SEB_CHECK_FAILED: "high",
  NO_FACE_DETECTED: "mid", FULLSCREEN_EXIT: "mid",
  WINDOW_BLUR: "low", TAB_HIDDEN: "low",
};
const WORDING = {
  MULTIPLE_FACES_DETECTED: "more than one face in frame",
  NO_FACE_DETECTED: "no face in frame",
  WINDOW_BLUR: "window lost focus",
  TAB_HIDDEN: "tab hidden",
  FULLSCREEN_EXIT: "left full screen",
  SEB_CHECK_FAILED: "opened outside Safe Exam Browser",
};

function wireRoom() {
  document.getElementById("roomExam").onchange = loadRoom;
  document.getElementById("refreshRoom").onclick = loadRoom;
  setInterval(() => {
    if (document.getElementById("pane-room").classList.contains("active")) loadRoom();
  }, 15000);
}

async function loadRoom() {
  const exam_id = val("roomExam");
  const box = document.getElementById("roster");
  if (!exam_id) { box.innerHTML = `<p class="empty">Create a paper first.</p>`; return; }

  const [{ data: attempts }, { data: incidents }, { data: students }] = await Promise.all([
    supabase.from("attempts").select("*").eq("exam_id", exam_id),
    supabase.from("incident_logs").select("student_id, event_type").eq("exam_id", exam_id),
    supabase.from("profiles").select("id, full_name, roll_no").eq("role", "student"),
  ]);

  (students ?? []).forEach((s) => { names[s.id] = s; });

  const flags = {};
  (incidents ?? []).forEach((i) => {
    flags[i.student_id] = (flags[i.student_id] ?? 0) + (SEVERITY[i.event_type] === "low" ? 0 : 1);
  });

  const sitting = (attempts ?? []).filter((a) => a.status === "in_progress").length;
  const done = (attempts ?? []).filter((a) => a.status === "submitted").length;
  const notStarted = (students?.length ?? 0) - (attempts?.length ?? 0);

  document.getElementById("roomStats").innerHTML = `
    <div><strong>${sitting}</strong><span>sitting</span></div>
    <div><strong>${done}</strong><span>submitted</span></div>
    <div><strong>${Math.max(notStarted, 0)}</strong><span>not started</span></div>
    <div><strong>${incidents?.length ?? 0}</strong><span>incidents</span></div>`;

  if (!attempts?.length) { box.innerHTML = `<p class="empty">Nobody has started this paper yet.</p>`; return; }

  const sorted = [...attempts].sort((a, b) =>
    (flags[b.student_id] ?? 0) - (flags[a.student_id] ?? 0));

  box.innerHTML = sorted.map((a) => {
    const who = names[a.student_id] ?? {};
    const f = flags[a.student_id] ?? 0;
    return `<div class="roster-row">
      <span class="roll">${escapeHtml(who.roll_no ?? "—")}</span>
      <span>${escapeHtml(who.full_name ?? "Unknown")}</span>
      <span class="tag ${a.status === "submitted" ? "pass" : ""}">${a.status.replace("_", " ")}</span>
      <span class="flags ${f > 2 ? "hot" : ""}">${f ? `${f} flags` : ""}</span>
      <span class="tools">
        <button class="btn ghost tiny" data-extra="${a.id}">+5 min</button>
        ${a.status !== "in_progress" ? `<button class="btn ghost tiny" data-unlock="${a.id}">Unlock</button>` : ""}
      </span>
    </div>`;
  }).join("");

  box.querySelectorAll("[data-extra]").forEach((b) => {
    b.onclick = async () => {
      const { error } = await supabase.rpc("grant_extra_time",
        { p_attempt_id: b.dataset.extra, p_minutes: 5 });
      b.textContent = error ? "failed" : "+5 done";
      if (!error) setTimeout(loadRoom, 800);
    };
  });
  box.querySelectorAll("[data-unlock]").forEach((b) => {
    b.onclick = async () => {
      if (!confirm("Reopen this paper for the student?")) return;
      const { error } = await supabase.rpc("reopen_attempt", { p_attempt_id: b.dataset.unlock });
      if (error) alert(error.message);
      loadRoom();
    };
  });
}

function subscribeToRoom() {
  const feed = document.getElementById("feed");
  feed.innerHTML = `<p class="empty">Nothing to report. Incidents appear here the moment they happen.</p>`;

  supabase.channel("room")
    .on("postgres_changes",
      { event: "INSERT", schema: "public", table: "incident_logs" },
      async ({ new: row }) => {
        const who = names[row.student_id] ?? await nameOf(row.student_id);
        const exam = exams.find((e) => e.id === row.exam_id);
        feed.querySelector(".empty")?.remove();
        const item = document.createElement("div");
        item.className = "feed-item";
        item.dataset.sev = SEVERITY[row.event_type] ?? "low";
        item.innerHTML = `
          <span class="who">${escapeHtml(who.full_name ?? "Unknown")}</span>
          <span class="meta" style="letter-spacing:.08em">${escapeHtml(who.roll_no ?? "")}</span>
          <span>${WORDING[row.event_type] ?? row.event_type}</span>
          <span class="at">${exam ? escapeHtml(exam.exam_code) + " · " : ""}${new Date(row.created_at).toLocaleTimeString()}</span>`;
        feed.prepend(item);
        while (feed.children.length > 80) feed.lastElementChild.remove();
      })
    .subscribe((status) => {
      document.getElementById("liveState").textContent =
        status === "SUBSCRIBED" ? "watching live" : status.toLowerCase();
    });
}

async function nameOf(id) {
  if (names[id]) return names[id];
  const { data } = await supabase.from("profiles")
    .select("id, full_name, roll_no").eq("id", id).single();
  names[id] = data ?? {};
  return names[id];
}

/* ══════════════ 5. RESULTS ══════════════ */
function wireResults() {
  document.getElementById("resultExam").onchange = loadResults;
  document.getElementById("exportBtn").onclick = () => {
    if (!resultRows.length) return;
    const exam = exams.find((e) => e.id === val("resultExam"));
    downloadCsv(`${exam?.exam_code ?? "results"}.csv`,
      ["Roll", "Name", "Score", "Status", "Submitted"],
      resultRows.map((r) => [r.roll, r.name, r.score, r.status, r.submitted]));
  };
}

async function loadResults() {
  const exam_id = val("resultExam");
  const box = document.getElementById("resultsTable");
  if (!exam_id) { box.innerHTML = `<p class="empty">Create a paper first.</p>`; return; }

  const { data: attempts } = await supabase.from("attempts")
    .select("id, student_id, score, status, submitted_at").eq("exam_id", exam_id);

  if (!attempts?.length) {
    resultRows = [];
    box.innerHTML = `<p class="empty">Nobody has sat this paper yet.</p>`;
    document.getElementById("longAnswers").innerHTML = "";
    document.getElementById("longCount").textContent = "";
    return;
  }

  resultRows = [];
  for (const a of attempts) {
    const who = await nameOf(a.student_id);
    resultRows.push({
      roll: who.roll_no ?? "", name: who.full_name ?? "",
      score: a.score ?? "", status: a.status,
      submitted: a.submitted_at ? new Date(a.submitted_at).toLocaleString() : "",
    });
  }
  resultRows.sort((x, y) => String(x.roll).localeCompare(String(y.roll)));

  const scores = attempts.map((a) => Number(a.score)).filter((n) => !Number.isNaN(n));
  const avg = scores.length ? (scores.reduce((s, n) => s + n, 0) / scores.length).toFixed(1) : "—";

  box.innerHTML = `
    <div class="stats">
      <div><strong>${attempts.length}</strong><span>attempts</span></div>
      <div><strong>${avg}</strong><span>average</span></div>
      <div><strong>${scores.length ? Math.max(...scores) : "—"}</strong><span>highest</span></div>
    </div>
    <table class="results">
      <thead><tr><th>Roll</th><th>Name</th><th>Score</th><th>Status</th></tr></thead>
      <tbody>${resultRows.map((r) => `<tr>
        <td class="num">${escapeHtml(r.roll)}</td>
        <td>${escapeHtml(r.name)}</td>
        <td class="num">${r.score}</td>
        <td><span class="tag ${r.status === "submitted" ? "pass" : ""}">${r.status.replace("_", " ")}</span></td>
      </tr>`).join("")}</tbody>
    </table>`;

  loadLongAnswers(exam_id, attempts);
}

async function loadLongAnswers(exam_id, attempts) {
  const ids = attempts.map((a) => a.id);
  const { data: rows } = await supabase.from("answers")
    .select("id, attempt_id, question_id, answer_text, auto_marks, questions!inner(qtype, prompt, marks)")
    .in("attempt_id", ids)
    .eq("questions.qtype", "long");

  const box = document.getElementById("longAnswers");
  const pending = (rows ?? []).filter((r) => r.auto_marks === null);
  document.getElementById("longCount").textContent =
    rows?.length ? `${pending.length} of ${rows.length} still to mark` : "none on this paper";

  if (!rows?.length) { box.innerHTML = `<p class="empty">This paper has no long answers.</p>`; return; }

  box.innerHTML = `<table class="results">
    <thead><tr><th>Roll</th><th>Answer</th><th>Out of</th><th>Marks</th></tr></thead>
    <tbody>${rows.map((r) => {
      const a = attempts.find((x) => x.id === r.attempt_id);
      const who = names[a?.student_id] ?? {};
      return `<tr>
        <td class="num">${escapeHtml(who.roll_no ?? "—")}</td>
        <td>${escapeHtml(r.answer_text ?? "(blank)").slice(0, 400)}</td>
        <td class="num">${r.questions.marks}</td>
        <td><input type="number" step="0.5" min="0" max="${r.questions.marks}"
                   value="${r.auto_marks ?? ""}" data-mark="${r.id}" data-attempt="${r.attempt_id}"></td>
      </tr>`;
    }).join("")}</tbody></table>`;

  box.querySelectorAll("[data-mark]").forEach((input) => {
    input.onchange = async () => {
      const marks = input.value === "" ? null : Number(input.value);
      const { error } = await supabase.rpc("mark_long_answer",
        { p_answer_id: input.dataset.mark, p_marks: marks });
      input.style.borderColor = error ? "var(--seal)" : "var(--pass)";
      if (error) { alert(error.message); return; }
      setTimeout(() => { input.style.borderColor = ""; }, 1200);
      loadResults();
    };
  });
}
