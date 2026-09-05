// supabase/functions/generate-questions/index.ts
//
// PariksaRakshak — multi-provider question engine
//
// Providers (only providers with complete configuration are used):
//   1. Google Gemini
//   2. Groq
//   3. Cloudflare Workers AI
//   4. NVIDIA hosted NIM
//   5. OpenRouter
//   6. Hugging Face Inference Providers
//
// Main improvements:
// - Up to 50 generated questions in one request.
// - Work is divided as evenly as possible across all enabled providers.
// - Provider calls run in parallel.
// - Automatic provider fallback on timeout / 429 / 5xx.
// - Objective answers are cross-checked in a second AI pass.
// - Generated MCQs must have a valid correct_key.
// - Generated cloze questions must have answer keys.
// - Coding questions must have 6 tests: first 4 visible, final 2 hidden.
// - Full uploaded text is accepted; no silent 4k/6k/60k truncation.
// - Long notes/PDF text is split into chunks so the whole document contributes.
// - Imported papers are chunked and all chunks are processed.

import { createClient } from "npm:@supabase/supabase-js@2";

type ProviderName =
  | "gemini"
  | "groq"
  | "cloudflare"
  | "nvidia"
  | "openrouter"
  | "huggingface";

type Provider = {
  name: ProviderName;
  model: string;
};

type QuestionSpec = {
  qtype: "mcq" | "cloze" | "long" | "coding";
  mcq_kind: "theory" | "output" | "error" | "blank";
  difficulty: "easy" | "medium" | "hard";
  marks: number;
};

type ProviderResult = {
  ok: boolean;
  provider: ProviderName;
  model: string;
  text?: string;
  error?: string;
  status?: number;
};

const GEMINI_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
const GROQ_KEY = Deno.env.get("GROQ_API_KEY") ?? "";

const CLOUDFLARE_ACCOUNT_ID =
  Deno.env.get("CLOUDFLARE_ACCOUNT_ID") ?? "";

const CLOUDFLARE_AI_TOKEN =
  Deno.env.get("CLOUDFLARE_AI_TOKEN") ??
  Deno.env.get("CLOUDFLARE_API_TOKEN") ??
  "";

const NVIDIA_API_KEY =
  Deno.env.get("NVIDIA_API_KEY") ?? "";

const OPENROUTER_KEY =
  Deno.env.get("OPENROUTER_API_KEY") ?? "";

const HUGGINGFACE_TOKEN =
  Deno.env.get("HUGGINGFACE_TOKEN") ??
  Deno.env.get("HF_TOKEN") ??
  "";

const GEMINI_MODELS = [
  Deno.env.get("GEMINI_MODEL") ?? "gemini-3.8-flash",
  "gemini-3.7-flash",
  "gemini-3.6-flash",
];

const GROQ_MODEL =
  Deno.env.get("GROQ_MODEL") ?? "openai/gpt-oss-20b";

const CLOUDFLARE_MODEL =
  Deno.env.get("CLOUDFLARE_MODEL") ?? "@cf/openai/gpt-oss-20b";

const NVIDIA_MODEL =
  Deno.env.get("NVIDIA_MODEL") ?? "openai/gpt-oss-20b";

const OPENROUTER_MODEL =
  Deno.env.get("OPENROUTER_MODEL") ?? "openrouter/free";

const HUGGINGFACE_MODEL =
  Deno.env.get("HUGGINGFACE_MODEL") ?? "openai/gpt-oss-20b:fastest";

const MAX_GENERATED_QUESTIONS = 50;
const MAX_SOURCE_CHARS = 1_200_000;
const GENERATION_BATCH_TARGET = 10;
const IMPORT_CHUNK_CHARS = 24_000;
const IMPORT_OVERLAP_CHARS = 1_200;
const GENERATION_OVERLAP_CHARS = 800;
const REQUEST_TIMEOUT_MS = 70_000;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const geminiQuestionSchema = {
  type: "OBJECT",
  properties: {
    questions: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          qtype: {
            type: "STRING",
            enum: ["mcq", "cloze", "long", "coding"],
          },
          mcq_kind: {
            type: "STRING",
            enum: ["theory", "output", "error", "blank"],
          },
          difficulty: {
            type: "STRING",
            enum: ["easy", "medium", "hard"],
          },
          prompt: { type: "STRING" },
          code_snippet: { type: "STRING" },
          marks: { type: "NUMBER" },
          options: {
            type: "ARRAY",
            items: { type: "STRING" },
          },
          correct_key: { type: "STRING" },
          explanation: { type: "STRING" },
          cloze_answers: {
            type: "ARRAY",
            items: { type: "STRING" },
          },
          language: { type: "STRING" },
          func_signature: { type: "STRING" },
          starter_code: { type: "STRING" },
          answer_basis: {
            type: "STRING",
            enum: ["generated", "explicit", "inferred", "unknown"],
          },
          test_cases: {
            type: "ARRAY",
            items: {
              type: "OBJECT",
              properties: {
                stdin: { type: "STRING" },
                expected_out: { type: "STRING" },
                is_hidden: { type: "BOOLEAN" },
              },
              required: ["stdin", "expected_out", "is_hidden"],
            },
          },
        },
        required: [
          "qtype",
          "mcq_kind",
          "difficulty",
          "prompt",
          "code_snippet",
          "marks",
          "options",
          "correct_key",
          "explanation",
          "cloze_answers",
          "language",
          "func_signature",
          "starter_code",
          "answer_basis",
          "test_cases",
        ],
      },
    },
  },
  required: ["questions"],
};

const geminiCodingTestsSchema = {
  type: "OBJECT",
  properties: {
    test_cases: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          stdin: { type: "STRING" },
          expected_out: { type: "STRING" },
          is_hidden: { type: "BOOLEAN" },
        },
        required: ["stdin", "expected_out", "is_hidden"],
      },
    },
  },
  required: ["test_cases"],
};

const CODING_LEVEL: Record<string, string> = {
  beginner:
    "First-year students in their first weeks of programming. Allowed: variables, arithmetic, if/else, while and for loops, lists, strings, input, print, and simple functions. Avoid advanced shortcuts, recursion, dictionaries, sets, lambda, map/filter/reduce and imports unless the source explicitly teaches them.",
  intermediate:
    "Students who have completed a first programming course. Dictionaries, sets, sorting, nested loops, recursion, list comprehensions and simple standard-library use are allowed.",
  advanced:
    "Data structures and algorithms level. Complexity matters. Standard algorithmic techniques are allowed.",
};

const DIFFICULTY_NOTE: Record<string, string> = {
  easy:
    "direct recall/application; a student who understood the notes should solve it",
  medium:
    "connects two ideas or applies the concept to a new example",
  hard:
    "requires multi-step reasoning, a subtle distinction, or an edge case",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = await req.json().catch(() => ({}));
    const providers = enabledProviders();

    if (body.ping === true) {
      return json(
        {
          ok: providers.length > 0,
          providers: providers.map((p) => ({
            provider: p.name,
            model: p.model,
          })),
          max_questions: MAX_GENERATED_QUESTIONS,
          max_source_chars: MAX_SOURCE_CHARS,
        },
        providers.length ? 200 : 503,
      );
    }

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

    const { data: profile } = await supaUser
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .single();

    if (profile?.role !== "faculty") {
      return json(
        { error: "Only faculty accounts can write questions." },
        403,
      );
    }

    if (!providers.length) {
      return json(
        {
          error:
            "No AI provider key is configured. Set GEMINI_API_KEY, GROQ_API_KEY or OPENROUTER_API_KEY.",
        },
        503,
      );
    }

    const mode = String(body.mode ?? "generate");

    const sourceText = normalizeSourceText(
      String(body.source_text ?? ""),
    );

    if (sourceText.length > MAX_SOURCE_CHARS) {
      return json(
        {
          error:
            `The extracted document is ${sourceText.length.toLocaleString()} characters. ` +
            `The current safety limit is ${MAX_SOURCE_CHARS.toLocaleString()} characters. ` +
            "Split an unusually large document into two files; the platform will never silently cut it.",
        },
        413,
      );
    }

    if (mode === "import") {
      if (!sourceText.trim()) {
        return json(
          { error: "There was no text to import." },
          400,
        );
      }

      const imported = await importWholePaper(
        sourceText,
        body,
        providers,
      );

      return json(imported);
    }

    const specs = expandMix(body.mix);

    if (!specs.length) {
      return json(
        {
          error:
            "Add at least one row to the question mix with a count above zero.",
        },
        400,
      );
    }

    if (specs.length > MAX_GENERATED_QUESTIONS) {
      return json(
        {
          error:
            `Generate ${MAX_GENERATED_QUESTIONS} questions or fewer in one request.`,
        },
        400,
      );
    }

    const topic = String(body.topic ?? "").trim();

    if (!topic && !sourceText) {
      return json(
        { error: "Give a topic or upload notes first." },
        400,
      );
    }

    const generated = await generateDistributed(
      specs,
      body,
      sourceText,
      providers,
    );

    return json(generated);
  } catch (e) {
    console.error(e);

    return json(
      {
        error:
          `Unexpected question-engine error: ${String(e)}`,
      },
      500,
    );
  }
});

function enabledProviders(): Provider[] {
  const out: Provider[] = [];

  if (GEMINI_KEY) {
    out.push({
      name: "gemini",
      model: GEMINI_MODELS[0],
    });
  }

  if (GROQ_KEY) {
    out.push({
      name: "groq",
      model: GROQ_MODEL,
    });
  }

  // Cloudflare Workers AI needs BOTH the API token and Account ID.
  if (CLOUDFLARE_AI_TOKEN && CLOUDFLARE_ACCOUNT_ID) {
    out.push({
      name: "cloudflare",
      model: CLOUDFLARE_MODEL,
    });
  }

  // Hosted NVIDIA NIM key for integrate.api.nvidia.com.
  if (NVIDIA_API_KEY) {
    out.push({
      name: "nvidia",
      model: NVIDIA_MODEL,
    });
  }

  if (OPENROUTER_KEY) {
    out.push({
      name: "openrouter",
      model: OPENROUTER_MODEL,
    });
  }

  if (HUGGINGFACE_TOKEN) {
    out.push({
      name: "huggingface",
      model: HUGGINGFACE_MODEL,
    });
  }

  return out;
}

async function callProviderWithFallback(
  preferred: Provider,
  providers: Provider[],
  prompt: string,
  purpose: "questions" | "coding_tests" | "verification",
  temperature = 0.45,
): Promise<ProviderResult> {
  const order = [
    preferred,
    ...providers.filter((p) => p.name !== preferred.name),
  ];

  let last: ProviderResult | null = null;

  for (const p of order) {
    const result = await callProvider(
      p,
      prompt,
      purpose,
      temperature,
    );

    if (result.ok) return result;
    last = result;
  }

  return last ?? {
    ok: false,
    provider: preferred.name,
    model: preferred.model,
    error: "No provider answered.",
    status: 503,
  };
}

async function callProvider(
  provider: Provider,
  prompt: string,
  purpose: "questions" | "coding_tests" | "verification",
  temperature: number,
): Promise<ProviderResult> {
  if (provider.name === "gemini") {
    return callGemini(prompt, purpose, temperature);
  }

  if (provider.name === "groq") {
    return callOpenAICompatible(
      provider,
      "https://api.groq.com/openai/v1/chat/completions",
      GROQ_KEY,
      prompt,
      temperature,
    );
  }

  if (provider.name === "cloudflare") {
    return callOpenAICompatible(
      provider,
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(
        CLOUDFLARE_ACCOUNT_ID,
      )}/ai/v1/chat/completions`,
      CLOUDFLARE_AI_TOKEN,
      prompt,
      temperature,
    );
  }

  if (provider.name === "nvidia") {
    return callOpenAICompatible(
      provider,
      "https://integrate.api.nvidia.com/v1/chat/completions",
      NVIDIA_API_KEY,
      prompt,
      temperature,
    );
  }

  if (provider.name === "openrouter") {
    return callOpenAICompatible(
      provider,
      "https://openrouter.ai/api/v1/chat/completions",
      OPENROUTER_KEY,
      prompt,
      temperature,
    );
  }

  return callOpenAICompatible(
    provider,
    "https://router.huggingface.co/v1/chat/completions",
    HUGGINGFACE_TOKEN,
    prompt,
    temperature,
  );
}

async function callGemini(
  prompt: string,
  purpose: "questions" | "coding_tests" | "verification",
  temperature: number,
): Promise<ProviderResult> {
  let lastError = "";

  for (const model of GEMINI_MODELS) {
    try {
      const schema =
        purpose === "questions"
          ? geminiQuestionSchema
          : purpose === "coding_tests"
          ? geminiCodingTestsSchema
          : undefined;

      const generationConfig: Record<string, unknown> = {
        responseMimeType: "application/json",
        maxOutputTokens:
          purpose === "questions" ? 20_000 : 8_000,
        temperature,
      };

      if (schema) {
        generationConfig.responseSchema = schema;
      }

      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": GEMINI_KEY,
          },
          body: JSON.stringify({
            contents: [
              {
                role: "user",
                parts: [{ text: prompt }],
              },
            ],
            generationConfig,
          }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        },
      );

      if (!res.ok) {
        lastError =
          `Gemini ${model} HTTP ${res.status}: ${(await res.text()).slice(0, 600)}`;

        if ([404, 408, 409, 429, 500, 502, 503, 504].includes(res.status)) {
          continue;
        }

        return {
          ok: false,
          provider: "gemini",
          model,
          error: lastError,
          status: res.status,
        };
      }

      const data = await res.json();

      const text =
        data.candidates?.[0]?.content?.parts
          ?.map((p: any) => p.text ?? "")
          .join("") ?? "";

      if (!text.trim()) {
        lastError = `Gemini ${model} returned no JSON text.`;
        continue;
      }

      return {
        ok: true,
        provider: "gemini",
        model,
        text,
        status: 200,
      };
    } catch (e) {
      lastError = `Gemini ${model}: ${String(e)}`;
    }
  }

  return {
    ok: false,
    provider: "gemini",
    model: GEMINI_MODELS[0],
    error: lastError || "Gemini unavailable.",
    status: 503,
  };
}

async function callOpenAICompatible(
  provider: Provider,
  endpoint: string,
  key: string,
  prompt: string,
  temperature: number,
): Promise<ProviderResult> {
  try {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    };

    if (provider.name === "openrouter") {
      headers["HTTP-Referer"] = "https://pariksarakshak.vercel.app";
      headers["X-Title"] = "PariksaRakshak";
    }

    const body: Record<string, unknown> = {
      model: provider.model,
      messages: [
        {
          role: "system",
          content:
            "You are a university assessment author. Return ONLY one valid JSON object. Never wrap JSON in markdown.",
        },
        {
          role: "user",
          content: prompt,
        },
      ],
      temperature,
      stream: false,
      response_format: {
        type: "json_object",
      },
    };

    if (provider.name === "groq") {
      body.max_completion_tokens = 20_000;
    } else {
      body.max_tokens = 20_000;
    }

    let res = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    // Some free/open models do not support response_format even though their
    // provider is OpenAI-compatible. Retry once without JSON mode; our prompt
    // still demands JSON and parseJsonLoose validates it.
    if (!res.ok && [400, 404, 422].includes(res.status)) {
      delete body.response_format;

      res = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    }

    if (!res.ok) {
      return {
        ok: false,
        provider: provider.name,
        model: provider.model,
        error:
          `${provider.name} HTTP ${res.status}: ${(await res.text()).slice(0, 600)}`,
        status: res.status,
      };
    }

    const data = await res.json();

    const content = data.choices?.[0]?.message?.content;

    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
        ? content
            .map((x: any) => x?.text ?? x?.content ?? "")
            .join("")
        : "";

    if (!text.trim()) {
      return {
        ok: false,
        provider: provider.name,
        model: provider.model,
        error: `${provider.name} returned no JSON text.`,
        status: 502,
      };
    }

    return {
      ok: true,
      provider: provider.name,
      model: String(data.model ?? provider.model),
      text,
      status: 200,
    };
  } catch (e) {
    return {
      ok: false,
      provider: provider.name,
      model: provider.model,
      error: `${provider.name}: ${String(e)}`,
      status: 503,
    };
  }
}

async function generateDistributed(
  specs: QuestionSpec[],
  body: any,
  sourceText: string,
  providers: Provider[],
) {
  const total = specs.length;

  const cycles = Math.max(
    1,
    Math.ceil(
      total /
        (providers.length * GENERATION_BATCH_TARGET),
    ),
  );

  const taskCount = Math.min(
    total,
    providers.length * cycles,
  );

  const groups: QuestionSpec[][] =
    Array.from({ length: taskCount }, () => []);

  specs.forEach((spec, i) => {
    groups[i % taskCount].push(spec);
  });

  const sourceChunks = sourceText
    ? splitTextIntoCount(
        sourceText,
        taskCount,
        GENERATION_OVERLAP_CHARS,
      )
    : Array(taskCount).fill("");

  const tasks = groups.map((group, i) => ({
    specs: group,
    source: sourceChunks[i] ?? "",
    sourceIndex: i + 1,
    sourceTotal: sourceChunks.length,
    preferred: providers[i % providers.length],
  }));

  const taskResults = await mapPool(
    tasks,
    Math.min(6, Math.max(1, providers.length * 2)),
    async (task) => {
      const prompt = generationPrompt(
        task.specs,
        body,
        task.source,
        task.sourceIndex,
        task.sourceTotal,
      );

      const res = await callProviderWithFallback(
        task.preferred,
        providers,
        prompt,
        "questions",
        0.55,
      );

      if (!res.ok || !res.text) {
        return {
          questions: [],
          provider: res.provider,
          model: res.model,
          error: res.error ?? "Generation failed.",
          expected: task.specs.length,
        };
      }

      const parsed = parseJsonLoose(res.text);

      const raw =
        Array.isArray(parsed?.questions)
          ? parsed.questions
          : [];

      let questions = raw
        .map((q: any) =>
          tidyQuestion(q, "generate", res.provider)
        )
        .filter(isUsableQuestion)
        .slice(0, task.specs.length);

      if (questions.length < task.specs.length) {
        const missing = task.specs.slice(questions.length);

        const topUpPrompt =
          generationPrompt(
            missing,
            body,
            task.source,
            task.sourceIndex,
            task.sourceTotal,
          ) +
          `\n\nIMPORTANT: This is a TOP-UP request. Return exactly ${missing.length} new questions. ` +
          "Do not repeat any question from the previous batch.";

        const topUp = await callProviderWithFallback(
          nextProvider(res.provider, providers),
          providers,
          topUpPrompt,
          "questions",
          0.5,
        );

        if (topUp.ok && topUp.text) {
          const obj = parseJsonLoose(topUp.text);

          const extra =
            Array.isArray(obj?.questions)
              ? obj.questions
                  .map((q: any) =>
                    tidyQuestion(q, "generate", topUp.provider)
                  )
                  .filter(isUsableQuestion)
              : [];

          questions = [
            ...questions,
            ...extra,
          ].slice(0, task.specs.length);
        }
      }

      return {
        questions,
        provider: res.provider,
        model: res.model,
        error: "",
        expected: task.specs.length,
      };
    },
  );

  let questions =
    dedupeQuestions(
      taskResults.flatMap((x) => x.questions),
    );

  questions = await verifyObjectiveAnswers(
    questions,
    providers,
    "generate",
  );

  questions = await repairCodingQuestions(
    questions,
    body,
    providers,
  );

  const objectiveProblems = questions.filter(
    objectiveNeedsTeacherReview,
  ).length;

  const providerUsage: Record<string, number> = {};

  for (const q of questions) {
    const p = String(q._provider ?? "unknown");
    providerUsage[p] = (providerUsage[p] ?? 0) + 1;
  }

  const clean =
    questions
      .slice(0, total)
      .map(stripInternalFields);

  return {
    questions: clean,
    mode: "generate",
    requested: total,
    returned: clean.length,
    providers_enabled: providers.map((p) => p.name),
    provider_usage: providerUsage,
    parallel_batches: taskCount,
    source_chunks: sourceText ? sourceChunks.length : 0,
    source_characters_used: sourceText.length,
    objective_questions_needing_review: objectiveProblems,
    warning:
      clean.length < total
        ? `Only ${clean.length} of ${total} requested questions survived validation. Run the missing quantity again.`
        : objectiveProblems
        ? `${objectiveProblems} objective question(s) could not be verified confidently. The faculty preview will require an answer before saving.`
        : null,
  };
}

async function importWholePaper(
  sourceText: string,
  body: any,
  providers: Provider[],
) {
  const chunks = splitByMaxChars(
    sourceText,
    IMPORT_CHUNK_CHARS,
    IMPORT_OVERLAP_CHARS,
  );

  const tasks = chunks.map((chunk, i) => ({
    chunk,
    index: i + 1,
    total: chunks.length,
    preferred: providers[i % providers.length],
  }));

  const results = await mapPool(
    tasks,
    Math.min(6, Math.max(1, providers.length * 2)),
    async (task) => {
      const prompt = importPrompt(
        task.chunk,
        body,
        task.index,
        task.total,
      );

      const res = await callProviderWithFallback(
        task.preferred,
        providers,
        prompt,
        "questions",
        0.08,
      );

      if (!res.ok || !res.text) {
        return {
          questions: [],
          provider: res.provider,
          error: res.error ?? "",
        };
      }

      const parsed = parseJsonLoose(res.text);

      const questions =
        Array.isArray(parsed?.questions)
          ? parsed.questions
              .map((q: any) =>
                tidyQuestion(q, "import", res.provider)
              )
              .filter(isUsableQuestion)
          : [];

      return {
        questions,
        provider: res.provider,
        error: "",
      };
    },
  );

  let questions =
    dedupeQuestions(
      results.flatMap((x) => x.questions),
    );

  questions = await verifyObjectiveAnswers(
    questions,
    providers,
    "import",
  );

  questions = await repairCodingQuestions(
    questions,
    body,
    providers,
  );

  const providerUsage: Record<string, number> = {};

  for (const q of questions) {
    const p = String(q._provider ?? "unknown");
    providerUsage[p] = (providerUsage[p] ?? 0) + 1;
  }

  const reviewCount = questions.filter(
    objectiveNeedsTeacherReview,
  ).length;

  return {
    questions: questions.map(stripInternalFields),
    mode: "import",
    returned: questions.length,
    providers_enabled: providers.map((p) => p.name),
    provider_usage: providerUsage,
    source_chunks: chunks.length,
    source_characters_used: sourceText.length,
    objective_questions_needing_review: reviewCount,
    warning:
      reviewCount
        ? `${reviewCount} objective answer(s) were genuinely ambiguous or could not be verified. Review those before saving.`
        : null,
  };
}

async function verifyObjectiveAnswers(
  questions: any[],
  providers: Provider[],
  mode: "generate" | "import",
) {
  const candidates =
    questions
      .map((q, index) => ({ q, index }))
      .filter(({ q }) => {
        if (!["mcq", "cloze"].includes(q.qtype)) {
          return false;
        }

        if (
          mode === "import" &&
          q.answer_basis === "explicit"
        ) {
          return false;
        }

        return true;
      });

  if (!candidates.length) {
    return questions;
  }

  const groups = chunkArray(candidates, 12);

  await mapPool(
    groups,
    Math.min(
      groups.length,
      Math.max(1, providers.length * 2),
    ),
    async (group, groupIndex) => {
      const preferred =
        providers[(groupIndex + 1) % providers.length];

      const prompt = `
You are the independent ANSWER-KEY VERIFIER for a university exam system.

Solve each objective question independently.

Do NOT rewrite any question.
Do NOT invent a key if the question is genuinely ambiguous.

For MCQ:
- correct_key must be A, B, C or D.
- Check code carefully for output/error/code-completion MCQs.

For cloze:
- return cloze_answers in blank order.

Confidence:
- high = answer is clear and checkable
- medium = likely but there is some interpretation
- low = ambiguous / insufficient information

Return ONLY JSON:
{
  "answers": [
    {
      "index": 0,
      "correct_key": "B",
      "cloze_answers": [],
      "confidence": "high",
      "note": "very short reason"
    }
  ]
}

QUESTIONS:
${JSON.stringify(
  group.map(({ q, index }) => ({
    index,
    qtype: q.qtype,
    prompt: q.prompt,
    options: q.options,
    code_snippet: q.code_snippet,
    current_correct_key: q.correct_key,
    current_cloze_answers: q.cloze_answers,
  })),
)}
`;

      const res = await callProviderWithFallback(
        preferred,
        providers,
        prompt,
        "verification",
        0.05,
      );

      if (!res.ok || !res.text) return;

      const obj = parseJsonLoose(res.text);

      const answers =
        Array.isArray(obj?.answers)
          ? obj.answers
          : [];

      for (const patch of answers) {
        const index = Number(patch?.index);

        if (
          !Number.isInteger(index) ||
          index < 0 ||
          index >= questions.length
        ) {
          continue;
        }

        const q = questions[index];

        const confidence =
          String(patch?.confidence ?? "").toLowerCase();

        if (q.qtype === "mcq") {
          const verifiedKey = normalizeKey(
            patch?.correct_key,
            q.options.length,
          );

          if (!verifiedKey) continue;

          const existingKey = normalizeKey(
            q.correct_key,
            q.options.length,
          );

          if (
            confidence === "high" ||
            !existingKey
          ) {
            q.correct_key = verifiedKey;
            q.answer_basis = "verified";
          }
        }

        if (q.qtype === "cloze") {
          const answers =
            Array.isArray(patch?.cloze_answers)
              ? patch.cloze_answers
                  .map((x: any) => String(x ?? "").trim())
                  .filter(Boolean)
              : [];

          if (
            answers.length &&
            (
              confidence === "high" ||
              !q.cloze_answers?.length
            )
          ) {
            q.cloze_answers = answers;
            q.answer_basis = "verified";
          }
        }
      }
    },
  );

  return questions;
}

async function repairCodingQuestions(
  questions: any[],
  body: any,
  providers: Provider[],
) {
  const indexes =
    questions
      .map((q, index) => ({ q, index }))
      .filter(
        ({ q }) =>
          q.qtype === "coding" &&
          normalizeCodingTests(q.test_cases).length < 5,
      );

  if (!indexes.length) {
    for (const q of questions) {
      if (q.qtype === "coding") {
        q.test_cases = normalizeCodingTests(q.test_cases);
      }
    }

    return questions;
  }

  await mapPool(
    indexes,
    Math.min(
      indexes.length,
      Math.max(1, providers.length * 2),
    ),
    async ({ q, index }, i) => {
      const preferred = nextProvider(
        q._provider,
        providers,
        i,
      );

      const language =
        q.language ||
        body.language ||
        "python";

      const prompt = `
You are repairing ONLY the automated tests for one programming exam question.

LANGUAGE:
${language}

QUESTION:
${q.prompt}

STARTER CODE:
${q.starter_code || "(none)"}

Create EXACTLY 6 correct stdin/stdout tests.

Rules:
- Test 1-4: is_hidden=false
- Test 5-6: is_hidden=true
- Inputs must follow the stated input format.
- expected_out must exactly match the required output.
- Use varied normal and edge cases.
- Do not rewrite the question.
- Return ONLY JSON:
{
  "test_cases": [
    {"stdin":"...", "expected_out":"...", "is_hidden":false}
  ]
}
`;

      const res = await callProviderWithFallback(
        preferred,
        providers,
        prompt,
        "coding_tests",
        0.03,
      );

      if (!res.ok || !res.text) return;

      const obj = parseJsonLoose(res.text);

      const tests =
        normalizeCodingTests(obj?.test_cases);

      if (tests.length >= 5) {
        questions[index].test_cases = tests;
      }
    },
  );

  return questions;
}

function generationPrompt(
  specs: QuestionSpec[],
  body: any,
  sourceChunk: string,
  sourceIndex: number,
  sourceTotal: number,
) {
  const grouped = groupSpecs(specs);

  const topic = String(body.topic ?? "").trim();
  const language = String(body.language ?? "python");

  const codingLevel =
    CODING_LEVEL[
      String(body.coding_level ?? "beginner")
    ] ?? CODING_LEVEL.beginner;

  const questionLanguage =
    String(body.question_language ?? "English");

  return `
You are a careful university examiner.

Create EXACTLY ${specs.length} NEW questions.

QUESTION LANGUAGE:
${questionLanguage}

TOPIC:
${topic || "(derive the topic only from the supplied source section)"}

THIS BATCH MUST CONTAIN:
${grouped
  .map((r) => {
    const difficulty =
      DIFFICULTY_NOTE[r.difficulty] ??
      DIFFICULTY_NOTE.medium;

    if (r.qtype === "mcq") {
      return `- ${r.count} MCQ (${r.mcq_kind}), ${r.difficulty}, ${r.marks} mark(s) each. Difficulty meaning: ${difficulty}`;
    }

    return `- ${r.count} ${r.qtype} question(s), ${r.difficulty}, ${r.marks} mark(s) each. Difficulty meaning: ${difficulty}`;
  })
  .join("\n")}

${
  sourceChunk
    ? `
SOURCE SECTION ${sourceIndex} OF ${sourceTotal}:
The complete uploaded document is being distributed across parallel batches.
Use the concepts in THIS section so the final paper covers the whole upload.

"""
${sourceChunk}
"""
`
    : ""
}

CODING LEVEL:
${codingLevel}

STRICT RULES:

GENERAL
- Do not repeat the same question or merely change numbers.
- Every question must have a meaningful explanation/answer rationale.
- Put the answer in answer fields only. NEVER reveal the answer inside the prompt.
- answer_basis="generated" for all generated questions.
- Return exactly the requested number and mix.

MCQ
- EXACTLY 4 plausible options.
- options contains option text only.
- correct_key MUST be exactly A, B, C or D.
- The keyed option must actually be correct.
- For mcq_kind=output/error/blank, put the program in code_snippet.
- For output questions, mentally execute the code before selecting the key.
- For error questions, there must be one clear intended defect.
- For blank questions, ____ must have one unambiguous best completion.

CLOZE
- Use ____ for each blank.
- cloze_answers MUST contain one correct answer per blank, in order.

LONG
- Do not put a model answer in prompt.
- explanation may contain a short marking guide / expected points.

CODING
- Language: ${language}.
- Include Task, Input format, Output format and at least one worked example in prompt.
- starter_code may parse input and include TODO comments, but MUST NOT contain the completed solution.
- test_cases MUST contain exactly 6 valid tests.
- Test 1-4: is_hidden=false.
- Test 5-6: is_hidden=true.
- expected_out must be exact.
- options=[], correct_key="", cloze_answers=[].

NON-CODING
- test_cases=[].

RETURN ONLY THIS JSON SHAPE:
{
  "questions": [
    {
      "qtype": "mcq|cloze|long|coding",
      "mcq_kind": "theory|output|error|blank",
      "difficulty": "easy|medium|hard",
      "prompt": "...",
      "code_snippet": "",
      "marks": 1,
      "options": [],
      "correct_key": "",
      "explanation": "",
      "cloze_answers": [],
      "language": "",
      "func_signature": "",
      "starter_code": "",
      "answer_basis": "generated",
      "test_cases": []
    }
  ]
}
`;
}

function importPrompt(
  sourceChunk: string,
  body: any,
  index: number,
  total: number,
) {
  const defaultMarks =
    Number(body.default_marks ?? 0);

  return `
You are importing an EXISTING teacher question paper into an exam platform.

This is source chunk ${index} of ${total}. Adjacent chunks may overlap slightly
so that a question crossing a page/chunk boundary is not lost.

IMPORTANT:
- Extract ALL complete questions visible in this chunk.
- Preserve question wording and options as closely as possible.
- Do NOT invent additional questions.
- Duplicate overlap will be removed by the platform later.
- Detect MCQ, cloze/fill-blank, coding and long-answer questions.
- Preserve marks when the source states them.
- ${
    defaultMarks > 0
      ? `When marks are absent use ${defaultMarks}.`
      : "When marks are absent use 1 for MCQ/cloze, 5 for long, 10 for coding."
  }

ANSWER KEYS:
- If the paper explicitly marks an MCQ answer, set correct_key and answer_basis="explicit".
- If no answer is printed but the MCQ has one clearly solvable correct answer, solve it and set answer_basis="inferred".
- If genuinely ambiguous, correct_key="" and answer_basis="unknown". Do NOT guess.
- For cloze, infer the answer only when it is clear; otherwise leave cloze_answers=[].
- For coding questions, create exactly 6 test cases when the specification is sufficient:
  first 4 visible, final 2 hidden.
- If a coding question is incomplete, use test_cases=[] rather than inventing a specification.

Return ONLY:
{
  "questions": [
    {
      "qtype": "mcq|cloze|long|coding",
      "mcq_kind": "theory|output|error|blank",
      "difficulty": "easy|medium|hard",
      "prompt": "...",
      "code_snippet": "",
      "marks": 1,
      "options": [],
      "correct_key": "",
      "explanation": "",
      "cloze_answers": [],
      "language": "",
      "func_signature": "",
      "starter_code": "",
      "answer_basis": "explicit|inferred|unknown",
      "test_cases": []
    }
  ]
}

SOURCE:
"""
${sourceChunk}
"""
`;
}

function expandMix(mix: unknown): QuestionSpec[] {
  if (!Array.isArray(mix)) return [];

  const rows =
    mix
      .map((r: any) => ({
        qtype:
          ["mcq", "cloze", "long", "coding"].includes(r?.qtype)
            ? r.qtype
            : "long",
        mcq_kind:
          ["theory", "output", "error", "blank"].includes(r?.mcq_kind)
            ? r.mcq_kind
            : "theory",
        difficulty:
          ["easy", "medium", "hard"].includes(r?.difficulty)
            ? r.difficulty
            : "medium",
        marks:
          Math.max(0.5, Number(r?.marks) || 1),
        count:
          Math.max(0, Math.min(50, Number(r?.count) || 0)),
      }))
      .filter((r) => r.count > 0);

  const specs: QuestionSpec[] = [];
  const left = rows.map((r) => ({ ...r }));

  while (left.some((r) => r.count > 0)) {
    for (const r of left) {
      if (r.count <= 0) continue;

      specs.push({
        qtype: r.qtype,
        mcq_kind: r.mcq_kind,
        difficulty: r.difficulty,
        marks: r.marks,
      });

      r.count--;

      if (specs.length >= MAX_GENERATED_QUESTIONS + 1) {
        return specs;
      }
    }
  }

  return specs;
}

function groupSpecs(specs: QuestionSpec[]) {
  const map = new Map<string, any>();

  for (const s of specs) {
    const key =
      `${s.qtype}|${s.mcq_kind}|${s.difficulty}|${s.marks}`;

    if (!map.has(key)) {
      map.set(key, {
        ...s,
        count: 0,
      });
    }

    map.get(key).count++;
  }

  return [...map.values()];
}

function tidyQuestion(
  q: any,
  mode: "generate" | "import",
  provider: ProviderName,
) {
  const out: any = { ...q };

  out.qtype =
    ["mcq", "cloze", "long", "coding"].includes(out.qtype)
      ? out.qtype
      : "long";

  out.mcq_kind =
    out.qtype === "mcq" &&
    ["theory", "output", "error", "blank"].includes(out.mcq_kind)
      ? out.mcq_kind
      : "theory";

  out.difficulty =
    ["easy", "medium", "hard"].includes(out.difficulty)
      ? out.difficulty
      : "medium";

  out.prompt = String(out.prompt ?? "").trim();
  out.code_snippet = String(out.code_snippet ?? "").trim();

  out.marks =
    Math.max(
      0.5,
      Number(out.marks) ||
        (out.qtype === "coding"
          ? 10
          : out.qtype === "long"
          ? 5
          : 1),
    );

  out.options =
    Array.isArray(out.options)
      ? out.options
          .map((x: any) =>
            String(x ?? "")
              .replace(/^\s*[A-D][.)]\s*/i, "")
              .trim()
          )
          .filter(Boolean)
          .slice(0, 4)
      : [];

  out.correct_key = normalizeKey(
    out.correct_key,
    out.options.length,
  );

  out.explanation = String(out.explanation ?? "").trim();

  out.cloze_answers =
    Array.isArray(out.cloze_answers)
      ? out.cloze_answers
          .map((x: any) => String(x ?? "").trim())
          .filter(Boolean)
      : [];

  out.language = String(out.language ?? "").trim();
  out.func_signature = String(out.func_signature ?? "").trim();
  out.starter_code = String(out.starter_code ?? "");

  out.answer_basis =
    ["generated", "explicit", "inferred", "unknown", "verified"].includes(
      out.answer_basis,
    )
      ? out.answer_basis
      : mode === "generate"
      ? "generated"
      : "unknown";

  out.test_cases =
    out.qtype === "coding"
      ? normalizeCodingTests(out.test_cases)
      : [];

  if (out.qtype !== "mcq") {
    out.options = [];
    out.correct_key = "";
  }

  if (out.qtype !== "cloze") {
    out.cloze_answers = [];
  }

  out._provider = provider;

  return out;
}

function isUsableQuestion(q: any) {
  if (!q?.prompt || q.prompt.length < 3) return false;

  if (q.qtype === "mcq" && q.options.length < 2) {
    return false;
  }

  return true;
}

function normalizeKey(
  value: unknown,
  optionCount: number,
) {
  const key =
    String(value ?? "")
      .trim()
      .toUpperCase()
      .replace(/[^A-D]/g, "")
      .slice(0, 1);

  if (!key) return "";

  const index = "ABCD".indexOf(key);

  if (
    index < 0 ||
    index >= optionCount
  ) {
    return "";
  }

  return key;
}

function normalizeCodingTests(value: unknown) {
  if (!Array.isArray(value)) return [];

  return value
    .filter(
      (t: any) =>
        t &&
        typeof t === "object" &&
        String(t.expected_out ?? "").length > 0,
    )
    .slice(0, 6)
    .map((t: any, i) => ({
      stdin: String(t.stdin ?? ""),
      expected_out:
        String(t.expected_out ?? "")
          .replace(/\r\n/g, "\n")
          .trimEnd(),
      is_hidden: i >= 4,
    }));
}

function objectiveNeedsTeacherReview(q: any) {
  if (q.qtype === "mcq") {
    return !normalizeKey(
      q.correct_key,
      q.options.length,
    );
  }

  if (q.qtype === "cloze") {
    const blanks =
      (q.prompt.match(/____/g) ?? []).length;

    if (blanks <= 0) return true;

    return q.cloze_answers.length !== blanks;
  }

  return false;
}

function stripInternalFields(q: any) {
  const { _provider, ...clean } = q;
  return clean;
}

function normalizeSourceText(text: string) {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\u0000/g, "")
    .trim();
}

function splitTextIntoCount(
  text: string,
  count: number,
  overlap: number,
) {
  if (count <= 1 || text.length < 2_000) {
    return [text];
  }

  const target = Math.ceil(text.length / count);

  const out: string[] = [];
  let start = 0;

  for (let i = 0; i < count; i++) {
    if (start >= text.length) {
      out.push("");
      continue;
    }

    let end =
      i === count - 1
        ? text.length
        : Math.min(
            text.length,
            start + target,
          );

    if (end < text.length) {
      end = findSafeBoundary(
        text,
        end,
        Math.min(
          3_000,
          Math.floor(target / 3),
        ),
      );
    }

    out.push(
      text.slice(start, end).trim(),
    );

    if (end >= text.length) {
      start = text.length;
    } else {
      start = Math.max(0, end - overlap);
    }
  }

  if (start < text.length && out.length) {
    out[out.length - 1] =
      `${out[out.length - 1]}\n\n${text.slice(start)}`.trim();
  }

  return out;
}

function splitByMaxChars(
  text: string,
  maxChars: number,
  overlap: number,
) {
  if (text.length <= maxChars) {
    return [text];
  }

  const out: string[] = [];
  let start = 0;

  while (start < text.length) {
    let end =
      Math.min(
        text.length,
        start + maxChars,
      );

    if (end < text.length) {
      end = findSafeBoundary(
        text,
        end,
        4_000,
      );
    }

    const chunk =
      text.slice(start, end).trim();

    if (chunk) out.push(chunk);

    if (end >= text.length) break;

    start = Math.max(
      start + 1,
      end - overlap,
    );
  }

  return out;
}

function findSafeBoundary(
  text: string,
  around: number,
  searchBack: number,
) {
  const from =
    Math.max(0, around - searchBack);

  const region =
    text.slice(from, around);

  const matches = [
    ...region.matchAll(
      /\n(?=(?:Q\s*)?\d{1,3}\s*[.)：:]\s*\S)/gi,
    ),
  ];

  if (matches.length) {
    const m = matches[matches.length - 1];
    return from + (m.index ?? region.length);
  }

  const para = region.lastIndexOf("\n\n");
  if (para >= 0) return from + para + 2;

  const line = region.lastIndexOf("\n");
  if (line >= 0) return from + line + 1;

  return around;
}

function dedupeQuestions(questions: any[]) {
  const seen = new Set<string>();
  const out: any[] = [];

  for (const q of questions) {
    const key =
      String(q.prompt ?? "")
        .toLowerCase()
        .replace(/\s+/g, " ")
        .replace(/[^\p{L}\p{N}\s]/gu, "")
        .trim()
        .slice(0, 500);

    if (!key || seen.has(key)) continue;

    seen.add(key);
    out.push(q);
  }

  return out;
}

function parseJsonLoose(text: string): any {
  const clean =
    String(text ?? "")
      .trim()
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "");

  try {
    return JSON.parse(clean);
  } catch {
    const first = clean.indexOf("{");
    const last = clean.lastIndexOf("}");

    if (first >= 0 && last > first) {
      try {
        return JSON.parse(
          clean.slice(first, last + 1),
        );
      } catch {
        return null;
      }
    }

    return null;
  }
}

function nextProvider(
  used: ProviderName | string | undefined,
  providers: Provider[],
  offset = 0,
) {
  if (!providers.length) {
    throw new Error("No provider configured.");
  }

  const index =
    providers.findIndex(
      (p) => p.name === used,
    );

  return providers[
    (
      (
        index >= 0
          ? index + 1 + offset
          : offset
      ) % providers.length +
      providers.length
    ) % providers.length
  ];
}

function chunkArray<T>(
  items: T[],
  size: number,
) {
  const out: T[][] = [];

  for (
    let i = 0;
    i < items.length;
    i += size
  ) {
    out.push(
      items.slice(i, i + size),
    );
  }

  return out;
}

async function mapPool<T, R>(
  items: T[],
  limit: number,
  worker: (
    item: T,
    index: number,
  ) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;

  const runners =
    Array.from(
      {
        length:
          Math.min(
            Math.max(1, limit),
            Math.max(1, items.length),
          ),
      },
      async () => {
        while (true) {
          const index = cursor++;

          if (index >= items.length) {
            return;
          }

          results[index] =
            await worker(
              items[index],
              index,
            );
        }
      },
    );

  await Promise.all(runners);

  return results;
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
