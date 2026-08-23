// supabase/functions/run-code/index.ts
//
// Runs a student's code against the test cases and decides the marks. Hidden
// tests are read with the service key and never appear in the reply — the
// student learns only pass or fail.
//
// Changes that matter if you hit "Failed to fetch" before:
//   * every path returns CORS headers, including the ones that throw, so the
//     browser reports the real error instead of a network failure
//   * "ping" answers without needing an attempt, so the setup page can prove
//     the function is alive
//   * Piston is called with a retry and a timeout, and its own error text is
//     passed through instead of being swallowed
import { createClient } from "npm:@supabase/supabase-js@2";

const PISTON_URL = Deno.env.get("PISTON_URL") ?? "https://emkc.org/api/v2/piston/execute";
const PISTON_TOKEN = Deno.env.get("PISTON_TOKEN") ?? "";
const GAP_MS = Number(Deno.env.get("PISTON_GAP_MS") ?? 220);

const LANG_MAP: Record<string, { language: string; version: string; file: string }> = {
  python:     { language: "python",     version: "3.10.0",  file: "main.py" },
  c:          { language: "c",          version: "10.2.0",  file: "main.c" },
  cpp:        { language: "c++",        version: "10.2.0",  file: "main.cpp" },
  java:       { language: "java",       version: "15.0.2",  file: "Main.java" },
  javascript: { language: "javascript", version: "18.15.0", file: "main.js" },
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json().catch(() => ({}));

    /* ── a liveness probe that needs no exam ── */
    if (body.action === "ping") {
      let piston = "unknown";
      try {
        const probe = await fetch(PISTON_URL.replace("/execute", "/runtimes"), {
          signal: AbortSignal.timeout(6000),
        });
        piston = probe.ok ? "reachable" : `http ${probe.status}`;
      } catch (e) {
        piston = `unreachable (${e})`;
      }
      return json({ ok: true, piston_url: PISTON_URL, piston });
    }

    /* ── who is asking ── */
    const authHeader = req.headers.get("Authorization") ?? "";
    const supaUser = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: { user } } = await supaUser.auth.getUser();
    if (!user) return json({ error: "Sign in again — the session has expired." }, 401);

    const { attempt_id, question_id, code, mode = "run" } = body;
    if (!attempt_id || !question_id || typeof code !== "string") {
      return json({ error: "Missing attempt, question or code." }, 400);
    }
    if (!code.trim()) return json({ error: "Write some code first." }, 400);
    if (code.length > 50_000) return json({ error: "That submission is too long." }, 400);

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: attempt } = await admin.from("attempts")
      .select("id, student_id, status, exam_id, extra_minutes, started_at, exams!inner(starts_at, ends_at, duration_min)")
      .eq("id", attempt_id).single();

    if (!attempt || attempt.student_id !== user.id) {
      return json({ error: "That attempt belongs to someone else." }, 403);
    }
    if (attempt.status !== "in_progress") {
      return json({ error: "This paper has already been submitted." }, 403);
    }

    // deno-lint-ignore no-explicit-any
    const ex: any = attempt.exams;
    const now = Date.now();
    const personalEnd = new Date(attempt.started_at).getTime() +
      (ex.duration_min + (attempt.extra_minutes ?? 0)) * 60_000;
    const hardEnd = Math.min(new Date(ex.ends_at).getTime(), personalEnd);

    if (now < new Date(ex.starts_at).getTime()) {
      return json({ error: "This exam is not open yet." }, 403);
    }
    if (now > hardEnd) {
      return json({ error: "Your time for this paper is over." }, 403);
    }

    const { data: q } = await admin.from("questions")
      .select("id, exam_id, qtype, marks, language").eq("id", question_id).single();
    if (!q || q.exam_id !== attempt.exam_id || q.qtype !== "coding") {
      return json({ error: "That is not a coding question on this paper." }, 400);
    }
    const lang = LANG_MAP[q.language ?? "python"];
    if (!lang) return json({ error: `Language not supported: ${q.language}` }, 400);

    /* ── the test cases; hidden ones never leave this function ── */
    let query = admin.from("test_cases")
      .select("id, stdin, expected_out, is_hidden, position")
      .eq("question_id", question_id).order("position");
    if (mode === "run") query = query.eq("is_hidden", false);

    const { data: tests, error: testErr } = await query;
    if (testErr) return json({ error: `Could not read the test cases: ${testErr.message}` }, 500);
    if (!tests?.length) {
      return json({
        error: mode === "run"
          ? "This question has no example tests yet. Press Submit to run the full set, or tell your teacher."
          : "This question has no test cases yet. Tell your teacher.",
      }, 400);
    }

    /* ── run them, one at a time, politely ── */
    const results: Array<Record<string, unknown>> = [];
    let passed = 0, visible = 0, hidden = 0, serviceFailures = 0;

    for (const t of tests) {
      const name = t.is_hidden ? `Hidden test ${++hidden}` : `Example ${++visible}`;
      const outcome = await runOnce(lang, code, t.stdin);

      if (outcome.serviceError) serviceFailures++;
      const expected = t.expected_out.replace(/\r\n/g, "\n").trimEnd();
      const pass = !outcome.serviceError && outcome.stdout === expected;
      if (pass) passed++;

      results.push(
        t.is_hidden
          ? { name, pass, hidden: true, ...(outcome.serviceError ? { note: "could not run" } : {}) }
          : {
              name, pass, hidden: false,
              got: outcome.stdout, expected,
              stderr: outcome.stderr,
            },
      );

      await sleep(GAP_MS);
    }

    // If the execution service failed on every test, that is not a wrong answer.
    if (serviceFailures === tests.length) {
      return json({
        error: "The code execution service did not respond. Your code was not judged, and nothing was recorded. Try again in a moment.",
        service_down: true,
      }, 503);
    }

    /* ── marks are written here, never posted by the browser ── */
    if (mode === "submit") {
      const allPassed = passed === tests.length;
      const { error: saveErr } = await admin.from("answers").upsert({
        attempt_id, question_id,
        code_submitted: code,
        passed_tests: passed,
        total_tests: tests.length,
        auto_marks: allPassed ? Number(q.marks) : 0,
        updated_at: new Date().toISOString(),
      }, { onConflict: "attempt_id,question_id" });

      if (saveErr) {
        return json({ error: `Ran your code, but could not record it: ${saveErr.message}` }, 500);
      }
    }

    return json({
      mode, passed, total: tests.length,
      all_passed: passed === tests.length,
      results,
    });
  } catch (e) {
    console.error(e);
    return json({ error: `Unexpected server error: ${e}` }, 500);
  }
});

/* ── one execution, with a single retry ──────────────────────────────── */
async function runOnce(
  lang: { language: string; version: string; file: string },
  code: string,
  stdin: string,
) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (PISTON_TOKEN) headers["Authorization"] = PISTON_TOKEN;

      const res = await fetch(PISTON_URL, {
        method: "POST",
        headers,
        body: JSON.stringify({
          language: lang.language,
          version: lang.version,
          files: [{ name: lang.file, content: code }],
          stdin,
          run_timeout: 5000,
          compile_timeout: 10000,
        }),
        signal: AbortSignal.timeout(25000),
      });

      if (res.status === 429) {          // rate limited — wait and retry once
        await sleep(1200);
        continue;
      }
      if (!res.ok) {
        const detail = (await res.text()).slice(0, 200);
        return { stdout: "", stderr: `execution service: ${res.status} ${detail}`, serviceError: true };
      }

      const data = await res.json();
      if (data.message) {                 // Piston's own error shape
        return { stdout: "", stderr: `execution service: ${String(data.message).slice(0, 200)}`, serviceError: true };
      }

      return {
        stdout: (data.run?.stdout ?? "").replace(/\r\n/g, "\n").trimEnd(),
        stderr: (data.compile?.stderr || data.run?.stderr || "").slice(0, 800),
        serviceError: false,
      };
    } catch (e) {
      if (attempt === 1) {
        return { stdout: "", stderr: `could not reach the execution service (${e})`, serviceError: true };
      }
      await sleep(800);
    }
  }
  return { stdout: "", stderr: "could not reach the execution service", serviceError: true };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
