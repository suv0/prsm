import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { FindingSchema, ReviewRunSchema, type Finding } from "@review-os/schemas";
import { reconcileFindingLines } from "./diff-index.js";
import { applyDocumentedIntent } from "./documented-intent.js";
import { filterFindingsByEvidence } from "./evidence.js";
import { finalizeFindings } from "./finalize.js";
import { rebuildMergedReview } from "./merge-runs.js";
import {
  archiveLegacyTopLevelIfNeeded,
  clearWorkingPasses,
  makeRunId,
  resolveAgentName,
  snapshotAgentRun,
} from "./versioning.js";

async function loadPassFindings(passesDir: string): Promise<Finding[]> {
  let entries: string[] = [];
  try {
    entries = await readdir(passesDir);
  } catch {
    return [];
  }

  const findings: Finding[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".findings.json")) continue;
    const raw = await readFile(path.join(passesDir, entry), "utf8");
    const parsed: unknown = JSON.parse(raw);
    const list = Array.isArray(parsed)
      ? parsed
      : typeof parsed === "object" &&
          parsed !== null &&
          Array.isArray((parsed as { findings?: unknown }).findings)
        ? (parsed as { findings: unknown[] }).findings
        : null;
    if (!list) {
      throw new Error(`Invalid findings file: ${entry}`);
    }

    const passId = entry.replace(/\.findings\.json$/, "");
    for (const [index, item] of list.entries()) {
      const withDefaults = {
        id: `${passId}-agent-${index + 1}`,
        language: "ts",
        evidence: [],
        views: [],
        autofixPossible: false,
        githubCommentTarget: {
          target: "line",
          reason: "Agent finding",
        },
        ...(typeof item === "object" && item !== null ? item : {}),
      };
      const result = FindingSchema.safeParse(withDefaults);
      if (result.success) findings.push(result.data);
    }
  }

  return findings;
}

export async function finalizeReviewRun(options: {
  outputDir: string;
  confidenceFloor?: number;
  agent?: string;
  /** When true, keep working passes/ after snapshot (default clears). */
  keepPasses?: boolean;
  render: (
    run: import("@review-os/schemas").ReviewRun,
    outputDir: string,
    diffText?: string,
  ) => Promise<void>;
}): Promise<{
  findingCount: number;
  removed: number;
  demoted: number;
  corrected: number;
  runId: string;
  agent: string;
  runCount: number;
  mergedFindingCount: number;
}> {
  const agent = resolveAgentName(options.agent);
  await archiveLegacyTopLevelIfNeeded(options.outputDir);

  const runPath = path.join(options.outputDir, "run.json");
  const runRaw = await readFile(runPath, "utf8");
  const run = ReviewRunSchema.parse(JSON.parse(runRaw));

  let passFindings = await loadPassFindings(
    path.join(options.outputDir, "passes"),
  );
  // Allow re-finalize from existing run findings (e.g. line re-anchor).
  if (passFindings.length === 0 && run.findings.length > 0) {
    passFindings = run.findings;
  }
  if (passFindings.length === 0) {
    throw new Error(
      `No pass findings found in ${path.join(options.outputDir, "passes")}. ` +
        "Have the agent write passes/<pass>.findings.json first.",
    );
  }

  let diffText = "";
  try {
    diffText = await readFile(path.join(options.outputDir, "diff.patch"), "utf8");
  } catch {
    diffText = "";
  }

  const anchored = reconcileFindingLines(passFindings, diffText);
  const intent = applyDocumentedIntent(anchored.findings, diffText);
  const evidence = filterFindingsByEvidence(intent.findings, {
    confidenceFloor: options.confidenceFloor ?? 0.8,
  });
  const finalized = finalizeFindings(evidence.kept);

  const createdAt = new Date().toISOString();
  const runId = makeRunId(agent, new Date(createdAt));

  const nextRun = {
    ...run,
    demo: false,
    agent,
    runId,
    createdAt,
    findings: finalized.findings,
    judge: finalized.judge,
    load: run.load
      ? {
          ...run.load,
          note: `Agent run via ${agent} (line-anchored, documented-intent aware, evidence-filtered).`,
        }
      : run.load,
    plan: run.plan
      ? {
          ...run.plan,
          selectedPasses:
            run.plan.selectedPasses.length > 0
              ? run.plan.selectedPasses
              : run.plan.skippedPasses
                  .filter((p) => p.reason.toLowerCase().includes("deferred"))
                  .map((p) => p.id),
          rationale: `${run.plan.rationale} Finalized via diff line anchor + documented intent + evidence filter + dedupe.`,
        }
      : run.plan,
  };

  const evidenceReport = {
    lineCorrections: anchored.corrected,
    lineRemoved: anchored.removed,
    lineDemoted: anchored.demoted,
    documentedIntentDemoted: intent.demoted,
    removed: evidence.removed,
    demoted: evidence.demoted,
    kept: evidence.kept.length,
  };

  await snapshotAgentRun({
    outputDir: options.outputDir,
    runId,
    agent,
    run: nextRun,
    evidenceReport,
    render: options.render,
    ...(diffText ? { diffText } : {}),
  });

  await writeFile(
    path.join(options.outputDir, "evidence-report.json"),
    JSON.stringify(evidenceReport, null, 2),
    "utf8",
  );

  if (!options.keepPasses) {
    await clearWorkingPasses(options.outputDir);
  }

  const merged = await rebuildMergedReview({
    outputDir: options.outputDir,
    prNumber: run.prNumber,
    render: options.render,
    baseRun: nextRun,
    ...(diffText ? { diffText } : {}),
  });

  return {
    findingCount: finalized.findings.length,
    removed: evidence.removed.length + anchored.removed.length,
    demoted: evidence.demoted.length + anchored.demoted.length,
    corrected: anchored.corrected.length,
    runId,
    agent,
    runCount: merged.runCount,
    mergedFindingCount: merged.findingCount,
  };
}
