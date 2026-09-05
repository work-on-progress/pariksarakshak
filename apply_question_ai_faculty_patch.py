from pathlib import Path

p = Path("public/js/faculty.js")

if not p.exists():
    raise SystemExit("Run this from the repository root. public/js/faculty.js was not found.")

s = p.read_text(encoding="utf-8")
original = s

replacements = [
    (
        'document.getElementById("sourceText").value = text.slice(0, 4000);',
        'document.getElementById("sourceText").value = text;',
    ),
    (
        'document.getElementById("paperText").value = text.slice(0, 6000);',
        'document.getElementById("paperText").value = text;',
    ),
    (
        '<input class="mix-count" type="number" min="0" max="30" value="${count}">',
        '<input class="mix-count" type="number" min="0" max="50" value="${count}">',
    ),
    (
        'if (total > 30) {',
        'if (total > 50) {',
    ),
    (
        '"Ask for 30 questions or fewer at a time — long requests come back trimmed. Run it twice."',
        '"Ask for 50 questions or fewer at a time. The server automatically divides large requests across the configured AI providers."',
    ),
]

for old, new in replacements:
    if old in s:
        s = s.replace(old, new)
    elif new not in s:
        raise SystemExit(
            "Faculty patch stopped because this expected code was not found:\\n\\n" + old
        )

old_import = '''  draft = res.questions;
  const missing = draft.filter((q) => q.qtype === "mcq" && !q.correct_key).length;
  note("importMsg",
    `Read ${draft.length} questions${missing ? `, ${missing} without a marked answer — set those before saving` : ""}.`,
    missing ? "warn" : "ok");
  renderDraft();'''

new_import = '''  draft = res.questions;
  const missing = draft.filter((q) =>
    (q.qtype === "mcq" && !q.correct_key) ||
    (q.qtype === "cloze" && !(q.cloze_answers ?? []).length)
  ).length;

  const providerText = res.provider_usage
    ? Object.entries(res.provider_usage)
        .map(([name, count]) => `${name} ${count}`)
        .join(" · ")
    : "";

  const chunkText = res.source_chunks
    ? ` · ${res.source_chunks} document chunk${res.source_chunks === 1 ? "" : "s"} processed`
    : "";

  note("importMsg",
    `Read ${draft.length} questions from the full document${chunkText}` +
    `${providerText ? ` · ${providerText}` : ""}` +
    `${missing ? ` · ${missing} objective answer${missing === 1 ? "" : "s"} still need review` : ""}.`,
    missing ? "warn" : "ok");

  renderDraft();'''

if old_import in s:
    s = s.replace(old_import, new_import)
elif new_import not in s:
    raise SystemExit("Could not find the current AI-import result block.")

old_generate = '''  draft = res.questions;
  const asked = total, got = draft.length;
  note("genMsg",
    got === asked
      ? `${got} questions written. Read them, edit anything, then save.`
      : `${got} questions came back out of ${asked} asked for. Save these and run it again for the rest.`,
    got === asked ? "ok" : "warn");
  renderDraft();'''

new_generate = '''  draft = res.questions;
  const asked = total, got = draft.length;

  const providerText = res.provider_usage
    ? Object.entries(res.provider_usage)
        .map(([name, count]) => `${name} ${count}`)
        .join(" · ")
    : "";

  const sourceTextInfo = res.source_characters_used
    ? ` · ${Number(res.source_characters_used).toLocaleString()} source characters used`
    : "";

  const review = Number(res.objective_questions_needing_review ?? 0);

  note("genMsg",
    (got === asked
      ? `${got} questions written`
      : `${got} questions came back out of ${asked}`) +
    `${providerText ? ` · ${providerText}` : ""}` +
    `${sourceTextInfo}` +
    `${review ? ` · ${review} answer${review === 1 ? "" : "s"} need review` : ""}. ` +
    (got === asked
      ? "Read them, edit anything, then save."
      : "Generate the missing quantity again."),
    got === asked && review === 0 ? "ok" : "warn");

  renderDraft();'''

if old_generate in s:
    s = s.replace(old_generate, new_generate)
elif new_generate not in s:
    raise SystemExit("Could not find the current generation result block.")

if s == original:
    print("No changes were necessary; the faculty question patch already appears installed.")
else:
    backup = p.with_suffix(".js.before-question-ai-v2")

    if not backup.exists():
        backup.write_text(original, encoding="utf-8")
        print(f"Backup created: {backup}")

    p.write_text(s, encoding="utf-8")
    print("Updated: public/js/faculty.js")
    print("PDF/notes text is no longer cut to 4,000/6,000 chars.")
    print("The UI now permits up to 50 generated questions.")
