// public/js/docimport.js
//
// Reads TXT/MD/CSV/PDF/DOCX in the browser.
// Nothing is permanently uploaded.
//
// PDF FIX:
// - Reads EVERY PDF page.
// - Adds page markers so the AI can see document boundaries.
// - Does not cut the text to a preview length.
// - Keeps extraction local in the browser.
// - A scanned/image-only PDF still needs OCR; that limitation is reported
//   explicitly rather than silently returning half/empty content.

import {
  PDFJS_URL,
  PDFJS_WORKER,
  MAMMOTH_URL,
} from "./config.js";

const loaded = {};

function loadScript(url) {
  if (loaded[url]) return loaded[url];

  loaded[url] = new Promise(
    (resolve, reject) => {
      const s =
        document.createElement("script");

      s.src = url;
      s.onload = resolve;

      s.onerror = () =>
        reject(
          new Error(
            `Could not load ${url}`,
          ),
        );

      document.head.appendChild(s);
    },
  );

  return loaded[url];
}

export async function extractText(file) {
  const name =
    file.name.toLowerCase();

  if (
    name.endsWith(".txt") ||
    name.endsWith(".md") ||
    name.endsWith(".csv")
  ) {
    return {
      text:
        (await file.text()).trim(),
    };
  }

  if (name.endsWith(".pdf")) {
    return readPdf(file);
  }

  if (name.endsWith(".docx")) {
    await loadScript(MAMMOTH_URL);

    if (!window.mammoth) {
      throw new Error(
        "The Word reader did not load. Check the connection and try again.",
      );
    }

    const buf =
      await file.arrayBuffer();

    const res =
      await window.mammoth.extractRawText({
        arrayBuffer: buf,
      });

    return {
      text:
        (res.value ?? "").trim(),
    };
  }

  if (name.endsWith(".doc")) {
    throw new Error(
      "Old .doc files cannot be read here. Open it in Word and save as .docx, or copy/paste the text.",
    );
  }

  throw new Error(
    "Use PDF, DOCX, TXT, MD or CSV — or paste the text directly.",
  );
}

async function readPdf(file) {
  await loadScript(PDFJS_URL);

  const pdfjs =
    window.pdfjsLib;

  if (!pdfjs) {
    throw new Error(
      "The PDF reader did not load. Check the connection and try again.",
    );
  }

  pdfjs.GlobalWorkerOptions.workerSrc =
    PDFJS_WORKER;

  const buf =
    await file.arrayBuffer();

  const pdf =
    await pdfjs
      .getDocument({
        data: buf,
      })
      .promise;

  const pages = [];

  // Read every page. Sequential reading keeps large PDFs stable.
  for (
    let pageNo = 1;
    pageNo <= pdf.numPages;
    pageNo++
  ) {
    const page =
      await pdf.getPage(pageNo);

    const content =
      await page.getTextContent({
        normalizeWhitespace: true,
      });

    const text =
      textItemsToLines(
        content.items ?? [],
      );

    pages.push(
      `--- PAGE ${pageNo} OF ${pdf.numPages} ---\n${text}`,
    );

    if (pageNo % 8 === 0) {
      await new Promise((r) =>
        setTimeout(r, 0)
      );
    }
  }

  const text =
    pages
      .join("\n\n")
      .replace(/\u0000/g, "")
      .trim();

  const visibleChars =
    text
      .replace(
        /--- PAGE \d+ OF \d+ ---/g,
        "",
      )
      .replace(/\s/g, "")
      .length;

  return {
    text,
    pages: pdf.numPages,
    warning:
      visibleChars < Math.max(
        40,
        pdf.numPages * 8,
      )
        ? "Very little selectable text came out of this PDF. It is probably scanned/image-only. The platform read every page, but images need OCR before reliable question import."
        : undefined,
  };
}

function textItemsToLines(items) {
  const lines = [];

  let currentY = null;
  let current = [];

  const pushLine = () => {
    if (!current.length) return;

    const line =
      current
        .join(" ")
        .replace(/\s+/g, " ")
        .replace(/\s+([,.;:!?])/g, "$1")
        .replace(/\(\s+/g, "(")
        .replace(/\s+\)/g, ")")
        .trim();

    if (line) lines.push(line);

    current = [];
  };

  for (const item of items) {
    if (
      !item ||
      typeof item.str !== "string"
    ) {
      continue;
    }

    const y =
      Math.round(
        item.transform?.[5] ?? 0,
      );

    if (
      currentY !== null &&
      Math.abs(y - currentY) > 3
    ) {
      pushLine();
    }

    const piece =
      item.str.trim();

    if (piece) {
      current.push(piece);
    }

    currentY = y;

    if (item.hasEOL) {
      pushLine();
      currentY = null;
    }
  }

  pushLine();

  return lines.join("\n");
}

export function parseQuestions(text) {
  const clean =
    text
      .replace(/\r\n/g, "\n")
      .replace(/\u00a0/g, " ");

  const lines =
    clean
      .split("\n")
      .map((l) => l.trim());

  const questions = [];
  let current = null;

  const startsQuestion = (l) =>
    /^(?:Q\s*)?\d{1,3}\s*[.)：:]\s*\S/i.test(l);

  const startsOption = (l) =>
    /^\(?([A-Da-d])[.)\]]\s*\S/.test(l);

  const answerLine = (l) =>
    l.match(
      /^(?:ans(?:wer)?|correct(?:\s*answer)?|key)\s*[:.\-]?\s*\(?([A-Da-d])\)?/i,
    );

  const push = () => {
    if (!current) return;

    current.prompt =
      current.prompt.trim();

    if (current.prompt) {
      current.qtype =
        current.options.length >= 2
          ? "mcq"
          : /_{3,}|\.{5,}/.test(
              current.prompt,
            )
          ? "cloze"
          : /write a (program|function)|implement|code to/i.test(
              current.prompt,
            )
          ? "coding"
          : "long";

      if (
        current.qtype === "cloze"
      ) {
        const blanks =
          (
            current.prompt.match(
              /_{3,}|\.{5,}/g,
            ) ?? []
          ).length || 1;

        current.prompt =
          current.prompt.replace(
            /_{3,}|\.{5,}/g,
            "____",
          );

        current.cloze_answers =
          new Array(blanks).fill("");
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

    if (
      /^--- PAGE \d+ OF \d+ ---$/i.test(
        line,
      )
    ) {
      continue;
    }

    const ans =
      answerLine(line);

    if (ans && current) {
      current.correct_key =
        ans[1].toUpperCase();

      continue;
    }

    if (startsQuestion(line)) {
      push();

      current = {
        prompt:
          line.replace(
            /^(?:Q\s*)?\d{1,3}\s*[.)：:]\s*/i,
            "",
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

    if (
      current &&
      startsOption(line)
    ) {
      const m =
        line.match(
          /^\(?([A-Da-d])[.)\]]\s*(.*)$/,
        );

      const letter =
        m[1].toUpperCase();

      let body =
        m[2].trim();

      if (
        /[*✓✔]\s*$/.test(body) ||
        /^\s*[*✓✔]/.test(body)
      ) {
        current.correct_key =
          letter;

        body =
          body
            .replace(/[*✓✔]/g, "")
            .trim();
      }

      current.options.push(
        `${letter}) ${body}`,
      );

      continue;
    }

    if (current) {
      current.prompt +=
        " " + line;
    }
  }

  push();

  const withoutKey =
    questions.filter(
      (q) =>
        q.qtype === "mcq" &&
        !q.correct_key,
    ).length;

  return {
    questions,
    withoutKey,
    note:
      questions.length
        ? `Found ${questions.length} question${questions.length === 1 ? "" : "s"}` +
          (
            withoutKey
              ? `, ${withoutKey} without a printed answer — use AI import if you want the platform to solve/verify those.`
              : "."
          )
        : "No numbered questions were recognised. Use AI import for a less regular layout.",
  };
}
