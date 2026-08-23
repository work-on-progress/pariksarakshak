// supabase/functions/generate-questions/index.ts
//
// Generates/imports question drafts with Gemini.
//
// Reliability rule added for coding questions:
// A coding question is NEVER returned to the faculty console with zero tests.
// If the first Gemini response omits tests, this function makes a focused
// repair call and supplies 6 tests: first 4 visible, final 2 hidden.

import { createClient } from "npm:@supabase/supabase-js@2";

const GEMINI_KEY =
  Deno.env.get("GEMINI_API_KEY") ?? "";

const MODELS = [
  Deno.env.get("GEMINI_MODEL") ??
    "gemini-3.7-flash",
  "gemini-3.6-flash",
  "gemini-3.5-flash-lite",
];

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

// ============================================================
// Main response schema
// ============================================================

const responseSchema = {
  type: "OBJECT",
  properties: {
    questions: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          qtype: {
            type: "STRING",
            enum: [
              "mcq",
              "cloze",
              "long",
              "coding",
            ],
          },

          mcq_kind: {
            type: "STRING",
            enum: [
              "theory",
              "output",
              "error",
              "blank",
            ],
          },

          difficulty: {
            type: "STRING",
            enum: [
              "easy",
              "medium",
              "hard",
            ],
          },

          prompt: {
            type: "STRING",
          },

          code_snippet: {
            type: "STRING",
          },

          marks: {
            type: "NUMBER",
          },

          options: {
            type: "ARRAY",
            items: {
              type: "STRING",
            },
          },

          correct_key: {
            type: "STRING",
          },

          explanation: {
            type: "STRING",
          },

          cloze_answers: {
            type: "ARRAY",
            items: {
              type: "STRING",
            },
          },

          language: {
            type: "STRING",
          },

          func_signature: {
            type: "STRING",
          },

          starter_code: {
            type: "STRING",
          },

          test_cases: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: {
                stdin: {
                  type: "STRING",
                },
                expected_out: {
                  type: "STRING",
                },
                is_hidden: {
                  type: "BOOLEAN",
                },
              },
              required: [
                "stdin",
                "expected_out",
                "is_hidden",
              ],
            },
          },
        },

        // test_cases is required. Non-coding questions use [].
        required: [
          "qtype",
          "prompt",
          "marks",
          "difficulty",
          "test_cases",
        ],
      },
    },
  },

  required: ["questions"],
};

// Focused schema used only when a coding question needs test repair.
const codingTestsSchema = {
  type: "OBJECT",
  properties: {
    test_cases: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          stdin: {
            type: "STRING",
          },
          expected_out: {
            type: "STRING",
          },
          is_hidden: {
            type: "BOOLEAN",
          },
        },
        required: [
          "stdin",
          "expected_out",
          "is_hidden",
        ],
      },
    },
  },
  required: ["test_cases"],
};

// ============================================================
// Coding level
// ============================================================

const CODING_LEVEL: Record<
  string,
  string
> = {
  beginner:
    "First-year students in their first weeks of programming. Allowed: variables, arithmetic, if/else, while and for loops, lists or arrays, strings, reading input, printing, and simple user-defined functions. NOT allowed: list comprehensions, lambda, map/filter/reduce, recursion, dictionaries, sets, slicing tricks, any imported module, and any library function beyond len, range, int, str, float, sum, min, max, sorted, abs. Every problem must be solvable in about ten lines.",

  intermediate:
    "Students who have finished a first programming course. Allowed: everything a beginner may use, plus dictionaries, sets, sorting with a key, string methods, nested loops, recursion, list comprehensions, and simple use of the standard library. Not contest material.",

  advanced:
    "Students in a data structures or algorithms course. Time and space complexity matter. Two pointers, hashing, sorting, stacks, queues, binary search, dynamic programming and standard graph traversals are all fair game.",
};

const DIFFICULTY_NOTE: Record<
  string,
  string
> = {
  easy:
    "recall and direct application; a student who read the notes should get it",

  medium:
    "requires connecting two ideas, or applying a concept to a new example",

  hard:
    "requires reasoning through several steps, a subtle distinction, or an edge case",
};

// ============================================================
// Handler
// ============================================================

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(
      "ok",
      {
        headers: corsHeaders,
      },
    );
  }

  try {
    // --------------------------------------------------------
    // Faculty authentication.
    // --------------------------------------------------------
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
        {
          error:
            "Sign in again — the session has expired.",
        },
        401,
      );
    }

    const { data: profile } =
      await supaUser
        .from("profiles")
        .select("role")
        .eq("id", user.id)
        .single();

    if (profile?.role !== "faculty") {
      return json(
        {
          error:
            "Only faculty accounts can write questions.",
        },
        403,
      );
    }

    if (!GEMINI_KEY) {
      return json(
        {
          error:
            "No Gemini key on the server.",
        },
        503,
      );
    }

    // --------------------------------------------------------
    // Request.
    // --------------------------------------------------------
    const body = await req.json();

    const mode =
      body.mode ?? "generate";

    const sourceText =
      String(
        body.source_text ?? "",
      ).slice(0, 60_000);

    const prompt =
      mode === "import"
        ? importPrompt(
            sourceText,
            body,
          )
        : generatePrompt(
            body,
            sourceText,
          );

    if (!prompt) {
      return json(
        {
          error:
            mode === "import"
              ? "There was no text to import."
              : "Give a topic or upload notes and add at least one row to the mix.",
        },
        400,
      );
    }

    // --------------------------------------------------------
    // First Gemini call.
    // --------------------------------------------------------
    const initial =
      await callGeminiJson(
        prompt,
        responseSchema,
        mode === "import"
          ? 0.1
          : 0.65,
        16_384,
      );

    if (!initial.ok) {
      return json(
        {
          error:
            initial.error,
        },
        initial.status,
      );
    }

    let parsed:
      | {
          questions?: any[];
        }
      | undefined;

    try {
      parsed =
        JSON.parse(
          initial.text,
        );
    } catch {
      return json(
        {
          error:
            "The AI reply could not be read. Try fewer questions at once.",
        },
        502,
      );
    }

    if (
      !parsed?.questions?.length
    ) {
      return json(
        {
          error:
            mode === "import"
              ? "No questions were found in that document."
              : "Nothing came back. Try a more specific topic.",
        },
        502,
      );
    }

    let questions =
      parsed.questions.map(tidy);

    // --------------------------------------------------------
    // Critical coding reliability step.
    //
    // If Gemini omitted coding tests, fix them BEFORE the faculty
    // sees/saves the draft.
    // --------------------------------------------------------
    const repaired: any[] = [];

    for (const q of questions) {
      if (
        q.qtype !== "coding"
      ) {
        repaired.push(q);
        continue;
      }

      if (
        validTests(q.test_cases)
          .length >= 5
      ) {
        q.test_cases =
          normalizeCodingTests(
            q.test_cases,
          );

        repaired.push(q);
        continue;
      }

      const fixed =
        await repairCodingTests(
          q,
          body,
        );

      if (!fixed) {
        return json(
          {
            error:
              "A coding question was created without reliable test cases. Press Write the questions again; the broken coding question was NOT returned or saved.",
          },
          502,
        );
      }

      q.test_cases =
        fixed;

      repaired.push(q);
    }

    questions = repaired;

    return json({
      questions,
      mode,
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
// Gemini helpers
// ============================================================

async function callGeminiJson(
  prompt: string,
  schema: unknown,
  temperature: number,
  maxOutputTokens: number,
) {
  let lastDetail = "";

  for (const model of MODELS) {
    try {
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json",

            "x-goog-api-key":
              GEMINI_KEY,
          },

          body:
            JSON.stringify({
              contents: [
                {
                  parts: [
                    {
                      text: prompt,
                    },
                  ],
                },
              ],

              generationConfig: {
                responseMimeType:
                  "application/json",

                responseSchema:
                  schema,

                temperature,

                maxOutputTokens,
              },
            }),

          signal:
            AbortSignal.timeout(
              60_000,
            ),
        },
      );

      if (res.ok) {
        const data =
          await res.json();

        const text =
          data.candidates?.[0]
            ?.content
            ?.parts?.[0]
            ?.text ?? "{}";

        return {
          ok: true as const,
          text,
          model,
        };
      }

      lastDetail =
        await res.text();

      if (
        res.status === 503 ||
        res.status === 404 ||
        res.status === 429
      ) {
        continue;
      }

      return {
        ok: false as const,
        error:
          `Question service: ${lastDetail.slice(0, 300)}`,
        status: 502,
      };
    } catch (e) {
      lastDetail =
        String(e);
    }
  }

  return {
    ok: false as const,
    error:
      `All configured Gemini models are currently unavailable. ${lastDetail.slice(0, 250)}`,
    status: 503,
  };
}

async function repairCodingTests(
  q: any,
  body: any,
) {
  const language =
    q.language ||
    body.language ||
    "python";

  const prompt = `
You are repairing ONLY the automated tests for one programming exam question.

Do not rewrite the question.

LANGUAGE:
${language}

QUESTION:
${q.prompt}

STARTER CODE:
${q.starter_code || "(none)"}

Create EXACTLY 6 stdin/stdout test cases that are mathematically and logically correct for this question.

Rules:
- Test 1 to Test 4 are visible examples: is_hidden=false.
- Test 5 and Test 6 are hidden edge cases: is_hidden=true.
- Use only inputs valid under the question.
- Include different values, not duplicates of the same case.
- expected_out must be the exact program output.
- Do not include explanations.
- Do not include markdown.
- Return only the JSON required by the schema.
`;

  const res =
    await callGeminiJson(
      prompt,
      codingTestsSchema,
      0.05,
      4096,
    );

  if (!res.ok) {
    return null;
  }

  try {
    const obj =
      JSON.parse(res.text);

    const tests =
      normalizeCodingTests(
        obj.test_cases,
      );

    return tests.length >= 5
      ? tests
      : null;
  } catch {
    return null;
  }
}

// ============================================================
// Normalisation
// ============================================================

function tidy(q: any) {
  const out = {
    ...q,
  };

  out.qtype =
    [
      "mcq",
      "cloze",
      "long",
      "coding",
    ].includes(out.qtype)
      ? out.qtype
      : "long";

  out.difficulty =
    [
      "easy",
      "medium",
      "hard",
    ].includes(
      out.difficulty,
    )
      ? out.difficulty
      : "medium";

  out.mcq_kind =
    out.qtype === "mcq"
      ? [
          "theory",
          "output",
          "error",
          "blank",
        ].includes(
          out.mcq_kind,
        )
        ? out.mcq_kind
        : "theory"
      : "theory";

  out.marks =
    Number(out.marks) ||
    (
      out.qtype === "coding"
        ? 10
        : out.qtype === "long"
        ? 5
        : 1
    );

  out.options =
    Array.isArray(
      out.options,
    )
      ? out.options.filter(
          Boolean,
        )
      : [];

  out.cloze_answers =
    Array.isArray(
      out.cloze_answers,
    )
      ? out.cloze_answers.filter(
          Boolean,
        )
      : [];

  out.test_cases =
    Array.isArray(
      out.test_cases,
    )
      ? out.test_cases
      : [];

  out.correct_key =
    String(
      out.correct_key ??
        "",
    )
      .trim()
      .toUpperCase()
      .slice(0, 1);

  out.code_snippet =
    String(
      out.code_snippet ??
        "",
    ).trim();

  out.explanation =
    String(
      out.explanation ??
        "",
    ).trim();

  out.prompt =
    String(
      out.prompt ??
        "",
    ).trim();

  out.starter_code =
    String(
      out.starter_code ??
        "",
    );

  out.language =
    String(
      out.language ??
        "",
    ).trim();

  return out;
}

function validTests(
  value: unknown,
) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(
    (t) =>
      t &&
      typeof t === "object" &&
      String(
        t.expected_out ?? "",
      ).length > 0,
  );
}

function normalizeCodingTests(
  value: unknown,
) {
  const tests =
    validTests(value)
      .slice(0, 8)
      .map(
        (
          t: any,
          i,
        ) => ({
          stdin:
            String(
              t.stdin ?? "",
            ),

          expected_out:
            String(
              t.expected_out ??
                "",
            ).trimEnd(),

          // LeetCode-like workflow:
          // first 4 are examples,
          // everything afterwards hidden.
          is_hidden:
            i >= 4,
        }),
      );

  return tests;
}

// ============================================================
// Generation prompt
// ============================================================

function generatePrompt(
  body: any,
  sourceText: string,
) {
  const topic =
    String(
      body.topic ?? "",
    ).trim();

  const rows: any[] =
    Array.isArray(
      body.mix,
    )
      ? body.mix
      : [];

  const language =
    body.language ??
    "python";

  const codingLevel =
    CODING_LEVEL[
      body.coding_level
    ] ??
    CODING_LEVEL.beginner;

  const questionLanguage =
    body.question_language ??
    "English";

  const wanted =
    rows.filter(
      (r) =>
        Number(
          r.count,
        ) > 0,
    );

  if (!wanted.length) {
    return "";
  }

  if (
    !topic &&
    !sourceText
  ) {
    return "";
  }

  const lines =
    wanted
      .map((r) => {
        const d =
          DIFFICULTY_NOTE[
            r.difficulty
          ] ??
          DIFFICULTY_NOTE.medium;

        const marks =
          Number(
            r.marks,
          ) || 1;

        if (
          r.qtype === "mcq"
        ) {
          const kind =
            ({
              theory:
                "a concept question in words, with no program shown.",

              output:
                `a short ${language} program in code_snippet; ask exactly what it prints.`,

              error:
                `a short ${language} program in code_snippet containing exactly one defect.`,

              blank:
                `a short ${language} program in code_snippet with ____ marking one missing piece.`,
            } as Record<string, string>)[
              r.mcq_kind
            ] ??
            "a concept question.";

          return `- ${r.count} MCQs, ${r.difficulty}, ${marks} mark each. Kind ${r.mcq_kind}: ${kind} Four options A-D and exactly one correct_key. test_cases must be [].`;
        }

        if (
          r.qtype === "cloze"
        ) {
          return `- ${r.count} fill-in-the-blank questions, ${r.difficulty}, ${marks} mark each. Use ____ for blanks and exact answers in cloze_answers. test_cases must be [].`;
        }

        if (
          r.qtype === "long"
        ) {
          return `- ${r.count} long-answer questions, ${r.difficulty}, ${marks} marks each. test_cases must be [].`;
        }

        if (
          r.qtype ===
            "coding"
        ) {
          return `- ${r.count} coding problems in ${language}, ${r.difficulty}, ${marks} marks each.
For EVERY coding problem:
  * prompt must contain the task, Input format, Output format and a worked example
  * starter_code parses the input and leaves a clear TODO
  * test_cases MUST contain exactly 6 valid cases
  * Test 1-4: is_hidden=false
  * Test 5-6: is_hidden=true
  * every expected_out must be exact and correct
  * visible cases should cover normal/simple examples
  * hidden cases should cover meaningful edge cases`;
        }

        return "";
      })
      .filter(Boolean);

  return `
You are an experienced university examiner.

Write every question in ${questionLanguage}.

TOPIC:
${topic || "(take the topic from the source material)"}

${
  sourceText
    ? `
SOURCE MATERIAL:
"""
${sourceText}
"""
`
    : ""
}

Produce exactly this mix:
${lines.join("\n")}

Coding/programming level:
${codingLevel}

Rules:
- Set difficulty on every question.
- Set mcq_kind on every MCQ; use theory for non-MCQs.
- Programs for MCQs go in code_snippet, not prompt.
- Do not reveal answers inside the question.
- Fill explanation in one or two sentences.
- Do not repeat the same concept.
- Plain, unambiguous wording.
- The JSON field test_cases MUST exist on EVERY question.
- Non-coding questions use test_cases=[].
- Coding questions use exactly 6 test cases.
`;
}

// ============================================================
// Import prompt
// ============================================================

function importPrompt(
  sourceText: string,
  body: any,
) {
  if (
    !sourceText.trim()
  ) {
    return "";
  }

  const marksNote =
    body.default_marks
      ? `If marks are absent, use ${body.default_marks}.`
      : "If marks are absent, use 1 for MCQ/cloze, 5 for long, 10 for coding.";

  return `
Below is a teacher's own question paper or question bank.

Convert it into structured data.

Rules:
- Reproduce each question as written.
- Do not invent new questions.
- If the document explicitly marks an MCQ answer, use it; otherwise correct_key="".
- Classify as mcq, cloze, coding or long.
- Judge difficulty easy/medium/hard.
- ${marksNote}
- explanation should be empty unless the source gives one.
- Every non-coding question must have test_cases=[].
- For coding questions, if the task has enough information to determine valid input/output, create exactly 6 test cases:
  first 4 visible, last 2 hidden.
- If a coding question is too incomplete to calculate expected outputs reliably, return test_cases=[]; the server repair step will try once more and reject the draft rather than saving a broken coding question.

DOCUMENT:
"""
${sourceText}
"""
`;
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
