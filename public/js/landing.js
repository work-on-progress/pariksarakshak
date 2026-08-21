// public/js/landing.js
import { supabase, configLooksFilled } from "./supabaseClient.js";
import { INSTITUTE_NAME } from "./config.js";

document.getElementById("instituteTag").textContent = INSTITUTE_NAME;
document.getElementById("footInstitute").textContent = INSTITUTE_NAME;

/* ══════ 1. THE HALL PLAN ══════
   An illustration, not live data: the seats seal in a sweep, then a few raise
   the kind of incident the real system logs. */
const seatsEl = document.getElementById("seats");
const feedEl = document.getElementById("planFeed");
const clockEl = document.getElementById("planClock");
const seats = [];

for (const r of "ABCDEF") {
  for (let c = 1; c <= 8; c++) {
    const el = document.createElement("div");
    el.className = "seat";
    el.textContent = `${r}${c}`;
    if ((r === "F" && c > 6) || (r === "E" && c === 8)) el.classList.add("empty");
    seatsEl.appendChild(el);
    seats.push(el);
  }
}

const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const occupied = seats.filter((s) => !s.classList.contains("empty"));

if (reduced) {
  occupied.forEach((s) => s.classList.add("sealed"));
  clockEl.textContent = `${occupied.length} sealed`;
  say("B4", "no face in frame · 6s");
} else {
  occupied.forEach((s, i) => setTimeout(() => {
    s.classList.add("sealed");
    clockEl.textContent = `${i + 1} sealed`;
  }, 40 + i * 28));

  const done = occupied.length * 28 + 400;
  setTimeout(() => flag("B4", "no face in frame · 6s"), done + 900);
  setTimeout(() => flag("D7", "second face detected"), done + 3600);
  setTimeout(() => flag("A2", "window lost focus"), done + 6600);
}

function flag(code, why) {
  const s = seats.find((x) => x.textContent === code);
  if (!s) return;
  s.classList.add("flagged");
  say(code, why);
  setTimeout(() => s.classList.remove("flagged"), 4200);
}
function say(code, why) {
  feedEl.innerHTML = `<div><span class="dot"></span><b>${code}</b>&nbsp;${why}</div>`;
}

/* ══════ 2. SIGN IN AND REGISTER ══════ */
const tabSignin = document.getElementById("tabSignin");
const tabRegister = document.getElementById("tabRegister");
const registerFields = document.getElementById("registerFields");
const submitBtn = document.getElementById("submitBtn");
const msg = document.getElementById("authMsg");
let mode = "signin";

tabSignin.onclick = () => setMode("signin");
tabRegister.onclick = () => setMode("register");

function setMode(next) {
  mode = next;
  tabSignin.setAttribute("aria-pressed", String(next === "signin"));
  tabRegister.setAttribute("aria-pressed", String(next === "register"));
  registerFields.classList.toggle("hidden", next === "signin");
  submitBtn.textContent = next === "signin" ? "Sign in" : "Create student account";
  msg.classList.add("hidden");
}

function show(text, kind = "error") {
  msg.textContent = text;
  msg.className = `notice ${kind}`;
  msg.classList.remove("hidden");
}

submitBtn.onclick = async () => {
  if (!configLooksFilled()) {
    show("This site has no Supabase keys yet. Open the setup check to fix it.");
    return;
  }
  const email = document.getElementById("email").value.trim();
  const password = document.getElementById("password").value;
  if (!email || !password) { show("Enter your email and password to continue."); return; }

  submitBtn.disabled = true;
  const original = submitBtn.textContent;
  submitBtn.textContent = mode === "signin" ? "Signing in…" : "Creating account…";

  try {
    if (mode === "register") {
      const full_name = document.getElementById("fullName").value.trim();
      const roll_no = document.getElementById("rollNo").value.trim();
      if (!full_name || !roll_no) {
        show("Add your full name and roll number so results can be matched.");
        return;
      }
      const { error } = await supabase.auth.signUp({
        email, password, options: { data: { full_name, roll_no } },
      });
      if (error) { show(error.message); return; }
      show("Account created. Signing you in…", "ok");
    }

    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) { show(error.message); return; }

    const { data: profile } = await supabase
      .from("profiles").select("role").eq("id", data.user.id).single();
    location.href = profile?.role === "faculty" ? "faculty.html" : "student.html";
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = original;
  }
};

document.getElementById("password").addEventListener("keydown", (e) => {
  if (e.key === "Enter") submitBtn.click();
});

/* ══════ 3. ALREADY SIGNED IN ══════ */
(async () => {
  if (!configLooksFilled()) {
    document.getElementById("topbarSlot").innerHTML =
      `<a class="btn small" href="setup.html">Finish setup</a>`;
    return;
  }
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;
  const { data: profile } = await supabase
    .from("profiles").select("role").eq("id", user.id).single();
  const faculty = profile?.role === "faculty";
  document.getElementById("topbarSlot").innerHTML =
    `<a class="btn small" href="${faculty ? "faculty.html" : "student.html"}">${
      faculty ? "Open console" : "Open my papers"}</a>`;
})();
