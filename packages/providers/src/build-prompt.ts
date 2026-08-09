import type { ProviderRequest } from "@review-os/core";

const CODE_FILE_RE = /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|css|scss)$/i;
const MAX_DIFF_CHARS = 80_000;
const MAX_KNOWLEDGE_CHARS = 12_000;

function preferCodeFiles(files: string[]): string[] {
  const code = files.filter((file) => CODE_FILE_RE.test(file));
  return code.length > 0 ? code : files.slice(0, 40);
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n…[truncated]`;
}

function filterDiffForFiles(diff: string, files: string[]): string {
  if (!diff) return "";
  if (files.length === 0) return truncate(diff, MAX_DIFF_CHARS);

  const wanted = new Set(files.map((file) => file.replaceAll("\\", "/")));
  const chunks = diff.split(/^diff --git /m).filter(Boolean);
  const kept: string[] = [];

  for (const chunk of chunks) {
    const header = chunk.split("\n", 1)[0] ?? "";
    const pathMatch = header.match(/b\/(.+)$/);
    const filePath = pathMatch?.[1]?.trim();
    if (filePath && wanted.has(filePath.replaceAll("\\", "/"))) {
      kept.push(`diff --git ${chunk}`);
    }
  }

  if (kept.length === 0) return truncate(diff, MAX_DIFF_CHARS);
  return truncate(kept.join("\n"), MAX_DIFF_CHARS);
}

export function buildReviewUserPrompt(request: ProviderRequest): string {
  const { passId, prompt, rules, context } = request;
  const focusFiles = preferCodeFiles(context.changedFiles);
  const knowledge = Object.entries(context.knowledge)
    .map(([name, body]) => `### ${name}\n${body}`)
    .join("\n\n");
  const diff = filterDiffForFiles(context.diffText ?? "", focusFiles);

  return [
    `# Pass: ${passId}`,
    "",
    "## Instructions",
    prompt,
    "",
    "## Rules",
    rules || "(none)",
    "",
    "## PR",
    `- Number: #${context.prNumber}`,
    `- Title: ${context.title ?? ""}`,
    context.prUrl ? `- URL: ${context.prUrl}` : "",
    context.base && context.head
      ? `- Branches: ${context.base} ← ${context.head}`
      : "",
    "",
    "## Changed files (focus)",
    ...focusFiles.slice(0, 80).map((file) => `- ${file}`),
    "",
    "## Knowledge",
    truncate(knowledge || "(none)", MAX_KNOWLEDGE_CHARS),
    "",
    "## Diff",
    diff || "(no diff available)",
    "",
    "## Output contract",
    "Return ONLY a JSON array of findings. No prose outside JSON.",
    "Each finding object must include:",
    "- kind: issue | question | praise",
    "- file, line, endLine?",
    "- severity: blocker | major | minor | nit | suggestion | question",
    "- category, confidence (0-1), importance (1-10)",
    "- currentCode, issueSimple, whyWeak, howToFix, betterCode",
    "- reviewComment (polite GitHub comment)",
    "- evidence: [{ quote, file?, line? }]",
    "- language (ts/tsx/js/etc)",
    "- githubCommentTarget: { target: line|summary, reason }",
    "",
    "## Writing style (critical — paste-ready teammate voice)",
    "Analysis can be sharp in whyWeak/howToFix. Public-facing text must be easy.",
    "",
    "issueSimple:",
    "- One short sentence (about 8–20 words).",
    "- Plain English: what goes wrong, for a busy teammate.",
    "- No stack jargon when a simple phrase works (prefer “can crash if X is missing” over “null dereference”).",
    "- Bad: “Potential NPE precipitating cascading failure in the auth subdomain.”",
    "- Good: “This can crash if the user is missing.”",
    "",
    "reviewComment (what gets pasted on GitHub):",
    "- 1–3 short sentences. Sound like a helpful teammate, not a report.",
    "- Prefer “Could we…?” / “Mind if we…?” / “Would it help to…?”",
    "- Name the risk + a concrete fix direction. No shame (“you forgot”, “obviously”, “this is wrong”).",
    "- No walls of text. No bullet lectures inside the comment unless asked.",
    "- Bad: “This is incorrect. The absence of a null check here is a critical defect that must be remediated immediately.”",
    "- Good: “Could we guard against a missing user here and return NotFound instead of crashing later?”",
    "",
    "whyWeak / howToFix:",
    "- Short paragraphs or 2–4 bullets max. Still plain English.",
    "- howToFix should be steps a human can do quickly.",
    "",
    "One finding = one problem. Be harsh in analysis. Stay kind in reviewComment.",
    "If you cannot prove an issue from the diff, use kind=question or omit it.",
    "Prefer code files over content/images.",
    "",
    "## Line numbers (critical)",
    "Use NEW-file line numbers from the unified diff (the + side / head file).",
    "For a brand-new file starting at @@ -0,0 +1,16 @@, valid lines are 1..16 only.",
    "Never invent line numbers. currentCode must be an exact snippet from that line.",
    "If unsure of the line, set githubCommentTarget.target=summary instead of guessing.",
    "",
    "## Documented intent",
    "Read nearby comments/docblocks. If they explain why code is temporary/intentional,",
    "do not treat it as an unknown bug. Prefer severity=suggestion, category=documented-debt,",
    "acknowledge the reason, and ask for a follow-up reminder/owner instead of blocking.",
  ]
    .filter(Boolean)
    .join("\n");
}
