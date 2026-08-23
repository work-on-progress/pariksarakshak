// public/js/docimport.js
//
// Reads a teacher's notes or question paper in the browser and turns it into
// text. Nothing is uploaded, nothing is stored — the text goes straight into
// the request and is forgotten when the tab closes.
//
// PDF and DOCX libraries load from a CDN the first time they are needed, so
// a teacher who only ever pastes text never downloads them.
import { PDFJS_URL, PDFJS_WORKER, MAMMOTH_URL } from "./config.js";

const loaded = {};

function loadScript(url) {
  if (loaded[url]) return loaded[url];
  loaded[url] = new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = url;
    s.onload = resolve;
    s.onerror = () => reject(new Error(`Could not load ${url}`));
    document.head.appendChild(s);
  });
  return loaded[url];
}

export async function extractText(file) {
  const name = file.name.toLowerCase();

  if (name.endsWith(".txt") || name.endsWith(".md") || name.endsWith(".csv")) {
    return { text: await file.text() };
  }

  if (name.endsWith(".pdf")) {
    await loadScript(PDFJS_URL);
    const pdfjs = window.pdfjsLib;
    if (!pdfjs) throw new Error("The PDF reader did not load. Check the connection and try again.");

    pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;

    const buf = await file.arrayBuffer();
    const pdf = await pdfjs.getDocument({ data: buf }).promise;
    const parts = [];

    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();

      let lastY = null;
      let line = [];
      const lines = [];

      for (const item of content.items) {
        const y = Math.round(item.transform[5]);

        if (lastY !== null && Math.abs(y - lastY) > 3) {
          lines.push(line.join(""));
          line = [];
        }

        line.push(item.str);
        lastY = y;
      }

      if (line.length) lines.push(line.join(""));
      parts.push(lines.join("\n"));
    }

    const text = parts.join("\n\n").trim();

    return {
      text,
      pages: pdf.numPages,
      warning:
        text.length < 40
          ? "Almost no text came out of that PDF. It is probably a scan of paper — the words are pictures, not text. Retype the questions, or run the file through an OCR tool first."
          : undefined,
    };
  }

  if (name.endsWith(".docx")) {
    await loadScript(MAMMOTH_URL);

    if (!window.mammoth) {
      throw new Error("The Word reader did not load. Check the connection and try again.");
    }

    const buf = await file.arrayBuffer();
    const res = await window.mammoth.extractRawText({ arrayBuffer: buf });

    return { text: (res.value ?? "").trim() };
  }

  if (name.endsWith(".doc")) {
    throw new Error(
      "Old .doc files cannot be read here. Open it in Word and save as .docx, or copy the text and paste it."
    );
  }

  throw new Error(
    "Use a PDF, a .docx, or a plain text file — or paste the text instead."
  );
}

export function parseQuestions(text) {
  const clean = text.replace(/\r\n/g, "\n").replace(/\u00a0/g, " ");
  const lines = clean.split("\n").map((l) => l.trim());

  const questions = [];
  let current = null;

  const startsQuestion = (l) =>
    /^(?:Q\s*)?\d{1,3}\s*[.)：:]\s*\S/i.test(l);

  const startsOption = (l) =>
    /^\(?([A-Da-d])[.)\]]\s*\S/.test(l);

  const answerLine = (l) =>
    l.match(
      /^(?:ans(?:wer)?|correct(?:\s*answer)?|key)\s*[:.\-]?\s*\(?([A-Da-d])\)?/i
    );

  const push = () => {
    if (!current) return;

    current.prompt = current.prompt.trim();

    if (current.prompt) {
      current.qtype =
        current.options.length >= 2
          ? "mcq"
          : /_{3,}|\.{5,}/.test(current.prompt)
            ? "cloze"
            : /write a (program|function)|implement|code to/i.test(current.prompt)
              ? "coding"
              : "long";

      if (current.qtype === "cloze") {
        const blanks =
          (current.prompt.match(/_{3,}|\.{5,}/g) ?? []).length || 1;

        current.prompt = current.prompt.replace(/_{3,}|\.{5,}/g, "____");
        current.cloze_answers = new Array(blanks).fill("");
      }

      current.marks =
        current.qtype === "coding"
          ? 10
          : current.qtype === "long"
            ? 5
            : 1;

      questions.push(current);
    }

    current = null;
  };

  for (const line of lines) {
    if (!line) continue;

    const ans = answerLine(line);

    if (ans && current) {
      current.correct_key = ans[1].toUpperCase();
      continue;
    }

    if (startsQuestion(line)) {
      push();

      current = {
        prompt: line.replace(
          /^(?:Q\s*)?\d{1,3}\s*[.)：:]\s*/i,
          ""
        ),
        options: [],
        correct_key: "",
        cloze_answers: [],
        test_cases: [],
        difficulty: "medium",
        mcq_kind: "theory",
        code_snippet: "",
        explanation: "",
      };

      continue;
    }

    if (current && startsOption(line)) {
      const m = line.match(/^\(?([A-Da-d])[.)\]]\s*(.*)$/);

      const letter = m[1].toUpperCase();
      let body = m[2].trim();

      if (/[*✓✔]\s*$/.test(body) || /^\s*[*✓✔]/.test(body)) {
        current.correct_key = letter;
        body = body.replace(/[*✓✔]/g, "").trim();
      }

      current.options.push(`${letter}) ${body}`);
      continue;
    }

    if (current) {
      current.prompt += " " + line;
    }
  }

  push();

  const withoutKey = questions.filter(
    (q) => q.qtype === "mcq" && !q.correct_key
  ).length;

  return {
    questions,
    withoutKey,
    note: questions.length
      ? `Found ${questions.length} question${questions.length === 1 ? "" : "s"}` +
        (withoutKey
          ? `, ${withoutKey} without a marked answer — set those yourself before saving.`
          : ".")
      : "No numbered questions were recognised. Try the AI import instead, which copes with messier layouts.",
  };
}