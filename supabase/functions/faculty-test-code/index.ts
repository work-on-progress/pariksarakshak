// supabase/functions/faculty-test-code/index.ts
//
// Faculty-only coding sandbox for "Test paper".
// It runs the same Judge0-style checks without creating attempts or marks.
// Hidden test inputs/expected outputs are never returned to the browser.

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

const LANGUAGE_ID: Record<string, number> = {
  python: 92,
  c: 103,
  cpp: 105,
  java: 91,
  javascript: 93,
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

    const authHeader =
      req.headers.get("Authorization") ?? "";

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

    const { data: profile } = await supaUser
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .single();

    if (profile?.role !== "faculty") {
      return json(
        { error: "Faculty test mode is available only to faculty accounts." },
        403,
      );
    }

    const questionId =
      String(body.question_id ?? "");

    let code =
      typeof body.code === "string"
        ? body.code
        : "";

    const mode =
      String(body.mode ?? "run");

    if (!questionId) {
      return json(
        { error: "Missing coding question." },
        400,
      );
    }

    if (!["run", "submit"].includes(mode)) {
      return json(
        { error: "Unknown faculty test mode." },
        400,
      );
    }

    if (!code.trim()) {
      return json(
        { error: "Write some code first." },
        400,
      );
    }

    if (code.length > 50_000) {
      return json(
        { error: "That submission is too long." },
        400,
      );
    }

    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const { data: q, error: qError } = await admin
      .from("questions")
      .select(
        "id, exam_id, qtype, marks, language, exams!inner(faculty_id)",
      )
      .eq("id", questionId)
      .single();

    if (qError || !q) {
      return json(
        { error: "Coding question not found." },
        404,
      );
    }

    // deno-lint-ignore no-explicit-any
    const ex: any = q.exams;

    if (ex?.faculty_id !== user.id) {
      return json(
        { error: "This question does not belong to your paper." },
        403,
      );
    }

    if (q.qtype !== "coding") {
      return json(
        { error: "That is not a coding question." },
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

    const codeBeforeNormalization = code;
    code = normalizeSourceCode(code, language);
    const sourceNormalized =
      code !== codeBeforeNormalization;

    if (!code.trim()) {
      return json(
        { error: "Write some code first." },
        400,
      );
    }

    let query = admin
      .from("test_cases")
      .select("id, stdin, expected_out, is_hidden, position")
      .eq("question_id", questionId)
      .order("position");

    if (mode === "run") {
      query = query.eq("is_hidden", false);
    }

    const { data: tests, error: testError } =
      await query;

    if (testError) {
      return json(
        { error: `Could not read test cases: ${testError.message}` },
        500,
      );
    }

    if (!tests?.length) {
      return json(
        {
          error:
            mode === "run"
              ? "This question has no visible sample tests."
              : "This question has no test cases.",
        },
        400,
      );
    }

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

      if (pass) passed++;

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

    if (serviceFailures === tests.length) {
      return json(
        {
          error:
            "The code execution provider is temporarily unavailable. Nothing was recorded.",
          service_down: true,
        },
        503,
      );
    }

    const partialMarks =
      tests.length > 0
        ? round2(
            Number(q.marks || 0) *
              passed /
              tests.length,
          )
        : 0;

    return json({
      ok: true,
      faculty_test: true,
      mode,
      passed,
      total: tests.length,
      all_passed: passed === tests.length,
      partial_marks:
        mode === "submit" ? partialMarks : null,
      max_marks: Number(q.marks || 0),
      source_normalized: sourceNormalized,
      results,
    });
  } catch (e) {
    console.error(e);

    return json(
      {
        error:
          `Unexpected faculty test runner error: ${String(e)}`,
      },
      500,
    );
  }
});

async function runJudge0(
  languageId: number,
  code: string,
  stdin: string,
): Promise<RunOutcome> {
  try {
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

    const created =
      await createRes.json();

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

    for (let i = 0; i < MAX_POLLS; i++) {
      await sleep(
        i < 3
          ? POLL_MS
          : Math.min(POLL_MS + i * 60, 900),
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

      const data =
        await resultRes.json();

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


function normalizeSourceCode(
  value: unknown,
  language: string,
) {
  let text = String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .replace(/^\uFEFF/, "");

  text = text
    .replace(/^(?:[ \t]*\n)+/, "")
    .replace(/(?:\n[ \t]*)+$/, "");

  if (String(language || "").toLowerCase() !== "python") {
    return text;
  }

  const lines = text.split("\n");
  const nonEmpty =
    lines.filter((line) => line.trim().length > 0);

  if (!nonEmpty.length) return text;

  const prefixes = nonEmpty.map(
    (line) => line.match(/^[ \t]*/)?.[0] ?? "",
  );

  let common = prefixes[0];

  for (let i = 1; i < prefixes.length && common; i++) {
    const next = prefixes[i];
    let j = 0;

    while (
      j < common.length &&
      j < next.length &&
      common[j] === next[j]
    ) {
      j++;
    }

    common = common.slice(0, j);
  }

  if (!common) return text;

  return lines
    .map((line) =>
      line.trim().length && line.startsWith(common)
        ? line.slice(common.length)
        : line
    )
    .join("\n");
}

function normalizeOutput(value: unknown) {
  return String(value ?? "")
    .replace(/\r\n/g, "\n")
    .trimEnd();
}

function round2(value: number) {
  return Math.round(
    (Number(value) + Number.EPSILON) * 100,
  ) / 100;
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
