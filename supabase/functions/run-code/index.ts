// supabase/functions/run-code/index.ts
//
// PariksaRakshak — reliable Python runner + proper diagnostics
//
// Behaviour:
//   Run visible tests:
//     - executes ONLY visible examples
//     - returns Input / Expected / Your Output
//     - returns the real Python compiler/runtime error when code fails
//
//   Submit for marks:
//     - executes visible + hidden tests
//     - hidden inputs/expected outputs NEVER leave this function
//
// Python execution uses Wandbox. The function discovers a current stable
// CPython 3 compiler from Wandbox's /api/list.json instead of permanently
// hard-coding a single "head" compiler.

import { createClient } from "npm:@supabase/supabase-js@2";

const WANDBOX_BASE =
  Deno.env.get("WANDBOX_BASE") ?? "https://wandbox.org/api";

const PISTON_URL =
  Deno.env.get("PISTON_URL") ?? "https://emkc.org/api/v2/piston/execute";

const PISTON_TOKEN =
  Deno.env.get("PISTON_TOKEN") ?? "";

const GAP_MS =
  Number(Deno.env.get("CODE_RUNNER_GAP_MS") ?? 220);

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
};

let pythonCompilerCache:
  | { name: string; expires: number }
  | null = null;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = await req.json().catch(() => ({}));

    // ------------------------------------------------------------
    // Setup check / liveness
    // ------------------------------------------------------------
    if (body.action === "ping") {
      const compiler = await resolvePythonCompiler().catch(() => null);

      return json({
        ok: Boolean(compiler),
        python_runner: "wandbox",
        python_compiler: compiler ?? null,
        piston_configured: Boolean(PISTON_TOKEN),
      }, compiler ? 200 : 503);
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
    // Validate attempt + timing
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
      (
        ex.duration_min +
        (attempt.extra_minutes ?? 0)
      ) * 60_000;

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

    const language = String(q.language ?? "python").toLowerCase();

    // ------------------------------------------------------------
    // Read tests.
    // run    -> visible only
    // submit -> full set
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
    // Execute
    // ------------------------------------------------------------
    const results: Array<Record<string, unknown>> = [];

    let passed = 0;
    let visibleNo = 0;
    let hiddenNo = 0;
    let serviceFailures = 0;

    for (const test of tests) {
      const outcome =
        await runProgram(
          language,
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
        });
      }

      await sleep(GAP_MS);
    }

    // If every provider call failed, this is infrastructure failure,
    // not a wrong answer.
    if (serviceFailures === tests.length) {
      return json(
        {
          error:
            "The code execution service could not be reached. Your code was not judged and your marks were not changed.",
          service_down: true,
        },
        503,
      );
    }

    // ------------------------------------------------------------
    // Full submission writes marks.
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
              allPassed
                ? Number(q.marks)
                : 0,
            updated_at:
              new Date().toISOString(),
          },
          {
            onConflict:
              "attempt_id,question_id",
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
      all_passed:
        passed === tests.length,
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
// Provider selection
// ============================================================

async function runProgram(
  language: string,
  code: string,
  stdin: string,
): Promise<RunOutcome> {
  if (language === "python") {
    return await runWandboxPython(code, stdin);
  }

  if (PISTON_TOKEN) {
    return await runPiston(language, code, stdin);
  }

  return {
    stdout: "",
    stderr:
      "No execution provider is configured for this language. Python is available; other languages currently require the configured Piston service.",
    serviceError: true,
    exitCode: -1,
    runner: "none",
  };
}

// ============================================================
// Wandbox Python
// ============================================================

async function resolvePythonCompiler(): Promise<string> {
  const now = Date.now();

  if (
    pythonCompilerCache &&
    pythonCompilerCache.expires > now
  ) {
    return pythonCompilerCache.name;
  }

  const res = await fetch(
    `${WANDBOX_BASE}/list.json`,
    {
      signal:
        AbortSignal.timeout(8000),
      headers: {
        Accept: "application/json",
      },
    },
  );

  if (!res.ok) {
    throw new Error(
      `Wandbox compiler list returned HTTP ${res.status}`,
    );
  }

  const list = await res.json();

  if (!Array.isArray(list)) {
    throw new Error(
      "Wandbox compiler list was not an array.",
    );
  }

  const candidates =
    list
      .filter((c: any) => {
        const language =
          String(c?.language ?? "");

        const version =
          String(c?.version ?? "");

        const name =
          String(c?.name ?? "");

        return (
          language === "Python" &&
          /python-3\./i.test(version) &&
          /cpython/i.test(name)
        );
      })
      .map((c: any) => ({
        name:
          String(c.name),
        version:
          String(c.version),
      }));

  if (!candidates.length) {
    throw new Error(
      "No CPython 3 compiler is currently listed by Wandbox.",
    );
  }

  // Prefer a stable compiler over a moving "head" build.
  const stable =
    candidates.filter(
      (c) =>
        !/head/i.test(c.name),
    );

  const pool =
    stable.length
      ? stable
      : candidates;

  pool.sort(
    (a, b) =>
      compareVersion(
        b.version,
        a.version,
      ),
  );

  const chosen =
    pool[0].name;

  pythonCompilerCache = {
    name: chosen,
    expires:
      now + 15 * 60_000,
  };

  return chosen;
}

async function runWandboxPython(
  code: string,
  stdin: string,
): Promise<RunOutcome> {
  let compiler: string;

  try {
    compiler =
      await resolvePythonCompiler();
  } catch (e) {
    return {
      stdout: "",
      stderr: String(e),
      serviceError: true,
      exitCode: -1,
      runner: "wandbox",
    };
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(
        `${WANDBOX_BASE}/compile.json`,
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json",
            Accept:
              "application/json",
          },

          body:
            JSON.stringify({
              compiler,
              code,
              stdin,
              save: false,
            }),

          signal:
            AbortSignal.timeout(
              25_000,
            ),
        },
      );

      if (res.status === 429) {
        await sleep(1000);
        continue;
      }

      if (!res.ok) {
        const detail =
          (await res.text())
            .slice(0, 500);

        return {
          stdout: "",
          stderr:
            `Wandbox HTTP ${res.status}: ${detail}`,
          serviceError: true,
          exitCode: -1,
          runner:
            `wandbox:${compiler}`,
        };
      }

      const data =
        await res.json();

      const exitCode =
        Number(
          data.status ?? -1,
        );

      // Wandbox provides runtime and compiler errors separately.
      // The previous implementation ignored program_error, which is
      // why the UI only showed "Program exited with status 1."
      const stdout =
        String(
          data.program_output ??
            "",
        );

      const stderrParts = [
        data.compiler_error,
        data.program_error,
      ]
        .map((v) =>
          String(v ?? "").trim(),
        )
        .filter(Boolean);

      let stderr =
        stderrParts.join("\n");

      // Some Wandbox responses only populate the merged message field.
      if (
        exitCode !== 0 &&
        !stderr
      ) {
        const merged =
          String(
            data.program_message ??
              data.compiler_message ??
              "",
          ).trim();

        if (
          merged &&
          normalizeOutput(merged) !==
            normalizeOutput(stdout)
        ) {
          stderr = merged;
        }
      }

      // If Wandbox gives a non-zero status with absolutely no diagnostic,
      // invalidate the compiler cache once and retry using a newly-resolved
      // stable compiler.
      if (
        exitCode !== 0 &&
        !stdout &&
        !stderr &&
        attempt === 0
      ) {
        pythonCompilerCache = null;

        try {
          compiler =
            await resolvePythonCompiler();
        } catch {
          // keep current compiler and allow the next loop to return
        }

        await sleep(500);
        continue;
      }

      return {
        stdout,
        stderr,
        serviceError: false,
        exitCode,
        runner:
          `wandbox:${compiler}`,
      };
    } catch (e) {
      if (attempt === 1) {
        return {
          stdout: "",
          stderr:
            `Could not reach Wandbox (${e})`,
          serviceError: true,
          exitCode: -1,
          runner:
            `wandbox:${compiler}`,
        };
      }

      await sleep(700);
    }
  }

  return {
    stdout: "",
    stderr:
      "Wandbox did not return a usable result.",
    serviceError: true,
    exitCode: -1,
    runner:
      `wandbox:${compiler}`,
  };
}

// ============================================================
// Optional Piston for non-Python languages
// ============================================================

async function runPiston(
  language: string,
  code: string,
  stdin: string,
): Promise<RunOutcome> {
  const langMap:
    Record<
      string,
      {
        language: string;
        version: string;
        file: string;
      }
    > = {
      c: {
        language: "c",
        version: "10.2.0",
        file: "main.c",
      },

      cpp: {
        language: "c++",
        version: "10.2.0",
        file: "main.cpp",
      },

      java: {
        language: "java",
        version: "15.0.2",
        file: "Main.java",
      },

      javascript: {
        language:
          "javascript",
        version:
          "18.15.0",
        file:
          "main.js",
      },
    };

  const lang =
    langMap[language];

  if (!lang) {
    return {
      stdout: "",
      stderr:
        `Language not supported: ${language}`,
      serviceError: true,
      exitCode: -1,
      runner: "piston",
    };
  }

  try {
    const res = await fetch(
      PISTON_URL,
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json",
          Authorization:
            PISTON_TOKEN,
        },

        body:
          JSON.stringify({
            language:
              lang.language,
            version:
              lang.version,
            files: [
              {
                name:
                  lang.file,
                content:
                  code,
              },
            ],
            stdin,
            run_timeout:
              5000,
            compile_timeout:
              10000,
          }),

        signal:
          AbortSignal.timeout(
            25_000,
          ),
      },
    );

    if (!res.ok) {
      return {
        stdout: "",
        stderr:
          `Piston HTTP ${res.status}: ${(await res.text()).slice(0, 400)}`,
        serviceError: true,
        exitCode: -1,
        runner: "piston",
      };
    }

    const data =
      await res.json();

    const exitCode =
      Number(
        data.run?.code ??
          data.compile?.code ??
          0,
      );

    return {
      stdout:
        String(
          data.run?.stdout ??
            "",
        ),

      stderr:
        String(
          data.compile?.stderr ||
            data.run?.stderr ||
            "",
        ).slice(0, 1500),

      serviceError: false,
      exitCode,
      runner: "piston",
    };
  } catch (e) {
    return {
      stdout: "",
      stderr:
        `Could not reach Piston (${e})`,
      serviceError: true,
      exitCode: -1,
      runner: "piston",
    };
  }
}

// ============================================================
// Helpers
// ============================================================

function normalizeOutput(
  value: unknown,
) {
  return String(value ?? "")
    .replace(/\r\n/g, "\n")
    .trimEnd();
}

function compareVersion(
  a: string,
  b: string,
) {
  const pa =
    (
      a.match(
        /\d+(?:\.\d+)+/,
      )?.[0] ??
      "0"
    )
      .split(".")
      .map(Number);

  const pb =
    (
      b.match(
        /\d+(?:\.\d+)+/,
      )?.[0] ??
      "0"
    )
      .split(".")
      .map(Number);

  const n =
    Math.max(
      pa.length,
      pb.length,
    );

  for (
    let i = 0;
    i < n;
    i++
  ) {
    const diff =
      (pa[i] ?? 0) -
      (pb[i] ?? 0);

    if (diff !== 0) {
      return diff;
    }
  }

  return 0;
}

function json(
  body: unknown,
  status = 200,
) {
  return new Response(
    JSON.stringify(body),
    {
      status,

      headers: {
        ...corsHeaders,

        "Content-Type":
          "application/json",

        "Cache-Control":
          "no-store",
      },
    },
  );
}