// public/js/exam.js
import { supabase, callFunction, requireUser, signOut } from "./supabaseClient.js";
import {
  enforceSEBOrBlock, activateWebLockdown, activateFocusMonitor,
  setIncidentContext, logIncident, devBypassActive,
} from "./anticheat.js";
import { startProctoring, stopProctoring } from "./proctor.js";

let user, profile, exam, attempt;
let questions = [];
const editors = {};        // question_id → CodeMirror
const saveTimers = {};     // question_id → debounce handle
let finished = false;

boot();

async function boot() {
  if (!enforceSEBOrBlock()) return;
  activateWebLockdown();

  const auth = await requireUser("student");
  if (!auth) return;
  ({ user, profile } = auth);

  document.getElementById("whoami").textContent =
    `${profile.full_name || user.email}${profile.roll_no ? " · " + profile.roll_no : ""}`;
  document.getElementById("signOutLink").onclick = (e) => { e.preventDefault(); signOut(); };
  document.getElementById("joinBtn").onclick = join;
  document.getElementById("examCode").addEventListener("keydown", (e) => {
    if (e.key === "Enter") join();
  });
}

/* ══════════════ JOIN ══════════════ */
async function join() {
  const code = document.getElementById("examCode").value.trim().toUpperCase();
  if (!code) return say("Type the exam code to begin.");

  const { data: rows } = await supabase.from("exams").select("*").eq("exam_code", code);
  if (!rows?.length) {
    return say("No live exam with that code. Check the code, or wait for the start time.");
  }
  exam = rows[0];

  const { data: existing } = await supabase.from("attempts")
    .select("*").eq("exam_id", exam.id).eq("student_id", user.id).maybeSingle();

  if (existing?.status === "submitted") {
    return say("You have already submitted this paper. It cannot be reopened.");
  }
  if (existing) {
    attempt = existing;
  } else {
    const { data: created, error } = await supabase.from("attempts")
      .insert({ exam_id: exam.id, student_id: user.id }).select().single();
    if (error) return say(error.message);
    attempt = created;
  }

  setIncidentContext({ attemptId: attempt.id, examId: exam.id, studentId: user.id });
  activateFocusMonitor();

  // Questions come from the sanitized view: no answer keys, no hidden tests.
  const { data: qs, error: qErr } = await supabase
    .from("student_questions").select("*").eq("exam_id", exam.id).order("position");
  if (qErr) return say(qErr.message);
  questions = qs ?? [];
  if (!questions.length) return say("This exam has no questions yet. Tell the invigilator.");

  const saved = await loadSavedAnswers();

  document.getElementById("joinScreen").classList.add("hidden");
  document.getElementById("examScreen").classList.remove("hidden");
  document.getElementById("paperTitle").textContent = exam.title;
  document.getElementById("paperCode").textContent = exam.exam_code;
  document.getElementById("finishBtn").onclick = () => finish(false);

  renderPaper(saved);
  startTimer();
  requestFullscreenQuietly();
  beginProctoring();
}

function say(text) {
  const el = document.getElementById("joinMsg");
  el.textContent = text;
  el.classList.remove("hidden");
}

async function loadSavedAnswers() {
  const { data } = await supabase.from("answers")
    .select("question_id, answer_text, code_submitted").eq("attempt_id", attempt.id);
  const map = {};
  (data ?? []).forEach((a) => { map[a.question_id] = a; });
  return map;
}

/* ══════════════ RENDER ══════════════ */
function renderPaper(saved) {
  const area = document.getElementById("questionArea");
  area.innerHTML = "";

  questions.forEach((q, i) => {
    const card = document.createElement("article");
    card.className = "qcard rise";
    card.style.animationDelay = `${Math.min(i, 6) * 40}ms`;

    const head = document.createElement("header");
    head.innerHTML = `
      <span class="qno">Q${i + 1}</span>
      <span class="tag ${tagClass(q.qtype)}">${label(q.qtype)}</span>
      <span class="tag">${q.marks} ${Number(q.marks) === 1 ? "mark" : "marks"}</span>
      <span class="save-state" data-ok="0"></span>`;
    card.appendChild(head);
    const state = head.querySelector(".save-state");

    const prompt = document.createElement("p");
    prompt.className = "prompt";
    prompt.textContent = q.prompt;
    card.appendChild(prompt);

    const body = document.createElement("div");
    card.appendChild(body);
    area.appendChild(card);

    const prior = saved[q.id];

    if (q.qtype === "mcq")     buildMcq(q, body, state, prior);
    if (q.qtype === "cloze")   buildCloze(q, body, state, prior);
    if (q.qtype === "long")    buildLong(q, body, state, prior);
    if (q.qtype === "coding")  buildCoding(q, body, state, prior);
  });
}

const label = (t) => ({ mcq: "Multiple choice", cloze: "Fill the blanks", long: "Long answer", coding: "Coding" }[t] ?? t);
const tagClass = (t) => ({ mcq: "blue", cloze: "warn", long: "", coding: "pass" }[t] ?? "");

function buildMcq(q, body, state, prior) {
  const options = Array.isArray(q.options) ? q.options : Object.values(q.options ?? {});
  options.forEach((opt) => {
    const key = String(opt).trim().charAt(0).toUpperCase();
    const row = document.createElement("label");
    row.className = "choice";
    const input = document.createElement("input");
    input.type = "radio";
    input.name = `q-${q.id}`;
    input.value = key;
    if (prior?.answer_text === key) { input.checked = true; row.classList.add("picked"); }
    const span = document.createElement("span");
    span.textContent = opt;
    row.append(input, span);
    input.onchange = () => {
      body.querySelectorAll(".choice").forEach((c) => c.classList.remove("picked"));
      row.classList.add("picked");
      saveAnswer(q.id, key, state);
    };
    body.appendChild(row);
  });
}

function buildCloze(q, body, state, prior) {
  const count = q.blank_count ?? 1;
  const wrap = document.createElement("div");
  wrap.className = "blanks";
  let prev = [];
  try { prev = JSON.parse(prior?.answer_text ?? "[]"); } catch { prev = []; }

  for (let b = 0; b < count; b++) {
    const input = document.createElement("input");
    input.placeholder = `Blank ${b + 1}`;
    input.value = prev[b] ?? "";
    input.autocomplete = "off";
    input.oninput = () => {
      const values = [...wrap.querySelectorAll("input")].map((i) => i.value);
      saveAnswer(q.id, JSON.stringify(values), state);
    };
    wrap.appendChild(input);
  }
  body.appendChild(wrap);
}

function buildLong(q, body, state, prior) {
  const ta = document.createElement("textarea");
  ta.rows = 8;
  ta.placeholder = "Write your answer here.";
  ta.value = prior?.answer_text ?? "";
  ta.oninput = () => saveAnswer(q.id, ta.value, state);
  body.appendChild(ta);
}

function buildCoding(q, body, state, prior) {
  const wrap = document.createElement("div");
  wrap.className = "editor-wrap";
  const ta = document.createElement("textarea");
  wrap.appendChild(ta);
  body.appendChild(wrap);

  const actions = document.createElement("div");
  actions.className = "code-actions";
  const runBtn = document.createElement("button");
  runBtn.className = "btn ghost small";
  runBtn.textContent = "Run visible tests";
  const submitBtn = document.createElement("button");
  submitBtn.className = "btn pass small";
  submitBtn.textContent = "Submit for marks";
  const hint = document.createElement("span");
  hint.className = "meta";
  hint.style.color = "var(--ink-3)";
  hint.textContent = "all tests must pass";
  actions.append(runBtn, submitBtn, hint);
  body.appendChild(actions);

  const verdict = document.createElement("div");
  verdict.className = "verdict hidden";
  body.appendChild(verdict);

  const cm = CodeMirror.fromTextArea(ta, {
    mode: cmMode(q.language),
    theme: "material-darker",
    lineNumbers: true,
    indentUnit: 4,
    smartIndent: true,
    matchBrackets: true,
  });
  cm.setValue(prior?.code_submitted ?? q.starter_code ?? "");
  cm.setSize("100%", "320px");
  editors[q.id] = cm;

  runBtn.onclick = () => runCode(q.id, "run", verdict, [runBtn, submitBtn], state);
  submitBtn.onclick = () => runCode(q.id, "submit", verdict, [runBtn, submitBtn], state);
}

const cmMode = (lang) => ({
  python: "python", javascript: "javascript",
  c: "text/x-csrc", cpp: "text/x-c++src", java: "text/x-java",
}[lang] ?? "python");

/* ══════════════ SAVING ══════════════ */
function saveAnswer(question_id, answer_text, stateEl) {
  clearTimeout(saveTimers[question_id]);
  stateEl.dataset.ok = "0";
  stateEl.textContent = "saving…";
  saveTimers[question_id] = setTimeout(async () => {
    const { error } = await supabase.from("answers").upsert({
      attempt_id: attempt.id, question_id, answer_text,
      updated_at: new Date().toISOString(),
    }, { onConflict: "attempt_id,question_id" });
    stateEl.dataset.ok = error ? "0" : "1";
    stateEl.textContent = error ? "not saved — retrying" : "saved";
    if (error) saveAnswer(question_id, answer_text, stateEl);
  }, 600);
}

/* ══════════════ CODE EXECUTION ══════════════ */
async function runCode(question_id, mode, verdict, buttons, stateEl) {
  buttons.forEach((b) => (b.disabled = true));
  verdict.classList.remove("hidden");
  verdict.textContent = mode === "run"
    ? "Running the visible tests…"
    : "Running every test on the server…";

  const res = await callFunction("run-code", {
    attempt_id: attempt.id,
    question_id,
    code: editors[question_id].getValue(),
    mode,
  });

  buttons.forEach((b) => (b.disabled = false));

  if (res.error) { verdict.textContent = `Could not run: ${res.error}`; return; }

  const lines = res.results.map((r) => {
    const mark = r.pass ? "PASS" : "FAIL";
    if (r.hidden) return `[${mark}] ${r.name}`;
    let block = `[${mark}] ${r.name}\n      your output: ${r.got || "(nothing)"}\n      expected:    ${r.expected}`;
    if (r.stderr) block += `\n      error: ${r.stderr}`;
    return block;
  });

  verdict.textContent =
    `${res.passed} of ${res.total} tests passed${res.all_passed ? "  ✓" : ""}\n\n${lines.join("\n")}`;

  if (mode === "submit") {
    stateEl.dataset.ok = res.all_passed ? "1" : "0";
    stateEl.textContent = `submitted · ${res.passed}/${res.total}`;
  }
}

/* ══════════════ CAMERA ══════════════ */
async function beginProctoring() {
  const camState = document.getElementById("camState");
  try {
    await startProctoring(document.getElementById("cam"), (s) => {
      camState.textContent =
        s === "OK" ? "face in frame"
        : s === "NO_FACE_DETECTED" ? "no face"
        : "more than one face";
      camState.dataset.state = s === "OK" ? "ok" : "bad";
    });
    camState.textContent = "face in frame";
  } catch {
    camState.textContent = "camera blocked";
    camState.dataset.state = "bad";
    logIncident("NO_FACE_DETECTED", "camera unavailable or permission denied");
  }
}

function requestFullscreenQuietly() {
  if (devBypassActive()) return;
  document.documentElement.requestFullscreen?.().catch(() => {});
}

/* ══════════════ TIMER ══════════════ */
function startTimer() {
  const endsAt = Math.min(
    new Date(exam.ends_at).getTime(),
    new Date(attempt.started_at).getTime() + exam.duration_min * 60000,
  );
  const el = document.getElementById("timer");

  const tick = () => {
    const left = endsAt - Date.now();
    if (left <= 0) { el.textContent = "00:00"; finish(true); return; }
    const m = Math.floor(left / 60000);
    const s = Math.floor((left % 60000) / 1000);
    el.textContent = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
    el.className = "timer" + (left < 60000 ? " critical" : left < 300000 ? " warning" : "");
    setTimeout(tick, 1000);
  };
  tick();
}

/* ══════════════ SUBMIT ══════════════ */
async function finish(auto) {
  if (finished) return;
  if (!auto && !confirm("Submit the paper? Answers cannot be changed after this.")) return;
  finished = true;

  // let any pending autosave land first
  await new Promise((r) => setTimeout(r, 700));
  const { data: score, error } = await supabase.rpc("grade_attempt", { p_attempt_id: attempt.id });
  stopProctoring();

  document.body.innerHTML = `
    <div class="gate">
      <div class="gate-inner">
        <img src="assets/logo-mark.svg" alt="">
        <h1>Paper submitted</h1>
        <p>${auto ? "Time is up. Your answers were submitted automatically." : "Your answers are recorded."}</p>
        ${error ? `<p class="meta">Marking will be completed by your department.</p>`
                : `<p class="meta">Objective and coding marks: <b>${score}</b>. Long answers are marked by your teacher.</p>`}
        <p class="meta" style="margin-top:1.5rem;color:var(--ink-3)">
          Wait for the invigilator to unlock the machine.</p>
      </div>
    </div>`;
}
