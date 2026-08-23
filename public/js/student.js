// public/js/student.js
//
// The portal never opens a paper. It asks the server for a five-minute,
// single-use six-digit code, and shows the student where to type it.
//
// Where they type it depends on how the teacher set the paper:
//   seb      → Safe Exam Browser opens, and asks for the code
//   browser  → a new window on this machine opens, and asks for the code
//   either   → the student picks
import { supabase, callFunction, requireUser, signOut, escapeHtml } from "./supabaseClient.js";
import { INSTITUTE_NAME, SEB_CONFIG_FILE } from "./config.js";

let user, profile;
let busy = false;
let current = null;         // the code we just issued
let countdownTimer = null;

const msg = document.getElementById("portalMsg");
const list = document.getElementById("examList");
const codeInput = document.getElementById("examCode");
const startBtn = document.getElementById("startByCodeBtn");
const panel = document.getElementById("entryPanel");

boot();

async function boot() {
  const auth = await requireUser("student");
  if (!auth) return;
  ({ user, profile } = auth);

  document.getElementById("instituteTag").textContent = INSTITUTE_NAME;
  document.getElementById("whoami").textContent =
    `${profile.full_name || user.email}${profile.roll_no ? " · " + profile.roll_no : ""}`;
  document.getElementById("signOutBtn").onclick = signOut;

  startBtn.onclick = () => startExam(codeInput.value);
  codeInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") startExam(codeInput.value);
  });
  document.getElementById("againBtn").onclick = () => current && startExam(current.exam_code);

  await loadPapers();
  setInterval(loadPapers, 60000);
}

/* ══════════════ WHAT IS OPEN ══════════════ */
async function loadPapers() {
  const { data, error } = await supabase.from("exams")
    .select("id, title, exam_code, duration_min, starts_at, ends_at, delivery_mode")
    .order("starts_at", { ascending: true });

  if (error) {
    list.innerHTML = `<p class="notice error">${escapeHtml(error.message)}</p>`;
    return;
  }

  const { data: mine } = await supabase.from("attempts")
    .select("exam_id, status").eq("student_id", user.id);
  const status = {};
  (mine ?? []).forEach((a) => { status[a.exam_id] = a.status; });

  document.getElementById("liveCount").textContent =
    data?.length ? `${data.length} open` : "nothing open";

  if (!data?.length) {
    list.innerHTML = `<p class="empty">No paper is open for you right now.
      It appears here the moment your teacher opens it.</p>`;
    return;
  }

  list.innerHTML = "";
  data.forEach((exam) => {
    const state = status[exam.id];
    const mode = exam.delivery_mode ?? "seb";
    const card = document.createElement("article");
    card.className = "student-exam-card";
    card.innerHTML = `
      <div>
        <span class="tag blue">${escapeHtml(exam.exam_code)}</span>
        <span class="tag ${mode === "browser" ? "warn" : mode === "either" ? "" : "pass"}">${
          mode === "browser" ? "this browser" : mode === "either" ? "either browser" : "locked browser"}</span>
        <h3>${escapeHtml(exam.title)}</h3>
        <p class="meta">${exam.duration_min} minutes · closes ${when(exam.ends_at)}</p>
      </div>
      <div class="card-action"></div>`;

    const slot = card.querySelector(".card-action");
    if (state === "submitted") {
      slot.innerHTML = `<span class="tag pass">submitted</span>`;
    } else {
      const btn = document.createElement("button");
      btn.className = "btn";
      btn.textContent = state === "in_progress" ? "Resume" : "Start";
      btn.onclick = () => startExam(exam.exam_code);
      slot.appendChild(btn);
    }
    list.appendChild(card);
  });
}

/* ══════════════ ISSUE THE CODE ══════════════ */
async function startExam(rawCode) {
  if (busy) return;
  const examCode = String(rawCode || "").trim().toUpperCase();
  if (!examCode) return show("Type the exam code, or pick a paper above.");

  hide();
  setBusy(true);

  try {
    const res = await callFunction("create-seb-launch", { exam_code: examCode });
    if (res.error) return show(res.error);

    current = res;
    renderCode(res);
  } finally {
    setBusy(false);
  }
}

function renderCode(res) {
  const mode = res.delivery_mode ?? "seb";
  panel.classList.remove("hidden");
  document.getElementById("entryCode").textContent = res.entry_code;
  document.getElementById("entryHead").textContent =
    `${res.exam_title ?? res.exam_code} — your secure code`;

  const openBtn = document.getElementById("openExamBtn");

  if (mode === "browser") {
    document.getElementById("entrySteps").innerHTML = `
      <b>This paper runs in this browser.</b> Press the button below, then type
      <b>${escapeHtml(res.entry_code)}</b> into the exam window. It runs full screen, and
      leaving full screen or switching windows is recorded.`;
    openBtn.textContent = "Open the exam window";
    openBtn.onclick = () => window.open("exam.html", "_blank", "noopener");
  } else if (mode === "either") {
    document.getElementById("entrySteps").innerHTML = `
      <b>You may use either browser.</b> Use Safe Exam Browser if it is installed on this
      machine — it is the stricter of the two. Then type <b>${escapeHtml(res.entry_code)}</b>
      when the exam window asks.`;
    openBtn.textContent = "Open Safe Exam Browser";
    openBtn.onclick = () => launchSeb();
    addSecondaryOpen();
  } else {
    document.getElementById("entrySteps").innerHTML = `
      <b>This paper runs in Safe Exam Browser.</b> Press the button, approve
      <b>Open Safe Exam Browser</b> if your browser asks, then type
      <b>${escapeHtml(res.entry_code)}</b> when it asks for your code.`;
    openBtn.textContent = "Open Safe Exam Browser";
    openBtn.onclick = () => launchSeb();
  }

  startCountdown(res.expires_at);
  panel.scrollIntoView({ behavior: "smooth", block: "center" });
}

function addSecondaryOpen() {
  const actions = panel.querySelector(".actions");
  if (document.getElementById("openHereBtn")) return;
  const btn = document.createElement("button");
  btn.className = "btn ghost";
  btn.id = "openHereBtn";
  btn.textContent = "Open in this browser instead";
  btn.onclick = () => window.open("exam.html", "_blank", "noopener");
  actions.insertBefore(btn, document.getElementById("againBtn"));
}

function launchSeb() {
  const url = new URL(`/seb/${SEB_CONFIG_FILE}`, location.origin);
  url.protocol = location.protocol === "https:" ? "sebs:" : "seb:";
  window.location.href = url.toString();
}

function startCountdown(expiresAt) {
  clearInterval(countdownTimer);
  const el = document.getElementById("entryCountdown");
  const end = new Date(expiresAt).getTime();

  const tick = () => {
    const left = end - Date.now();
    if (left <= 0) {
      clearInterval(countdownTimer);
      el.textContent = "expired";
      document.getElementById("entryCode").classList.add("expired");
      document.getElementById("entrySteps").innerHTML =
        `<b>That code has expired.</b> Press <b>Get a new code</b> to receive another.`;
      return;
    }
    const m = Math.floor(left / 60000);
    const s = Math.floor((left % 60000) / 1000);
    el.textContent = `expires in ${m}:${String(s).padStart(2, "0")}`;
  };
  tick();
  countdownTimer = setInterval(tick, 1000);
}

function setBusy(on) {
  busy = on;
  startBtn.disabled = on;
  startBtn.textContent = on ? "Working…" : "Start";
  list.querySelectorAll("button").forEach((b) => { b.disabled = on; });
}

function show(text, kind = "error") {
  msg.textContent = text;
  msg.className = `notice ${kind}`;
  msg.classList.remove("hidden");
}
function hide() { msg.classList.add("hidden"); }
function when(v) {
  return new Date(v).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}
