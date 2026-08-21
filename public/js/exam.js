// public/js/exam.js
import {
  supabase, callFunction, callPublicFunction, requireUser, signOut, escapeHtml,
} from "./supabaseClient.js";
import {
  enforceSEBOrBlock, activateWebLockdown, activateFocusMonitor,
  setIncidentContext, logIncident, devBypassActive,
} from "./anticheat.js";
import { startProctoring, stopProctoring } from "./proctor.js";
import {
  AUTOSAVE_DELAY_MS, HEARTBEAT_MS, PROCTOR_ENABLED, SUPPORT_NOTE,
  LOCK_ON_FACE_LOSS, FACE_LOCK_MS,
} from "./config.js";

let user, profile, exam, attempt;
let questions = [];
const editors = {};      // question_id → CodeMirror
const saveTimers = {};   // question_id → debounce handle
const answered = {};     // question_id → true once something is stored
let endsAt = 0;
let finished = false;

boot();

async function boot() {
  // 1. Prove we are inside the approved Safe Exam Browser configuration.
  if (!(await enforceSEBOrBlock())) return;
  activateWebLockdown();

  // 2. A launch started in the normal browser arrives with a one-time token.
  //    Spend it for a sign-in inside SEB, so the student types no password in
  //    the locked browser, and remember which paper they chose.
  let autoExamCode = "";
  const launchToken = new URLSearchParams(location.search).get("launch");
  if (launchToken) {
    const exchanged = await callPublicFunction("exchange-seb-launch", {
      launch_token: launchToken,
    });
    if (exchanged.error) return launchFailed(exchanged.error);

    const { error } = await supabase.auth.verifyOtp({
      token_hash: exchanged.token_hash,
      type: "magiclink",
    });
    if (error) return launchFailed(`Could not sign you in inside SEB: ${error.message}`);

    autoExamCode = exchanged.exam_code ?? "";
    // Take the spent token out of the address bar immediately.
    history.replaceState({}, "", location.pathname);
  }

  const auth = await requireUser("student");
  if (!auth) return;
  ({ user, profile } = auth);

  document.getElementById("whoami").textContent =
    `${profile.full_name || user.email}${profile.roll_no ? " · " + profile.roll_no : ""}`;
  document.getElementById("signOutLink").onclick = (e) => { e.preventDefault(); signOut(); };
  document.getElementById("joinBtn").onclick = lookUpExam;
  document.getElementById("examCode").addEventListener("keydown", (e) => {
    if (e.key === "Enter") lookUpExam();
  });

  // 3. Launched from the portal: open exactly that paper, no code to type.
  if (autoExamCode) {
    document.getElementById("examCode").value = autoExamCode;
    await lookUpExam();
  }
}

function launchFailed(detail) {
  document.body.className = "hall";
  document.body.innerHTML = `
    <div class="gate"><div class="gate-inner">
      <img src="assets/logo-mark.svg" alt="">
      <h1>That secure launch has expired</h1>
      <p>${escapeHtml(detail)}</p>
      <p class="meta" style="margin-top:1.4rem;color:var(--ink-3)">
        Launch links last two minutes and work once, on purpose. Close Safe Exam
        Browser, return to the student portal, and press Start secure exam again.</p>
    </div></div>`;
}

const say = (text) => {
  const el = document.getElementById("joinMsg");
  el.textContent = text;
  el.classList.remove("hidden");
};

/* ══════════════ 1. FIND THE PAPER ══════════════ */
async function lookUpExam() {
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
  if (existing) { attempt = existing; return openPaper(true); }

  showRules();
}

/* ══════════════ 2. THE RULES ══════════════ */
function showRules() {
  document.getElementById("joinScreen").classList.add("hidden");
  const screen = document.getElementById("rulesScreen");
  screen.classList.remove("hidden");

  document.getElementById("rulesTitle").textContent = exam.title;
  document.getElementById("rulesList").innerHTML = [
    `You have <b>${exam.duration_min} minutes</b> once you start. The timer does not pause.`,
    "Your answers save by themselves. If the machine restarts, sign in again and carry on.",
    "Copying, pasting and right-click are switched off for the whole paper.",
    "Leaving full screen, hiding the window, or stepping away from the camera is recorded.",
    "Coding answers earn marks only when every test passes, including hidden ones.",
  ].map((t) => `<li>${t}</li>`).join("");
  document.getElementById("rulesCustom").textContent = exam.instructions ?? "";
  document.getElementById("rulesMeta").textContent = SUPPORT_NOTE;

  const agree = document.getElementById("agree");
  const start = document.getElementById("startBtn");
  agree.onchange = () => { start.disabled = !agree.checked; };
  start.onclick = startAttempt;
}

async function startAttempt() {
  const start = document.getElementById("startBtn");
  start.disabled = true;
  start.textContent = "Opening the paper…";

  const { data: created, error } = await supabase.from("attempts")
    .insert({ exam_id: exam.id, student_id: user.id }).select().single();

  if (error) {
    start.disabled = false;
    start.textContent = "Start the paper";
    document.getElementById("rulesCustom").textContent = error.message;
    return;
  }
  attempt = created;
  openPaper(false);
}

/* ══════════════ 3. OPEN THE PAPER ══════════════ */
async function openPaper(resuming) {
  setIncidentContext({ attemptId: attempt.id, examId: exam.id, studentId: user.id });
  activateFocusMonitor();

  // The sanitized view: no answer keys, no hidden tests.
  const { data: qs, error } = await supabase
    .from("student_questions").select("*").eq("exam_id", exam.id).order("position");
  if (error) return say(error.message);
  if (!qs?.length) return say("This paper has no questions yet. Tell the invigilator.");

  questions = exam.shuffle_questions ? shuffle(qs, `${exam.id}:${user.id}:q`) : qs;

  const saved = await loadSavedAnswers();

  document.getElementById("joinScreen").classList.add("hidden");
  document.getElementById("rulesScreen").classList.add("hidden");
  document.getElementById("examScreen").classList.remove("hidden");
  document.getElementById("paperTitle").textContent = exam.title;
  document.getElementById("paperCode").textContent = exam.exam_code;
  document.getElementById("finishBtn").onclick = () => finish(false);

  renderPaper(saved);
  recomputeEndsAt();
  startTimer();
  startHeartbeat();
  if (!devBypassActive()) document.documentElement.requestFullscreen?.().catch(() => {});
  if (PROCTOR_ENABLED) beginProctoring();

  if (resuming) {
    const bar = document.querySelector(".hall-bar");
    const note = document.createElement("span");
    note.className = "tag warn";
    note.textContent = "resumed";
    bar.insertBefore(note, bar.querySelector(".spacer"));
  }
}

async function loadSavedAnswers() {
  const { data } = await supabase.from("answers")
    .select("question_id, answer_text, code_submitted").eq("attempt_id", attempt.id);
  const map = {};
  (data ?? []).forEach((a) => {
    map[a.question_id] = a;
    if (a.answer_text || a.code_submitted) answered[a.question_id] = true;
  });
  return map;
}

/* Deterministic shuffle: the same student always sees the same order, so a
   reload never rearranges the paper, but neighbours differ. */
function shuffle(list, seedText) {
  let h = 2166136261;
  for (const ch of seedText) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  const rand = () => {
    h ^= h << 13; h ^= h >>> 17; h ^= h << 5;
    return ((h >>> 0) % 100000) / 100000;
  };
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/* ══════════════ 4. RENDER ══════════════ */
const LABEL = { mcq: "Multiple choice", cloze: "Fill the blanks", long: "Long answer", coding: "Coding" };
const TAGCLASS = { mcq: "blue", cloze: "warn", long: "", coding: "pass" };

function renderPaper(saved) {
  const area = document.getElementById("questionArea");
  const strip = document.getElementById("progress");
  area.innerHTML = "";
  strip.innerHTML = "";

  questions.forEach((q, i) => {
    const pip = document.createElement("button");
    pip.className = "pip" + (answered[q.id] ? " done" : "");
    pip.id = `pip-${q.id}`;
    pip.title = `Question ${i + 1}`;
    pip.onclick = () => document.getElementById(`card-${q.id}`)
      .scrollIntoView({ behavior: "smooth", block: "start" });
    strip.appendChild(pip);

    const card = document.createElement("article");
    card.className = "qcard rise";
    card.id = `card-${q.id}`;
    card.style.animationDelay = `${Math.min(i, 6) * 40}ms`;
    card.innerHTML = `
      <header>
        <span class="qno">Q${i + 1}</span>
        <span class="tag ${TAGCLASS[q.qtype]}">${LABEL[q.qtype]}</span>
        <span class="tag">${q.marks} ${Number(q.marks) === 1 ? "mark" : "marks"}</span>
        <span class="save-state" data-ok="0"></span>
      </header>
      <p class="prompt"></p>
      <div class="body"></div>`;
    card.querySelector(".prompt").textContent = q.prompt;
    area.appendChild(card);

    const body = card.querySelector(".body");
    const state = card.querySelector(".save-state");
    const prior = saved[q.id];

    if (q.qtype === "mcq")    buildMcq(q, body, state, prior);
    if (q.qtype === "cloze")  buildCloze(q, body, state, prior);
    if (q.qtype === "long")   buildLong(q, body, state, prior);
    if (q.qtype === "coding") buildCoding(q, body, state, prior);
  });
}

function buildMcq(q, body, state, prior) {
  let options = Array.isArray(q.options) ? q.options : Object.values(q.options ?? {});
  if (exam.shuffle_options) options = shuffle(options, `${q.id}:${user.id}:o`);

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
  const wrap = document.createElement("div");
  wrap.className = "blanks";
  let prev = [];
  try { prev = JSON.parse(prior?.answer_text ?? "[]"); } catch { prev = []; }

  for (let b = 0; b < (q.blank_count ?? 1); b++) {
    const input = document.createElement("input");
    input.placeholder = `Blank ${b + 1}`;
    input.value = prev[b] ?? "";
    input.autocomplete = "off";
    input.oninput = () => saveAnswer(
      q.id, JSON.stringify([...wrap.querySelectorAll("input")].map((i) => i.value)), state);
    wrap.appendChild(input);
  }
  body.appendChild(wrap);
}

function buildLong(q, body, state, prior) {
  const ta = document.createElement("textarea");
  ta.rows = 8;
  ta.placeholder = "Write your answer here.";
  ta.value = prior?.answer_text ?? "";
  const count = document.createElement("span");
  count.className = "wordcount";
  const update = () => {
    const words = ta.value.trim() ? ta.value.trim().split(/\s+/).length : 0;
    count.textContent = `${words} ${words === 1 ? "word" : "words"}`;
  };
  ta.oninput = () => { update(); saveAnswer(q.id, ta.value, state); };
  update();
  body.append(ta, count);
}

function buildCoding(q, body, state, prior) {
  const wrap = document.createElement("div");
  wrap.className = "editor-wrap";
  const ta = document.createElement("textarea");
  wrap.appendChild(ta);

  const actions = document.createElement("div");
  actions.className = "code-actions";
  const runBtn = Object.assign(document.createElement("button"),
    { className: "btn ghost small", textContent: "Run visible tests" });
  const submitBtn = Object.assign(document.createElement("button"),
    { className: "btn pass small", textContent: "Submit for marks" });
  const resetBtn = Object.assign(document.createElement("button"),
    { className: "btn ghost small", textContent: "Reset code" });
  const hint = Object.assign(document.createElement("span"),
    { className: "meta", textContent: "every test must pass" });
  hint.style.color = "var(--ink-3)";
  actions.append(runBtn, submitBtn, resetBtn, hint);

  const verdict = document.createElement("div");
  verdict.className = "verdict hidden";

  body.append(wrap, actions, verdict);

  const cm = CodeMirror.fromTextArea(ta, {
    mode: cmMode(q.language),
    theme: "material-darker",
    lineNumbers: true,
    indentUnit: 4,
    matchBrackets: true,
  });
  cm.setValue(prior?.code_submitted ?? q.starter_code ?? "");
  cm.setSize("100%", "320px");
  editors[q.id] = cm;

  // Keep the code itself saved even if the student never presses Submit.
  cm.on("change", () => saveCode(q.id, cm.getValue(), state));

  runBtn.onclick = () => runCode(q.id, "run", verdict, [runBtn, submitBtn], state);
  submitBtn.onclick = () => runCode(q.id, "submit", verdict, [runBtn, submitBtn], state);
  resetBtn.onclick = () => {
    if (confirm("Put the starter code back? Your current code will be lost.")) {
      cm.setValue(q.starter_code ?? "");
    }
  };
}

const cmMode = (lang) => ({
  python: "python", javascript: "javascript",
  c: "text/x-csrc", cpp: "text/x-c++src", java: "text/x-java",
}[lang] ?? "python");

/* ══════════════ 5. SAVING ══════════════ */
function markDone(question_id) {
  answered[question_id] = true;
  document.getElementById(`pip-${question_id}`)?.classList.add("done");
}

function saveAnswer(question_id, answer_text, stateEl) {
  queueSave(question_id, stateEl, { answer_text });
}
function saveCode(question_id, code, stateEl) {
  queueSave(question_id, stateEl, { code_submitted: code });
}

function queueSave(question_id, stateEl, fields) {
  clearTimeout(saveTimers[question_id]);
  stateEl.dataset.ok = "0";
  stateEl.textContent = "saving…";

  saveTimers[question_id] = setTimeout(async () => {
    const { error } = await supabase.from("answers").upsert({
      attempt_id: attempt.id, question_id, ...fields,
      updated_at: new Date().toISOString(),
    }, { onConflict: "attempt_id,question_id" });

    if (error) {
      stateEl.dataset.ok = "0";
      stateEl.textContent = "not saved — retrying";
      setTimeout(() => queueSave(question_id, stateEl, fields), 2500);
      return;
    }
    stateEl.dataset.ok = "1";
    stateEl.textContent = "saved";
    markDone(question_id);
  }, AUTOSAVE_DELAY_MS);
}

/* ══════════════ 6. CODE EXECUTION ══════════════ */
async function runCode(question_id, mode, verdict, buttons, stateEl) {
  buttons.forEach((b) => (b.disabled = true));
  verdict.classList.remove("hidden");
  verdict.textContent = mode === "run"
    ? "Running the visible tests…"
    : "Running every test on the server…";

  const res = await callFunction("run-code", {
    attempt_id: attempt.id, question_id,
    code: editors[question_id].getValue(), mode,
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
    markDone(question_id);
  }
}

/* ══════════════ 7. CAMERA ══════════════
   The paper is covered while nobody is in front of it, or while two people
   are. The clock keeps running — the cover is not a pause button, and the
   student is told so plainly. Everything is already saved. */
let lockTimer = null;

async function beginProctoring() {
  const camState = document.getElementById("camState");
  buildProctorLock();

  try {
    await startProctoring(document.getElementById("cam"), onFaceState);
    camState.textContent = "face in frame";
    camState.dataset.state = "ok";
  } catch {
    camState.textContent = "camera blocked";
    camState.dataset.state = "bad";
    logIncident("NO_FACE_DETECTED", "camera unavailable or permission denied");
  }
}

function onFaceState(state) {
  const camState = document.getElementById("camState");
  camState.textContent =
    state === "OK" ? "face in frame"
    : state === "NO_FACE_DETECTED" ? "no face" : "more than one face";
  camState.dataset.state = state === "OK" ? "ok" : "bad";

  if (!LOCK_ON_FACE_LOSS || finished) return;

  clearTimeout(lockTimer);
  if (state === "OK") {
    showProctorLock(false);
  } else {
    lockTimer = setTimeout(() => showProctorLock(true, state), FACE_LOCK_MS);
  }
}

function buildProctorLock() {
  if (document.getElementById("proctorLock")) return;
  const el = document.createElement("div");
  el.id = "proctorLock";
  el.className = "proctor-lock hidden";
  el.innerHTML = `
    <div class="proctor-lock-card">
      <img src="assets/logo-mark.svg" alt="">
      <h2 id="lockTitle">Paper covered</h2>
      <p id="lockWhy"></p>
      <p class="meta" style="margin-top:.8rem">Your answers are saved. The clock is still running.</p>
      <span class="proctor-lock-state" id="lockState"></span>
    </div>`;
  document.body.appendChild(el);
}

function showProctorLock(on, state) {
  const el = document.getElementById("proctorLock");
  if (!el) return;
  el.classList.toggle("hidden", !on);
  if (!on) return;

  const alone = state === "NO_FACE_DETECTED";
  document.getElementById("lockTitle").textContent =
    alone ? "Come back to your seat" : "Only you may sit this paper";
  document.getElementById("lockWhy").textContent = alone
    ? "The camera cannot see you. The paper reappears as soon as you are back in front of it."
    : "The camera can see more than one person. The paper reappears when only you are in frame.";
  document.getElementById("lockState").textContent = state.replace(/_/g, " ").toLowerCase();
}

/* ══════════════ 8. TIME ══════════════ */
function recomputeEndsAt() {
  const personal = new Date(attempt.started_at).getTime() +
    (exam.duration_min + (attempt.extra_minutes ?? 0)) * 60000;
  endsAt = Math.min(new Date(exam.ends_at).getTime(), personal);
}

function startTimer() {
  const el = document.getElementById("timer");
  const tick = () => {
    if (finished) return;
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

/* Picks up extra time granted by faculty, and notices a forced submit. */
function startHeartbeat() {
  setInterval(async () => {
    if (finished) return;
    const { data } = await supabase.from("attempts")
      .select("extra_minutes, status").eq("id", attempt.id).single();
    if (!data) return;
    if (data.status === "submitted") { finished = true; showReceipt(true, null); return; }
    if (data.extra_minutes !== attempt.extra_minutes) {
      attempt.extra_minutes = data.extra_minutes;
      recomputeEndsAt();
    }
  }, HEARTBEAT_MS);
}

/* ══════════════ 9. SUBMIT ══════════════ */
async function finish(auto) {
  if (finished) return;
  if (!auto) {
    const left = questions.filter((q) => !answered[q.id]).length;
    const warning = left
      ? `${left} question${left === 1 ? " is" : "s are"} still blank.\n\n`
      : "";
    if (!confirm(`${warning}Submit the paper? Answers cannot be changed after this.`)) return;
  }
  finished = true;
  clearTimeout(lockTimer);
  showProctorLock(false);

  await new Promise((r) => setTimeout(r, AUTOSAVE_DELAY_MS + 400));   // let saves land
  const { data: score, error } = await supabase.rpc("grade_attempt", { p_attempt_id: attempt.id });
  stopProctoring();
  showReceipt(auto, error ? null : score);
}

function showReceipt(auto, score) {
  document.body.innerHTML = `
    <div class="gate">
      <div class="gate-inner">
        <img src="assets/logo-mark.svg" alt="">
        <h1>Paper submitted</h1>
        <p>${auto ? "Time is up. Your answers were submitted automatically."
                  : "Your answers are recorded."}</p>
        ${score === null || score === undefined
          ? `<p class="meta">Marking will be completed by your department.</p>`
          : `<p class="meta">Objective and coding marks: <b>${score}</b>. Long answers are marked by your teacher.</p>`}
        <p class="meta" style="margin-top:1.5rem;color:var(--ink-3)">
          Wait for the invigilator to unlock the machine.</p>
      </div>
    </div>`;
}
