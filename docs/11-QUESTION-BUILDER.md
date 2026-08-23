# 11 · Building a question paper

The **Questions** tab has three steps, in order down the page: where the
questions come from, what mix you want, and reading them before they are saved.

---

## 1 · Where they come from

### A topic
Type it and the questions are written from general knowledge of the subject.
Fastest, and fine for a practice quiz.

### My notes
Drop a PDF, a Word file or a text file, or paste the text. The file is read
**in your browser** — pdf.js for PDFs, mammoth for Word — and only the extracted
text is sent. Nothing is uploaded, nothing is stored, and no file ever reaches
the server.

Questions are then written from what that text actually covers, with an
instruction not to test anything it does not mention. This is the mode to use
for a real unit test, because it keeps the paper inside what you taught.

> **A scanned PDF will not work.** If your file is a photograph of printed pages,
> the words are pictures and there is no text to extract. You will get a warning
> saying exactly that. Retype the questions, or run the file through an OCR tool
> first.

### An existing paper
You already have a question bank or last year's paper. Bring it in as it is.
Two buttons:

- **Read them here** — a parser that runs in your browser, instantly and free.
  It handles the usual layout: numbered questions, options as `A)` or `(a)`,
  and an answer marked as `Answer: B`, an asterisk, or a tick.
- **Read them with AI** — for messier documents. The model is told plainly that
  this is transcription and not authoring: reproduce each question as written,
  invent nothing, and never guess an answer that is not marked.

Either way, anything without a marked answer is flagged **answer missing**, and
the console refuses to save until you have clicked the correct option. That is
deliberate — a paper that silently marks the wrong answer as correct is worse
than no paper.

---

## 2 · The mix

A table you build row by row. Each row is a type, a difficulty, a count and the
marks for each one.

| Type | What it is |
|---|---|
| MCQ — theory | A question in words. No code shown |
| MCQ — what does this code print | A short program, and four plausible outputs |
| MCQ — find the mistake | A program with exactly one defect, and four candidate defects |
| MCQ — complete the code | A program with `____` in it, and four things that could fill it |
| Fill in the blanks | `____` in a sentence, one exact answer per blank |
| Long answer | Conceptual, marked by you afterwards |
| Coding problem | Written and run against tests |

The summary line updates as you build: **12 questions · 22 marks · 5 easy,
5 medium, 2 hard.** Three presets — quick quiz, unit test, coding practical —
fill the table for you as a starting point.

### The three code-based MCQ kinds

These are the ones worth understanding, because they change what you can set
tomorrow without a working code runner.

**What does this code print** shows a program and asks for its output. The
distractors are the results of common mistakes — an off-by-one, a wrong loop
bound, integer division where float was meant.

**Find the mistake** shows a program with one defect and asks what is wrong.
Options name specific defects, never vague ones like "syntax error".

**Complete the code** shows a program with `____` and asks which option fills
it. All four options are syntactically valid in that position, so the student
has to reason about behaviour rather than spotting the one that compiles.

**None of these needs the code execution service.** They are graded like any
other multiple choice. If Piston is unreachable, code-based MCQs give you
code-flavoured questions that still work.

### Coding level

One setting, and it binds every program written anywhere in the paper —
in coding problems and in code-based MCQs alike.

| Level | What students may be assumed to know |
|---|---|
| **Beginner** | Variables, arithmetic, if/else, loops, lists, strings, input, print, simple functions. **Not** comprehensions, lambda, map/filter, recursion, dictionaries, sets, or any imported module. Solvable in about ten lines |
| **Intermediate** | The above plus dictionaries, sets, sorting with a key, string methods, nested loops, recursion, comprehensions, simple standard library |
| **Advanced** | Data structures and algorithms. Complexity matters. Two pointers, hashing, stacks, queues, binary search, dynamic programming, graph traversal |

This is the setting that stops a first-week paper from asking about
`functools.reduce`. If your students are beginners, set beginner and the model
is explicitly forbidden the advanced constructs.

---

## 3 · Read them before you save

Every question appears as a card with its type, kind, difficulty and marks. You
can edit the wording in place, click a different option to change the answer,
and delete anything you dislike. Nothing reaches the database until you press
**Save to paper**.

**Read the code-based questions especially carefully.** A language model asked
"what does this print" will sometimes be confidently wrong — that is exactly the
kind of question it gets wrong. You are the check, and there is no substitute
for it.

---

## Writing one by hand

Below the generator, a full editor: type, difficulty, marks, the kind of MCQ,
the code snippet that goes above the question, the four options, an explanation
shown when you release results, and a test-case grid for coding problems.

Existing questions open in the same editor from the list on the right, so
fixing a bad question takes ten seconds.

---

## Practical limits

- **Thirty questions per request.** Long requests come back trimmed. Ask for
  twenty, save them, ask for the rest — the position numbering continues.
- **Roughly 60,000 characters of notes.** Paste one unit at a time.
- **The free Gemini tier has a daily allowance.** If drafting fails with a quota
  message, that is what happened. Questions you have already saved are safe.
