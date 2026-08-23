// supabase/functions/run-code/index.ts
//
// PariksaRakshak code runner.
//
// IMPORTANT 2026 change:
// The old public Piston instance is no longer safely usable without an
// authorization token. For Python papers we therefore use Wandbox first,
// then fall back to Piston only when it is configured/reachable.
//
// Hidden tests are read with the service-role key and NEVER returned to the
// student. Visible tests return input, expected output and the student's output.

import { createClient } from "npm:@supabase/supabase-js@2";

const PISTON_URL =
  Deno.env.get("PISTON_URL") ?? "https://emkc.org/api/v2/piston/execute";
const PISTON_TOKEN = Deno.env.get("PISTON_TOKEN") ?? "";

const WANDBOX_URL =
  Deno.env.get("WANDBOX_URL") ?? "https://wandbox.org/api/compile.json";

const GAP_MS = Number(Deno.env.get("CODE_RUNNER_GAP_MS") ?? 250);

const LANG_MAP: Record<
  string,
  { language: string; version: string; file: string }
> = {
  python: {
    language: "python",
    version: "3.10.0",
    file: "main.py",
  },
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
    language: "javascript",
    version: "18.15.0",
    file: "main.js",
  },
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const sleep = (ms: number) =>
  new Promise((resolve) => setTimeout(resolve, ms));

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = await req.json().catch(() => ({}));

    // ------------------------------------------------------------
    // Setup-page health check.
    // ------------------------------------------------------------
    if (body.action === "ping") {
      const [wandbox, piston] = await Promise.all([
        pingUrl("https://wandbox.org/api/list.json"),
        PISTON_TOKEN
          ? pingUrl(PISTON_URL.replace("/execute", "/runtimes"), {
              Authorization: PISTON_TOKEN,
            })
          : Promise.resolve("not configured"),
      ]);

      return json({
        ok: true,
        primary_python_runner: "wandbox",
        wandbox,
        piston,
      });
    }

    // ------------------------------------------------------------
    // Authentication.
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

    if (
      !attempt_id ||
      !question_id ||
      typeof code !== "string"
    ) {
      return json(
        { error: "Missing attempt, question or code." },
        400,
      );
    }

    if (!code.trim()) {
      return json({ error: "Write some code first." }, 400);
    }

    if (code.length > 50_000) {
      return json(
        { error: "That submission is too long." },
        400,
      );
    }

    if (!["run", "submit"].includes(mode)) {
      return json({ error: "Unknown code-run mode." }, 400);
    }

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    // ------------------------------------------------------------
    // Attempt + timing validation.
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
      (ex.duration_min + (attempt.extra_minutes ?? 0)) *
        60_000;

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
    // Coding question validation.
    // ------------------------------------------------------------
    const { data: q } = await admin
      .from("questions")
      .select("id, exam_id, qtype, marks, language")
      .eq("id", question_id)
      .single();

    if (
      !q ||
      q.exam_id !== attempt.exam_id ||
      q.qtype !== "coding"
    ) {
      return json(
        {
          error:
            "That is not a coding question on this paper.",
        },
        400,
      );
    }

    const language = q.language ?? "python";
    const lang = LANG_MAP[language];

    if (!lang) {
      return json(
        { error: `Language not supported: ${language}` },
        400,
      );
    }

    // ------------------------------------------------------------
    // Visible run = only examples.
    // Submit = all visible + hidden.
    // ------------------------------------------------------------
    let query = admin
      .from("test_cases")
      .select(
        "id, stdin, expected_out, is_hidden, position",
      )
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
              ? "This coding question has no visible example tests. Ask the teacher to regenerate or edit this coding question."
              : "This coding question has no test cases. Ask the teacher to regenerate or edit this coding question.",
          missing_tests: true,
        },
        400,
      );
    }

    // ------------------------------------------------------------
    // Execute one test at a time.
    // ------------------------------------------------------------
    const results: Array<Record<string, unknown>> = [];

    let passed = 0;
    let visible = 0;
    let hidden = 0;
    let serviceFailures = 0;

    for (const t of tests) {
      const name = t.is_hidden
        ? `Hidden test ${++hidden}`
        : `Visible test ${++visible}`;

      const outcome = await runOnce(
        language,
        lang,
        code,
        t.stdin,
      );

      if (outcome.serviceError) {
        serviceFailures++;
      }

      const expected = normalizeOutput(t.expected_out);
      const actual = normalizeOutput(outcome.stdout);

      const pass =
        !outcome.serviceError &&
        actual === expected;

      if (pass) passed++;

      if (t.is_hidden) {
        results.push({
          name,
          pass,
          hidden: true,
          ...(outcome.serviceError
            ? { note: "could not run" }
            : {}),
        });
      } else {
        results.push({
          name,
          pass,
          hidden: false,
          input: t.stdin,
          expected,
          got: actual,
          stderr: outcome.stderr,
          runner: outcome.runner,
        });
      }

      await sleep(GAP_MS);
    }

    // Every execution service failed: do NOT grade the student.
    if (serviceFailures === tests.length) {
      return json(
        {
          error:
            "The code execution service did not respond. Your code was not judged and no marks were changed.",
          service_down: true,
        },
        503,
      );
    }

    // ------------------------------------------------------------
    // Only full submission writes marks.
    // ------------------------------------------------------------
    if (mode === "submit") {
      const allPassed = passed === tests.length;

      const { error: saveErr } = await admin
        .from("answers")
        .upsert(
          {
            attempt_id,
            question_id,
            code_submitted: code,
            passed_tests: passed,
            total_tests: tests.length,
            auto_marks: allPassed
              ? Number(q.marks)
              : 0,
            updated_at: new Date().toISOString(),
          },
          {
            onConflict: "attempt_id,question_id",
          },
        );

      if (saveErr) {
        return json(
          {
            error:
              `Ran your code, but could not record it: ${saveErr.message}`,
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
// Execution providers
// ============================================================

async function runOnce(
  language: string,
  lang: {
    language: string;
    version: string;
    file: string;
  },
  code: string,
  stdin: string,
) {
  // Python: use Wandbox first. It does not need the Piston token.
  if (language === "python") {
    const wandbox = await runWandboxPython(code, stdin);

    if (!wandbox.serviceError) {
      return wandbox;
    }

    // If a Piston token exists, keep it as a fallback.
    if (PISTON_TOKEN) {
      const piston = await runPiston(lang, code, stdin);
      if (!piston.serviceError) return piston;
    }

    return wandbox;
  }

  // Other languages still use configured Piston.
  if (!PISTON_TOKEN) {
    return {
      stdout: "",
      stderr:
        "No execution provider is configured for this language. Python works through Wandbox; other languages need a Piston token or self-hosted runner.",
      serviceError: true,
      runner: "none",
    };
  }

  return runPiston(lang, code, stdin);
}

async function runWandboxPython(
  code: string,
  stdin: string,
) {
  for (let n = 0; n < 2; n++) {
    try {
      const res = await fetch(WANDBOX_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          compiler: "cpython-head",
          code,
          stdin,
          save: false,
        }),
        signal: AbortSignal.timeout(20_000),
      });

      if (res.status === 429) {
        await sleep(1000);
        continue;
      }

      if (!res.ok) {
        const detail =
          (await res.text()).slice(0, 300);

        return {
          stdout: "",
          stderr:
            `Wandbox HTTP ${res.status}: ${detail}`,
          serviceError: true,
          runner: "wandbox",
        };
      }

      const data = await res.json();

      const status = String(data.status ?? "");
      const stdout = String(
        data.program_output ??
          data.program_message ??
          "",
      );

      const stderr = String(
        data.compiler_error ??
          data.compiler_message ??
          "",
      ).slice(0, 1200);

      // Wandbox status "0" means program completed normally.
      if (status && status !== "0") {
        return {
          stdout,
          stderr:
            stderr ||
            `Program exited with status ${status}.`,
          serviceError: false,
          runner: "wandbox",
        };
      }

      return {
        stdout,
        stderr,
        serviceError: false,
        runner: "wandbox",
      };
    } catch (e) {
      if (n === 1) {
        return {
          stdout: "",
          stderr:
            `Could not reach Wandbox (${e})`,
          serviceError: true,
          runner: "wandbox",
        };
      }

      await sleep(700);
    }
  }

  return {
    stdout: "",
    stderr: "Could not reach Wandbox.",
    serviceError: true,
    runner: "wandbox",
  };
}

async function runPiston(
  lang: {
    language: string;
    version: string;
    file: string;
  },
  code: string,
  stdin: string,
) {
  for (let n = 0; n < 2; n++) {
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };

      if (PISTON_TOKEN) {
        headers.Authorization = PISTON_TOKEN;
      }

      const res = await fetch(PISTON_URL, {
        method: "POST",
        headers,
        body: JSON.stringify({
          language: lang.language,
          version: lang.version,
          files: [
            {
              name: lang.file,
              content: code,
            },
          ],
          stdin,
          run_timeout: 5000,
          compile_timeout: 10000,
        }),
        signal: AbortSignal.timeout(25_000),
      });

      if (res.status === 429) {
        await sleep(1200);
        continue;
      }

      if (!res.ok) {
        const detail =
          (await res.text()).slice(0, 300);

        return {
          stdout: "",
          stderr:
            `Piston HTTP ${res.status}: ${detail}`,
          serviceError: true,
          runner: "piston",
        };
      }

      const data = await res.json();

      if (data.message) {
        return {
          stdout: "",
          stderr:
            `Piston: ${String(data.message).slice(0, 300)}`,
          serviceError: true,
          runner: "piston",
        };
      }

      return {
        stdout:
          data.run?.stdout ?? "",
        stderr:
          (
            data.compile?.stderr ||
            data.run?.stderr ||
            ""
          ).slice(0, 1200),
        serviceError: false,
        runner: "piston",
      };
    } catch (e) {
      if (n === 1) {
        return {
          stdout: "",
          stderr:
            `Could not reach Piston (${e})`,
          serviceError: true,
          runner: "piston",
        };
      }

      await sleep(800);
    }
  }

  return {
    stdout: "",
    stderr: "Could not reach Piston.",
    serviceError: true,
    runner: "piston",
  };
}

async function pingUrl(
  url: string,
  headers: Record<string, string> = {},
) {
  try {
    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(6000),
    });

    return res.ok
      ? "reachable"
      : `http ${res.status}`;
  } catch (e) {
    return `unreachable (${e})`;
  }
}

function normalizeOutput(value: unknown) {
  return String(value ?? "")
    .replace(/\r\n/g, "\n")
    .trimEnd();
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
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      },
    },
  );
}
