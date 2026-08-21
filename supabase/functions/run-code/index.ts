// supabase/functions/run-code/index.ts
// Runs a student's code against the test cases. Hidden tests are read with the
// service role and their input and expected output never appear in the reply —
// the student learns only pass or fail.
import { createClient } from "npm:@supabase/supabase-js@2";

const PISTON_URL = "https://emkc.org/api/v2/piston/execute";

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
    // 1. Who is asking
    const authHeader = req.headers.get("Authorization") ?? "";
    const supaUser = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: { user } } = await supaUser.auth.getUser();
    if (!user) return json({ error: "Sign in again — the session has expired." }, 401);

    const { attempt_id, question_id, code, mode = "run" } = await req.json();
    if (!attempt_id || !question_id || typeof code !== "string") {
      return json({ error: "Missing attempt, question or code." }, 400);
    }
    if (code.length > 50_000) return json({ error: "That submission is too long." }, 400);

    // 2. Server-side client
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: attempt } = await admin.from("attempts")
      .select("id, student_id, status, exam_id, exams!inner(starts_at, ends_at)")
      .eq("id", attempt_id).single();

    if (!attempt || attempt.student_id !== user.id) {
      return json({ error: "That attempt belongs to someone else." }, 403);
    }
    if (attempt.status !== "in_progress") {
      return json({ error: "This paper has already been submitted." }, 403);
    }
    // deno-lint-ignore no-explicit-any
    const ex: any = attempt.exams;
    const now = new Date();
    if (now < new Date(ex.starts_at) || now > new Date(ex.ends_at)) {
      return json({ error: "This exam is not open right now." }, 403);
    }

    const { data: q } = await admin.from("questions")
      .select("id, exam_id, qtype, marks, language").eq("id", question_id).single();
    if (!q || q.exam_id !== attempt.exam_id || q.qtype !== "coding") {
      return json({ error: "That is not a coding question on this paper." }, 400);
    }
    const lang = LANG_MAP[q.language ?? "python"];
    if (!lang) return json({ error: `Language not supported: ${q.language}` }, 400);

    // 3. Test cases — hidden ones stay on this side
    let query = admin.from("test_cases")
      .select("id, stdin, expected_out, is_hidden, position")
      .eq("question_id", question_id).order("position");
    if (mode === "run") query = query.eq("is_hidden", false);
    const { data: tests } = await query;
    if (!tests?.length) return json({ error: "This question has no test cases yet." }, 400);

    // 4. Execute, one at a time, politely
    const results: Array<Record<string, unknown>> = [];
    let passed = 0, visible = 0, hidden = 0;

    for (const t of tests) {
      const name = t.is_hidden ? `Hidden test ${++hidden}` : `Example ${++visible}`;
      let pass = false, got = "", stderr = "";

      try {
        const pRes = await fetch(PISTON_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            language: lang.language,
            version: lang.version,
            files: [{ name: lang.file, content: code }],
            stdin: t.stdin,
            run_timeout: 5000,
            compile_timeout: 10000,
          }),
        });
        const pData = await pRes.json();
        got = (pData.run?.stdout ?? "").replace(/\r\n/g, "\n").trimEnd();
        stderr = (pData.compile?.stderr || pData.run?.stderr || "").slice(0, 800);
        pass = got === t.expected_out.replace(/\r\n/g, "\n").trimEnd();
      } catch {
        stderr = "The execution service did not respond. Try again.";
      }

      if (pass) passed++;

      results.push(
        t.is_hidden
          ? { name, pass, hidden: true }
          : { name, pass, hidden: false, got, expected: t.expected_out.trimEnd(), stderr },
      );

      await sleep(250);   // stay under the public Piston rate limit
    }

    // 5. Marks are written here, never posted by the browser
    if (mode === "submit") {
      const allPassed = passed === tests.length;
      await admin.from("answers").upsert({
        attempt_id, question_id,
        code_submitted: code,
        passed_tests: passed,
        total_tests: tests.length,
        auto_marks: allPassed ? Number(q.marks) : 0,   // full marks only on a clean sweep
        updated_at: new Date().toISOString(),
      }, { onConflict: "attempt_id,question_id" });
    }

    return json({
      mode,
      passed,
      total: tests.length,
      all_passed: passed === tests.length,
      results,
    });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
