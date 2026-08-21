# 3 · Question drafting — the `generate-questions` function

The code is in **`supabase/functions/generate-questions/index.ts`**. This guide gets it
deployed and explains how to change what it writes.

## 3.1 Install the tools (once)

Node.js from https://nodejs.org, then:

```bash
npm install -g supabase
supabase --version

supabase login
supabase link --project-ref YOUR_PROJECT_REF
```

`YOUR_PROJECT_REF` is the `abcd1234` part of your Supabase project URL.

## 3.2 Get a Gemini key and store it as a secret

1. Open https://aistudio.google.com and choose **Get API key**.
2. Store it on Supabase, not in the repository:

```bash
supabase secrets set GEMINI_API_KEY=AIza...your-key...
```

`SUPABASE_URL`, `SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are provided to
Edge Functions automatically — you do not set those.

## 3.3 Deploy

```bash
supabase functions deploy generate-questions
```

## 3.4 What it does, in order

1. **Checks the caller.** The request must carry a signed-in user's token, and that
   user's profile role must be `faculty`. A student token gets a 403.
2. **Builds the prompt** from the topic, the optional pasted notes, and the counts.
3. **Calls Gemini with a `responseSchema`.** Structured output means the reply is
   always valid JSON in the exact shape the database expects — no parsing of prose,
   no half-formed questions.
4. **Returns the draft** to the console for editing. Faculty may see the keys; that is
   the point of the role check in step 1.
5. **Optionally saves directly** if you pass `save_to_exam_id`. The function confirms
   the paper belongs to that teacher before writing anything.

The console uses the preview path, so nothing reaches the database until you have read
what the model wrote.

## 3.5 Test it

The easiest test is through the console after step 5 of the checklist. To test from a
terminal, sign in on the site, open the browser console and run
`(await supabase.auth.getSession()).data.session.access_token`, then:

```bash
curl -X POST "https://YOUR_PROJECT_REF.supabase.co/functions/v1/generate-questions" \
  -H "Authorization: Bearer PASTE_THE_TOKEN" \
  -H "apikey: YOUR_ANON_KEY" \
  -H "Content-Type: application/json" \
  -d '{"topic":"SQL indexing and query optimisation","distribution":{"mcq":2,"cloze":1,"long":1,"coding":1}}'
```

A good reply has exactly the counts you asked for, four options per MCQ with a single
letter key, one answer per blank, and a coding question with two visible examples plus
three or more hidden tests.

## 3.6 Changing what it writes

Everything you would want to change is in the `prompt` string inside the function:

| To change | Edit |
|---|---|
| Marks per question type | the mark values listed in the prompt, and `marks` in the schema description |
| Coding language | the sentence naming Python, and the `language` field description |
| Difficulty or style | add a line such as "Aim at first-year students; avoid trick questions" |
| Number of hidden tests | the "5 to 7 test cases" sentence |
| Question language (Hindi, bilingual) | add "Write every question in Hindi" or "Give each question in English followed by Hindi" |

Redeploy after any edit:

```bash
supabase functions deploy generate-questions
```

## 3.7 Working from lecture PDFs

Do not upload files to the function. Copy the text out of your PDF or slides and paste
it into the **Lecture notes** box in the console — it is sent as `source_text`, and the
prompt instructs the model to stay inside that text. Anything longer than roughly
30,000 characters is trimmed, so paste one unit at a time.

## 3.8 If it fails

| Message | Cause | Fix |
|---|---|---|
| `Only faculty accounts can draft questions.` | signed in as a student | promote the account in SQL (§2.4) |
| `The question service refused the request` with 400 | model name changed or key invalid | check the current model name in AI Studio and update `MODEL`; re-set the secret |
| with 429 | daily free allowance used up | wait for the reset, or draft fewer questions per call |
| Fewer questions than requested | the model trimmed a long request | ask for fewer at a time, or draft twice and save both |

Next → [04 · Code runner](04-PISTON-CODE-RUNNER.md)
