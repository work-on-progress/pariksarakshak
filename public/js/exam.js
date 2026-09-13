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
const saveFailureSeen = new Set();
let globalSaveIndicator = null;
let lastSuccessfulSaveAt = 0;
let saveAgeTimer = null;

// EXAM_EXPERIENCE_V2
let questionFocusObserver = null;

// EXAM_UX_V3
// Review marks are navigation-only state and do not affect grading.
const reviewQuestions = new Set();
let finalReviewOverlay = null;
let finalReviewResolve = null;

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
    ? ["Coding answers are tested automatically. Partial marks may be awarded for tests passed, including hidden tests."]
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

  await safeAttemptEvent("ATTEMPT_STARTED", {
    delivery_mode: runningMode,
  });
  await touchAttemptHealth(false, null);

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
  loadReviewMarks();
  renderPaper(saved);
  updateGlobalSaveIndicator();
  startSaveAgeTicker();
  recomputeEndsAt();

  if (resuming) {
    showRecoveryBanner(saved);
    safeAttemptEvent("ATTEMPT_RESUMED", {
      restored_answers: Object.keys(saved).length,
      remaining_seconds: Math.max(0, Math.floor((endsAt - Date.now()) / 1000)),
    });
  }

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
    .select("question_id, answer_text, code_submitted, updated_at")
    .eq("attempt_id", attempt.id);

  const map = {};
  let latest = 0;

  (data ?? []).forEach((a) => {
    map[a.question_id] = a;
    if (a.answer_text || a.code_submitted) answered[a.question_id] = true;

    const ts = a.updated_at ? new Date(a.updated_at).getTime() : 0;
    if (ts > latest) latest = ts;
  });

  if (latest) {
    lastSuccessfulSaveAt = latest;
  }

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

const STUDENT_RICH_TAGS = new Set([
  "P", "BR", "STRONG", "B", "EM", "I", "U",
  "UL", "OL", "LI", "CODE", "PRE", "BLOCKQUOTE",
  "H3", "H4", "SUP", "SUB",
]);

function sanitizeStudentRichHtml(value) {
  const template = document.createElement("template");
  template.innerHTML = String(value ?? "");

  const clean = (node) => {
    [...node.childNodes].forEach((child) => {
      if (child.nodeType === Node.TEXT_NODE) return;
      if (child.nodeType !== Node.ELEMENT_NODE) {
        child.remove();
        return;
      }

      const tag = child.tagName.toUpperCase();
      if (["SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "SVG", "MATH"].includes(tag)) {
        child.remove();
        return;
      }

      clean(child);

      if (!STUDENT_RICH_TAGS.has(tag)) {
        child.replaceWith(...child.childNodes);
        return;
      }

      [...child.attributes].forEach((attr) => child.removeAttribute(attr.name));
    });
  };

  clean(template.content);
  return template.innerHTML.trim();
}

function renderQuestionRich(target, html, fallback) {
  const safe = html ? sanitizeStudentRichHtml(html) : "";
  if (safe) target.innerHTML = safe;
  else target.textContent = fallback ?? "";
}

function renderCodingSpec(q, body) {
  const rows = [
    ["Input format", q.input_format],
    ["Output format", q.output_format],
    ["Constraints", q.constraints_text],
  ].filter(([, value]) => String(value ?? "").trim());

  if (!rows.length) return;

  const spec = document.createElement("section");
  spec.className = "coding-spec";

  rows.forEach(([label, value]) => {
    const block = document.createElement("div");
    const title = document.createElement("b");
    const pre = document.createElement("pre");
    title.textContent = label;
    pre.textContent = String(value ?? "");
    block.append(title, pre);
    spec.appendChild(block);
  });

  body.appendChild(spec);
}

async function loadVisibleCodingExamples(questionId, target) {
  target.innerHTML = `<span class="meta">Loading sample tests…</span>`;

  const { data, error } = await supabase
    .from("test_cases")
    .select("stdin, expected_out, position")
    .eq("question_id", questionId)
    .eq("is_hidden", false)
    .order("position")
    .limit(2);

  if (error) {
    target.innerHTML = "";
    return;
  }

  const tests = data ?? [];
  target.innerHTML = "";
  if (!tests.length) return;

  const heading = document.createElement("div");
  heading.className = "coding-samples-heading";
  heading.innerHTML = `<b>Sample tests</b><span>These examples are visible. Final marks also use hidden tests.</span>`;
  target.appendChild(heading);

  tests.forEach((test, index) => {
    const card = document.createElement("div");
    card.className = "sample-test-card";

    const title = document.createElement("b");
    title.textContent = `Sample ${index + 1}`;

    const compare = document.createElement("div");
    compare.className = "test-compare sample-test-compare";
    compare.innerHTML = `
      <div><span>INPUT</span><pre></pre></div>
      <div><span>EXPECTED OUTPUT</span><pre></pre></div>`;

    const pres = compare.querySelectorAll("pre");
    pres[0].textContent = test.stdin || "(no input)";
    pres[1].textContent = test.expected_out || "(nothing)";

    card.append(title, compare);
    target.appendChild(card);
  });
}

function renderPaper(saved) {
  const area = document.getElementById("questionArea");
  const strip = document.getElementById("progress");
  area.innerHTML = "";
  strip.innerHTML = "";

  questions.forEach((q, i) => {
    const pip = document.createElement("button");
    pip.className =
      "pip" +
      (answered[q.id] ? " done" : "") +
      (reviewQuestions.has(q.id) ? " review" : "");
    pip.id = `pip-${q.id}`;
    pip.title = `Question ${i + 1}`;
    pip.textContent = String(i + 1);
    pip.setAttribute("aria-label", `Go to question ${i + 1}`);
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

    renderQuestionRich(
      card.querySelector(".prompt"),
      q.prompt_html,
      q.prompt,
    );
    if (q.code_snippet) card.querySelector(".snippet").textContent = q.code_snippet;
    area.appendChild(card);

    const body = card.querySelector(".body");
    const state = card.querySelector(".save-state");
    const prior = saved[q.id];

    if (q.qtype === "mcq")    buildMcq(q, body, state, prior);
    if (q.qtype === "cloze")  buildCloze(q, body, state, prior);
    if (q.qtype === "long")   buildLong(q, body, state, prior);
    if (q.qtype === "coding") buildCoding(q, body, state, prior);

    card.appendChild(buildQuestionNav(q, i));
  });

  installSectionProgress();
  updateExamProgressSummary();
  installQuestionFocusTracking();
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
  renderCodingSpec(q, body);

  const samples = document.createElement("section");
  samples.className = "coding-samples";
  body.appendChild(samples);
  loadVisibleCodingExamples(q.id, samples);

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
    { className: "meta", textContent: "partial marks available for passed tests" });
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
   EXAM EXPERIENCE V2 — PROGRESS + CURRENT QUESTION
   ══════════════════════════════════════════════════════════════════════ */

function updateExamProgressSummary() {
  const el = document.getElementById("examProgressSummary");
  if (!el) return;

  const total = questions.length;
  const done = questions.filter((q) => Boolean(answered[q.id])).length;
  const left = Math.max(total - done, 0);
  const review = reviewQuestions.size;

  if (left === 0 && total && review === 0) {
    el.textContent = `${done} / ${total} answered · complete`;
  } else if (review) {
    el.textContent =
      `${done} / ${total} answered · ${review} review`;
  } else {
    el.textContent = `${done} / ${total} answered`;
  }

  updateSectionProgress();
}

function reviewStorageKey() {
  return attempt?.id
    ? `pariksarakshak:review:${attempt.id}`
    : null;
}

function loadReviewMarks() {
  reviewQuestions.clear();

  const key = reviewStorageKey();
  if (!key) return;

  try {
    const saved = JSON.parse(localStorage.getItem(key) || "[]");
    if (!Array.isArray(saved)) return;

    const validIds = new Set(questions.map((q) => q.id));

    saved.forEach((id) => {
      if (validIds.has(id)) reviewQuestions.add(id);
    });
  } catch (e) {
    console.warn("[review marks] could not restore:", e);
  }
}

function saveReviewMarks() {
  const key = reviewStorageKey();
  if (!key) return;

  try {
    localStorage.setItem(
      key,
      JSON.stringify([...reviewQuestions]),
    );
  } catch (e) {
    console.warn("[review marks] could not save:", e);
  }
}

function clearReviewMarks() {
  const key = reviewStorageKey();

  if (key) {
    try {
      localStorage.removeItem(key);
    } catch {
      // Non-critical local navigation state.
    }
  }

  reviewQuestions.clear();
}

function toggleReview(questionId) {
  if (reviewQuestions.has(questionId)) {
    reviewQuestions.delete(questionId);
  } else {
    reviewQuestions.add(questionId);
  }

  saveReviewMarks();
  syncReviewUI(questionId);
  updateExamProgressSummary();
}

function syncReviewUI(questionId) {
  const marked = reviewQuestions.has(questionId);

  document
    .getElementById(`pip-${questionId}`)
    ?.classList.toggle("review", marked);

  const btn = document.querySelector(
    `#card-${questionId} [data-review-question="${questionId}"]`,
  );

  if (btn) {
    btn.classList.toggle("active", marked);
    btn.setAttribute("aria-pressed", String(marked));
    btn.textContent =
      marked ? "★ Marked for review" : "☆ Mark for review";
  }
}

function scrollToQuestion(index) {
  const q = questions[index];
  if (!q) return;

  closeFinalReview(false);

  requestAnimationFrame(() => {
    document
      .getElementById(`card-${q.id}`)
      ?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });

    setCurrentQuestion(q.id);
  });
}

function buildQuestionNav(q, index) {
  const nav = document.createElement("div");
  nav.className = "question-nav-footer";

  const review = document.createElement("button");
  review.type = "button";
  review.className =
    "btn ghost small question-review-btn" +
    (reviewQuestions.has(q.id) ? " active" : "");
  review.dataset.reviewQuestion = q.id;
  review.setAttribute(
    "aria-pressed",
    String(reviewQuestions.has(q.id)),
  );
  review.textContent =
    reviewQuestions.has(q.id)
      ? "★ Marked for review"
      : "☆ Mark for review";

  review.onclick = () => toggleReview(q.id);

  const movement = document.createElement("div");
  movement.className = "question-move-actions";

  const previous = document.createElement("button");
  previous.type = "button";
  previous.className = "btn ghost small";
  previous.textContent = "← Previous";
  previous.disabled = index === 0;
  previous.onclick = () => scrollToQuestion(index - 1);

  const next = document.createElement("button");
  next.type = "button";
  next.className = "btn small";
  next.textContent =
    index === questions.length - 1
      ? "Review paper →"
      : "Next →";

  next.onclick = async () => {
    if (index === questions.length - 1) {
      await showFinalReview();
      return;
    }

    scrollToQuestion(index + 1);
  };

  movement.append(previous, next);
  nav.append(review, movement);

  return nav;
}

function installSectionProgress() {
  const progress = document.getElementById("progress");
  if (!progress) return;

  let strip = document.getElementById("sectionProgress");

  if (!strip) {
    strip = document.createElement("div");
    strip.id = "sectionProgress";
    strip.className = "section-progress";
    progress.insertAdjacentElement("afterend", strip);
  }

  updateSectionProgress();
}

function updateSectionProgress() {
  const strip = document.getElementById("sectionProgress");
  if (!strip) return;

  const order = [];
  const grouped = new Map();

  questions.forEach((q, index) => {
    if (!grouped.has(q.qtype)) {
      grouped.set(q.qtype, {
        type: q.qtype,
        total: 0,
        answered: 0,
        firstIndex: index,
      });
      order.push(q.qtype);
    }

    const group = grouped.get(q.qtype);
    group.total++;

    if (answered[q.id]) {
      group.answered++;
    }
  });

  strip.innerHTML = "";

  order.forEach((type) => {
    const group = grouped.get(type);
    const button = document.createElement("button");

    button.type = "button";
    button.className =
      "section-progress-chip" +
      (group.answered === group.total ? " complete" : "");

    button.innerHTML = `
      <span>${escapeHtml(LABEL[type] ?? type)}</span>
      <b>${group.answered}/${group.total}</b>
    `;

    button.onclick = () => scrollToQuestion(group.firstIndex);
    strip.appendChild(button);
  });
}

function closeFinalReview(result = false) {
  const overlay = finalReviewOverlay;
  const resolve = finalReviewResolve;

  finalReviewOverlay = null;
  finalReviewResolve = null;

  overlay?.remove();

  if (resolve) {
    resolve(Boolean(result));
  }
}

function finalReviewQuestionState(q) {
  if (reviewQuestions.has(q.id)) return "review";
  if (answered[q.id]) return "answered";
  return "blank";
}

function showFinalReview() {
  if (finalReviewOverlay) {
    return Promise.resolve(false);
  }

  const total = questions.length;
  const done = questions.filter((q) => Boolean(answered[q.id])).length;
  const blank = Math.max(total - done, 0);
  const review = reviewQuestions.size;
  const coding = questions.filter((q) => q.qtype === "coding").length;

  const overlay = document.createElement("div");
  overlay.id = "finalReviewOverlay";
  overlay.className = "final-review-overlay";

  const panel = document.createElement("section");
  panel.className = "final-review-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-modal", "true");
  panel.setAttribute("aria-labelledby", "finalReviewTitle");

  panel.innerHTML = `
    <div class="final-review-head">
      <div>
        <span class="eyebrow">Final check</span>
        <h2 id="finalReviewTitle">Review before submitting</h2>
        <p>
          Nothing is submitted until you press
          <b>Submit paper now</b>.
        </p>
      </div>
      <button
        type="button"
        class="final-review-close"
        aria-label="Close final review">×</button>
    </div>

    <div class="final-review-stats">
      <div class="ok">
        <b>${done}</b>
        <span>Answered</span>
      </div>
      <div class="${blank ? "warn" : "ok"}">
        <b>${blank}</b>
        <span>Unanswered</span>
      </div>
      <div class="${review ? "review" : ""}">
        <b>${review}</b>
        <span>For review</span>
      </div>
      <div>
        <b>${coding}</b>
        <span>Coding</span>
      </div>
    </div>

    <div class="final-review-legend">
      <span><i class="answered"></i> Answered</span>
      <span><i class="blank"></i> Unanswered</span>
      <span><i class="review"></i> Marked for review</span>
    </div>

    <div class="final-review-grid" id="finalReviewGrid"></div>

    ${
      blank
        ? `<p class="notice warn final-review-warning">
             ${blank} question${blank === 1 ? " is" : "s are"} still unanswered.
             You can return to the paper before submitting.
           </p>`
        : `<p class="notice ok final-review-warning">
             Every question has an answer. You can still revisit anything marked for review.
           </p>`
    }

    ${
      coding
        ? `<p class="final-review-coding">
             Coding questions are automatically evaluated with visible and hidden tests during final submission.
           </p>`
        : ""
    }

    <div class="final-review-actions">
      <button type="button" class="btn ghost" id="finalReviewBack">
        Back to paper
      </button>
      <button type="button" class="btn danger" id="finalReviewSubmit">
        Submit paper now
      </button>
    </div>
  `;

  overlay.appendChild(panel);
  document.body.appendChild(overlay);

  const grid = panel.querySelector("#finalReviewGrid");

  questions.forEach((q, index) => {
    const button = document.createElement("button");
    const state = finalReviewQuestionState(q);

    button.type = "button";
    button.className = `final-review-q ${state}`;
    button.title =
      `Question ${index + 1} · ${LABEL[q.qtype] ?? q.qtype}`;

    button.innerHTML = `
      <b>${index + 1}</b>
      <span>${state === "review" ? "review" : state}</span>
    `;

    button.onclick = () => {
      closeFinalReview(false);
      scrollToQuestion(index);
    };

    grid.appendChild(button);
  });

  panel.querySelector(".final-review-close").onclick =
    () => closeFinalReview(false);

  panel.querySelector("#finalReviewBack").onclick =
    () => closeFinalReview(false);

  panel.querySelector("#finalReviewSubmit").onclick =
    () => closeFinalReview(true);

  finalReviewOverlay = overlay;

  return new Promise((resolve) => {
    finalReviewResolve = resolve;
  });
}

function setCurrentQuestion(questionId) {
  document
    .querySelectorAll("#progress .pip")
    .forEach((pip) => pip.classList.remove("current"));

  document
    .querySelectorAll(".qcard")
    .forEach((card) => card.classList.remove("current-question"));

  document.getElementById(`pip-${questionId}`)?.classList.add("current");
  document.getElementById(`card-${questionId}`)?.classList.add("current-question");
}

function installQuestionFocusTracking() {
  questionFocusObserver?.disconnect();

  const cards = [...document.querySelectorAll(".qcard")];
  if (!cards.length) return;

  setCurrentQuestion(questions[0]?.id);

  questionFocusObserver = new IntersectionObserver(
    (entries) => {
      const visible = entries
        .filter((entry) => entry.isIntersecting)
        .sort((a, b) => {
          const da = Math.abs(a.boundingClientRect.top - 150);
          const db = Math.abs(b.boundingClientRect.top - 150);
          return da - db;
        });

      if (!visible.length) return;

      const id =
        visible[0].target.id.replace(/^card-/, "");

      setCurrentQuestion(id);
    },
    {
      root: null,
      rootMargin: "-18% 0px -55% 0px",
      threshold: [0, 0.15, 0.4],
    },
  );

  cards.forEach((card) => questionFocusObserver.observe(card));
}

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

  if (lastSuccessfulSaveAt) {
    setGlobalSaveState(
      `Online · saved ${shortAge(lastSuccessfulSaveAt)}`,
      "ok",
    );
  } else {
    setGlobalSaveState("Online · answers loaded ✓", "ok");
  }
}

function startSaveAgeTicker() {
  clearInterval(saveAgeTimer);
  saveAgeTimer = setInterval(() => {
    if (finished) {
      clearInterval(saveAgeTimer);
      return;
    }

    if (
      !pendingSaveQuestions.size &&
      !failedSaveQuestions.size &&
      navigator.onLine
    ) {
      updateGlobalSaveIndicator();
    }
  }, 5000);
}

function shortAge(value) {
  const ts = typeof value === "number"
    ? value
    : new Date(value).getTime();

  const sec = Math.max(
    0,
    Math.floor((Date.now() - ts) / 1000),
  );

  if (sec < 10) return "just now";
  if (sec < 60) return `${sec}s ago`;

  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;

  return `${Math.floor(min / 60)}h ago`;
}

async function touchAttemptHealth(saved = false, error = null) {
  if (!attempt?.id) return;

  try {
    await supabase.rpc("touch_attempt_health", {
      p_attempt_id: attempt.id,
      p_saved: Boolean(saved),
      p_save_error: error ? String(error).slice(0, 600) : null,
    });
  } catch (e) {
    console.warn("[attempt health]", e);
  }
}

async function safeAttemptEvent(type, detail = {}) {
  if (!attempt?.id) return;

  try {
    await supabase.rpc("log_attempt_event", {
      p_attempt_id: attempt.id,
      p_event_type: type,
      p_detail: detail ?? {},
    });
  } catch (e) {
    console.warn("[attempt audit]", type, e);
  }
}

function showRecoveryBanner(saved) {
  const sheet = document.querySelector(".paper-sheet");
  if (!sheet || document.getElementById("recoveryBanner")) return;

  const restored = Object.values(saved ?? {}).filter(
    (a) => a?.answer_text || a?.code_submitted,
  ).length;

  const left = Math.max(0, endsAt - Date.now());
  const m = Math.floor(left / 60000);
  const s = Math.floor((left % 60000) / 1000);

  const el = document.createElement("div");
  el.id = "recoveryBanner";
  el.className = "notice ok recovery-banner";
  el.innerHTML = `
    <b>Attempt recovered.</b>
    ${restored}/${questions.length} saved answer${restored === 1 ? "" : "s"} restored ·
    ${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")} remaining.
    <button type="button" class="recovery-close" aria-label="Dismiss">×</button>
  `;

  const progress = document.getElementById("progress");
  progress?.insertAdjacentElement("afterend", el);

  el.querySelector(".recovery-close").onclick = () => el.remove();
}

/* ══════════════════════════════════════════════════════════════════════
   5 · SAVING — and this time the real reason is shown
   ══════════════════════════════════════════════════════════════════════ */
function markDone(question_id) {
  answered[question_id] = true;
  document.getElementById(`pip-${question_id}`)?.classList.add("done");
  updateExamProgressSummary();
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

      touchAttemptHealth(
        false,
        `${error.code ?? "error"} ${error.message ?? ""}`,
      );

      if (!saveFailureSeen.has(question_id)) {
        saveFailureSeen.add(question_id);
        safeAttemptEvent("ANSWER_SAVE_FAILED", {
          question_id,
          code: error.code ?? null,
          message: error.message ?? null,
        });
      }

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

    lastSuccessfulSaveAt = Date.now();
    touchAttemptHealth(true, null);

    if (saveFailureSeen.has(question_id)) {
      saveFailureSeen.delete(question_id);
      safeAttemptEvent("ANSWER_SAVE_RECOVERED", {
        question_id,
      });
    }

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

    safeAttemptEvent("CODING_MANUAL_SUBMIT", {
      question_id,
      passed: Number(res.passed ?? 0),
      total: Number(res.total ?? 0),
    });
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
  const beat = async () => {
    if (finished) return;

    touchAttemptHealth(false, null);

    const { data } = await supabase.from("attempts")
      .select("extra_minutes, status").eq("id", attempt.id).single();

    if (data) {
      if (data.status === "submitted") {
        finished = true;
        safeAttemptEvent("SUBMISSION_CONFIRMED_EXTERNALLY", {});
        showReceipt(true, null);
        return;
      }

      if (data.extra_minutes !== attempt.extra_minutes) {
        attempt.extra_minutes = data.extra_minutes;
        recomputeEndsAt();
      }
    }

    // One paper, one place. Opening it elsewhere revokes this session.
    if (sessionToken && BROWSER_MODE.singleSession) {
      const res = await callPublicFunction("session-check", {
        session_token: sessionToken,
      });

      if (res.active === false && res.reason === "revoked") {
        safeAttemptEvent("SESSION_REVOKED", {
          reason: res.reason,
        });

        lockOut(
          "Your paper was opened on another machine or in another window, so this copy has been closed.",
        );
      }
    }
  };

  beat();
  setInterval(beat, HEARTBEAT_MS);
}


/* ══════════════════════════════════════════════════════════════════════
   10 · SUBMIT
   ══════════════════════════════════════════════════════════════════════ */
async function finish(auto) {
  if (auto && finalReviewOverlay) {
    closeFinalReview(false);
  }

  if (finished || submissionInProgress) return;

  if (!auto) {
    const confirmed = await showFinalReview();

    if (!confirmed) {
      return;
    }
  }

  submissionInProgress = true;
  finished = true;

  await safeAttemptEvent(
    auto ? "AUTO_SUBMIT_STARTED" : "FINAL_SUBMIT_STARTED",
    {
      auto: Boolean(auto),
      answered: Object.keys(answered).filter((id) => answered[id]).length,
      total_questions: questions.length,
    },
  );

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

    await safeAttemptEvent("CODING_FINALIZATION_COMPLETED", {
      total: codingSummary.total,
      evaluated: codingSummary.evaluated,
      blank: codingSummary.blank,
      failed: codingSummary.failed,
    });
  }

  showSubmissionStatus("Finalizing objective and coding marks…");

  const { data: score, error } =
    await supabase.rpc("grade_attempt", {
      p_attempt_id: attempt.id,
    });

  if (error) {
    console.error("[grade_attempt]", error);

    await safeAttemptEvent("FINAL_SUBMIT_FAILED", {
      message: error.message ?? String(error),
      code: error.code ?? null,
    });
  } else {
    await safeAttemptEvent("FINAL_SUBMIT_CONFIRMED", {
      score,
      auto: Boolean(auto),
    });
  }

  clearReviewMarks();
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
