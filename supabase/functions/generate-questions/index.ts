// supabase/functions/generate-questions/index.ts
//
// Two jobs, chosen by `mode`:
//   "generate" — write new questions from a topic or from uploaded notes,
//                following a mix the teacher specifies row by row.
//   "import"   — take questions that already exist in a document and turn
//                them into structured rows, inventing nothing.
//
// The Gemini key lives in Supabase secrets and never reaches a browser.
import { createClient } from "npm:@supabase/supabase-js@2";

const GEMINI_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
const MODELS = [
  Deno.env.get("GEMINI_MODEL") ?? "gemini-3.7-flash",
  "gemini-3.6-flash",
  "gemini-3.5-flash-lite",
];
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

/* ── The shape every reply must take ─────────────────────────────────── */
const responseSchema = {
  type: "OBJECT",
  properties: {
    questions: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          qtype: { type: "STRING", enum: ["mcq", "cloze", "long", "coding"] },
          mcq_kind: {
            type: "STRING", enum: ["theory", "output", "error", "blank"],
            description: "For MCQ only. theory for a concept question, output for 'what does this print', error for 'what is wrong with this code', blank for 'what completes the ____'. Use theory for every non-MCQ question.",
          },
          difficulty: { type: "STRING", enum: ["easy", "medium", "hard"] },
          prompt: { type: "STRING", description: "The question itself. Never put the program here — that goes in code_snippet." },
          code_snippet: { type: "STRING", description: "The program a code-based MCQ refers to. Empty for theory MCQs and all other types." },
          marks: { type: "NUMBER" },
          options: {
            type: "ARRAY", items: { type: "STRING" },
            description: "Exactly four options for MCQ, each starting 'A) ', 'B) ', 'C) ', 'D) '. Empty otherwise.",
          },
          correct_key: { type: "STRING", description: "A, B, C or D for MCQ. Empty otherwise." },
          explanation: { type: "STRING", description: "One or two sentences on why the answer is right." },
          cloze_answers: {
            type: "ARRAY", items: { type: "STRING" },
            description: "One answer per ____ blank, in order. Empty otherwise.",
          },
          language: { type: "STRING", description: "python, c, cpp, java or javascript for coding questions and code-based MCQs. Empty otherwise." },
          func_signature: { type: "STRING" },
          starter_code: { type: "STRING" },
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
        required: ["qtype", "prompt", "marks", "difficulty"],
      },
    },
  },
  required: ["questions"],
};

/* ── What each coding level may assume ───────────────────────────────── */
const CODING_LEVEL: Record<string, string> = {
  beginner:
    "First-year students in their first weeks of programming. Allowed: variables, arithmetic, if/else, while and for loops, lists or arrays, strings, reading input, printing, and simple user-defined functions. NOT allowed: list comprehensions, lambda, map/filter/reduce, recursion, dictionaries, sets, slicing tricks, any imported module, and any library function beyond len, range, int, str, float, sum, min, max, sorted, abs. Every problem must be solvable in about ten lines.",
  intermediate:
    "Students who have finished a first programming course. Allowed: everything a beginner may use, plus dictionaries, sets, sorting with a key, string methods, nested loops, recursion, list comprehensions, and simple use of the standard library. Not contest material.",
  advanced:
    "Students in a data structures or algorithms course. Time and space complexity matter. Two pointers, hashing, sorting, stacks, queues, binary search, dynamic programming and standard graph traversals are all fair game.",
};

const DIFFICULTY_NOTE: Record<string, string> = {
  easy: "recall and direct application; a student who read the notes should get it",
  medium: "requires connecting two ideas, or applying a concept to a new example",
  hard: "requires reasoning through several steps, a subtle distinction, or an edge case",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    /* ── who is asking ── */
    const authHeader = req.headers.get("Authorization") ?? "";
    const supaUser = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );
    const { data: { user } } = await supaUser.auth.getUser();
    if (!user) return json({ error: "Sign in again — the session has expired." }, 401);

    const { data: profile } = await supaUser
      .from("profiles").select("role").eq("id", user.id).single();
    if (profile?.role !== "faculty") {
      return json({ error: "Only faculty accounts can write questions." }, 403);
    }

    if (!GEMINI_KEY) {
      return json({ error: "No Gemini key on the server. Run: supabase secrets set GEMINI_API_KEY=…" }, 503);
    }

    const body = await req.json();
    const mode = body.mode ?? "generate";
    const sourceText = String(body.source_text ?? "").slice(0, 60000);

    const prompt = mode === "import"
      ? importPrompt(sourceText, body)
      : generatePrompt(body, sourceText);

    if (!prompt) {
      return json({
        error: mode === "import"
          ? "There was no text to import. Upload a file, or paste the questions."
          : "Give a topic or upload notes, and add at least one row to the mix.",
      }, 400);
    }

    /* ── call Gemini ── */
    let gRes: Response | null = null;
let lastDetail = "";
let usedModel = "";

for (const model of MODELS) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": GEMINI_KEY,
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema,
          temperature: mode === "import" ? 0.1 : 0.75,
          maxOutputTokens: 16384,
        },
      }),
    },
  );

  if (res.ok) {
    gRes = res;
    usedModel = model;
    break;
  }

  lastDetail = await res.text();

  // Try next free model only for temporary availability/model issues.
  if (res.status === 503 || res.status === 404 || res.status === 429) {
    continue;
  }

  return json(
    { error: `Question service: ${lastDetail.slice(0, 300)}` },
    502,
  );
}

if (!gRes) {
  return json(
    {
      error:
        `All free Gemini models are currently unavailable. Last error: ${lastDetail.slice(0, 300)}`,
    },
    503,
  );
}

console.log(`Question generation succeeded with ${usedModel}`);

    const gData = await gRes.json();
    const text = gData.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";

    let parsed: { questions?: any[] };
    try {
      parsed = JSON.parse(text);
    } catch {
      return json({ error: "The reply could not be read. Try again, or ask for fewer questions at once." }, 502);
    }
    if (!parsed.questions?.length) {
      return json({
        error: mode === "import"
          ? "No questions were found in that document. Check that it contains numbered questions."
          : "Nothing came back. Try a more specific topic.",
      }, 502);
    }

    return json({ questions: parsed.questions.map(tidy), mode });
  } catch (e) {
    console.error(e);
    return json({ error: `Unexpected server error: ${e}` }, 500);
  }
});

/* ── normalise the reply so the console can trust it ─────────────────── */
function tidy(q: any) {
  const out = { ...q };
  out.qtype = ["mcq", "cloze", "long", "coding"].includes(out.qtype) ? out.qtype : "long";
  out.difficulty = ["easy", "medium", "hard"].includes(out.difficulty) ? out.difficulty : "medium";
  out.mcq_kind = out.qtype === "mcq"
    ? (["theory", "output", "error", "blank"].includes(out.mcq_kind) ? out.mcq_kind : "theory")
    : "theory";
  out.marks = Number(out.marks) || (out.qtype === "coding" ? 10 : out.qtype === "long" ? 5 : 1);
  out.options = Array.isArray(out.options) ? out.options.filter(Boolean) : [];
  out.cloze_answers = Array.isArray(out.cloze_answers) ? out.cloze_answers.filter(Boolean) : [];
  out.test_cases = Array.isArray(out.test_cases) ? out.test_cases : [];
  out.correct_key = String(out.correct_key ?? "").trim().toUpperCase().slice(0, 1);
  out.code_snippet = String(out.code_snippet ?? "").trim();
  out.explanation = String(out.explanation ?? "").trim();
  out.prompt = String(out.prompt ?? "").trim();
  return out;
}

/* ── writing new questions ───────────────────────────────────────────── */
function generatePrompt(body: any, sourceText: string) {
  const topic = String(body.topic ?? "").trim();
  const rows: any[] = Array.isArray(body.mix) ? body.mix : [];
  const language = body.language ?? "python";
  const codingLevel = CODING_LEVEL[body.coding_level] ?? CODING_LEVEL.beginner;
  const questionLanguage = body.question_language ?? "English";

  const wanted = rows.filter((r) => Number(r.count) > 0);
  if (!wanted.length) return "";
  if (!topic && !sourceText) return "";

  const lines = wanted.map((r) => {
    const d = DIFFICULTY_NOTE[r.difficulty] ?? DIFFICULTY_NOTE.medium;
    const marks = Number(r.marks) || 1;

    if (r.qtype === "mcq") {
      const kind = ({
        theory: "a concept question in words, with no program shown. Leave code_snippet empty.",
        output: `a short ${language} program in code_snippet, and the question asks exactly what it prints. The four options must be plausible outputs, including the results of common mistakes.`,
        error: `a short ${language} program in code_snippet containing exactly one defect. The question asks what is wrong with it. Options must name specific defects, not vague ones.`,
        blank: `a short ${language} program in code_snippet with ____ marking one missing piece. The question asks which option correctly completes it. All four options must be syntactically valid in that position.`,
      } as Record<string, string>)[r.mcq_kind] ?? "a concept question in words.";

      return `- ${r.count} multiple-choice questions, ${r.difficulty} (${d}), ${marks} mark each. Kind "${r.mcq_kind}": ${kind} Four options A) to D), one correct_key letter.`;
    }
    if (r.qtype === "cloze") {
      return `- ${r.count} fill-in-the-blank questions, ${r.difficulty} (${d}), ${marks} mark each. Use ____ for each blank, and give one exact answer per blank, in order, in cloze_answers.`;
    }
    if (r.qtype === "long") {
      return `- ${r.count} long-answer questions, ${r.difficulty} (${d}), ${marks} marks each. Conceptual, answerable in a paragraph or two.`;
    }
    if (r.qtype === "coding") {
      return `- ${r.count} coding problems in ${language}, ${r.difficulty} (${d}), ${marks} marks each, and for each one:
      * a prompt with the problem, an Input format section, an Output format section and one worked example
      * stdin/stdout style: the program reads from standard input and prints the result
      * starter_code that already parses the input and leaves a clear TODO
      * 5 to 7 test cases: exactly 2 with is_hidden=false matching the worked example, the rest is_hidden=true covering the smallest input, the largest allowed size, negatives, duplicates and a single element
      * expected_out must be the exact standard output, with no trailing spaces`;
    }
    return "";
  }).filter(Boolean);

  return `
You are an experienced university examiner writing an end-of-unit paper.
Write every question in ${questionLanguage}.

TOPIC: ${topic || "(take the topic from the source material)"}
${sourceText ? `\nSOURCE MATERIAL — base every question only on what this text actually covers. Do not test anything it does not mention:\n"""\n${sourceText}\n"""\n` : ""}

Produce exactly this mix, and nothing else:
${lines.join("\n")}

CODING AND CODE-SNIPPET LEVEL — this binds every program you write, in coding
questions and in code-based multiple choice alike:
${codingLevel}

Rules:
- Set "difficulty" on every question to the value it was asked for.
- Set "mcq_kind" on every multiple-choice question. Use "theory" elsewhere.
- Programs go in code_snippet, never inside prompt. Keep them under 15 lines.
- Distractors must be mistakes a real student would make, never absurd.
- Never reveal the answer inside the prompt, the snippet or the options.
- Fill in "explanation" for every question, in one or two sentences.
- Do not ask the same idea twice.
- Plain, unambiguous wording. No double negatives.
`;
}

/* ── lifting questions out of a teacher's own document ───────────────── */
function importPrompt(sourceText: string, body: any) {
  if (!sourceText.trim()) return "";
  const marksNote = body.default_marks
    ? `If a question does not state its marks, use ${body.default_marks}.`
    : "If a question does not state its marks, use 1 for multiple choice and fill-in-the-blank, 5 for long answers, 10 for coding problems.";

  return `
Below is a question paper or question bank from a teacher's own document.
Convert it into structured data. This is transcription, not authoring.

RULES — these matter more than anything else:
- Reproduce each question as written. Do not rewrite, improve, shorten or translate.
- Do NOT invent questions. If the document holds eleven, return eleven.
- If the document marks the correct answer — a key, an asterisk, bold text, or an
  answer section at the end — use it. If it does not, set correct_key to "" and
  leave it for the teacher. Never guess.
- Classify each one: mcq (has options), cloze (blanks written as ____ or dots),
  coding (asks for a program), otherwise long.
- If a question shows a program and asks about it, put the program in code_snippet
  and set mcq_kind to output, error or blank as fits.
- Judge difficulty yourself: easy, medium or hard.
- ${marksNote}
- Leave test_cases empty. The teacher will add them.
- Leave explanation empty unless the document gives one.

DOCUMENT:
"""
${sourceText}
"""
`;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}
