import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { ReviewRunSchema } from "@review-os/schemas";
import { renderFinalReviewMarkdown } from "./markdown.js";
import { renderFinalReviewHtml } from "./html.js";
import { renderFinalReviewTriage } from "./triage.js";

export type RenderReviewDirResult = {
  prNumber: number;
  findingCount: number;
  outputDir: string;
};

/**
 * Re-render final artifacts from existing run.json without re-merging agent runs.
 * Use after hand-editing a finding (e.g. double-check).
 */
export async function renderReviewFromDir(
  outputDir: string,
): Promise<RenderReviewDirResult> {
  const runPath = path.join(outputDir, "run.json");
  const raw = await readFile(runPath, "utf8");
  const run = ReviewRunSchema.parse(JSON.parse(raw));

  const markdown = renderFinalReviewMarkdown(run);
  const html = renderFinalReviewHtml(run);
  const triage = renderFinalReviewTriage(run);

  await writeFile(path.join(outputDir, "final-review.md"), markdown, "utf8");
  await writeFile(path.join(outputDir, "final-review.html"), html, "utf8");
  await writeFile(path.join(outputDir, "triage.html"), triage, "utf8");
  await writeFile(
    path.join(outputDir, "findings.json"),
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

  return {
    prNumber: run.prNumber,
    findingCount: run.findings.length,
    outputDir,
  };
}
