import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ReviewPlan, ReviewRun } from "@review-os/schemas";

async function readOptional(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

export async function writeAgentWorkspace(options: {
  outputDir: string;
  repoRoot: string;
  run: ReviewRun;
  plan: ReviewPlan;
  /** Pass ids the agent should execute (planner-selected). */
  passIds: string[];
}): Promise<void> {
  const agentDir = path.join(options.outputDir, "agent");
  const passesDir = path.join(options.outputDir, "passes");
  await mkdir(agentDir, { recursive: true });
  await mkdir(passesDir, { recursive: true });

  const focusFiles = (options.run.load?.files ?? [])
    .map((file) => file.path)
    .filter((filePath) =>
      /\.(ts|tsx|js|jsx|mjs|cjs|css|scss)$/i.test(filePath),
    )
    .slice(0, 60);

  for (const passId of options.passIds) {
    const prompt = await readOptional(
      path.join(options.repoRoot, "prompts", `${passId}.md`),
    );
    const rules = await readOptional(
      path.join(options.repoRoot, "rules", `${passId}.md`),
    );
    const extraInstructions = (
      await readOptional(path.join(options.outputDir, "extra-instructions.md"))
    ).trim();

    const brief = [
      `# Agent brief — ${passId}`,
      "",
      `PR #${options.run.prNumber}`,
      options.run.title ? `Title: ${options.run.title}` : "",
      options.run.prUrl ? `URL: ${options.run.prUrl}` : "",
      "",
      "## Your job",
      "",
      `You are the **${passId}** specialist. Blind review — do NOT read other passes/*.findings.json.`,
  "Be harsh in analysis. Keep reviewComment polite.",
  "Every issue needs evidence from the diff/code. If unsure, use kind=question.",
  "",
  "## Line numbers (critical)",
  "",
  "Use NEW-file / head-side line numbers from `diff.patch` only.",
  "For a new file `@@ -0,0 +1,16 @@`, valid lines are **1..16**. Never invent 42.",
  "`currentCode` must match the exact text at that line in the diff.",
  "If you cannot find the line, use `githubCommentTarget.target = summary`.",
  "",
  "## Documented intent",
  "",
  "If nearby comments explain why this code is intentional/temporary,",
  "prefer `severity: suggestion` + category `documented-debt` (follow-up reminder),",
  "not a harsh blocker. Acknowledge the author's reasoning in the comment.",
  "",
  ...(extraInstructions
    ? [
        "## Extra reviewer instructions",
        "",
        "Follow these for this entire review:",
        "",
        extraInstructions,
        "",
      ]
    : []),
  "## Read these",
      "",
      `- prompts/${passId}.md`,
      `- rules/${passId}.md`,
      `- reviews/${options.run.prNumber}/knowledge/*`,
      `- reviews/${options.run.prNumber}/diff.patch (focus on code files)`,
      `- reviews/${options.run.prNumber}/changed-files.md`,
      ...(extraInstructions
        ? [`- reviews/${options.run.prNumber}/extra-instructions.md`]
        : []),
      "",
      "## Focus files (prefer these)",
      "",
      ...(focusFiles.length
        ? focusFiles.map((file) => `- ${file}`)
        : ["- (see changed-files.md)"]),
      "",
      "## Embedded prompt",
      "",
      prompt || "(missing prompt file)",
      "",
      "## Embedded rules",
      "",
      rules || "(none)",
      "",
      "## Output",
      "",
      `Write a JSON array to:`,
      "",
      `passes/${passId}.findings.json`,
      "",
      "Each object fields: kind, file, line, endLine?, severity, category, confidence, importance,",
      "currentCode, issueSimple, whyWeak, howToFix, betterCode, reviewComment, evidence[], language,",
      "githubCommentTarget { target, reason }.",
      "",
    ]
      .filter(Boolean)
      .join("\n");

    await writeFile(path.join(agentDir, `${passId}.brief.md`), brief, "utf8");
  }

  const readme = [
    `# Agent run — PR #${options.run.prNumber}`,
    "",
    "No API key needed. **You** (Cursor / Claude Code / Command Code) are the model.",
    "",
    "## Steps",
    "",
    "1. For each brief below, run that specialist pass independently (blind).",
    "2. Write findings JSON into `passes/<pass>.findings.json`.",
    "3. Finalize:",
    "",
    "```bash",
    `pnpm prsm --finalize ${options.run.prNumber}`,
    "```",
    "",
    "4. Open `final-review.md` (and `.html`).",
    "",
    "## Passes to run",
    "",
    ...options.passIds.map((id) => `- [ ] \`agent/${id}.brief.md\` → \`passes/${id}.findings.json\``),
    "",
    "## Plan rationale",
    "",
    options.plan.rationale,
    "",
  ].join("\n");

  await writeFile(path.join(agentDir, "README.md"), readme, "utf8");
}
