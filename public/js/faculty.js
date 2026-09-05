// public/js/faculty.js
import {
  supabase, callFunction, requireUser, signOut, downloadCsv, escapeHtml,
} from "./supabaseClient.js";
import { INSTITUTE_NAME, STUDENT_EMAIL_DOMAIN } from "./config.js";
import { extractText, parseQuestions } from "./docimport.js";

let user, profile;
let exams = [];
let draft = null;
let editingExamId = null;
let editingQuestionId = null;
let credentials = [];
let resultRows = [];
const names = {};

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
  wireSources();
  wireMix();
  wireManual();
  wireStudents();
  wireRoom();
  wireResults();

  await loadExams();
  subscribeToRoom();
  loadStudents();
}

/* ══════════════ SHELL ══════════════ */
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
  el.innerHTML = text;
  el.className = `notice ${kind ?? ""}`;
  el.classList.toggle("hidden", !text);
}
const val = (id) => document.getElementById(id).value.trim();
const fmt = (iso) => new Date(iso).toLocaleString([], {
  day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit",
});
const isLive = (e) => e.is_published &&
  new Date(e.starts_at) <= new Date() && new Date() <= new Date(e.ends_at);

/* ══════════════ 1 · PAPERS ══════════════ */
function wirePapers() {
  document.getElementById("createExam").onclick = createOrUpdateExam;
  document.getElementById("cancelExamEdit").onclick = resetExamForm;
}

function toLocalInput(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000);
  return local.toISOString().slice(0, 16);
}

function resetExamForm() {
  editingExamId = null;
  document.getElementById("paperFormTitle").textContent = "New paper";
  document.getElementById("createExam").textContent = "Create paper";
  document.getElementById("cancelExamEdit").classList.add("hidden");
  ["title", "code", "starts", "ends", "instructions"].forEach((id) => {
    document.getElementById(id).value = "";
  });
  document.getElementById("dur").value = 60;
  document.getElementById("warnAfter").value = 3;
  document.getElementById("shuffleQ").checked = true;
  document.getElementById("shuffleO").checked = true;
  const seb = document.querySelector('input[name="delivery"][value="seb"]');
  if (seb) seb.checked = true;
  note("examMsg", "", "");
}

function beginExamEdit(id) {
  const e = exams.find((x) => x.id === id);
  if (!e) return;
  editingExamId = e.id;
  document.getElementById("paperFormTitle").textContent = `Edit paper · ${e.exam_code}`;
  document.getElementById("createExam").textContent = "Save changes";
  document.getElementById("cancelExamEdit").classList.remove("hidden");
  document.getElementById("title").value = e.title ?? "";
  document.getElementById("code").value = e.exam_code ?? "";
  document.getElementById("starts").value = toLocalInput(e.starts_at);
  document.getElementById("ends").value = toLocalInput(e.ends_at);
  document.getElementById("dur").value = e.duration_min ?? 60;
  document.getElementById("instructions").value = e.instructions ?? "";
  document.getElementById("warnAfter").value = e.browser_warn_after ?? 3;
  document.getElementById("shuffleQ").checked = e.shuffle_questions !== false;
  document.getElementById("shuffleO").checked = e.shuffle_options !== false;
  const mode = document.querySelector(`input[name="delivery"][value="${e.delivery_mode ?? "seb"}"]`);
  if (mode) mode.checked = true;
  note("examMsg", "Editing this paper. Changes apply to future/resumed loads. Avoid changing duration while students are actively sitting unless you intend to.", "warn");
  document.getElementById("pane-papers").scrollIntoView({ behavior: "smooth", block: "start" });
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
    if (keep && exams.some((e) => e.id === keep)) sel.value = keep;
  });

  const MODE_TAG = {
    seb: `<span class="tag pass">locked browser</span>`,
    browser: `<span class="tag warn">ordinary browser</span>`,
    either: `<span class="tag">either</span>`,
  };

  document.getElementById("examList").innerHTML = exams.length
    ? exams.map((e) => `
      <div class="list-row">
        <span class="code">${escapeHtml(e.exam_code)}</span>
        <span>
          <span class="title">${escapeHtml(e.title)}</span><br>
          <span class="when">${fmt(e.starts_at)} → ${fmt(e.ends_at)} · ${e.duration_min} min</span>
        </span>
        <span style="margin-left:auto;display:flex;gap:.4rem;align-items:center;flex-wrap:wrap">
          ${MODE_TAG[e.delivery_mode ?? "seb"]}
          <span class="tag ${isLive(e) ? "pass" : ""}">${isLive(e) ? "live now" : e.is_published ? "closed" : "draft"}</span>
          <button class="btn ghost tiny" data-edit-exam="${e.id}">Edit</button>
          <button class="btn ghost tiny" data-toggle="${e.id}">${e.is_published ? "Unpublish" : "Publish"}</button>
          <button class="btn ghost tiny" data-del="${e.id}">Delete</button>
        </span>
      </div>`).join("")
    : `<p class="empty">No papers yet. Create one on the left.</p>`;

  document.querySelectorAll("[data-edit-exam]").forEach((b) => {
    b.onclick = () => beginExamEdit(b.dataset.editExam);
  });
  document.querySelectorAll("[data-toggle]").forEach((b) => {
    b.onclick = async () => {
      const e = exams.find((x) => x.id === b.dataset.toggle);
      const { error } = await supabase.from("exams").update({ is_published: !e.is_published }).eq("id", e.id);
      if (error) return alert(error.message);
      loadExams();
    };
  });
  document.querySelectorAll("[data-del]").forEach((b) => {
    b.onclick = async () => {
      const e = exams.find((x) => x.id === b.dataset.del);
      if (!confirm(`Delete ${e.exam_code} with all questions, attempts, answers and incidents? This cannot be undone.`)) return;
      const { error } = await supabase.rpc("delete_exam_cascade", { p_exam_id: e.id });
      if (error) return alert(error.message);
      if (editingExamId === e.id) resetExamForm();
      loadExams();
      loadQuestions();
      loadRoom();
      loadResults();
    };
  });
}

async function createOrUpdateExam() {
  const title = val("title"), code = val("code").toUpperCase();
  const starts = val("starts"), ends = val("ends"), dur = Number(val("dur"));
  const delivery = document.querySelector('input[name="delivery"]:checked')?.value ?? "seb";

  if (!title || !code || !starts || !ends) {
    return note("examMsg", "Fill in the title, code and both times.", "error");
  }
  if (new Date(ends) <= new Date(starts)) {
    return note("examMsg", "The closing time must be after the opening time.", "error");
  }
  if (!Number.isFinite(dur) || dur < 5) {
    return note("examMsg", "Minutes allowed must be at least 5.", "error");
  }

  const payload = {
    title,
    exam_code: code,
    instructions: val("instructions") || null,
    starts_at: new Date(starts).toISOString(),
    ends_at: new Date(ends).toISOString(),
    duration_min: dur,
    delivery_mode: delivery,
    browser_warn_after: Number(val("warnAfter")) || 0,
    shuffle_questions: document.getElementById("shuffleQ").checked,
    shuffle_options: document.getElementById("shuffleO").checked,
  };

  let error;
  if (editingExamId) {
    ({ error } = await supabase.from("exams").update(payload).eq("id", editingExamId));
  } else {
    ({ error } = await supabase.from("exams").insert({
      ...payload,
      faculty_id: user.id,
      is_published: true,
    }));
  }

  if (error) {
    return note("examMsg",
      error.code === "23505" ? "That exam code is already in use. Pick another."
        : error.message.includes("delivery_mode")
        ? "The database does not know about delivery modes yet. Run migration 005."
        : error.message, "error");
  }

  if (editingExamId) {
    note("examMsg", `Paper <b>${escapeHtml(code)}</b> updated.`, "ok");
  } else {
    const modeWord = delivery === "browser" ? "an ordinary browser"
      : delivery === "either" ? "either browser" : "Safe Exam Browser";
    note("examMsg", `Paper created. Students join with <b>${escapeHtml(code)}</b>, sitting it in ${modeWord}.`, "ok");
  }
  resetExamForm();
  await loadExams();
}

/* ══════════════ 2 · WHERE QUESTIONS COME FROM ══════════════ */
let importedText = "";       // notes, for generation
let paperText = "";          // an existing paper, for import

function wireSources() {
  document.getElementById("examSelect").onchange = loadQuestions;

  const tabs = ["topic", "notes", "paper"];
  tabs.forEach((t) => {
    document.getElementById(`src-${t}`).onclick = () => {
      tabs.forEach((x) => {
        document.getElementById(`src-${x}`).setAttribute("aria-selected", String(x === t));
        document.getElementById(`pane-src-${x}`).classList.toggle("active", x === t);
      });
      // Reading an existing paper is its own path; the mix does not apply.
      document.getElementById("mixPanel").classList.toggle("hidden", t === "paper");
    };
  });

  wireDrop("dropNotes", "notesFile", "pickNotes", "notesStatus", (text) => {
    importedText = text;
    document.getElementById("sourceText").value = text;
  });
  wireDrop("dropPaper", "paperFile", "pickPaper", "paperStatus", (text) => {
    paperText = text;
    document.getElementById("paperText").value = text;
  });

  document.getElementById("parseLocalBtn").onclick = importLocally;
  document.getElementById("parseAiBtn").onclick = importWithAi;
}

function wireDrop(zoneId, inputId, buttonId, statusId, done) {
  const zone = document.getElementById(zoneId);
  const input = document.getElementById(inputId);

  document.getElementById(buttonId).onclick = () => input.click();
  input.onchange = () => input.files[0] && read(input.files[0]);

  ["dragenter", "dragover"].forEach((ev) =>
    zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add("over"); }));
  ["dragleave", "drop"].forEach((ev) =>
    zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.remove("over"); }));
  zone.addEventListener("drop", (e) => {
    const f = e.dataTransfer.files[0];
    if (f) read(f);
  });

  async function read(file) {
    note(statusId, `Reading ${escapeHtml(file.name)}…`, "");
    try {
      const { text, pages, warning } = await extractText(file);
      if (warning) { note(statusId, warning, "warn"); }
      else {
        note(statusId,
          `Read ${escapeHtml(file.name)} — ${text.length.toLocaleString()} characters${pages ? ` from ${pages} pages` : ""}. Nothing was uploaded.`,
          "ok");
      }
      done(text);
    } catch (e) {
      note(statusId, escapeHtml(String(e.message ?? e)), "error");
    }
  }
}

/* ── reading an existing paper ── */
function currentPaperText() {
  return val("paperText") || paperText;
}

function importLocally() {
  const text = currentPaperText();
  if (!text) return note("importMsg", "Upload a file or paste the questions first.", "error");

  const { questions, note: summary, withoutKey } = parseQuestions(text);
  if (!questions.length) return note("importMsg", summary, "warn");

  draft = questions;
  note("importMsg", summary, withoutKey ? "warn" : "ok");
  renderDraft();
}

async function importWithAi() {
  const text = currentPaperText();
  if (!text) return note("importMsg", "Upload a file or paste the questions first.", "error");

  const btn = document.getElementById("parseAiBtn");
  btn.disabled = true; btn.textContent = "Reading…";
  note("importMsg", "Reading the document. Nothing is being invented — only what is written is kept.", "");

  const res = await callFunction("generate-questions", { mode: "import", source_text: text });

  btn.disabled = false; btn.textContent = "Read them with AI";
  if (res.error) return note("importMsg", escapeHtml(res.error), "error");

  draft = res.questions;
  const missing = draft.filter((q) =>
    (q.qtype === "mcq" && !q.correct_key) ||
    (q.qtype === "cloze" && !(q.cloze_answers ?? []).length)
  ).length;

  const providerText = res.provider_usage
    ? Object.entries(res.provider_usage)
        .map(([name, count]) => `${name} ${count}`)
        .join(" · ")
    : "";

  const chunkText = res.source_chunks
    ? ` · ${res.source_chunks} document chunk${res.source_chunks === 1 ? "" : "s"} processed`
    : "";

  note("importMsg",
    `Read ${draft.length} questions from the full document${chunkText}` +
    `${providerText ? ` · ${providerText}` : ""}` +
    `${missing ? ` · ${missing} objective answer${missing === 1 ? "" : "s"} still need review` : ""}.`,
    missing ? "warn" : "ok");

  renderDraft();
}

/* ══════════════ 3 · THE MIX ══════════════ */
const MIX_TYPES = [
  { value: "mcq:theory", label: "MCQ — theory", marks: 1 },
  { value: "mcq:output", label: "MCQ — what does this code print", marks: 1 },
  { value: "mcq:error",  label: "MCQ — find the mistake in the code", marks: 1 },
  { value: "mcq:blank",  label: "MCQ — complete the code", marks: 1 },
  { value: "cloze",      label: "Fill in the blanks", marks: 1 },
  { value: "long",       label: "Long answer", marks: 5 },
  { value: "coding",     label: "Coding problem", marks: 10 },
];

const PRESETS = {
  quick: [
    ["mcq:theory", "easy", 5, 1],
    ["mcq:theory", "medium", 3, 1],
    ["mcq:output", "medium", 2, 1],
  ],
  unit: [
    ["mcq:theory", "easy", 5, 1],
    ["mcq:theory", "medium", 3, 1],
    ["mcq:output", "medium", 2, 1],
    ["mcq:error", "hard", 1, 1],
    ["cloze", "easy", 3, 1],
    ["long", "medium", 2, 5],
  ],
  coding: [
    ["mcq:output", "easy", 3, 1],
    ["mcq:blank", "medium", 2, 1],
    ["coding", "easy", 1, 10],
    ["coding", "medium", 1, 10],
  ],
};

function wireMix() {
  document.getElementById("addMixRow").onclick = () => addMixRow();
  document.querySelectorAll("[data-preset]").forEach((b) => {
    b.onclick = () => applyPreset(b.dataset.preset);
  });
  document.getElementById("genBtn").onclick = generate;
  document.getElementById("saveBtn").onclick = saveDraft;
  document.getElementById("clearBtn").onclick = () => {
    draft = null; renderDraft(); note("genMsg", "", "");
  };
  applyPreset("unit");
}

function applyPreset(name) {
  document.getElementById("mixRows").innerHTML = "";
  (PRESETS[name] ?? PRESETS.unit).forEach(([type, diff, count, marks]) =>
    addMixRow(type, diff, count, marks));
  updateMixSummary();
}

function addMixRow(type = "mcq:theory", difficulty = "medium", count = 5, marks = 1) {
  const row = document.createElement("div");
  row.className = "mix-row";
  row.innerHTML = `
    <select class="mix-type">${MIX_TYPES.map((t) =>
      `<option value="${t.value}" ${t.value === type ? "selected" : ""}>${t.label}</option>`).join("")}</select>
    <select class="mix-diff">
      ${["easy", "medium", "hard"].map((d) =>
        `<option value="${d}" ${d === difficulty ? "selected" : ""}>${d}</option>`).join("")}
    </select>
    <input class="mix-count" type="number" min="0" max="50" value="${count}">
    <input class="mix-marks" type="number" min="0" step="0.5" value="${marks}">
    <button class="btn ghost tiny mix-drop">Remove</button>`;

  row.querySelector(".mix-drop").onclick = () => { row.remove(); updateMixSummary(); };
  row.querySelector(".mix-type").onchange = (e) => {
    const preset = MIX_TYPES.find((t) => t.value === e.target.value);
    if (preset) row.querySelector(".mix-marks").value = preset.marks;
    updateMixSummary();
  };
  row.querySelectorAll("input, select").forEach((el) => el.addEventListener("input", updateMixSummary));

  document.getElementById("mixRows").appendChild(row);
  updateMixSummary();
}

function readMix() {
  return [...document.querySelectorAll(".mix-row")].map((row) => {
    const [qtype, kind] = row.querySelector(".mix-type").value.split(":");
    return {
      qtype,
      mcq_kind: kind ?? "theory",
      difficulty: row.querySelector(".mix-diff").value,
      count: Number(row.querySelector(".mix-count").value) || 0,
      marks: Number(row.querySelector(".mix-marks").value) || 1,
    };
  }).filter((r) => r.count > 0);
}

function updateMixSummary() {
  const mix = readMix();
  const n = mix.reduce((s, r) => s + r.count, 0);
  const marks = mix.reduce((s, r) => s + r.count * r.marks, 0);
  const byDiff = { easy: 0, medium: 0, hard: 0 };
  mix.forEach((r) => { byDiff[r.difficulty] += r.count; });

  document.getElementById("mixSummary").textContent = n
    ? `${n} questions · ${marks} marks · ${byDiff.easy} easy, ${byDiff.medium} medium, ${byDiff.hard} hard`
    : "nothing selected";
}

async function generate() {
  const examId = val("examSelect");
  if (!examId) return note("genMsg", "Create a paper first, then write questions for it.", "error");

  const mix = readMix();
  if (!mix.length) return note("genMsg", "Add at least one row to the mix, with a count above zero.", "error");

  const topic = val("topic");
  const source = val("sourceText") || importedText;
  if (!topic && !source) {
    return note("genMsg", "Give a topic, or upload your notes on the tab above.", "error");
  }

  const total = mix.reduce((s, r) => s + r.count, 0);
  if (total > 50) {
    return note("genMsg", "Ask for 50 questions or fewer at a time. The server automatically divides large requests across the configured AI providers.", "error");
  }

  const btn = document.getElementById("genBtn");
  btn.disabled = true; btn.textContent = "Writing…";
  note("genMsg", `Writing ${total} questions. This takes a few seconds.`, "");

  const res = await callFunction("generate-questions", {
    mode: "generate",
    topic,
    source_text: source,
    mix,
    coding_level: val("codingLevel"),
    language: val("codeLang"),
  });

  btn.disabled = false; btn.textContent = "Write the questions";
  if (res.error) return note("genMsg", escapeHtml(res.error), "error");

  draft = res.questions;
  const asked = total, got = draft.length;

  const providerText = res.provider_usage
    ? Object.entries(res.provider_usage)
        .map(([name, count]) => `${name} ${count}`)
        .join(" · ")
    : "";

  const sourceTextInfo = res.source_characters_used
    ? ` · ${Number(res.source_characters_used).toLocaleString()} source characters used`
    : "";

  const review = Number(res.objective_questions_needing_review ?? 0);

  note("genMsg",
    (got === asked
      ? `${got} questions written`
      : `${got} questions came back out of ${asked}`) +
    `${providerText ? ` · ${providerText}` : ""}` +
    `${sourceTextInfo}` +
    `${review ? ` · ${review} answer${review === 1 ? "" : "s"} need review` : ""}. ` +
    (got === asked
      ? "Read them, edit anything, then save."
      : "Generate the missing quantity again."),
    got === asked && review === 0 ? "ok" : "warn");

  renderDraft();
}

/* ══════════════ THE PREVIEW ══════════════ */
const KIND_LABEL = { theory: "theory", output: "code output", error: "find the mistake", blank: "complete the code" };

function renderDraft() {
  const panel = document.getElementById("previewPanel");
  const box = document.getElementById("preview");
  const has = !!draft?.length;

  panel.classList.toggle("hidden", !has);
  document.getElementById("saveBtn").classList.toggle("hidden", !has);
  document.getElementById("clearBtn").classList.toggle("hidden", !has);
  if (!has) { box.innerHTML = ""; return; }

  const marks = draft.reduce((s, q) => s + Number(q.marks || 0), 0);
  document.getElementById("previewCount").textContent = `${draft.length} questions · ${marks} marks`;

  box.innerHTML = "";
  draft.forEach((q, i) => {
    const el = document.createElement("div");
    el.className = "qprev";
    el.dataset.type = q.qtype;
    const needsKey = q.qtype === "mcq" && !q.correct_key;

    el.innerHTML = `
      <header>
        <b>Q${i + 1}</b>
        <span class="tag ${{ mcq: "blue", cloze: "warn", long: "", coding: "pass" }[q.qtype]}">${q.qtype}</span>
        ${q.qtype === "mcq" ? `<span class="tag">${KIND_LABEL[q.mcq_kind] ?? q.mcq_kind}</span>` : ""}
        <span class="tag diff-${q.difficulty}">${q.difficulty}</span>
        <span class="tag">${q.marks}m</span>
        ${needsKey ? `<span class="tag seal">answer missing</span>` : ""}
        <button class="drop">Remove</button>
      </header>
      <textarea rows="2" class="q-prompt"></textarea>
      ${q.code_snippet ? `<pre class="snippet-prev"></pre>` : ""}
      <div class="opts"></div>
      ${q.qtype === "cloze" ? `<p class="answer">Answers: ${escapeHtml((q.cloze_answers ?? []).join(", ") || "(set these before saving)")}</p>` : ""}
      ${q.qtype === "coding" ? `<p class="tests">${(q.test_cases ?? []).length} tests · ${(q.test_cases ?? []).filter((t) => !t.is_hidden).length} shown to students</p>` : ""}
      ${q.explanation ? `<p class="why">${escapeHtml(q.explanation)}</p>` : ""}`;

    const ta = el.querySelector(".q-prompt");
    ta.value = q.prompt;
    ta.oninput = () => { q.prompt = ta.value; };

    if (q.code_snippet) el.querySelector(".snippet-prev").textContent = q.code_snippet;

    if (q.qtype === "mcq") {
      const opts = el.querySelector(".opts");
      (q.options ?? []).forEach((opt, idx) => {
        const letter = String.fromCharCode(65 + idx);
        const row = document.createElement("label");
        row.className = "opt-row" + (q.correct_key === letter ? " correct" : "");
        row.innerHTML = `<input type="radio" name="key-${i}" ${q.correct_key === letter ? "checked" : ""}>
                         <span>${escapeHtml(opt)}</span>`;
        row.querySelector("input").onchange = () => {
          q.correct_key = letter;
          renderDraft();
        };
        opts.appendChild(row);
      });
    }

    el.querySelector(".drop").onclick = () => { draft.splice(i, 1); renderDraft(); };
    box.appendChild(el);
  });
}

function normaliseGeneratedTests(testCases) {
  const tests = Array.isArray(testCases)
    ? testCases
      .filter((t) => t && String(t.expected_out ?? "") !== "")
      .map((t, i) => ({
        stdin: String(t.stdin ?? ""),
        expected_out: String(t.expected_out ?? ""),
        is_hidden: t.is_hidden !== false,
        position: i + 1,
      }))
    : [];

  // A generated coding question must have examples. If Gemini marked every
  // case hidden, expose the first two so Run visible tests is useful.
  if (tests.length && !tests.some((t) => !t.is_hidden)) {
    tests.slice(0, Math.min(2, tests.length)).forEach((t) => { t.is_hidden = false; });
  }
  return tests;
}

async function saveDraft() {
  const exam_id = val("examSelect");
  if (!exam_id || !draft?.length) return;

  const missing = draft.filter((q) => q.qtype === "mcq" && !q.correct_key);
  if (missing.length) {
    return note("genMsg",
      `${missing.length} multiple-choice question${missing.length === 1 ? " has" : "s have"} no answer marked. Click the correct option on each before saving.`,
      "error");
  }

  const brokenCoding = draft.find((q) =>
    q.qtype === "coding" && normaliseGeneratedTests(q.test_cases).length < 2);
  if (brokenCoding) {
    return note("genMsg",
      "A coding question came back without enough test cases. Remove/regenerate that coding question, or add its tests by hand before saving.",
      "error");
  }

  const btn = document.getElementById("saveBtn");
  btn.disabled = true; btn.textContent = "Saving…";

  let position = await nextPosition(exam_id);
  let saved = 0;

  for (const q of draft) {
    const { data: row, error } = await supabase.from("questions").insert({
      exam_id, qtype: q.qtype, position: position++,
      marks: q.marks, prompt: q.prompt,
      difficulty: q.difficulty ?? "medium",
      mcq_kind: q.qtype === "mcq" ? (q.mcq_kind ?? "theory") : "theory",
      code_snippet: q.code_snippet || null,
      explanation: q.explanation || null,
      options: q.options?.length ? q.options : null,
      correct_key: q.correct_key || null,
      cloze_answers: q.cloze_answers?.length ? q.cloze_answers : null,
      language: q.language || null,
      func_signature: q.func_signature || null,
      starter_code: q.starter_code || null,
    }).select("id").single();

    if (error) {
      btn.disabled = false; btn.textContent = "Save to paper";
      return note("genMsg",
        `Stopped after ${saved} questions: ${escapeHtml(error.message)}` +
        (error.message.includes("difficulty") || error.message.includes("mcq_kind")
          ? " — this looks like migration 005 has not been run yet." : ""),
        "error");
    }

    if (q.qtype === "coding") {
      const tests = normaliseGeneratedTests(q.test_cases);
      const { error: testError } = await supabase.from("test_cases").insert(
        tests.map((t) => ({ ...t, question_id: row.id })),
      );
      if (testError) {
        // Do not leave a coding question in the paper with zero runnable tests.
        await supabase.from("questions").delete().eq("id", row.id);
        btn.disabled = false; btn.textContent = "Save to paper";
        return note("genMsg",
          `Stopped after ${saved} questions: coding test cases could not be saved — ${escapeHtml(testError.message)}`,
          "error");
      }
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

/* ══════════════ BY HAND ══════════════ */
function wireManual() {
  document.getElementById("mType").onchange = switchManualType;
  document.getElementById("mKind").onchange = switchManualType;
  document.getElementById("addTest").onclick = () => addTestRow();
  document.getElementById("mSave").onclick = saveManual;
  document.getElementById("mCancel").onclick = resetManualForm;
  switchManualType();
  addTestRow("", "", false);
  addTestRow("", "", true);
}

function switchManualType() {
  const t = val("mType");
  const kind = val("mKind");
  document.getElementById("mMcqBox").classList.toggle("hidden", t !== "mcq");
  document.getElementById("mKindBox").classList.toggle("hidden", t !== "mcq");
  document.getElementById("mClozeBox").classList.toggle("hidden", t !== "cloze");
  document.getElementById("mCodingBox").classList.toggle("hidden", t !== "coding");
  document.getElementById("mSnippetBox").classList.toggle(
    "hidden", !(t === "mcq" && kind !== "theory"));

  if (!editingQuestionId) {
    document.getElementById("mMarks").value = t === "coding" ? 10 : t === "long" ? 5 : 1;
  }
}

function addTestRow(stdin = "", expected = "", hidden = true) {
  const row = document.createElement("div");
  row.className = "testrow";
  row.innerHTML = `
    <input class="t-in" placeholder="input" value="${escapeHtml(stdin)}">
    <input class="t-out" placeholder="expected output" value="${escapeHtml(expected)}">
    <label><input type="checkbox" class="t-hidden" ${hidden ? "checked" : ""}> hidden</label>
    <button class="btn ghost tiny">×</button>`;
  row.querySelector("button").onclick = () => row.remove();
  document.getElementById("mTests").appendChild(row);
}

function readTestRows() {
  return [...document.querySelectorAll("#mTests .testrow")].map((r, i) => ({
    stdin: r.querySelector(".t-in").value,
    expected_out: r.querySelector(".t-out").value,
    is_hidden: r.querySelector(".t-hidden").checked,
    position: i + 1,
  })).filter((t) => t.expected_out !== "");
}

async function saveManual() {
  const exam_id = val("examSelect");
  if (!exam_id) return note("mMsg", "Pick a paper at the top first.", "error");

  const qtype = val("mType");
  const prompt = val("mPrompt");
  if (!prompt) return note("mMsg", "Write the question first.", "error");

  const row = {
    exam_id, qtype, marks: Number(val("mMarks")) || 1, prompt,
    difficulty: val("mDiff"),
    mcq_kind: qtype === "mcq" ? val("mKind") : "theory",
    code_snippet: null, explanation: val("mExplain") || null,
    options: null, correct_key: null, cloze_answers: null,
    language: null, starter_code: null,
  };

  if (qtype === "mcq") {
    if (val("mKind") !== "theory") {
      row.code_snippet = document.getElementById("mSnippet").value;
      if (!row.code_snippet.trim()) {
        return note("mMsg", "This kind of question needs the code that goes above it.", "error");
      }
    }
    const opts = ["A", "B", "C", "D"].map((L) => ({ L, text: val("mOpt" + L) })).filter((o) => o.text);
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

  let tests = null;
  if (qtype === "coding") {
    row.language = val("mLang");
    row.starter_code = document.getElementById("mStarter").value;
    tests = readTestRows();
    if (tests.length < 2) return note("mMsg", "Add at least two test cases with an expected output.", "error");
    if (!tests.some((t) => !t.is_hidden)) {
      return note("mMsg", "Leave at least one test visible so students see the format.", "error");
    }
  }

  if (editingQuestionId) {
    const { error } = await supabase.from("questions").update(row).eq("id", editingQuestionId);
    if (error) return note("mMsg", escapeHtml(error.message), "error");
    if (qtype === "coding") {
      const { error: delTestError } = await supabase.from("test_cases").delete().eq("question_id", editingQuestionId);
      if (delTestError) return note("mMsg", `Could not replace test cases: ${escapeHtml(delTestError.message)}`, "error");
      const { error: addTestError } = await supabase.from("test_cases")
        .insert(tests.map((t) => ({ ...t, question_id: editingQuestionId })));
      if (addTestError) return note("mMsg", `Could not save test cases: ${escapeHtml(addTestError.message)}`, "error");
    }
    note("mMsg", "Question updated.", "ok");
  } else {
    row.position = await nextPosition(exam_id);
    const { data, error } = await supabase.from("questions").insert(row).select("id").single();
    if (error) return note("mMsg", escapeHtml(error.message), "error");
    if (qtype === "coding") {
      const { error: addTestError } = await supabase.from("test_cases")
        .insert(tests.map((t) => ({ ...t, question_id: data.id })));
      if (addTestError) {
        await supabase.from("questions").delete().eq("id", data.id);
        return note("mMsg", `Could not save test cases: ${escapeHtml(addTestError.message)}`, "error");
      }
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
  ["mPrompt", "mOptA", "mOptB", "mOptC", "mOptD", "mCloze", "mStarter", "mSnippet", "mExplain"]
    .forEach((id) => (document.getElementById(id).value = ""));
  document.getElementById("mTests").innerHTML = "";
  addTestRow("", "", false);
  addTestRow("", "", true);
  switchManualType();
}

async function loadQuestions() {
  const exam_id = val("examSelect");
  const box = document.getElementById("questionList");
  const blueprint = document.getElementById("blueprint");
  if (!exam_id) {
    box.innerHTML = `<p class="empty">Create a paper first.</p>`;
    blueprint.innerHTML = "";
    return;
  }

  // Read questions separately from test cases. A failed nested test_cases join
  // used to make a real paper look EMPTY in the console.
  const { data: qs, error: qError } = await supabase.from("questions")
    .select("*").eq("exam_id", exam_id).order("position");

  if (qError) {
    document.getElementById("qCount").textContent = "could not read";
    blueprint.innerHTML = "";
    box.innerHTML = `<p class="notice error">Could not read this paper: ${escapeHtml(qError.message)}</p>`;
    return;
  }

  const codingIds = (qs ?? []).filter((q) => q.qtype === "coding").map((q) => q.id);
  const testMap = {};
  if (codingIds.length) {
    const { data: tests, error: tError } = await supabase.from("test_cases")
      .select("question_id, is_hidden").in("question_id", codingIds);
    if (!tError) {
      (tests ?? []).forEach((t) => {
        testMap[t.question_id] ??= { total: 0, visible: 0 };
        testMap[t.question_id].total++;
        if (!t.is_hidden) testMap[t.question_id].visible++;
      });
    }
  }

  const total = (qs ?? []).reduce((sum, q) => sum + Number(q.marks), 0);
  document.getElementById("qCount").textContent =
    qs?.length ? `${qs.length} questions · ${total} marks` : "empty";

  if (!qs?.length) {
    blueprint.innerHTML = "";
    box.innerHTML = `<p class="empty">No questions yet. Write some above, or import a paper you already have.</p>`;
    return;
  }

  const counts = { easy: 0, medium: 0, hard: 0 };
  qs.forEach((q) => { counts[q.difficulty ?? "medium"] = (counts[q.difficulty ?? "medium"] ?? 0) + 1; });
  blueprint.innerHTML = ["easy", "medium", "hard"].map((d) =>
    `<span class="tag diff-${d}">${counts[d]} ${d}</span>`).join(" ");

  box.innerHTML = qs.map((q, i) => {
    const tc = testMap[q.id] ?? { total: 0, visible: 0 };
    const codingMeta = q.qtype === "coding"
      ? ` · ${tc.total} tests · ${tc.visible} visible${tc.visible === 0 ? " ⚠" : ""}` : "";
    return `
      <div class="list-row">
        <span class="tag ${{ mcq: "blue", cloze: "warn", long: "", coding: "pass" }[q.qtype]}">${q.qtype}</span>
        <span>
          <span class="title">Q${i + 1}. ${escapeHtml(q.prompt.slice(0, 80))}${q.prompt.length > 80 ? "…" : ""}</span><br>
          <span class="when">${q.difficulty ?? "medium"} · ${q.marks} marks${
            q.qtype === "mcq" && q.mcq_kind !== "theory" ? ` · ${KIND_LABEL[q.mcq_kind] ?? q.mcq_kind}` : ""}${codingMeta}</span>
        </span>
        <span class="tools" style="margin-left:auto;display:flex;gap:.3rem">
          <button class="btn ghost tiny" data-edit="${q.id}">Edit</button>
          <button class="btn ghost tiny" data-qdel="${q.id}">Delete</button>
        </span>
      </div>`;
  }).join("");

  box.querySelectorAll("[data-edit]").forEach((b) => {
    b.onclick = () => editQuestion(qs.find((q) => q.id === b.dataset.edit));
  });
  box.querySelectorAll("[data-qdel]").forEach((b) => {
    b.onclick = async () => {
      if (!confirm("Delete this question and any answers/test cases attached to it?")) return;
      const { error } = await supabase.from("questions").delete().eq("id", b.dataset.qdel);
      if (error) return alert(error.message);
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
  document.getElementById("mDiff").value = q.difficulty ?? "medium";
  document.getElementById("mKind").value = q.mcq_kind ?? "theory";
  document.getElementById("mMarks").value = q.marks;
  document.getElementById("mPrompt").value = q.prompt;
  document.getElementById("mSnippet").value = q.code_snippet ?? "";
  document.getElementById("mExplain").value = q.explanation ?? "";
  switchManualType();

  if (q.qtype === "mcq") {
    const opts = Array.isArray(q.options) ? q.options : [];
    ["A", "B", "C", "D"].forEach((L, i) => {
      document.getElementById("mOpt" + L).value = (opts[i] ?? "").replace(/^[A-D]\)\s*/, "");
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

/* ══════════════ 4 · STUDENTS ══════════════ */
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
  if (res.error) return note("studentMsg", escapeHtml(res.error), "error");

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
  if (res.error) return note("resetMsg", escapeHtml(res.error), "error");
  note("resetMsg", `${escapeHtml(res.full_name || roll)} — new password: <b>${escapeHtml(res.password)}</b>`, "ok");
}

async function loadStudents() {
  const { data } = await supabase.from("profiles")
    .select("id, full_name, roll_no, role").eq("role", "student").order("roll_no");
  document.getElementById("studentCount").textContent = data?.length ? `${data.length} enrolled` : "none yet";
  const box = document.getElementById("studentList");
  box.innerHTML = data?.length
    ? data.map((s) => `<div class="roster-row">
        <span class="roll">${escapeHtml(s.roll_no ?? "—")}</span>
        <span>${escapeHtml(s.full_name ?? "")}</span>
        <span class="tools" style="margin-left:auto;display:flex;gap:.35rem;flex-wrap:wrap">
          <button class="btn ghost tiny" data-edit-student="${s.id}">Edit</button>
          <button class="btn ghost tiny" data-reset-student-pw="${escapeHtml(s.roll_no ?? "")}">Reset password</button>
          <button class="btn ghost tiny" data-delete-student="${s.id}">Delete</button>
        </span>
      </div>`).join("")
    : `<p class="empty">No students yet. Create them on the left.</p>`;

  box.querySelectorAll("[data-edit-student]").forEach((b) => {
    b.onclick = async () => {
      const s = data.find((x) => x.id === b.dataset.editStudent);
      if (!s) return;
      const roll = prompt("Roll number", s.roll_no ?? "");
      if (roll === null) return;
      const name = prompt("Student name", s.full_name ?? "");
      if (name === null) return;
      const res = await callFunction("manage-students", {
        action: "update",
        student_id: s.id,
        roll_no: roll.trim(),
        full_name: name.trim(),
        email_domain: STUDENT_EMAIL_DOMAIN,
      });
      if (res.error) return alert(`Could not update student: ${res.error}`);
      delete names[s.id];
      await loadStudents();
      alert(`Updated ${res.roll_no ?? roll}.`);
    };
  });

  box.querySelectorAll("[data-reset-student-pw]").forEach((b) => {
    b.onclick = async () => {
      const roll = b.dataset.resetStudentPw;
      if (!roll) return;
      const res = await callFunction("manage-students", { action: "reset_password", roll_no: roll });
      if (res.error) return alert(`Could not reset password: ${res.error}`);
      alert(`${res.full_name || roll}
New password: ${res.password}`);
    };
  });

  box.querySelectorAll("[data-delete-student]").forEach((b) => {
    b.onclick = async () => {
      const s = data.find((x) => x.id === b.dataset.deleteStudent);
      if (!s) return;
      if (!confirm(`Delete ${s.full_name || s.roll_no || "this student"}?

This removes the login account, attempts, answers, incidents and exam sessions. This cannot be undone.`)) return;
      const res = await callFunction("manage-students", { action: "delete", student_id: s.id });
      if (res.error) return alert(`Could not delete student: ${res.error}`);
      delete names[s.id];
      await loadStudents();
      await loadRoom();
      await loadResults();
    };
  });
}

async function resetAttempt(examId, studentId, label = "this student") {
  if (!confirm(`Reset ${label}'s attempt?

Their answers, incidents and attempt record for this paper will be removed. They can then take the paper again.`)) return false;
  const { error } = await supabase.rpc("reset_student_attempt", {
    p_exam_id: examId,
    p_student_id: studentId,
  });
  if (error) {
    alert(`Could not reset attempt: ${error.message}`);
    return false;
  }
  alert("Attempt reset. The student can take this paper again.");
  await loadRoom();
  await loadResults();
  return true;
}

/* ══════════════ 5 · THE ROOM ══════════════ */
const SEVERITY = {
  MULTIPLE_FACES_DETECTED: "high", SEB_CHECK_FAILED: "high",
  NO_FACE_DETECTED: "mid", FULLSCREEN_EXIT: "mid",
  WINDOW_BLUR: "low", TAB_HIDDEN: "low",
};
const WORDING = {
  MULTIPLE_FACES_DETECTED: "more than one face in frame",
  NO_FACE_DETECTED: "no face in frame",
  WINDOW_BLUR: "switched away from the window",
  TAB_HIDDEN: "switched to another tab",
  FULLSCREEN_EXIT: "left full screen",
  SEB_CHECK_FAILED: "tried to open outside Safe Exam Browser",
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
    supabase.from("incident_logs")
      .select("id, student_id, event_type, detail, created_at").eq("exam_id", exam_id),
    supabase.from("profiles").select("id, full_name, roll_no").eq("role", "student"),
  ]);

  (students ?? []).forEach((s) => { names[s.id] = s; });

  const flags = {};
  (incidents ?? []).forEach((i) => {
    flags[i.student_id] = (flags[i.student_id] ?? 0) + 1;
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

  const sorted = [...attempts].sort((a, b) => (flags[b.student_id] ?? 0) - (flags[a.student_id] ?? 0));

  box.innerHTML = sorted.map((a) => {
    const who = names[a.student_id] ?? {};
    const f = flags[a.student_id] ?? 0;
    return `<div class="roster-row">
      <span class="roll">${escapeHtml(who.roll_no ?? "—")}</span>
      <span>${escapeHtml(who.full_name ?? "Unknown")}</span>
      <span class="tag ${a.status === "submitted" ? "pass" : ""}">${a.status.replace("_", " ")}</span>
      <button class="btn ghost tiny ${f > 2 ? "hot" : ""}" data-view-flags="${a.student_id}"
              data-student-label="${escapeHtml(who.full_name || who.roll_no || "student")}">
        ${f} event${f === 1 ? "" : "s"} · view flags
      </button>
      <span class="tools">
        <button class="btn ghost tiny" data-extra="${a.id}">+5 min</button>
        ${a.status !== "in_progress" ? `<button class="btn ghost tiny" data-unlock="${a.id}">Unlock</button>` : ""}
        <button class="btn ghost tiny" data-reset-attempt="${a.student_id}" data-student-label="${escapeHtml(who.full_name || who.roll_no || "student")}">Reset / reattempt</button>
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
  box.querySelectorAll("[data-reset-attempt]").forEach((b) => {
    b.onclick = async () => {
      await resetAttempt(exam_id, b.dataset.resetAttempt, b.dataset.studentLabel);
    };
  });
  box.querySelectorAll("[data-view-flags]").forEach((b) => {
    b.onclick = () => viewStudentFlags(exam_id, b.dataset.viewFlags, b.dataset.studentLabel);
  });
}

async function viewStudentFlags(examId, studentId, label = "student") {
  const { data, error } = await supabase.from("incident_logs")
    .select("event_type, detail, created_at")
    .eq("exam_id", examId)
    .eq("student_id", studentId)
    .order("created_at", { ascending: false });

  if (error) return alert(`Could not read flags: ${error.message}`);

  const dialog = document.getElementById("flagsDialog");
  document.getElementById("flagsTitle").textContent = `${label} — ${(data ?? []).length} recorded events`;
  const body = document.getElementById("flagsBody");

  body.innerHTML = data?.length
    ? `<table class="results incident-table">
        <thead><tr><th>Time</th><th>Keyword</th><th>What happened</th><th>Detail</th></tr></thead>
        <tbody>${data.map((i) => `<tr>
          <td class="num">${escapeHtml(new Date(i.created_at).toLocaleString())}</td>
          <td><code>${escapeHtml(i.event_type)}</code></td>
          <td>${escapeHtml(WORDING[i.event_type] ?? i.event_type)}</td>
          <td>${escapeHtml(i.detail || "—")}</td>
        </tr>`).join("")}</tbody>
      </table>`
    : `<p class="empty">No anti-cheat events were recorded for this student on this paper.</p>`;

  if (typeof dialog.showModal === "function") dialog.showModal();
  else dialog.setAttribute("open", "");
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

/* ══════════════ 6 · RESULTS ══════════════ */
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
      attemptId: a.id, studentId: a.student_id,
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
      <thead><tr><th>Roll</th><th>Name</th><th>Score</th><th>Status</th><th>Actions</th></tr></thead>
      <tbody>${resultRows.map((r) => `<tr>
        <td class="num">${escapeHtml(r.roll)}</td>
        <td>${escapeHtml(r.name)}</td>
        <td class="num">${r.score}</td>
        <td><span class="tag ${r.status === "submitted" ? "pass" : ""}">${r.status.replace("_", " ")}</span></td>
        <td class="actions">
          <button class="btn ghost tiny" data-result-flags="${r.studentId}" data-result-label="${escapeHtml(r.name || r.roll || "student")}">View flags</button>
          <button class="btn ghost tiny" data-result-reset="${r.studentId}" data-result-label="${escapeHtml(r.name || r.roll || "student")}">Reset / reattempt</button>
        </td>
      </tr>`).join("")}</tbody>
    </table>`;

  box.querySelectorAll("[data-result-flags]").forEach((b) => {
    b.onclick = () => viewStudentFlags(exam_id, b.dataset.resultFlags, b.dataset.resultLabel);
  });
  box.querySelectorAll("[data-result-reset]").forEach((b) => {
    b.onclick = async () => {
      await resetAttempt(exam_id, b.dataset.resultReset, b.dataset.resultLabel);
    };
  });

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
        <td>${escapeHtml((r.answer_text ?? "(blank)").slice(0, 400))}</td>
        <td class="num">${r.questions.marks}</td>
        <td><input type="number" step="0.5" min="0" max="${r.questions.marks}"
                   value="${r.auto_marks ?? ""}" data-mark="${r.id}"></td>
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
