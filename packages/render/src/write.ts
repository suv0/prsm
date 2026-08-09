import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ReviewRun } from "@review-os/schemas";
import { renderFinalReviewMarkdown } from "./markdown.js";
import { renderFinalReviewHtml } from "./html.js";
import { renderFinalReviewTriage } from "./triage.js";

export type WriteReviewArtifactsOptions = {
  /**
   * Prepare mode: update knowledge/plan/diff/run.json but do not overwrite
   * an existing merged final-review (keeps multi-agent history intact).
   */
  preserveExistingFinal?: boolean;
};

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function writeKnowledgeDocs(
  outputDir: string,
  docs: Record<string, string>,
): Promise<void> {
  const knowledgeDir = path.join(outputDir, "knowledge");
  await mkdir(knowledgeDir, { recursive: true });
  for (const [name, body] of Object.entries(docs)) {
    await writeFile(path.join(knowledgeDir, name), body, "utf8");
  }
}

export async function writeReviewArtifacts(
  run: ReviewRun,
  outputDir: string,
  diffText?: string,
  options: WriteReviewArtifactsOptions = {},
): Promise<void> {
  await mkdir(outputDir, { recursive: true });

  const finalMd = path.join(outputDir, "final-review.md");
  const finalHtml = path.join(outputDir, "final-review.html");
  const triageHtml = path.join(outputDir, "triage.html");
  const findingsPath = path.join(outputDir, "findings.json");
  const skipFinal =
    Boolean(options.preserveExistingFinal) &&
    ((await exists(finalHtml)) ||
      (await exists(finalMd)) ||
      (await exists(path.join(outputDir, "runs"))) ||
      (await exists(path.join(outputDir, "agents-index.json"))));

  if (!skipFinal) {
    const markdown = renderFinalReviewMarkdown(run);
    const html = renderFinalReviewHtml(run);
    const triage = renderFinalReviewTriage(run);
    await writeFile(finalMd, markdown, "utf8");
    await writeFile(finalHtml, html, "utf8");
    await writeFile(triageHtml, triage, "utf8");
    await writeFile(
      findingsPath,
      JSON.stringify(
        {
          findings: run.findings,
          judge: run.judge,
        },
        null,
        2,
      ),
      "utf8",
    );
  }

  let runToWrite: ReviewRun = run;
  if (skipFinal) {
    try {
      const existing = JSON.parse(
        await readFile(path.join(outputDir, "run.json"), "utf8"),
      ) as ReviewRun;
      if (
        (Array.isArray(existing.findings) && existing.findings.length > 0) ||
        (Array.isArray(existing.agents) && existing.agents.length > 0)
      ) {
        runToWrite = {
          ...run,
          findings: existing.findings,
          judge: existing.judge ?? run.judge,
          agents: existing.agents,
          agent: existing.agent,
          runId: existing.runId,
        };
      }
    } catch {
      // no prior merged run
    }
  }

  await writeFile(
    path.join(outputDir, "run.json"),
    JSON.stringify(runToWrite, null, 2),
    "utf8",
  );
  await writeFile(
    path.join(outputDir, "plan.json"),
    JSON.stringify(run.plan ?? null, null, 2),
    "utf8",
  );

  if (run.plan) {
    const planMd = [
      `# Plan for PR #${run.prNumber}`,
      "",
      run.plan.rationale,
      "",
      "## Selected passes",
      "",
      ...(run.plan.selectedPasses.length
        ? run.plan.selectedPasses.map((id) => `- ${id}`)
        : ["- none (deferred or none matched)"]),
      "",
      "## Skipped / deferred passes",
      "",
      ...(run.plan.skippedPasses.length
        ? run.plan.skippedPasses.map((p) => `- ${p.id}: ${p.reason}`)
        : ["- none"]),
      "",
    ].join("\n");
    await writeFile(path.join(outputDir, "plan.md"), planMd, "utf8");
  }

  if (Object.keys(run.knowledgeDocs ?? {}).length > 0) {
    await writeKnowledgeDocs(outputDir, run.knowledgeDocs);
  }

  if (diffText && diffText.length > 0) {
    await writeFile(path.join(outputDir, "diff.patch"), diffText, "utf8");
  }

  if (run.load?.files?.length) {
    const filesMd = [
      `# Changed files — PR #${run.prNumber}`,
      "",
      ...run.load.files.map(
        (file) =>
          `- \`${file.path}\` (${file.changeType}, +${file.additions}/-${file.deletions})`,
      ),
      "",
    ].join("\n");
    await writeFile(path.join(outputDir, "changed-files.md"), filesMd, "utf8");
  }
}
