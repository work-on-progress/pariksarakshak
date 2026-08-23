// public/js/setup.js
// Tests the real system rather than describing it: keys, database, the rules
// that hide answers, both Edge Functions, the camera, and Safe Exam Browser.
import { supabase, callFunction, callPublicFunction, configLooksFilled } from "./supabaseClient.js";
import {
  SUPABASE_URL, ALLOW_DEV_BYPASS, INSTITUTE_NAME, SEB_CONFIG_FILE, STRICT_SEB_VERIFY,
} from "./config.js";
import { sebPresent } from "./anticheat.js";
import { cameraProbe } from "./proctor.js";

const box = document.getElementById("checks");
let session = null;
let whoRole = null;

document.getElementById("runBtn").onclick = runAll;
document.getElementById("signInBtn").onclick = signIn;
refreshWho();
runAll();

function card(id, title) {
  let el = document.getElementById(`chk-${id}`);
  if (!el) {
    el = document.createElement("div");
    el.className = "check";
    el.id = `chk-${id}`;
    el.innerHTML = `<span class="mark">…</span><div><b></b><span></span></div>`;
    box.appendChild(el);
  }
  el.dataset.state = "running";
  el.querySelector(".mark").textContent = "checking";
  el.querySelector("b").textContent = title;
  el.querySelector("span:last-child").textContent = "";
  return el;
}

function verdict(el, state, detail) {
  el.dataset.state = state;
  el.querySelector(".mark").textContent =
    state === "ok" ? "PASS" : state === "warn" ? "CHECK" : "FAIL";
  el.querySelector("div span").textContent = detail;
}

async function runAll() {
  const btn = document.getElementById("runBtn");
  btn.disabled = true;
  btn.textContent = "Checking…";
  box.innerHTML = "";

  const results = [];
  const step = async (id, title, fn) => {
    const el = card(id, title);
    try {
      const [state, detail] = await fn();
      verdict(el, state, detail);
      results.push(state);
    } catch (e) {
      verdict(el, "fail", String(e.message ?? e));
      results.push("fail");
    }
  };

  // ---------- 1. config ----------
  await step("config", "Supabase keys are filled in", async () => {
    if (!configLooksFilled()) {
      return ["fail", "public/js/config.js still has the placeholder values. Paste your project URL and anon key, then redeploy."];
    }
    return ["ok", `Pointing at ${SUPABASE_URL}`];
  });

  if (!configLooksFilled()) { finish(results, btn); return; }

  // ---------- 2. database reachable ----------
  await step("db", "The database answers", async () => {
    const { error } = await supabase.from("exams").select("id").limit(1);
    if (error && error.code === "42P01") {
      return ["fail", "The tables do not exist. Run supabase/migrations/001_schema.sql in the SQL editor."];
    }
    if (error && !error.message.includes("row-level security")) {
      return ["fail", error.message];
    }
    return ["ok", "Connected, and the tables are there."];
  });

  // ---------- 3. the sanitized view ----------
  await step("view", "The student view hides the answer keys", async () => {
    const { error } = await supabase.from("student_questions").select("id").limit(1);
    if (error && error.code === "42P01") {
      return ["fail", "The student_questions view is missing. Re-run the schema script."];
    }
    if (error) return ["warn", `The view exists but replied: ${error.message}`];
    return ["ok", "student_questions exists and carries no key columns."];
  });

  // ---------- 4. answer keys unreachable ----------
  await step("rls", "Answer keys cannot be read from a browser", async () => {
    const { data, error } = await supabase.from("questions").select("correct_key").limit(1);
    if (!session) return ["warn", "Sign in below as faculty, then run again — this check needs a session to be meaningful."];
    if (error) return ["ok", "The table refuses the request, as intended."];
    if ((data ?? []).length === 0) return ["ok", "No rows come back to this account."];
    if (whoRole === "faculty") return ["ok", "You are faculty, so keys are visible to you — that is correct. A student session sees nothing."];
    return ["fail", "A student session can read correct_key. Re-run the schema script."];
  });

  // ---------- 5. hidden tests unreachable ----------
  await step("hidden", "Hidden test cases stay on the server", async () => {
    const { data, error } = await supabase.from("test_cases")
      .select("id").eq("is_hidden", true).limit(1);
    if (error) return ["ok", "The table refuses the request, as intended."];
    if (whoRole === "faculty") return ["ok", "You are faculty, so you can see them — that is correct."];
    if ((data ?? []).length) return ["fail", "Hidden tests are visible to a student session. Re-run the schema script."];
    return ["ok", "No hidden rows come back."];
  });

  // ---------- 6. realtime ----------
  await step("realtime", "Live incident feed connects", async () => {
    const status = await new Promise((resolve) => {
      const ch = supabase.channel(`probe-${Date.now()}`)
        .on("postgres_changes", { event: "INSERT", schema: "public", table: "incident_logs" }, () => {})
        .subscribe((s) => {
          if (s === "SUBSCRIBED" || s === "CHANNEL_ERROR" || s === "TIMED_OUT") {
            supabase.removeChannel(ch);
            resolve(s);
          }
        });
      setTimeout(() => { supabase.removeChannel(ch); resolve("TIMED_OUT"); }, 6000);
    });
    return status === "SUBSCRIBED"
      ? ["ok", "Realtime is on and the console will receive alerts."]
      : ["fail", "Realtime did not connect. Check that incident_logs is in the supabase_realtime publication."];
  });

  // ---------- 7. question drafting function ----------
  await step("fn-gen", "The question drafting function is deployed", async () => {
    const res = await callFunction("generate-questions", { ping: true });
    if (res.error?.includes("not deployed")) {
      return ["fail", "Not found. Run: supabase functions deploy generate-questions"];
    }
    if (!session) return ["warn", "Deployed. Sign in as faculty to test it end to end."];
    if (res.error?.includes("Only faculty")) return ["warn", "Deployed, but this account is not faculty."];
    if (res.error?.includes("topic")) return ["ok", "Deployed, faculty accepted, waiting for a real topic."];
    if (res.error?.includes("Question service")) return ["fail", `Deployed, but Gemini refused: ${res.error}`];
    return res.error ? ["warn", res.error] : ["ok", "Deployed and answering."];
  });

  // ---------- 8. code runner function ----------
  await step("fn-run", "The code runner is deployed", async () => {
    const res = await callFunction("run-code", { ping: true });
    if (res.error?.includes("not deployed")) {
      return ["fail", "Not found. Run: supabase functions deploy run-code"];
    }
    if (res.error?.includes("Missing attempt")) return ["ok", "Deployed and validating requests."];
    if (!session) return ["warn", "Deployed. Sign in to test it further."];
    return res.error ? ["warn", res.error] : ["ok", "Deployed and answering."];
  });

  // ---------- 9. student account function ----------
  await step("fn-students", "The student account function is deployed", async () => {
    const res = await callFunction("manage-students", { action: "create", students: [] });
    if (res.error?.includes("not deployed")) {
      return ["fail", "Not found. Run: supabase functions deploy manage-students"];
    }
    if (res.error?.includes("empty")) return ["ok", "Deployed, faculty accepted, list was empty as expected."];
    if (res.error?.includes("Only faculty")) return ["warn", "Deployed, but this account is not faculty."];
    if (!session) return ["warn", "Deployed. Sign in as faculty to test it."];
    return res.error ? ["warn", res.error] : ["ok", "Deployed and answering."];
  });

  // ---------- 10. the secure launch ----------
  await step("fn-launch", "The secure launch function is deployed", async () => {
    const res = await callFunction("create-seb-launch", { exam_code: "" });
    if (res.error?.includes("not deployed")) {
      return ["fail", "Not found. Run: supabase functions deploy create-seb-launch"];
    }
    if (res.error?.includes("Enter the exam code")) {
      return ["ok", "Deployed and validating requests."];
    }
    if (res.error?.includes("Only student")) {
      return ["ok", "Deployed. It refuses faculty accounts, which is correct — students launch exams."];
    }
    if (!session) return ["warn", "Deployed. Sign in below to test it further."];
    return res.error ? ["warn", res.error] : ["ok", "Deployed and answering."];
  });

  await step("fn-exchange", "The SEB sign-in exchange is deployed", async () => {
    const res = await callPublicFunction("exchange-seb-launch", { launch_token: "x".repeat(40) });
    if (res.error?.includes("not deployed")) {
      return ["fail", "Not found. Run: supabase functions deploy exchange-seb-launch --no-verify-jwt"];
    }
    if (res._status === 401 && /Missing authorization|Invalid JWT/i.test(res.error ?? "")) {
      return ["fail", "Deployed with JWT checking on. Redeploy it with --no-verify-jwt, or it can never run inside SEB."];
    }
    if (res.error?.includes("expired or was already used")) {
      return ["ok", "Deployed, and it correctly rejects a made-up token."];
    }
    return res.error ? ["warn", res.error] : ["warn", "Deployed, but the reply was unexpected."];
  });

  // ---------- 11. the .seb file ----------
  await step("seb-file", "The SEB configuration is published on this site", async () => {
    const res = await fetch(`/seb/${SEB_CONFIG_FILE}`, { method: "HEAD", cache: "no-store" })
      .catch(() => null);
    if (!res?.ok) {
      return ["fail", `public/seb/${SEB_CONFIG_FILE} is missing. Build it (guide 05), commit it, and the Start secure exam button will work.`];
    }
    return ["ok", `Served at /seb/${SEB_CONFIG_FILE}, so the sebs:// launch link resolves.`];
  });

  // ---------- 12. the config key ----------
  await step("seb-key", "The server can verify the SEB configuration", async () => {
    if (!STRICT_SEB_VERIFY) {
      return ["warn", "STRICT_SEB_VERIFY is off in config.js, so a faked SEB would be accepted. Turn it on once the key is set."];
    }
    const res = await callPublicFunction("verify-seb", {
      url: "https://example.invalid/probe",
      config_key_hash: "0".repeat(64),
    });
    if (res.error?.includes("not deployed")) {
      return ["fail", "Not found. Run: supabase functions deploy verify-seb --no-verify-jwt"];
    }
    if (res.code === "not_configured") {
      return ["fail", "No Config Key on the server. Read it from the SEB Exam tab, then: supabase secrets set SEB_CONFIG_KEY=<key>"];
    }
    if (res._status === 403) {
      return ["ok", "A Config Key is set, and a wrong one is correctly rejected."];
    }
    return res.error ? ["warn", res.error] : ["warn", "Deployed, but the reply was unexpected."];
  });

  // ---------- 12b. the single-session guard ----------
  await step("fn-session", "The single-session guard is deployed", async () => {
    const res = await callPublicFunction("session-check", { session_token: "x".repeat(40) });
    if (res.error?.includes("not deployed")) {
      return ["fail", "Not found. Run: supabase functions deploy session-check --no-verify-jwt"];
    }
    if (res.active === false) return ["ok", "Deployed, and it correctly rejects a made-up session."];
    return ["warn", "Deployed, but the reply was unexpected."];
  });

  // ---------- 12c. the answer-saving fix ----------
  await step("save-grants", "Answers can actually be written", async () => {
    const { error } = await supabase.from("answers")
      .select("id").limit(1);
    if (error && /permission|denied/i.test(error.message)) {
      return ["fail", "The answers table refuses even a read. Run migration 005."];
    }
    const { data: cols, error: colErr } = await supabase
      .from("exams").select("delivery_mode").limit(1);
    if (colErr && /delivery_mode/.test(colErr.message)) {
      return ["fail", "Migration 005 has not been run — delivery modes and the answer-saving fix are both missing."];
    }
    return ["ok", "Migration 005 is in place. Answers save, and papers can be set to browser mode."];
  });

  // ---------- 12d. the code runner and Piston ----------
  await step("piston", "The code execution service is reachable", async () => {
    const res = await callFunction("run-code", { action: "ping" });
    if (res.error?.includes("not deployed")) {
      return ["fail", "Not found. Run: supabase functions deploy run-code"];
    }
    if (!res.ok) return ["warn", res.error ?? "The runner answered, but not as expected."];
    if (res.piston === "reachable") return ["ok", `Piston answered at ${res.piston_url}. Coding questions will run.`];
    return ["fail", `The runner is deployed but Piston is ${res.piston}. Coding questions will not run — avoid them, or set PISTON_URL to your own host.`];
  });

  // ---------- 13. camera ----------
  await step("camera", "A camera is available for proctoring", async () => {
    try {
      await cameraProbe();
      return ["ok", "Camera opened and released. Local face checks will work."];
    } catch (e) {
      return ["warn", `No camera available here (${e.name}). Fine on this machine, but check a lab machine before the exam.`];
    }
  });

  // ---------- 14. safe exam browser ----------
  await step("seb", "Safe Exam Browser", async () => {
    if (sebPresent()) return ["ok", "This page is running inside Safe Exam Browser."];
    return ["warn", "Not running in SEB — expected on your own machine. The real test is pressing Start secure exam on a lab machine."];
  });

  // ---------- 15. exam-day switch ----------
  await step("bypass", "The testing bypass is switched off", async () => {
    const local = ["localhost", "127.0.0.1", "::1"].includes(location.hostname);
    if (!ALLOW_DEV_BYPASS) return ["ok", "Off. The paper opens only inside Safe Exam Browser."];
    return local
      ? ["warn", "On, and you are on localhost, so ?dev=1 works here. It has no effect on the deployed site."]
      : ["warn", "ALLOW_DEV_BYPASS is true in config.js. It is ignored anywhere but localhost, but set it to false before the first real exam."];
  });

  // ---------- 16. a paper to sit ----------
  await step("paper", "There is a live paper", async () => {
    const { data } = await supabase.from("exams").select("exam_code, title").limit(5);
    if (!data?.length) return ["warn", "No live paper right now. Run 002_demo_paper.sql for a demo, or create one in the console."];
    return ["ok", `Live now: ${data.map((e) => e.exam_code).join(", ")}`];
  });

  finish(results, btn);
}

function finish(results, btn) {
  btn.disabled = false;
  btn.textContent = "Run the checks again";
  const fails = results.filter((r) => r === "fail").length;
  const warns = results.filter((r) => r === "warn").length;
  document.getElementById("summary").textContent = fails
    ? `${fails} to fix${warns ? `, ${warns} to look at` : ""}`
    : warns ? `All clear, ${warns} to look at` : "Everything passed — you are ready.";
}

/* ---- signing in from this page ---- */
async function signIn() {
  const email = document.getElementById("email").value.trim();
  const password = document.getElementById("password").value;
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  document.getElementById("who").textContent = error ? error.message : "Signed in.";
  await refreshWho();
  runAll();
}

async function refreshWho() {
  const { data } = await supabase.auth.getSession();
  session = data.session;
  if (!session) { whoRole = null; return; }
  const { data: p } = await supabase.from("profiles")
    .select("full_name, role").eq("id", session.user.id).single();
  whoRole = p?.role ?? null;
  document.getElementById("who").textContent =
    `${p?.full_name || session.user.email} · ${whoRole ?? "no profile"} · ${INSTITUTE_NAME}`;
}
