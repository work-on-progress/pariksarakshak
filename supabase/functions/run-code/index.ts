// supabase/functions/run-code/index.ts
//
// PariksaRakshak — Judge0-backed code runner
//
// Why this file exists:
// The previous Wandbox sandbox returned:
//   ERROR (catatonit:2): failed to exec pid1: No such file or directory
// That is an execution-provider/container failure, not a student's Python error.
//
// Behaviour:
//   Run visible tests
//     -> only visible examples
//     -> returns Input / Expected / Your Output / real error
//
//   Submit for marks
//     -> visible + hidden tests
//     -> hidden input/expected output never leave this function
//
// Judge0 CE is used asynchronously:
//   POST /submissions -> token
//   GET  /submissions/{token} until finished

import { createClient } from "npm:@supabase/supabase-js@2";

const JUDGE0_BASE =
  Deno.env.get("JUDGE0_BASE") ?? "https://ce.judge0.com";

const JUDGE0_AUTH_TOKEN =
  Deno.env.get("JUDGE0_AUTH_TOKEN") ?? "";

const GAP_MS =
  Number(Deno.env.get("CODE_RUNNER_GAP_MS") ?? 180);

const POLL_MS =
  Number(Deno.env.get("JUDGE0_POLL_MS") ?? 350);

const MAX_POLLS =
  Number(Deno.env.get("JUDGE0_MAX_POLLS") ?? 24);

// Stable Judge0 CE language IDs.
// Python is the important one for tomorrow's exam.
const LANGUAGE_ID: Record<string, number> = {
  python: 92,      // Python 3.11.2
  c: 103,          // C GCC 14.1
  cpp: 105,        // C++ GCC 14.1
  java: 91,        // Java 17
  javascript: 93,  // Node.js 18.15
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

type RunOutcome = {
  stdout: string;
  stderr: string;
  serviceError: boolean;
  exitCode: number;
  runner: string;
  statusDescription: string;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = await req.json().catch(() => ({}));

    // ------------------------------------------------------------
    // Setup check / provider health
    // ------------------------------------------------------------
    if (body.action === "ping") {
      const health = await judge0Health();

      return json(
        {
          ok: health.ok,
          provider: "judge0",
          base: JUDGE0_BASE,
          detail: health.detail,
        },
        health.ok ? 200 : 503,
      );
    }

    // ------------------------------------------------------------
    // Authentication
    // ------------------------------------------------------------
    const authHeader = req.headers.get("Authorization") ?? "";

    const supaUser = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      {
        global: {
          headers: {
            Authorization: authHeader,
          },
        },
      },
    );

    const {
      data: { user },
    } = await supaUser.auth.getUser();

    if (!user) {
      return json(
        { error: "Sign in again — the session has expired." },
        401,
      );
    }

    const {
      attempt_id,
      question_id,
      code,
      mode = "run",
    } = body;

    if (!attempt_id || !question_id || typeof code !== "string") {
      return json(
        { error: "Missing attempt, question or code." },
        400,
      );
    }

    if (!code.trim()) {
      return json({ error: "Write some code first." }, 400);
    }

    if (code.length > 50_000) {
      return json({ error: "That submission is too long." }, 400);
    }

    if (!["run", "submit"].includes(mode)) {
      return json({ error: "Unknown run mode." }, 400);
    }

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // ------------------------------------------------------------
    // Validate attempt and timing
    // ------------------------------------------------------------
    const { data: attempt } = await admin
      .from("attempts")
      .select(
        "id, student_id, status, exam_id, extra_minutes, started_at, exams!inner(starts_at, ends_at, duration_min)",
      )
      .eq("id", attempt_id)
      .single();

    if (!attempt || attempt.student_id !== user.id) {
      return json(
        { error: "That attempt belongs to someone else." },
        403,
      );
    }

    if (attempt.status !== "in_progress") {
      return json(
        { error: "This paper has already been submitted." },
        403,
      );
    }

    // deno-lint-ignore no-explicit-any
    const ex: any = attempt.exams;

    const now = Date.now();

    const personalEnd =
      new Date(attempt.started_at).getTime() +
      (ex.duration_min + (attempt.extra_minutes ?? 0)) * 60_000;

    const hardEnd = Math.min(
      new Date(ex.ends_at).getTime(),
      personalEnd,
    );

    if (now < new Date(ex.starts_at).getTime()) {
      return json(
        { error: "This exam is not open yet." },
        403,
      );
    }

    if (now > hardEnd) {
      return json(
        { error: "Your time for this paper is over." },
        403,
      );
    }

    // ------------------------------------------------------------
    // Validate coding question
    // ------------------------------------------------------------
    const { data: q } = await admin
      .from("questions")
      .select("id, exam_id, qtype, marks, language")
      .eq("id", question_id)
      .single();

    if (!q || q.exam_id !== attempt.exam_id || q.qtype !== "coding") {
      return json(
        { error: "That is not a coding question on this paper." },
        400,
      );
    }

    const language =
      String(q.language ?? "python").toLowerCase();

    const languageId =
      LANGUAGE_ID[language];

    if (!languageId) {
      return json(
        { error: `Language not supported: ${language}` },
        400,
      );
    }

    // ------------------------------------------------------------
    // Read tests:
    // run    -> visible only
    // submit -> visible + hidden
    // ------------------------------------------------------------
    let query = admin
      .from("test_cases")
      .select("id, stdin, expected_out, is_hidden, position")
      .eq("question_id", question_id)
      .order("position");

    if (mode === "run") {
      query = query.eq("is_hidden", false);
    }

    const {
      data: tests,
      error: testErr,
    } = await query;

    if (testErr) {
      return json(
        {
          error:
            `Could not read the test cases: ${testErr.message}`,
        },
        500,
      );
    }

    if (!tests?.length) {
      return json(
        {
          error:
            mode === "run"
              ? "This coding question has no visible example tests."
              : "This coding question has no test cases.",
          missing_tests: true,
        },
        400,
      );
    }

    // ------------------------------------------------------------
    // Execute tests
    // ------------------------------------------------------------
    const results: Array<Record<string, unknown>> = [];

    let passed = 0;
    let visibleNo = 0;
    let hiddenNo = 0;
    let serviceFailures = 0;

    for (const test of tests) {
      const outcome = await runJudge0(
        languageId,
        code,
        String(test.stdin ?? ""),
      );

      if (outcome.serviceError) {
        serviceFailures++;
      }

      const expected =
        normalizeOutput(test.expected_out);

      const actual =
        normalizeOutput(outcome.stdout);

      const pass =
        !outcome.serviceError &&
        outcome.exitCode === 0 &&
        actual === expected;

      if (pass) {
        passed++;
      }

      if (test.is_hidden) {
        results.push({
          name: `Hidden test ${++hiddenNo}`,
          hidden: true,
          pass,
        });
      } else {
        results.push({
          name: `Visible test ${++visibleNo}`,
          hidden: false,
          pass,
          input: String(test.stdin ?? ""),
          expected,
          got: actual,
          stderr: outcome.stderr,
          exit_code: outcome.exitCode,
          runner: outcome.runner,
          status: outcome.statusDescription,
        });
      }

      await sleep(GAP_MS);
    }

    // Infrastructure failure is not a student's wrong answer.
    if (serviceFailures === tests.length) {
      return json(
        {
          error:
            "The code execution provider is temporarily unavailable. Your code was not judged and your marks were not changed.",
          service_down: true,
        },
        503,
      );
    }

    // ------------------------------------------------------------
    // Only full submission writes marks
    // ------------------------------------------------------------
    if (mode === "submit") {
      const allPassed =
        passed === tests.length;

      const { error: saveErr } = await admin
        .from("answers")
        .upsert(
          {
            attempt_id,
            question_id,
            code_submitted: code,
            passed_tests: passed,
            total_tests: tests.length,
            auto_marks:
              allPassed ? Number(q.marks) : 0,
            updated_at:
              new Date().toISOString(),
          },
          {
            onConflict: "attempt_id,question_id",
          },
        );

      if (saveErr) {
        return json(
          {
            error:
              `The tests ran, but the result could not be recorded: ${saveErr.message}`,
          },
          500,
        );
      }
    }

    return json({
      mode,
      passed,
      total: tests.length,
      all_passed: passed === tests.length,
      results,
    });
  } catch (e) {
    console.error(e);

    return json(
      {
        error:
          `Unexpected server error: ${e}`,
      },
      500,
    );
  }
});

// ============================================================
// Judge0
// ============================================================

async function judge0Health() {
  try {
    const res = await fetch(
      `${JUDGE0_BASE}/languages`,
      {
        headers: judge0Headers(),
        signal: AbortSignal.timeout(7000),
      },
    );

    if (!res.ok) {
      return {
        ok: false,
        detail: `HTTP ${res.status}`,
      };
    }

    const data = await res.json();

    return {
      ok: Array.isArray(data) && data.length > 0,
      detail:
        Array.isArray(data)
          ? `${data.length} languages available`
          : "unexpected response",
    };
  } catch (e) {
    return {
      ok: false,
      detail: String(e),
    };
  }
}

async function runJudge0(
  languageId: number,
  code: string,
  stdin: string,
): Promise<RunOutcome> {
  try {
    // ----------------------------------------------------------
    // Create asynchronous submission
    // ----------------------------------------------------------
    const createRes = await fetch(
      `${JUDGE0_BASE}/submissions?base64_encoded=false&wait=false`,
      {
        method: "POST",
        headers: {
          ...judge0Headers(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          language_id: languageId,
          source_code: code,
          stdin,
          cpu_time_limit: 5,
          wall_time_limit: 10,
          memory_limit: 128000,
        }),
        signal: AbortSignal.timeout(12000),
      },
    );

    if (!createRes.ok) {
      const detail =
        (await createRes.text()).slice(0, 500);

      return {
        stdout: "",
        stderr:
          `Judge0 submission failed (HTTP ${createRes.status}): ${detail}`,
        serviceError: true,
        exitCode: -1,
        runner: "judge0",
        statusDescription: "provider error",
      };
    }

    const created = await createRes.json();

    const token =
      String(created?.token ?? "");

    if (!token) {
      return {
        stdout: "",
        stderr:
          "Judge0 did not return a submission token.",
        serviceError: true,
        exitCode: -1,
        runner: "judge0",
        statusDescription: "provider error",
      };
    }

    // ----------------------------------------------------------
    // Poll until processing is complete.
    // Judge0 status:
    //   1 = In Queue
    //   2 = Processing
    //   >=3 = completed
    // ----------------------------------------------------------
    for (let i = 0; i < MAX_POLLS; i++) {
      await sleep(
        i < 3 ? POLL_MS : Math.min(POLL_MS + i * 60, 900),
      );

      const resultRes = await fetch(
        `${JUDGE0_BASE}/submissions/${token}?base64_encoded=false&fields=stdout,stderr,compile_output,message,status,time,memory`,
        {
          headers: judge0Headers(),
          signal: AbortSignal.timeout(9000),
        },
      );

      if (!resultRes.ok) {
        if (resultRes.status >= 500) {
          continue;
        }

        const detail =
          (await resultRes.text()).slice(0, 500);

        return {
          stdout: "",
          stderr:
            `Judge0 result lookup failed (HTTP ${resultRes.status}): ${detail}`,
          serviceError: true,
          exitCode: -1,
          runner: "judge0",
          statusDescription: "provider error",
        };
      }

      const data = await resultRes.json();

      const statusId =
        Number(data?.status?.id ?? 0);

      const statusDescription =
        String(data?.status?.description ?? "");

      if (statusId === 1 || statusId === 2) {
        continue;
      }

      const stdout =
        String(data?.stdout ?? "");

      const stderr = [
        data?.compile_output,
        data?.stderr,
        data?.message,
      ]
        .map((v) => String(v ?? "").trim())
        .filter(Boolean)
        .join("\n");

      // Judge0:
      // status 3 = Accepted/completed normally.
      // Other completed statuses are compile/runtime/time/etc failures.
      const exitCode =
        statusId === 3 ? 0 : 1;

      return {
        stdout,
        stderr:
          stderr ||
          (
            statusId === 3
              ? ""
              : statusDescription || "Program failed."
          ),
        serviceError: false,
        exitCode,
        runner: "judge0",
        statusDescription,
      };
    }

    return {
      stdout: "",
      stderr:
        "Judge0 timed out while waiting for the submission.",
      serviceError: true,
      exitCode: -1,
      runner: "judge0",
      statusDescription: "timeout",
    };
  } catch (e) {
    return {
      stdout: "",
      stderr:
        `Could not reach Judge0 (${e})`,
      serviceError: true,
      exitCode: -1,
      runner: "judge0",
      statusDescription: "provider error",
    };
  }
}

function judge0Headers() {
  const headers: Record<string, string> = {
    Accept: "application/json",
  };

  if (JUDGE0_AUTH_TOKEN) {
    headers["X-Auth-Token"] =
      JUDGE0_AUTH_TOKEN;
  }

  return headers;
}

function normalizeOutput(value: unknown) {
  return String(value ?? "")
    .replace(/\r\n/g, "\n")
    .trimEnd();
}

function json(body: unknown, status = 200) {
  return new Response(
    JSON.stringify(body),
    {
      status,
      headers: {
        ...corsHeaders,
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    },
  );
}