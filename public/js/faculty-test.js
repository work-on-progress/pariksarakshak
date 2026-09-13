// public/js/faculty-test.js
// Faculty-only paper sandbox.
// It never creates a student attempt and never writes student answers/results.

import {
  supabase,
  callFunction,
  requireUser,
  escapeHtml,
} from "./supabaseClient.js";

let user = null;
let profile = null;
let exam = null;
let questions = [];
let originalQuestions = [];
let testsByQuestion = {};

const answers = {};
const editors = {};
const codingState = {};
let timerId = null;
let secondsLeft = 0;
let started = false;
let finished = false;

const params = new URLSearchParams(location.search);
const examId = params.get("exam");

boot();

async function boot() {
  const auth = await requireUser("faculty");
  if (!auth) return;

  ({ user, profile } = auth);

  if (!examId) {
    return showLoadError("No paper was selected.");
  }

  await loadPaper();
}

async function loadPaper() {
  const [{ data: ex, error: examError }, { data: qs, error: questionError }] =
    await Promise.all([
      supabase
        .from("exams")
        .select("*")
        .eq("id", examId)
        .single(),
      supabase
        .from("questions")
        .select("*")
        .eq("exam_id", examId)
        .order("position"),
    ]);

  if (examError) return showLoadError(examError.message);
  if (questionError) return showLoadError(questionError.message);

  if (!ex || ex.faculty_id !== user.id) {
    return showLoadError("This paper does not belong to your faculty account.");
  }

  exam = ex;
  originalQuestions = qs ?? [];

  const codingIds = originalQuestions
    .filter((q) => q.qtype === "coding")
    .map((q) => q.id);

  if (codingIds.length) {
    const { data: tests, error } = await supabase
      .from("test_cases")
      .select("question_id, stdin, expected_out, is_hidden, position")
      .in("question_id", codingIds)
      .order("position");

    if (error) return showLoadError(error.message);

    (tests ?? []).forEach((test) => {
      (testsByQuestion[test.question_id] ||= []).push(test);
    });
  }

  document.getElementById("testPaperTitle").textContent =
    `${exam.exam_code} · ${exam.title}`;
  document.getElementById("testIntroTitle").textContent = exam.title;

  const totalMarks = originalQuestions.reduce(
    (sum, q) => sum + Number(q.marks || 0),
    0,
  );

  const codingCount = originalQuestions.filter((q) => q.qtype === "coding").length;
  const longCount = originalQuestions.filter((q) => q.qtype === "long").length;

  document.getElementById("testFacts").innerHTML = `
    <div><b>${originalQuestions.length}</b><span>Questions</span></div>
    <div><b>${totalMarks}</b><span>Total marks</span></div>
    <div><b>${exam.duration_min}</b><span>Minutes</span></div>
    <div><b>${codingCount}</b><span>Coding</span></div>
    <div><b>${longCount}</b><span>Long answer</span></div>
  `;

  if (!originalQuestions.length) {
    document.getElementById("startFacultyTest").disabled = true;
    note(
      "testLoadMsg",
      "This paper has no questions yet. Add questions before testing it.",
      "warn",
    );
  }

  document.getElementById("startFacultyTest").onclick = startTest;
  document.getElementById("testFinishBtn").onclick = () => finishTest(false);
  document.getElementById("testFinishBottom").onclick = () => finishTest(false);
}

function startTest() {
  if (!originalQuestions.length || started) return;

  started = true;
  finished = false;
  questions = originalQuestions.map((q) => ({ ...q }));

  if (exam.shuffle_questions) {
    questions = shuffle([...questions]);
  }

  document.getElementById("testIntro").classList.add("hidden");
  document.getElementById("testPaper").classList.remove("hidden");
  document.getElementById("testFinishBtn").classList.remove("hidden");

  renderPaper();
  startLocalTimer();
  window.scrollTo({ top: 0, behavior: "instant" });
}

function renderPaper() {
  const nav = document.getElementById("testQuestionNav");
  const area = document.getElementById("testQuestionArea");

  nav.innerHTML = "";
  area.innerHTML = "";

  questions.forEach((q, index) => {
    const pip = document.createElement("button");
    pip.type = "button";
    pip.className = "faculty-test-pip";
    pip.id = `test-pip-${q.id}`;
    pip.textContent = String(index + 1);
    pip.title = `Question ${index + 1}`;
    pip.onclick = () =>
      document.getElementById(`test-q-${q.id}`)?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    nav.appendChild(pip);

    const card = document.createElement("article");
    card.className = "qcard faculty-test-qcard";
    card.id = `test-q-${q.id}`;

    const header = document.createElement("header");
    header.innerHTML = `
      <span class="qno">Q${index + 1}</span>
      <span class="tag">${escapeHtml(q.qtype)}</span>
      <span class="tag">${escapeHtml(q.difficulty || "medium")}</span>
      <span class="spacer"></span>
      <b>${Number(q.marks || 0)} mark${Number(q.marks || 0) === 1 ? "" : "s"}</b>
    `;

    const body = document.createElement("div");
    body.className = "qbody";

    const prompt = document.createElement("div");
    prompt.className = "prompt";
    prompt.innerHTML = safeRichHtml(q.prompt_html || textToHtml(q.prompt));
    body.appendChild(prompt);

    if (q.code_snippet) {
      const pre = document.createElement("pre");
      pre.className = "snippet";
      pre.textContent = q.code_snippet;
      body.appendChild(pre);
    }

    if (q.qtype === "mcq") buildMcq(q, body);
    if (q.qtype === "cloze") buildCloze(q, body);
    if (q.qtype === "long") buildLong(q, body);
    if (q.qtype === "coding") buildCoding(q, body);

    card.append(header, body);
    area.appendChild(card);
  });

  updateProgress();
}

function buildMcq(q, body) {
  let options = (Array.isArray(q.options) ? q.options : [])
    .map((text, index) => ({
      key: String.fromCharCode(65 + index),
      text: String(text ?? ""),
    }));

  if (exam.shuffle_options) {
    options = shuffle(options);
  }

  options.forEach(({ key, text }) => {
    const label = document.createElement("label");
    label.className = "choice";

    const input = document.createElement("input");
    input.type = "radio";
    input.name = `faculty-test-${q.id}`;
    input.value = key;

    const span = document.createElement("span");
    span.textContent = text;

    input.onchange = () => {
      answers[q.id] = key;
      body.querySelectorAll(".choice").forEach((x) => x.classList.remove("picked"));
      label.classList.add("picked");
      markAnswered(q.id);
    };

    label.append(input, span);
    body.appendChild(label);
  });
}

function buildCloze(q, body) {
  const wrap = document.createElement("div");
  wrap.className = "blanks";

  const count =
    Array.isArray(q.cloze_answers) && q.cloze_answers.length
      ? q.cloze_answers.length
      : Math.max(1, (String(q.prompt || "").match(/____/g) || []).length);

  const values = Array(count).fill("");

  for (let i = 0; i < count; i++) {
    const input = document.createElement("input");
    input.placeholder = `Blank ${i + 1}`;

    input.oninput = () => {
      values[i] = input.value;
      answers[q.id] = [...values];

      if (values.some((v) => v.trim())) {
        markAnswered(q.id);
      } else {
        markUnanswered(q.id);
      }
    };

    wrap.appendChild(input);
  }

  body.appendChild(wrap);
}

function buildLong(q, body) {
  const ta = document.createElement("textarea");
  ta.rows = 8;
  ta.placeholder = "Write your answer here.";

  const count = document.createElement("span");
  count.className = "wordcount";

  const update = () => {
    answers[q.id] = ta.value;

    const words = ta.value.trim()
      ? ta.value.trim().split(/\s+/).length
      : 0;

    count.textContent = `${words} ${words === 1 ? "word" : "words"}`;

    if (ta.value.trim()) markAnswered(q.id);
    else markUnanswered(q.id);
  };

  ta.oninput = update;
  update();

  body.append(ta, count);
}

function buildCoding(q, body) {
  renderCodingSpec(q, body);
  renderVisibleSamples(q, body);

  const wrap = document.createElement("div");
  wrap.className = "editor-wrap";

  const ta = document.createElement("textarea");
  wrap.appendChild(ta);

  const actions = document.createElement("div");
  actions.className = "code-actions";

  const runBtn = button("Run visible tests", "btn ghost small");
  const submitBtn = button("Submit for marks", "btn pass small");
  const resetBtn = button("Reset code", "btn ghost small");

  const hint = document.createElement("span");
  hint.className = "meta";
  hint.textContent = "test mode · no marks are written";
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

  cm.setValue(q.starter_code || "");
  cm.setSize("100%", "320px");
  editors[q.id] = cm;

  cm.on("change", () => {
    const code = cm.getValue();
    answers[q.id] = code;
    if (code.trim()) markAnswered(q.id);
    else markUnanswered(q.id);
  });

  runBtn.onclick = () =>
    runCoding(q, "run", verdict, [runBtn, submitBtn]);

  submitBtn.onclick = () =>
    runCoding(q, "submit", verdict, [runBtn, submitBtn]);

  resetBtn.onclick = () => {
    if (!confirm("Put the starter code back?")) return;
    cm.setValue(q.starter_code || "");
  };
}

function renderCodingSpec(q, body) {
  const sections = [
    ["Input format", q.input_format],
    ["Output format", q.output_format],
    ["Constraints", q.constraints_text],
  ];

  const present = sections.filter(([, value]) => String(value ?? "").trim());
  if (!present.length) return;

  const spec = document.createElement("section");
  spec.className = "coding-spec";

  present.forEach(([label, value]) => {
    const block = document.createElement("div");
    const h = document.createElement("b");
    const pre = document.createElement("pre");

    h.textContent = label;
    pre.textContent = String(value ?? "");

    block.append(h, pre);
    spec.appendChild(block);
  });

  body.appendChild(spec);
}

function renderVisibleSamples(q, body) {
  const tests = (testsByQuestion[q.id] || [])
    .filter((t) => !t.is_hidden);

  if (!tests.length) return;

  const section = document.createElement("section");
  section.className = "coding-samples";

  const title = document.createElement("b");
  title.textContent = "Sample tests";
  section.appendChild(title);

  tests.forEach((test, i) => {
    const card = document.createElement("div");
    card.className = "sample-test-card";
    card.innerHTML = `
      <b>Sample ${i + 1}</b>
      <div class="test-compare">
        <div><span>INPUT</span><pre></pre></div>
        <div><span>EXPECTED OUTPUT</span><pre></pre></div>
      </div>
    `;

    const pre = card.querySelectorAll("pre");
    pre[0].textContent = String(test.stdin ?? "") || "(no input)";
    pre[1].textContent = String(test.expected_out ?? "");

    section.appendChild(card);
  });

  body.appendChild(section);
}

async function runCoding(q, mode, verdict, buttons) {
  const code = editors[q.id]?.getValue() || "";

  if (!code.trim()) {
    showVerdictError(verdict, "Write some code first.");
    return null;
  }

  buttons.forEach((b) => (b.disabled = true));
  verdict.classList.remove("hidden");
  verdict.innerHTML =
    `<p class="muted">${mode === "run" ? "Running visible tests…" : "Checking all tests…"}</p>`;

  try {
    const res = await callFunction("faculty-test-code", {
      question_id: q.id,
      code,
      mode,
    });

    if (res.error) {
      showVerdictError(verdict, res.error);
      return null;
    }

    codingState[q.id] = res;
    renderCodingVerdict(verdict, res, mode);

    if (mode === "submit") {
      markAnswered(q.id);
    }

    return res;
  } catch (e) {
    showVerdictError(verdict, e?.message || String(e));
    return null;
  } finally {
    buttons.forEach((b) => (b.disabled = false));
  }
}

function renderCodingVerdict(box, res, mode) {
  box.classList.remove("hidden");

  const passClass = res.passed === res.total ? "pass" : "warn";

  box.innerHTML = `
    <div class="test-verdict-head">
      <b class="${passClass}">
        ${res.passed}/${res.total} tests passed
      </b>
      ${
        mode === "submit"
          ? `<span class="meta">estimated marks: ${Number(res.partial_marks || 0).toFixed(2)}</span>`
          : `<span class="meta">visible tests only</span>`
      }
    </div>
  `;

  (res.results || []).forEach((r) => {
    const card = document.createElement("div");
    card.className = `test-result-card ${r.pass ? "pass" : "fail"}`;

    if (r.hidden) {
      card.innerHTML = `
        <b>${escapeHtml(r.name || "Hidden test")}</b>
        <span>${r.pass ? "Passed" : "Failed"}</span>
      `;
    } else {
      card.innerHTML = `
        <b>${escapeHtml(r.name || "Visible test")}</b>
        <span>${r.pass ? "Passed" : "Failed"}</span>
        <div class="test-compare">
          <div><span>INPUT</span><pre>${escapeHtml(r.input || "")}</pre></div>
          <div><span>EXPECTED</span><pre>${escapeHtml(r.expected || "")}</pre></div>
          <div><span>YOUR OUTPUT</span><pre>${escapeHtml(r.got || "")}</pre></div>
        </div>
        ${
          r.stderr
            ? `<pre class="test-error">${escapeHtml(r.stderr)}</pre>`
            : ""
        }
      `;
    }

    box.appendChild(card);
  });
}

async function finishTest(auto = false) {
  if (finished) return;

  if (!auto) {
    const unanswered = questions.filter((q) => !isAnswered(q)).length;
    const message = unanswered
      ? `${unanswered} question${unanswered === 1 ? " is" : "s are"} unanswered. Finish and compare anyway?`
      : "Finish the test and compare your answers with the answer key?";

    if (!confirm(message)) return;
  }

  finished = true;
  clearInterval(timerId);

  const finishButtons = [
    document.getElementById("testFinishBtn"),
    document.getElementById("testFinishBottom"),
  ];

  finishButtons.forEach((b) => {
    if (b) {
      b.disabled = true;
      b.textContent = "Checking…";
    }
  });

  for (const q of questions.filter((x) => x.qtype === "coding")) {
    const code = editors[q.id]?.getValue() || "";
    answers[q.id] = code;

    if (!code.trim()) {
      codingState[q.id] = {
        passed: 0,
        total: (testsByQuestion[q.id] || []).length,
        partial_marks: 0,
        results: [],
        blank_code: true,
      };
      continue;
    }

    const res = await callFunction("faculty-test-code", {
      question_id: q.id,
      code,
      mode: "submit",
    });

    codingState[q.id] = res.error
      ? { error: res.error, passed: 0, total: 0, partial_marks: 0 }
      : res;
  }

  renderResults(auto);

  document.getElementById("testPaper").classList.add("hidden");
  document.getElementById("testFinishBtn").classList.add("hidden");
  document.getElementById("testResults").classList.remove("hidden");

  window.scrollTo({ top: 0, behavior: "smooth" });
}

function renderResults(auto) {
  let autoMarks = 0;
  let autoPossible = 0;
  let longPossible = 0;
  let correctCount = 0;

  const rows = questions.map((q, index) => {
    const result = evaluateQuestion(q);

    if (q.qtype === "long") {
      longPossible += Number(q.marks || 0);
    } else {
      autoPossible += Number(q.marks || 0);
      autoMarks += Number(result.marks || 0);
      if (result.correct) correctCount++;
    }

    return resultCard(q, index, result);
  }).join("");

  const totalPossible = questions.reduce(
    (sum, q) => sum + Number(q.marks || 0),
    0,
  );

  const box = document.getElementById("testResults");

  box.innerHTML = `
    <section class="faculty-test-result-hero">
      <span class="eyebrow">${auto ? "Timer ended" : "Test completed"}</span>
      <h1>Faculty test report</h1>
      <p>
        This report exists only in this browser. It does not appear in student results.
      </p>

      <div class="faculty-test-score-grid">
        <div>
          <b>${formatMark(autoMarks)} / ${formatMark(autoPossible)}</b>
          <span>Auto-check score</span>
        </div>
        <div>
          <b>${correctCount}</b>
          <span>Objective/coding checks correct</span>
        </div>
        <div>
          <b>${formatMark(longPossible)}</b>
          <span>Long-answer marks to review</span>
        </div>
        <div>
          <b>${formatMark(totalPossible)}</b>
          <span>Total paper marks</span>
        </div>
      </div>

      <div class="actions">
        <button class="btn" id="restartFacultyTest">Run test again</button>
        <a class="btn ghost" href="faculty.html">Back to console</a>
      </div>
    </section>

    <div class="faculty-test-result-list">
      ${rows}
    </div>
  `;

  document.getElementById("restartFacultyTest").onclick = () => {
    location.reload();
  };
}

function evaluateQuestion(q) {
  if (q.qtype === "mcq") {
    const selected = String(answers[q.id] || "").toUpperCase();
    const correct = String(q.correct_key || "").toUpperCase();
    const ok = Boolean(selected && correct && selected === correct);

    return {
      correct: ok,
      marks: ok ? Number(q.marks || 0) : 0,
      answer: selected || "(unanswered)",
      expected: correct || "(answer key missing)",
    };
  }

  if (q.qtype === "cloze") {
    const submitted = Array.isArray(answers[q.id]) ? answers[q.id] : [];
    const expected = Array.isArray(q.cloze_answers) ? q.cloze_answers : [];

    const matches = expected.reduce(
      (count, exp, i) =>
        count +
        (norm(submitted[i]) === norm(exp) ? 1 : 0),
      0,
    );

    const possible = Math.max(expected.length, 1);
    const fraction = matches / possible;

    return {
      correct: matches === expected.length && expected.length > 0,
      marks: round2(Number(q.marks || 0) * fraction),
      answer: submitted.length ? submitted.join(" | ") : "(unanswered)",
      expected: expected.length ? expected.join(" | ") : "(answer key missing)",
      detail: `${matches}/${expected.length} blanks correct`,
    };
  }

  if (q.qtype === "coding") {
    const state = codingState[q.id] || {};
    const marks = Number(state.partial_marks || 0);

    return {
      correct: Number(state.total || 0) > 0 && Number(state.passed || 0) === Number(state.total || 0),
      marks,
      answer: answers[q.id]?.trim() ? "Code submitted" : "(blank)",
      expected:
        Number(state.total || 0) > 0
          ? `${state.passed || 0}/${state.total} tests passed`
          : state.error || "No coding result",
      detail: state.error || "",
    };
  }

  return {
    correct: null,
    marks: null,
    answer: String(answers[q.id] || "").trim() || "(unanswered)",
    expected: q.reference_answer || "(no reference answer saved)",
    detail: "Manual review required",
  };
}

function resultCard(q, index, result) {
  const status =
    q.qtype === "long"
      ? `<span class="tag warn">manual review</span>`
      : result.correct
      ? `<span class="tag pass">correct</span>`
      : `<span class="tag seal">check</span>`;

  const explanation = q.explanation_html || q.explanation
    ? `
      <details class="faculty-test-reference">
        <summary>Why the answer is right</summary>
        <div class="rich-readonly">
          ${safeRichHtml(q.explanation_html || textToHtml(q.explanation))}
        </div>
      </details>`
    : "";

  const longReference =
    q.qtype === "long"
      ? `
        <details class="faculty-test-reference" open>
          <summary>Reference answer</summary>
          <div class="rich-readonly">
            ${safeRichHtml(q.reference_answer_html || textToHtml(q.reference_answer || "No reference answer saved."))}
          </div>
        </details>
        <details class="faculty-test-reference">
          <summary>Marking rubric</summary>
          <div class="rich-readonly">
            ${safeRichHtml(q.marking_rubric_html || textToHtml(q.marking_rubric || "No rubric saved."))}
          </div>
        </details>`
      : "";

  const codingReference =
    q.qtype === "coding"
      ? `
        <details class="faculty-test-reference">
          <summary>Reference solution</summary>
          <pre class="snippet">${escapeHtml(q.reference_solution || "No reference solution saved.")}</pre>
        </details>`
      : "";

  return `
    <article class="faculty-test-result-card">
      <header>
        <b>Q${index + 1}</b>
        <span class="tag">${escapeHtml(q.qtype)}</span>
        ${status}
        <span class="spacer"></span>
        ${
          result.marks === null
            ? `<span>${Number(q.marks || 0)} marks</span>`
            : `<span>${formatMark(result.marks)} / ${formatMark(Number(q.marks || 0))}</span>`
        }
      </header>

      <div class="rich-readonly">
        ${safeRichHtml(q.prompt_html || textToHtml(q.prompt))}
      </div>

      <div class="faculty-test-answer-compare">
        <div>
          <span>YOUR TEST ANSWER</span>
          <pre>${escapeHtml(result.answer || "")}</pre>
        </div>
        <div>
          <span>${q.qtype === "long" ? "REFERENCE" : "EXPECTED / RESULT"}</span>
          <pre>${escapeHtml(result.expected || "")}</pre>
        </div>
      </div>

      ${result.detail ? `<p class="meta">${escapeHtml(result.detail)}</p>` : ""}
      ${explanation}
      ${longReference}
      ${codingReference}
    </article>
  `;
}

function isAnswered(q) {
  if (q.qtype === "mcq") {
    return Boolean(String(answers[q.id] || "").trim());
  }

  if (q.qtype === "cloze") {
    return Array.isArray(answers[q.id]) &&
      answers[q.id].some((x) => String(x || "").trim());
  }

  if (q.qtype === "long" || q.qtype === "coding") {
    return Boolean(String(answers[q.id] || "").trim());
  }

  return false;
}

function markAnswered(questionId) {
  document.getElementById(`test-pip-${questionId}`)?.classList.add("done");
  updateProgress();
}

function markUnanswered(questionId) {
  document.getElementById(`test-pip-${questionId}`)?.classList.remove("done");
  updateProgress();
}

function updateProgress() {
  const done = questions.filter(isAnswered).length;
  document.getElementById("testProgress").textContent =
    `${done} / ${questions.length} answered`;
}

function startLocalTimer() {
  secondsLeft = Math.max(60, Number(exam.duration_min || 60) * 60);

  const tick = () => {
    const minutes = Math.floor(secondsLeft / 60);
    const seconds = secondsLeft % 60;

    document.getElementById("testTimer").textContent =
      `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;

    if (secondsLeft <= 0) {
      clearInterval(timerId);
      finishTest(true);
      return;
    }

    secondsLeft--;
  };

  tick();
  timerId = setInterval(tick, 1000);
}

function showLoadError(message) {
  document.getElementById("testIntroTitle").textContent =
    "Could not open test mode";
  document.getElementById("startFacultyTest").disabled = true;
  note("testLoadMsg", escapeHtml(message), "error");
}

function note(id, text, kind = "") {
  const el = document.getElementById(id);
  if (!el) return;
  el.innerHTML = text;
  el.className = `notice ${kind}`.trim();
  el.classList.toggle("hidden", !text);
}

function button(text, className) {
  return Object.assign(document.createElement("button"), {
    type: "button",
    textContent: text,
    className,
  });
}

function showVerdictError(box, message) {
  box.classList.remove("hidden");
  box.innerHTML = `<p class="notice error">${escapeHtml(message)}</p>`;
}

function norm(value) {
  return String(value ?? "").trim().toLowerCase();
}

function round2(value) {
  return Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function formatMark(value) {
  const n = Number(value || 0);
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

function shuffle(items) {
  const arr = [...items];

  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }

  return arr;
}

function cmMode(lang) {
  return {
    python: "python",
    javascript: "javascript",
    c: "text/x-csrc",
    cpp: "text/x-c++src",
    java: "text/x-java",
  }[String(lang || "").toLowerCase()] || "python";
}

const ALLOWED = new Set([
  "P", "BR", "STRONG", "B", "EM", "I", "U",
  "UL", "OL", "LI", "CODE", "PRE", "BLOCKQUOTE",
  "H3", "H4", "SUP", "SUB",
]);

function safeRichHtml(value) {
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

      if (!ALLOWED.has(tag)) {
        clean(child);
        child.replaceWith(...child.childNodes);
        return;
      }

      [...child.attributes].forEach((attr) =>
        child.removeAttribute(attr.name)
      );

      clean(child);
    });
  };

  clean(template.content);
  return template.innerHTML;
}

function textToHtml(text) {
  return escapeHtml(String(text ?? ""))
    .split(/\n{2,}/)
    .map((part) => `<p>${part.replace(/\n/g, "<br>")}</p>`)
    .join("");
}
