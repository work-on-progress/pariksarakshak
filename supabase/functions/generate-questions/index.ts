// supabase/functions/generate-questions/index.ts
// Drafts exam questions with the Gemini API using a strict response schema,
// so what comes back is always shaped the way the database expects.
// The API key lives in Supabase secrets and never reaches a browser.
import { createClient } from "npm:@supabase/supabase-js@2";

const GEMINI_KEY = Deno.env.get("GEMINI_API_KEY")!;
const MODEL = "gemini-3.6-flash";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const responseSchema = {
  type: "OBJECT",
  properties: {
    questions: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          qtype: { type: "STRING", enum: ["mcq", "cloze", "long", "coding"] },
          prompt: { type: "STRING" },
          marks: { type: "NUMBER" },
          options: {
            type: "ARRAY", items: { type: "STRING" },
            description: "Exactly four options for MCQ, each starting 'A) ', 'B) ', 'C) ', 'D) '. Empty otherwise.",
          },
          correct_key: { type: "STRING", description: "A, B, C or D for MCQ. Empty otherwise." },
          cloze_answers: {
            type: "ARRAY", items: { type: "STRING" },
            description: "One answer per ____ blank, in order. Empty otherwise.",
          },
          language: { type: "STRING", description: "python, c, cpp, java or javascript for coding. Empty otherwise." },
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
        required: ["qtype", "prompt", "marks"],
      },
    },
  },
  required: ["questions"],
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    // 1. Faculty only
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
      return json({ error: "Only faculty accounts can draft questions." }, 403);
    }

    // 2. Input
    const { topic, source_text = "", distribution, save_to_exam_id } = await req.json();
    if (!topic && !source_text) {
      return json({ error: "Give a topic, or paste the notes to draw from." }, 400);
    }
    const dist = { mcq: 0, cloze: 0, long: 0, coding: 0, ...(distribution ?? {}) };

    // 3. Prompt
    const prompt = `
You are an experienced university examiner writing an end-of-unit paper.

TOPIC: ${topic}
${source_text ? `SOURCE MATERIAL — base every question only on this text:\n${source_text.slice(0, 30000)}` : ""}

Produce exactly this many questions:
- ${dist.mcq} multiple choice, four options each ("A) …" through "D) …"), one correct_key letter, 1 mark each
- ${dist.cloze} fill in the blanks, using ____ for each blank, cloze_answers holding one exact answer per blank in order, 1 mark each
- ${dist.long} long answer, conceptual, 5 marks each
- ${dist.coding} coding problems in Python, 10 marks each, and for each one:
    * a prompt with the problem, an Input format section and an Output format section
    * stdin/stdout style: the program reads with input() and prints the result
    * starter_code that already parses the input and leaves a TODO
    * 5 to 7 test cases: exactly 2 with is_hidden=false as worked examples,
      the rest with is_hidden=true covering edge cases — empty input, largest
      allowed size, negatives, duplicates
    * expected_out must be the exact stdout, with no trailing spaces

Rules:
- Distractors must be plausible mistakes a student would actually make.
- Never reveal an answer inside the prompt text.
- Keep the wording plain and unambiguous.
`;

    // 4. Call Gemini
    const gRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${GEMINI_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema,
            temperature: 0.7,
          },
        }),
      },
    );
    if (!gRes.ok) {
      const detail = await gRes.text();
      return json({ error: `The question service refused the request: ${detail.slice(0, 400)}` }, 502);
    }
    const gData = await gRes.json();
    const text = gData.candidates?.[0]?.content?.parts?.[0]?.text ?? "{}";
    const parsed = JSON.parse(text);

    // 5. Optional: save straight to a paper (ownership is checked first)
    if (save_to_exam_id) {
      const admin = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
      );
      const { data: exam } = await admin.from("exams")
        .select("id").eq("id", save_to_exam_id).eq("faculty_id", user.id).single();
      if (!exam) return json({ error: "That paper does not belong to this account." }, 403);

      let position = 1;
      for (const q of parsed.questions) {
        const { data: row, error } = await admin.from("questions").insert({
          exam_id: save_to_exam_id, qtype: q.qtype, position: position++,
          marks: q.marks, prompt: q.prompt,
          options: q.options?.length ? q.options : null,
          correct_key: q.correct_key || null,
          cloze_answers: q.cloze_answers?.length ? q.cloze_answers : null,
          language: q.language || null,
          func_signature: q.func_signature || null,
          starter_code: q.starter_code || null,
        }).select("id").single();
        if (error) return json({ error: error.message }, 500);

        if (q.qtype === "coding" && q.test_cases?.length) {
          const rows = q.test_cases.map((t: any, i: number) => ({
            question_id: row.id, stdin: t.stdin, expected_out: t.expected_out,
            is_hidden: t.is_hidden, position: i + 1,
          }));
          const { error: tErr } = await admin.from("test_cases").insert(rows);
          if (tErr) return json({ error: tErr.message }, 500);
        }
      }
      return json({ saved: true, count: parsed.questions.length });
    }

    // Preview: faculty may see the keys
    return json(parsed);
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
