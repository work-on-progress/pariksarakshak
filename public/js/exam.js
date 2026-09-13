// public/js/exam.js
//
// The paper. It opens in one of two ways:
//   * a six-digit code typed here, which is the normal route
//   * a ?launch= token, kept working for the older sebs:// link
//
// Either way the code is spent for a session, and only then does the page
// learn how the paper must be delivered — Safe Exam Browser, or an ordinary
// browser with the rules a web page can enforce.
import {
  supabase, callFunction, callPublicFunction, escapeHtml,
} from "./supabaseClient.js";
import {
  checkDelivery, activateWebLockdown, activateFocusMonitor, requestFullscreen,
  watchFullscreen, setIncidentContext, logIncident, renderBlocked, attentionCount,
} from "./anticheat.js";
import { startProctoring, stopProctoring } from "./proctor.js";
import {
  AUTOSAVE_DELAY_MS, HEARTBEAT_MS, PROCTOR_ENABLED, SUPPORT_NOTE,
  LOCK_ON_FACE_LOSS, FACE_LOCK_MS, BROWSER_MODE,
} from "./config.js";

let user, profile, exam, attempt;
let questions = [];
let deliveryMode = "seb";        // what the paper demands
let runningMode = "seb";         // what we actually got
let sessionToken = null;
let warnAfter = 3;

const editors = {};              // question_id → CodeMirror
const saveTimers = {};           // question_id → debounce handle
const answered = {};             // question_id → true once something is stored

let endsAt = 0;
let finished = false;
let lockTimer = null;

// AUTO_CODING_FINALIZATION_V1
const CODING_AUTOSAVE_DELAY_MS = 150;
const FINAL_CODE_TIMEOUT_MS = 35000;
let submissionInProgress = false;

// GLOBAL_SAVE_STATUS_V1
// Shows students whether every change has actually reached the database.
const pendingSaveQuestions = new Set();
const failedSaveQuestions = new Set();
let globalSaveIndicator = null;

boot();

/* ══════════════════════════════════════════════════════════════════════
   BOOT
   ══════════════════════════════════════════════════════════════════════ */
async function boot() {
  const params = new URLSearchParams(location.search);
  const launchToken = params.get("launch");

  document.getElementById("codeHint").textContent = SUPPORT_NOTE;
  document.getElementById("enterBtn").onclick = () => openWith({ entry_code: codeValue() });
  document.getElementById("entryCode").addEventListener("keydown", (e) => {
    if (e.key === "Enter") openWith({ entry_code: codeValue() });
  });
  document.getElementById("entryCode").addEventListener("input", (e) => {
    e.target.value = e.target.value.replace(/\D/g, "").slice(0, 6);
  });

  // The old sebs:// route still works: it carries a token instead of a code.
  if (launchToken) {
    history.replaceState({}, "", location.pathname);
    await openWith({ launch_token: launchToken });
    return;
  }

  document.getElementById("entryCode").focus();
}

const codeValue = () => document.getElementById("entryCode").value.trim();

function codeError(text) {
  const el = document.getElementById("codeMsg");
  el.textContent = text;
  el.classList.remove("hidden");
  const btn = document.getElementById("enterBtn");
  btn.disabled = false;
  btn.textContent = "Open my paper";
}

/* ══════════════════════════════════════════════════════════════════════
   1 · SPEND THE CODE, LEARN THE MODE, CHECK WE MAY OPEN HERE
   ══════════════════════════════════════════════════════════════════════ */
async function openWith(payload) {
  if (payload.entry_code && !/^\d{6}$/.test(payload.entry_code)) {
    return codeError("The code is exactly six digits.");
  }

  const btn = document.getElementById("enterBtn");
  btn.disabled = true;
  btn.textContent = "Opening…";
  document.getElementById("codeMsg").classList.add("hidden");

  const res = await callPublicFunction("exchange-seb-launch", payload);
  if (res.error) return codeError(res.error);

  // Sign in on this machine using the one-time token the server just issued.
  const { error: authError } = await supabase.auth.verifyOtp({
    token_hash: res.token_hash,
    type: "magiclink",
  });
  if (authError) return codeError(`Could not sign you in: ${authError.message}`);

  sessionToken = res.session_token ?? null;
  deliveryMode = res.delivery_mode ?? "seb";
  warnAfter = res.browser_warn_after ?? 3;

  // Only now do we know which rules this paper is under.
  const verdict = await checkDelivery(deliveryMode);
  if (!verdict.ok) return renderBlocked(verdict.reason);
  runningMode = verdict.mode;

  const { data: { user: u } } = await supabase.auth.getUser();
  if (!u) return codeError("Sign-in did not complete. Try the code again.");
  user = u;

  const { data: p } = await supabase.from("profiles").select("*").eq("id", user.id).single();
  profile = p ?? {};

  await loadExam(res.exam_code);
}

async function loadExam(examCode) {
  const { data: rows, error } = await supabase.from("exams").select("*").eq("exam_code", examCode);
  if (error) return codeError(error.message);
  if (!rows?.length) return codeError("That paper is not open right now.");
  exam = rows[0];

  const { data: existing } = await supabase.from("attempts")
    .select("*").eq("exam_id", exam.id).eq("student_id", user.id).maybeSingle();

  if (existing?.status === "submitted") {
    return codeError("You have already submitted this paper. It cannot be reopened.");
  }
  if (existing) { attempt = existing; return openPaper(true); }

  showRules();
}

/* ══════════════════════════════════════════════════════════════════════
   2 · THE RULES — different wording per mode, because the rules differ
   ══════════════════════════════════════════════════════════════════════ */
function showRules() {
  document.getElementById("codeScreen").classList.add("hidden");
  document.getElementById("rulesScreen").classList.remove("hidden");
  document.getElementById("rulesTitle").textContent = exam.title;

  const common = [
    `You have <b>${exam.duration_min} minutes</b> once you start. The timer does not pause.`,
    "Your answers save by themselves. If the machine restarts, sign in again and carry on.",
    "Copying, pasting and right-click are switched off for the whole paper.",
  ];

  const perMode = runningMode === "seb"
    ? [
        "The machine is locked. Screenshots, other windows and other applications are unavailable until you finish.",
        "Stepping away from the camera is recorded.",
      ]
    : [
        "The paper runs full screen. <b>Leaving full screen, switching tabs or switching windows is recorded</b>, and you will see the count in the corner as it rises.",
        "Opening this paper anywhere else closes it here.",
        "Your invigilator can see every switch on their screen as it happens.",
      ];

  const coding = questionsLikelyHaveCode()
    ? ["Coding answers earn marks only when every test passes, including the hidden ones."]
    : [];

  document.getElementById("rulesList").innerHTML =
    [...common, ...perMode, ...coding].map((t) => `<li>${t}</li>`).join("");
  document.getElementById("rulesCustom").textContent = exam.instructions ?? "";
  document.getElementById("rulesMeta").textContent = SUPPORT_NOTE;

  const agree = document.getElementById("agree");
  const start = document.getElementById("startBtn");
  agree.onchange = () => { start.disabled = !agree.checked; };
  start.onclick = startAttempt;
}

const questionsLikelyHaveCode = () => true;   // cheap; the rules line is harmless

async function startAttempt() {
  const start = document.getElementById("startBtn");
  start.disabled = true;
  start.textContent = "Opening the paper…";

  // Fullscreen must be asked for inside the click, or the browser refuses.
  if (runningMode === "browser" && BROWSER_MODE.requireFullscreen) {
    await requestFullscreen();
  }

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

/* ══════════════════════════════════════════════════════════════════════
   3 · OPEN THE PAPER
   ══════════════════════════════════════════════════════════════════════ */
async function openPaper(resuming) {
  setIncidentContext({ attemptId: attempt.id, examId: exam.id, studentId: user.id });

  activateWebLockdown({
    blockCopyPaste: runningMode === "seb" ? true : BROWSER_MODE.blockCopyPaste,
    blockPrint: runningMode === "seb" ? true : BROWSER_MODE.blockPrint,
  });

  activateFocusMonitor({
    warnAfter,
    autoSubmitAfter: runningMode === "browser" ? (BROWSER_MODE.autoSubmitAfterSwitches || 0) : 0,
    onSwitch: showAttention,
    onAutoSubmit: (n) => {
      const el = document.getElementById("attention");
      if (el) {
        el.classList.remove("hidden");
        el.className = "attention hot";
        el.textContent = `${n} switches away · limit reached · submitting`;
      }
      finish(true);
    },
  });

  if (runningMode === "browser" && BROWSER_MODE.blockOnFullscreenExit) {
    watchFullscreen(() => showFullscreenCover(true), () => showFullscreenCover(false));
  }

  const { data: qs, error } = await supabase
    .from("student_questions").select("*").eq("exam_id", exam.id).order("position");
  if (error) return codeError(error.message);
  if (!qs?.length) return codeError("This paper has no questions yet. Tell the invigilator.");

  questions = exam.shuffle_questions ? shuffle(qs, `${exam.id}:${user.id}:q`) : qs;
  const saved = await loadSavedAnswers();

  document.getElementById("codeScreen").classList.add("hidden");
  document.getElementById("rulesScreen").classList.add("hidden");
  document.getElementById("examScreen").classList.remove("hidden");
  document.getElementById("paperTitle").textContent = exam.title;
  document.getElementById("paperCode").textContent = exam.exam_code;

  const modeTag = document.getElementById("modeTag");
  modeTag.textContent = runningMode === "seb" ? "locked browser" : "browser";
  modeTag.className = runningMode === "seb" ? "tag pass" : "tag warn";

  document.getElementById("finishBtn").onclick = () => finish(false);

  installGlobalSaveIndicator();
  renderPaper(saved);
  updateGlobalSaveIndicator();
  recomputeEndsAt();
  startTimer();
  startHeartbeat();
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

/* ══════════════════════════════════════════════════════════════════════
   4 · RENDER
   ══════════════════════════════════════════════════════════════════════ */
const LABEL = { mcq: "Multiple choice", cloze: "Fill the blanks", long: "Long answer", coding: "Coding" };
const TAGCLASS = { mcq: "blue", cloze: "warn", long: "", coding: "pass" };
const KIND_LABEL = { output: "what does it print", error: "find the mistake", blank: "complete the code" };

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

    const kindTag = q.qtype === "mcq" && q.mcq_kind && q.mcq_kind !== "theory"
      ? `<span class="tag">${KIND_LABEL[q.mcq_kind] ?? q.mcq_kind}</span>` : "";

    card.innerHTML = `
      <header>
        <span class="qno">Q${i + 1}</span>
        <span class="tag ${TAGCLASS[q.qtype]}">${LABEL[q.qtype]}</span>
        ${kindTag}
        <span class="tag diff-${q.difficulty ?? "medium"}">${q.difficulty ?? "medium"}</span>
        <span class="tag">${q.marks} ${Number(q.marks) === 1 ? "mark" : "marks"}</span>
        <span class="save-state" data-ok="0"></span>
      </header>
      <p class="prompt"></p>
      ${q.code_snippet ? `<pre class="snippet"></pre>` : ""}
      <div class="body"></div>`;

    card.querySelector(".prompt").textContent = q.prompt;
    if (q.code_snippet) card.querySelector(".snippet").textContent = q.code_snippet;
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
  // Stable A/B/C/D keys are assigned from the ORIGINAL option position
  // before display-order shuffling. This fixes correct visible selections
  // being saved as the first letter of option text.
  let options = (
    Array.isArray(q.options)
      ? q.options
      : Object.values(q.options ?? {})
  ).map((text, index) => ({
    key: String.fromCharCode(65 + index),
    text: String(text ?? ""),
  }));

  if (exam.shuffle_options) {
    options = shuffle(options, `${q.id}:${user.id}:o`);
  }

  options.forEach(({ key, text }) => {
    const row = document.createElement("label");
    row.className = "choice";

    const input = document.createElement("input");
    input.type = "radio";
    input.name = `q-${q.id}`;
    input.value = key;

    if (String(prior?.answer_text ?? "").trim().toUpperCase() === key) {
      input.checked = true;
      row.classList.add("picked");
    }

    const span = document.createElement("span");
    span.textContent = text;

    row.append(input, span);

    input.onchange = () => {
      body.querySelectorAll(".choice").forEach((c) => c.classList.remove("picked"));
      row.classList.add("picked");
      queueSave(q.id, state, { answer_text: key });
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
    input.oninput = () => queueSave(q.id, state, {
      answer_text: JSON.stringify([...wrap.querySelectorAll("input")].map((i) => i.value)),
    });
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
  ta.oninput = () => { update(); queueSave(q.id, state, { answer_text: ta.value }); };
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

  cm.on("change", () =>
    queueSave(
      q.id,
      state,
      { code_submitted: cm.getValue() },
      0,
      CODING_AUTOSAVE_DELAY_MS,
    )
  );

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

/* ══════════════════════════════════════════════════════════════════════
   GLOBAL SAVE STATUS
   ══════════════════════════════════════════════════════════════════════ */

function installGlobalSaveIndicator() {
  if (document.getElementById("globalSaveStatus")) {
    globalSaveIndicator =
      document.getElementById("globalSaveStatus");
    return;
  }

  const bar = document.querySelector(".hall-bar");
  if (!bar) return;

  const el = document.createElement("span");
  el.id = "globalSaveStatus";
  el.setAttribute("role", "status");
  el.setAttribute("aria-live", "polite");
  el.style.cssText = `
    display:inline-flex;
    align-items:center;
    justify-content:center;
    min-height:28px;
    padding:.28rem .55rem;
    border-radius:6px;
    border:1px solid var(--rule);
    font-family:var(--mono);
    font-size:.62rem;
    letter-spacing:.04em;
    white-space:nowrap;
    color:var(--ink-3);
    background:var(--card-2);
  `;

  const spacer = bar.querySelector(".spacer");
  bar.insertBefore(el, spacer || null);

  globalSaveIndicator = el;

  if (!document.getElementById("globalSaveStatusStyle")) {
    const style = document.createElement("style");
    style.id = "globalSaveStatusStyle";
    style.textContent = `
      @media (max-width: 700px), (pointer: coarse) {
        #globalSaveStatus {
          max-width: 120px;
          overflow: hidden;
          text-overflow: ellipsis;
          font-size: .52rem !important;
          padding: .22rem .4rem !important;
        }
      }
    `;
    document.head.appendChild(style);
  }

  window.addEventListener("online", updateGlobalSaveIndicator);
  window.addEventListener("offline", updateGlobalSaveIndicator);
}

function setGlobalSaveState(text, kind = "idle") {
  if (!globalSaveIndicator) return;

  globalSaveIndicator.textContent = text;
  globalSaveIndicator.dataset.state = kind;

  const palette = {
    ok: {
      color: "var(--pass)",
      border: "var(--pass)",
      background: "var(--pass-wash)",
    },
    saving: {
      color: "var(--blue)",
      border: "var(--blue)",
      background: "var(--blue-wash)",
    },
    error: {
      color: "var(--seal)",
      border: "var(--seal)",
      background: "var(--seal-wash)",
    },
    offline: {
      color: "var(--warn)",
      border: "var(--warn)",
      background: "var(--card-2)",
    },
    idle: {
      color: "var(--ink-3)",
      border: "var(--rule)",
      background: "var(--card-2)",
    },
  };

  const p = palette[kind] ?? palette.idle;

  globalSaveIndicator.style.color = p.color;
  globalSaveIndicator.style.borderColor = p.border;
  globalSaveIndicator.style.background = p.background;
}

function updateGlobalSaveIndicator() {
  if (!globalSaveIndicator) return;

  if (!navigator.onLine) {
    setGlobalSaveState(
      "Offline · answers waiting",
      "offline",
    );
    return;
  }

  if (failedSaveQuestions.size) {
    setGlobalSaveState(
      `${failedSaveQuestions.size} answer${failedSaveQuestions.size === 1 ? "" : "s"} retrying`,
      "error",
    );
    return;
  }

  if (pendingSaveQuestions.size) {
    setGlobalSaveState(
      `Saving ${pendingSaveQuestions.size}…`,
      "saving",
    );
    return;
  }

  setGlobalSaveState("All changes saved ✓", "ok");
}

/* ══════════════════════════════════════════════════════════════════════
   5 · SAVING — and this time the real reason is shown
   ══════════════════════════════════════════════════════════════════════ */
function markDone(question_id) {
  answered[question_id] = true;
  document.getElementById(`pip-${question_id}`)?.classList.add("done");
}

function queueSave(
  question_id,
  stateEl,
  fields,
  attemptNo = 0,
  delayMs = AUTOSAVE_DELAY_MS,
) {
  clearTimeout(saveTimers[question_id]);
  stateEl.dataset.ok = "0";
  stateEl.textContent = "saving…";

  pendingSaveQuestions.add(question_id);
  failedSaveQuestions.delete(question_id);
  updateGlobalSaveIndicator();

  saveTimers[question_id] = setTimeout(async () => {
    const { error } = await supabase.from("answers").upsert({
      attempt_id: attempt.id, question_id, ...fields,
      updated_at: new Date().toISOString(),
    }, { onConflict: "attempt_id,question_id" });

    if (error) {
      // The old build printed "not saved — retrying" and threw the reason
      // away, which made a permissions problem look like a network problem.
      console.error("[save failed]", error);
      stateEl.dataset.ok = "0";
      stateEl.textContent = `not saved (${error.code ?? "error"})`;

      pendingSaveQuestions.delete(question_id);
      failedSaveQuestions.add(question_id);
      updateGlobalSaveIndicator();

      showSaveBanner(error, attemptNo);
      setTimeout(
        () => queueSave(question_id, stateEl, fields, attemptNo + 1, delayMs),
        2500,
      );
      return;
    }

    stateEl.dataset.ok = "1";
    stateEl.textContent = "saved";

    pendingSaveQuestions.delete(question_id);
    failedSaveQuestions.delete(question_id);
    updateGlobalSaveIndicator();

    markDone(question_id);
    hideSaveBanner();
  }, delayMs);
}

function showSaveBanner(error, attemptNo) {
  const el = document.getElementById("saveBanner");
  const permission = ["42501", "PGRST301", "PGRST116"].includes(error.code) ||
    /permission|policy|denied/i.test(error.message ?? "");

  el.innerHTML = permission
    ? `<b>Answers are not saving.</b> The database refused the write
       (<code>${escapeHtml(error.code ?? "")} ${escapeHtml(error.message ?? "")}</code>).
       This is a permissions problem, not the network — tell your invigilator to run
       migration 005. Keep working; every answer is retried automatically.`
    : `<b>Answers are not saving.</b>
       <code>${escapeHtml(error.code ?? "")} ${escapeHtml(error.message ?? "")}</code>.
       Retrying${attemptNo > 2 ? ` (attempt ${attemptNo + 1})` : ""}. Tell your invigilator
       if this does not clear.`;
  el.classList.remove("hidden");
}

function hideSaveBanner() {
  const el = document.getElementById("saveBanner");
  const stillFailing = [...document.querySelectorAll(".save-state")]
    .some((s) => s.textContent.startsWith("not saved"));
  if (!stillFailing) el.classList.add("hidden");
}

/* ══════════════════════════════════════════════════════════════════════
   6 · CODE EXECUTION
   ══════════════════════════════════════════════════════════════════════ */
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

  if (res.error) {
    verdict.textContent = res.service_down
      ? `${res.error}\n\nYour code is saved. Try again in a minute, or tell your invigilator.`
      : `Could not run: ${res.error}`;
    return;
  }

  const visible = res.results.filter((r) => !r.hidden);
  const hidden = res.results.filter((r) => r.hidden);

  verdict.innerHTML = "";

  const summary = document.createElement("div");
  summary.className = "test-summary";
  summary.textContent = `${res.passed} of ${res.total} tests passed${res.all_passed ? " ✓" : ""}`;
  verdict.appendChild(summary);

  if (visible.length) {
    const grid = document.createElement("div");
    grid.className = "test-results-grid";

    visible.forEach((r) => {
      const card = document.createElement("div");
      card.className = `test-result-card ${r.pass ? "pass" : "fail"}`;

      const head = document.createElement("div");
      head.className = "test-result-head";
      head.textContent = `${r.pass ? "PASS" : "FAIL"} · ${r.name}`;
      card.appendChild(head);

      const row = document.createElement("div");
      row.className = "test-compare";
      row.innerHTML = `
        <div><span>INPUT</span><pre></pre></div>
        <div><span>EXPECTED OUTPUT</span><pre></pre></div>
        <div><span>YOUR OUTPUT</span><pre></pre></div>`;
      const pres = row.querySelectorAll("pre");
      pres[0].textContent = r.input || "(no input)";
      pres[1].textContent = r.expected || "(nothing)";
      pres[2].textContent = r.got || "(nothing)";
      card.appendChild(row);

      if (r.stderr) {
        const err = document.createElement("pre");
        err.className = "test-error";
        err.textContent = `Error: ${r.stderr}`;
        card.appendChild(err);
      }
      grid.appendChild(card);
    });
    verdict.appendChild(grid);
  }

  if (hidden.length) {
    const hiddenLine = document.createElement("div");
    hiddenLine.className = "hidden-test-summary";
    hiddenLine.textContent = hidden.map((r) =>
      `${r.pass ? "PASS" : "FAIL"} · ${r.name}${r.note ? ` — ${r.note}` : ""}`
    ).join("  |  ");
    verdict.appendChild(hiddenLine);
  }

  if (mode === "submit") {
    stateEl.dataset.ok = res.all_passed ? "1" : "0";
    stateEl.textContent = `submitted · ${res.passed}/${res.total}`;
    markDone(question_id);
  }
}

/* ══════════════════════════════════════════════════════════════════════
   AUTO CODING FINALIZATION
   ══════════════════════════════════════════════════════════════════════ */

async function flushCodingDrafts() {
  const coding = questions.filter((q) => q.qtype === "coding");

  coding.forEach((q) => pendingSaveQuestions.add(q.id));
  updateGlobalSaveIndicator();

  return Promise.all(
    coding.map(async (q) => {
      const cm = editors[q.id];
      if (!cm) return { question_id: q.id, skipped: true };

      clearTimeout(saveTimers[q.id]);
      const code = cm.getValue();

      // Save even an intentionally blank editor. Otherwise a student who
      // deletes previously-written code just before Final Submit could have
      // the older non-blank database value evaluated by the server.
      const { error } = await supabase.from("answers").upsert(
        {
          attempt_id: attempt.id,
          question_id: q.id,
          code_submitted: code,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "attempt_id,question_id" },
      );

      if (error) {
        console.warn("[final code flush]", q.id, error);
        pendingSaveQuestions.delete(q.id);
        failedSaveQuestions.add(q.id);
        updateGlobalSaveIndicator();

        return {
          question_id: q.id,
          saved: false,
          error: error.message,
        };
      }

      pendingSaveQuestions.delete(q.id);
      failedSaveQuestions.delete(q.id);
      updateGlobalSaveIndicator();

      return {
        question_id: q.id,
        saved: true,
        blank: !code.trim(),
      };
    }),
  );
}

function withTimeout(promise, ms, label) {
  let timer;

  const timeout = new Promise((resolve) => {
    timer = setTimeout(
      () =>
        resolve({
          error: `${label} timed out.`,
          service_down: true,
          timeout: true,
        }),
      ms,
    );
  });

  return Promise.race([promise, timeout]).finally(() => {
    clearTimeout(timer);
  });
}

async function finalizeOneCodingQuestion(q) {
  const state =
    document.getElementById(`card-${q.id}`)
      ?.querySelector(".save-state");

  if (state) {
    state.dataset.ok = "0";
    state.textContent = "final coding check…";
  }

  let res = null;

  for (let n = 1; n <= 2; n++) {
    res = await withTimeout(
      callFunction("run-code", {
        attempt_id: attempt.id,
        question_id: q.id,
        mode: "finalize",
      }),
      FINAL_CODE_TIMEOUT_MS,
      `Coding question ${q.id}`,
    );

    if (!res?.error) break;

    console.warn(
      `[final coding] question=${q.id} try=${n}`,
      res.error,
    );

    if (n < 2) {
      await new Promise((r) => setTimeout(r, 500));
    }
  }

  if (res?.error) {
    if (state) {
      state.dataset.ok = "0";
      state.textContent = "final check unavailable";
    }

    return {
      question_id: q.id,
      ok: false,
      error: res.error,
    };
  }

  if (res.blank_code) {
    if (state) {
      state.dataset.ok = "0";
      state.textContent = `blank · 0/${res.total ?? 0}`;
    }

    return {
      question_id: q.id,
      ok: true,
      blank: true,
      passed: 0,
      total: Number(res.total ?? 0),
    };
  }

  if (state) {
    state.dataset.ok = res.all_passed ? "1" : "0";
    state.textContent =
      `submitted · ${res.passed ?? 0}/${res.total ?? 0}`;
  }

  markDone(q.id);

  return {
    question_id: q.id,
    ok: true,
    blank: false,
    passed: Number(res.passed ?? 0),
    total: Number(res.total ?? 0),
  };
}

async function submitAllCodingForMarks(onProgress = () => {}) {
  const coding = questions.filter((q) => q.qtype === "coding");

  if (!coding.length) {
    return {
      total: 0,
      evaluated: 0,
      blank: 0,
      failed: 0,
      results: [],
    };
  }

  let completed = 0;

  const results = await Promise.all(
    coding.map(async (q) => {
      const result = await finalizeOneCodingQuestion(q);
      completed++;
      onProgress(completed, coding.length);
      return result;
    }),
  );

  return {
    total: coding.length,
    evaluated: results.filter((r) => r.ok && !r.blank).length,
    blank: results.filter((r) => r.ok && r.blank).length,
    failed: results.filter((r) => !r.ok).length,
    results,
  };
}

function showSubmissionStatus(text) {
  const btn = document.getElementById("finishBtn");

  if (globalSaveIndicator) {
    setGlobalSaveState(text, "saving");
  }

  if (btn) {
    btn.disabled = true;
    btn.textContent = "Submitting…";
  }

  const banner = document.getElementById("saveBanner");

  if (banner) {
    banner.className = "notice";
    banner.innerHTML = `<b>Finalizing paper</b><br>${escapeHtml(text)}`;
    banner.classList.remove("hidden");
  }
}

/* ══════════════════════════════════════════════════════════════════════
   7 · CAMERA
   ══════════════════════════════════════════════════════════════════════ */
async function beginProctoring() {
  const camState = document.getElementById("camState");
  if (LOCK_ON_FACE_LOSS) buildCover();

  try {
    await startProctoring(document.getElementById("cam"), onFaceState);
    camState.textContent = "face in frame";
    camState.dataset.state = "ok";
  } catch {
    camState.textContent = "camera off";
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

  // The camera never takes the paper away unless you switch this on yourself.
  if (!LOCK_ON_FACE_LOSS || finished) return;
  clearTimeout(lockTimer);
  if (state === "OK") showCover(false);
  else lockTimer = setTimeout(() => showCover(true, state), FACE_LOCK_MS);
}

/* ══════════════════════════════════════════════════════════════════════
   8 · COVERS — fullscreen, camera, and the one-session lock
   ══════════════════════════════════════════════════════════════════════ */
function buildCover() {
  if (document.getElementById("cover")) return;
  const el = document.createElement("div");
  el.id = "cover";
  el.className = "proctor-lock hidden";
  el.innerHTML = `
    <div class="proctor-lock-card">
      <img src="assets/logo-mark.svg" alt="">
      <h2 id="coverTitle"></h2>
      <p id="coverWhy"></p>
      <p class="meta" style="margin-top:.8rem">Your answers are saved. The clock is still running.</p>
      <div id="coverAction" style="margin-top:1.2rem"></div>
    </div>`;
  document.body.appendChild(el);
}

function showCover(on, state) {
  buildCover();
  const el = document.getElementById("cover");
  el.classList.toggle("hidden", !on);
  if (!on) return;
  const alone = state === "NO_FACE_DETECTED";
  document.getElementById("coverTitle").textContent =
    alone ? "Come back to your seat" : "Only you may sit this paper";
  document.getElementById("coverWhy").textContent = alone
    ? "The camera cannot see you. The paper returns as soon as you are back in front of it."
    : "The camera can see more than one person. The paper returns when only you are in frame.";
  document.getElementById("coverAction").innerHTML = "";
}

function showFullscreenCover(on) {
  if (finished) return;
  buildCover();
  const el = document.getElementById("cover");
  el.classList.toggle("hidden", !on);
  if (!on) return;

  document.getElementById("coverTitle").textContent = "Return to full screen";
  document.getElementById("coverWhy").textContent =
    "This paper runs full screen. Leaving it has been recorded. Press the button to carry on.";
  const action = document.getElementById("coverAction");
  action.innerHTML = `<button class="btn" id="backToFs">Return to the paper</button>`;
  document.getElementById("backToFs").onclick = async () => {
    await requestFullscreen();
    showFullscreenCover(false);
  };
}

function lockOut(reason) {
  finished = true;
  stopProctoring();
  document.body.innerHTML = `
    <div class="gate"><div class="gate-inner">
      <img src="assets/logo-mark.svg" alt="">
      <h1>This paper was opened somewhere else</h1>
      <p>${escapeHtml(reason)}</p>
      <p class="meta" style="margin-top:1.4rem;color:var(--ink-3)">
        Everything you wrote here is saved. Continue on the machine where it is now
        open, or ask your invigilator to reopen it for you.</p>
    </div></div>`;
}

function showAttention(count, warnLimit) {
  if (runningMode !== "browser" || !BROWSER_MODE.warnOnTabSwitch) return;
  const el = document.getElementById("attention");
  el.classList.remove("hidden");
  el.textContent = `${count} switch${count === 1 ? "" : "es"} away · recorded`;
  el.className = count >= warnLimit ? "attention hot" : "attention";
}

/* ══════════════════════════════════════════════════════════════════════
   9 · TIME AND HEARTBEAT
   ══════════════════════════════════════════════════════════════════════ */
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

function startHeartbeat() {
  setInterval(async () => {
    if (finished) return;

    const { data } = await supabase.from("attempts")
      .select("extra_minutes, status").eq("id", attempt.id).single();
    if (data) {
      if (data.status === "submitted") { finished = true; showReceipt(true, null); return; }
      if (data.extra_minutes !== attempt.extra_minutes) {
        attempt.extra_minutes = data.extra_minutes;
        recomputeEndsAt();
      }
    }

    // One paper, one place. Opening it elsewhere revokes this session.
    if (sessionToken && BROWSER_MODE.singleSession) {
      const res = await callPublicFunction("session-check", { session_token: sessionToken });
      if (res.active === false && res.reason === "revoked") {
        lockOut("Your paper was opened on another machine or in another window, so this copy has been closed.");
      }
    }
  }, HEARTBEAT_MS);
}

/* ══════════════════════════════════════════════════════════════════════
   10 · SUBMIT
   ══════════════════════════════════════════════════════════════════════ */
async function finish(auto) {
  if (finished || submissionInProgress) return;

  if (!auto) {
    const left = questions.filter((q) => !answered[q.id]).length;
    const warning = left
      ? `${left} question${left === 1 ? " is" : "s are"} still blank.\n\n`
      : "";

    const codingCount =
      questions.filter((q) => q.qtype === "coding").length;

    const codingNote = codingCount
      ? `\n\nAll ${codingCount} coding question${codingCount === 1 ? "" : "s"} will be automatically submitted for marks using the latest saved code.`
      : "";

    if (
      !confirm(
        `${warning}Submit the paper? Answers cannot be changed after this.${codingNote}`,
      )
    ) {
      return;
    }
  }

  submissionInProgress = true;
  finished = true;

  clearTimeout(lockTimer);
  showCover(false);

  showSubmissionStatus("Saving the latest coding answers…");

  await flushCodingDrafts();

  await new Promise((r) =>
    setTimeout(r, AUTOSAVE_DELAY_MS + 450)
  );

  const codingCount =
    questions.filter((q) => q.qtype === "coding").length;

  let codingSummary = {
    total: 0,
    evaluated: 0,
    blank: 0,
    failed: 0,
    results: [],
  };

  if (codingCount) {
    showSubmissionStatus(
      `Evaluating coding questions 0/${codingCount}…`,
    );

    codingSummary = await submitAllCodingForMarks(
      (done, total) => {
        showSubmissionStatus(
          `Evaluating coding questions ${done}/${total}…`,
        );
      },
    );
  }

  showSubmissionStatus("Finalizing objective and coding marks…");

  const { data: score, error } =
    await supabase.rpc("grade_attempt", {
      p_attempt_id: attempt.id,
    });

  if (error) {
    console.error("[grade_attempt]", error);
  }

  stopProctoring();

  showReceipt(
    auto,
    error ? null : score,
    codingSummary,
  );
}

function showReceipt(auto, score, codingSummary = null) {
  const switches = attentionCount();
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
        ${codingSummary?.failed
          ? `<p class="notice warn" style="margin-top:.8rem">
               ${codingSummary.failed} coding question${codingSummary.failed === 1 ? "" : "s"}
               could not be automatically evaluated. The saved code is preserved for review.
             </p>`
          : ""}
        ${runningMode === "browser" && switches
          ? `<p class="meta" style="margin-top:.6rem;color:var(--ink-3)">${switches} switch${switches === 1 ? "" : "es"} away were recorded.</p>`
          : ""}
        <p class="meta" style="margin-top:1.5rem;color:var(--ink-3)">
          ${runningMode === "seb"
            ? "Wait for the invigilator to unlock the machine."
            : "You may close this window."}</p>
      </div>
    </div>`;
}
