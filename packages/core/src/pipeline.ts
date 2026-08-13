import path from "node:path";
import type {
  Finding,
  JudgeResult,
  PrOverview,
  ReviewLoad,
  ReviewPlan,
  ReviewRun,
} from "@review-os/schemas";
import { reconcileFindingLines } from "./diff-index.js";
import { applyDocumentedIntent } from "./documented-intent.js";
import { filterFindingsByEvidence } from "./evidence.js";
import { finalizeFindings } from "./finalize.js";
import { buildKnowledgePack } from "./knowledge.js";
import { planReview } from "./planner.js";
import { isFatalProviderError } from "./provider-errors.js";
import { detectSignals } from "./signals.js";
import type { Pass, PipelineResult, Provider, PassContext } from "./types.js";

export interface PipelineDeps {
  providers: Map<string, Provider>;
  passes: Pass[];
  render: (
    run: ReviewRun,
    outputDir: string,
    diffText?: string,
  ) => Promise<void>;
}

export interface RunPipelineOptions {
  config: PassContext["config"];
  prNumber: number;
  prUrl?: string;
  title?: string;
  base?: string;
  head?: string;
  demo?: boolean;
  /** When true, skip specialist passes and only persist load artifacts. */
  loadOnly?: boolean;
  load?: ReviewLoad;
  changedFiles?: string[];
  knowledge?: Record<string, string>;
  rules?: Record<string, string>;
  companyStandards?: string;
  /** Hub/CLI free-text guidance applied to every specialist pass. */
  extraInstructions?: string;
  cwd?: string;
  /** Optional raw diff written by the renderer beside the review. */
  diffText?: string;
  /** Optional precomputed plan; otherwise planner runs from file signals. */
  plan?: ReviewPlan;
  /** Optional PR overview (generated once before specialist passes). */
  overview?: PrOverview;
  /** Progress lines (serve-ui / CLI). Defaults to console.log. */
  log?: (line: string) => void;
  /**
   * Override the review output directory (default: `<cwd>/<config.outputDir>/<prNumber>`).
   * Used for parallel multi-agent isolation under `.work/<agent>/`.
   */
  outputDirOverride?: string;
  /**
   * Run specialist passes concurrently (blind passes are independent).
   * Default true for live reviews; prepare/load-only ignores this.
   */
  parallelPasses?: boolean;
}

function countFindings(findings: Finding[]): JudgeResult["counts"] {
  const counts = {
    blocker: 0,
    major: 0,
    minor: 0,
    nit: 0,
    suggestion: 0,
    question: 0,
    praise: 0,
  };

  for (const finding of findings) {
    if (finding.kind === "praise") {
      counts.praise += 1;
      continue;
    }
    if (finding.kind === "question" || finding.severity === "question") {
      counts.question += 1;
      continue;
    }
    const key = finding.severity;
    counts[key] += 1;
  }

  return counts;
}

function buildJudge(findings: Finding[], loadOnly: boolean): JudgeResult {
  const counts = countFindings(findings);
  if (loadOnly && findings.length === 0) {
    return {
      readiness: "needs_changes",
      topReasons: [
        "PR loaded successfully. Specialist AI review passes are not enabled yet (Phase 3+).",
      ],
      counts,
      score: 0,
    };
  }

  const readiness =
    counts.blocker > 0
      ? "blocked"
      : counts.major > 0
        ? "needs_changes"
        : "approved_with_nits";

  const topReasons = findings
    .filter((f) => f.kind === "issue")
    .sort((a, b) => b.importance - a.importance || b.confidence - a.confidence)
    .slice(0, 5)
    .map((f) => `${f.severity}: ${f.issueSimple}`);

  return {
    readiness,
    topReasons,
    counts,
    score:
      readiness === "blocked" ? 35 : readiness === "needs_changes" ? 62 : 88,
  };
}

export async function runPipeline(
  options: RunPipelineOptions,
  deps: PipelineDeps,
): Promise<PipelineResult> {
  const {
    config,
    prNumber,
    prUrl,
    title = `Review for PR #${prNumber}`,
    base,
    head,
    demo = false,
    loadOnly = false,
    load,
    changedFiles = [],
    knowledge = {},
    rules = {},
    companyStandards,
    extraInstructions,
    cwd = process.cwd(),
    diffText,
    plan: providedPlan,
    overview,
    log: logOption,
    outputDirOverride,
    parallelPasses = true,
  } = options;

  const log = logOption ?? ((line: string) => console.log(line));

  const enabledPassIds = config.passes.filter((p) => p.enabled).map((p) => p.id);
  const signals = detectSignals(changedFiles);
  const knowledgePack = buildKnowledgePack({
    prNumber,
    title,
    ...(base !== undefined ? { base } : {}),
    ...(head !== undefined ? { head } : {}),
    changedFiles,
    signals,
    ...(load?.additions !== undefined ? { additions: load.additions } : {}),
    ...(load?.deletions !== undefined ? { deletions: load.deletions } : {}),
  });
  const mergedKnowledge = { ...knowledgePack.docs, ...knowledge };

  const planned =
    providedPlan ??
    planReview({
      availablePassIds: enabledPassIds,
      signals,
    });

  const plan: ReviewPlan = loadOnly
    ? {
        selectedPasses: [],
        skippedPasses: [
          ...planned.selectedPasses.map((id) => ({
            id,
            reason:
              "Selected by planner, deferred for agent/chat or --provider/--run execution",
          })),
          ...planned.skippedPasses,
        ],
        rationale: `${planned.rationale} Prepare mode: knowledge + plan + agent briefs are written; specialists run next via chat skill or --provider/--run.`,
      }
    : demo
      ? {
          selectedPasses: planned.selectedPasses,
          skippedPasses: [
            ...config.passes
              .filter((p) => !p.enabled)
              .map((p) => ({ id: p.id, reason: "Disabled in config" })),
            ...planned.skippedPasses,
          ],
          rationale: `Demo mode with planner. ${planned.rationale}`,
        }
      : planned;

  const selectedPasses = loadOnly
    ? []
    : deps.passes.filter((p) => plan.selectedPasses.includes(p.id));

  const outputDir =
    outputDirOverride ??
    path.resolve(cwd, config.outputDir, String(prNumber));

  const context: PassContext = {
    config,
    prNumber,
    ...(prUrl !== undefined ? { prUrl } : {}),
    title,
    ...(base !== undefined ? { base } : {}),
    ...(head !== undefined ? { head } : {}),
    demo,
    repoRoot: cwd,
    outputDir,
    changedFiles,
    ...(diffText !== undefined ? { diffText } : {}),
    knowledge: mergedKnowledge,
    rules,
    ...(companyStandards !== undefined ? { companyStandards } : {}),
    ...(extraInstructions !== undefined ? { extraInstructions } : {}),
    plan,
    log,
  };

  const passResults: Awaited<ReturnType<Pass["run"]>>[] = [];
  const failedPasses: string[] = [];
  let abortedForProviderLimit = false;
  const runParallel =
    parallelPasses && selectedPasses.length > 1 && !loadOnly && !demo;

  if (runParallel) {
    log(
      `Specialist passes (parallel): ${selectedPasses.map((p) => p.id).join(" · ") || "(none)"}`,
    );
    const settled = await Promise.all(
      selectedPasses.map(async (pass, i) => {
        const passConfig = config.passes.find((p) => p.id === pass.id);
        const providerId = passConfig?.provider ?? config.providers.default;
        const provider = deps.providers.get(providerId);
        if (!provider) {
          throw new Error(`Provider not registered: ${providerId}`);
        }
        const startedAt = Date.now();
        log(
          `▶ pass ${i + 1}/${selectedPasses.length}: ${pass.id} via ${providerId}…`,
        );
        try {
          const result = await pass.run(context, provider);
          const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
          log(
            `✓ pass ${pass.id} done — ${result.findings.length} finding(s) in ${seconds}s`,
          );
          return { ok: true as const, result, providerId };
        } catch (error) {
          const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
          const detail = error instanceof Error ? error.message : String(error);
          log(`✗ pass ${pass.id} failed after ${seconds}s — ${detail}`);
          return { ok: false as const, detail, providerId, passId: pass.id };
        }
      }),
    );

    for (let i = 0; i < settled.length; i += 1) {
      const item = settled[i]!;
      if (item.ok) {
        passResults.push(item.result);
        continue;
      }
      failedPasses.push(item.passId);
      passResults.push({
        passId: item.passId,
        provider: item.providerId,
        findings: [],
      });
      if (isFatalProviderError(item.detail)) {
        abortedForProviderLimit = true;
      }
    }
    if (abortedForProviderLimit) {
      log(
        `  → at least one pass hit a credit/quota/auth limit (parallel run kept other pass results)`,
      );
    } else if (failedPasses.length > 0) {
      log(
        `  → keeping successful parallel passes; ${failedPasses.length} failed`,
      );
    }
  } else {
    log(
      `Specialist passes: ${selectedPasses.map((p) => p.id).join(" → ") || "(none)"}`,
    );
    for (let i = 0; i < selectedPasses.length; i += 1) {
      const pass = selectedPasses[i]!;
      const passConfig = config.passes.find((p) => p.id === pass.id);
      const providerId = passConfig?.provider ?? config.providers.default;
      const provider = deps.providers.get(providerId);
      if (!provider) {
        throw new Error(`Provider not registered: ${providerId}`);
      }
      const startedAt = Date.now();
      log(
        `▶ pass ${i + 1}/${selectedPasses.length}: ${pass.id} via ${providerId}…`,
      );
      try {
        const result = await pass.run(context, provider);
        const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
        log(
          `✓ pass ${pass.id} done — ${result.findings.length} finding(s) in ${seconds}s`,
        );
        passResults.push(result);
      } catch (error) {
        const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
        const detail = error instanceof Error ? error.message : String(error);
        failedPasses.push(pass.id);
        log(`✗ pass ${pass.id} failed after ${seconds}s — ${detail}`);
        passResults.push({
          passId: pass.id,
          provider: providerId,
          findings: [],
        });
        if (isFatalProviderError(detail)) {
          abortedForProviderLimit = true;
          log(
            `  → ${providerId} hit a credit/quota/auth limit — skipping remaining passes for this agent (other agents still run)`,
          );
          for (let j = i + 1; j < selectedPasses.length; j += 1) {
            const skipped = selectedPasses[j]!;
            const skippedProvider =
              config.passes.find((p) => p.id === skipped.id)?.provider ??
              config.providers.default;
            log(
              `⊘ pass ${skipped.id} skipped — provider limit on ${providerId}`,
            );
            failedPasses.push(skipped.id);
            passResults.push({
              passId: skipped.id,
              provider: skippedProvider,
              findings: [],
            });
          }
          break;
        }
        log(`  → keeping earlier passes; continuing with remaining specialists`);
      }
    }
  }

  let findings = passResults.flatMap((result) => result.findings);
  let judge = buildJudge(findings, loadOnly);

  if (!demo && !loadOnly && findings.length > 0) {
    const anchored = reconcileFindingLines(findings, diffText ?? "");
    const intent = applyDocumentedIntent(anchored.findings, diffText ?? "");
    const evidence = filterFindingsByEvidence(intent.findings, {
      confidenceFloor: config.confidenceFloor,
    });
    const finalized = finalizeFindings(evidence.kept);
    findings = finalized.findings;
    judge = finalized.judge;
    if (anchored.corrected.length > 0) {
      log(`  → corrected ${anchored.corrected.length} line number(s) from diff`);
    }
    if (anchored.removed.length > 0) {
      log(`  → removed ${anchored.removed.length} finding(s) with invalid lines`);
    }
    if (intent.demoted.length > 0) {
      log(
        `  → demoted ${intent.demoted.length} finding(s) due to documented intent`,
      );
    }
  }

  const run: ReviewRun = {
    prNumber,
    ...(prUrl !== undefined ? { prUrl } : {}),
    title,
    ...(base !== undefined ? { base } : {}),
    ...(head !== undefined ? { head } : {}),
    createdAt: new Date().toISOString(),
    demo,
    ...(load !== undefined ? { load } : {}),
    ...(overview !== undefined ? { overview } : {}),
    plan,
    judge,
    knowledgeDocs: mergedKnowledge,
    findings,
    passResults,
  };

  if (
    selectedPasses.length > 0 &&
    failedPasses.length === selectedPasses.length &&
    findings.length === 0
  ) {
    throw new Error(
      abortedForProviderLimit
        ? `All specialist passes failed for this agent (credit/quota/auth). Remaining agents will still run.`
        : `All specialist passes failed for this agent (no findings). Remaining agents will still run.`,
    );
  }

  await deps.render(run, outputDir, diffText);

  return {
    run,
    outputDir,
    failedPasses,
    abortedForProviderLimit,
  };
}
