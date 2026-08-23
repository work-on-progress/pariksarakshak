// public/js/student.js
// The normal-browser portal. It never opens the paper. It asks the server for a
// two-minute, single-use launch token and hands that to Safe Exam Browser
// through the sebs:// link. The attempt itself is only ever created inside SEB.
import { supabase, callFunction, requireUser, signOut, escapeHtml } from "./supabaseClient.js";
import { INSTITUTE_NAME, SEB_CONFIG_FILE } from "./config.js";

let user, profile;
let busy = false;

const msg = document.getElementById("portalMsg");
const list = document.getElementById("examList");
const codeInput = document.getElementById("examCode");
const startBtn = document.getElementById("startByCodeBtn");

boot();

async function boot() {
  const auth = await requireUser("student");
  if (!auth) return;
  ({ user, profile } = auth);

  document.getElementById("instituteTag").textContent = INSTITUTE_NAME;
  document.getElementById("whoami").textContent =
    `${profile.full_name || user.email}${profile.roll_no ? " · " + profile.roll_no : ""}`;
  document.getElementById("signOutBtn").onclick = signOut;

  startBtn.onclick = () => startSecureExam(codeInput.value);
  codeInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") startSecureExam(codeInput.value);
  });

  await loadPapers();
  setInterval(loadPapers, 60000);   // a paper may open while the student waits
}

/* ══════════════ WHAT IS OPEN ══════════════ */
async function loadPapers() {
  // Row-level security already limits this to published papers inside their
  // window, so whatever comes back is a paper this student may sit.
  const { data, error } = await supabase.from("exams")
    .select("id, title, exam_code, duration_min, starts_at, ends_at")
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
    data?.length ? `${data.length} open now` : "nothing open";

  if (!data?.length) {
    list.innerHTML = `<p class="empty">No paper is open for you right now.
      It appears here the moment your teacher opens it.</p>`;
    return;
  }

  list.innerHTML = "";
  data.forEach((exam) => {
    const done = status[exam.exam_id] ?? status[exam.id];
    const card = document.createElement("article");
    card.className = "student-exam-card";
    card.innerHTML = `
      <div>
        <span class="tag blue">${escapeHtml(exam.exam_code)}</span>
        <h3>${escapeHtml(exam.title)}</h3>
        <p class="meta">${exam.duration_min} minutes · closes ${when(exam.ends_at)}</p>
      </div>
      <div class="card-action"></div>`;

    const slot = card.querySelector(".card-action");
    if (done === "submitted") {
      slot.innerHTML = `<span class="tag pass">submitted</span>`;
    } else {
      const btn = document.createElement("button");
      btn.className = "btn";
      btn.textContent = done === "in_progress" ? "Resume in SEB" : "Start secure exam";
      btn.onclick = () => startSecureExam(exam.exam_code);
      slot.appendChild(btn);
    }
    list.appendChild(card);
  });
}

/* ══════════════ THE LAUNCH ══════════════ */
async function startSecureExam(rawCode) {
  if (busy) return;
  const examCode = String(rawCode || "").trim().toUpperCase();
  if (!examCode) return show("Type the exam code, or pick a paper above.");

  hide();
  setBusy(true);

  try {
    // Fail clearly before minting a token if the configuration was never published.
    const present = await fetch(`/seb/${SEB_CONFIG_FILE}`, { method: "HEAD", cache: "no-store" })
      .catch(() => null);
    if (!present?.ok) {
      return show("The Safe Exam Browser configuration has not been published on this site yet. Tell the invigilator.");
    }

    const res = await callFunction("create-seb-launch", { exam_code: examCode });
    if (res.error) return show(res.error);

    // sebs:// is https carried by Safe Exam Browser. The query parameter reaches
    // the exam page because "Allow Query Parameter" is on in the configuration.
    const launch = new URL(`/seb/${SEB_CONFIG_FILE}`, location.origin);
    launch.protocol = location.protocol === "https:" ? "sebs:" : "seb:";
    launch.searchParams.set("launch", res.launch_token);

    msg.className = "notice ok";
msg.innerHTML = `
  <b>Secure launch is ready.</b><br>
  <span style="display:inline-block;margin:.45rem 0 .7rem">
    Click below and choose <b>Open Safe Exam Browser</b>.
  </span><br>
  <a class="btn" href="${launch.toString()}">
    Open Safe Exam Browser
  </a>
  <br>
  <span class="meta" style="display:inline-block;margin-top:.65rem">
    Do not log in again inside SEB.
  </span>
`;
msg.classList.remove("hidden");
setBusy(false);
  } finally {
    setTimeout(() => setBusy(false), 4500);
  }
}

function setBusy(on) {
  busy = on;
  startBtn.disabled = on;
  startBtn.textContent = on ? "Opening SEB…" : "Start secure exam";
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
