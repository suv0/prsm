import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  archiveLegacyTopLevelIfNeeded,
  describeProviderFailure,
  isFatalProviderError,
  rebuildMergedReview,
  runPipeline,
  versionCompletedReview,
  type Provider,
} from "@review-os/core";
import { fetchPullRequest, type LoadedPullRequest } from "@review-os/github";
import {
  createProviderRegistry,
  defaultPasses,
  generatePrOverview,
  listAvailableProviders,
} from "@review-os/providers";
import type { PrOverview } from "@review-os/schemas";
import { writeReviewArtifacts } from "@review-os/render";
import type { AppConfig } from "@review-os/schemas";
import { loadCustomAgents } from "./custom-agents.js";

export const LIVE_PASSES = new Set(["correctness", "nitpick", "devils-advocate"]);

async function resolveExtraInstructions(
  outputDir: string,
  incoming?: string,
): Promise<string | undefined> {
  const trimmed = incoming?.trim();
  if (trimmed) {
    await mkdir(outputDir, { recursive: true });
    await writeFile(
      path.join(outputDir, "extra-instructions.md"),
      `${trimmed}\n`,
      "utf8",
    );
    return trimmed;
  }
  try {
    const existing = (
      await readFile(path.join(outputDir, "extra-instructions.md"), "utf8")
    ).trim();
    return existing || undefined;
  } catch {
    return undefined;
  }
}

export const DEFAULT_MULTI_AGENTS = [
  "cursor",
  "claude-code",
  "command-code",
] as const;

function isRunnableReviewAgent(
  id: string,
  registry: Map<string, Provider>,
): boolean {
  if (id === "demo") return false;
  return registry.has(id);
}

function isParallelCliAgent(
  id: string,
  registry: Map<string, Provider>,
): boolean {
  return isRunnableReviewAgent(id, registry) && id !== "anthropic";
}

export type LogFn = (line: string) => void;

export function withProviderPasses(
  config: AppConfig,
  providerId: string,
): AppConfig {
  return {
    ...config,
    providers: {
      ...config.providers,
      default: providerId,
    },
    passes: config.passes.map((pass) => {
      if (LIVE_PASSES.has(pass.id)) {
        return { ...pass, enabled: true, provider: providerId };
      }
      return { ...pass, enabled: false };
    }),
  };
}

export async function runWithProvider(options: {
  prRef: string;
  repoRoot: string;
  config: AppConfig;
  providers: Map<string, Provider>;
  providerId: string;
  agent?: string;
  log?: LogFn;
  /** Reuse a already-fetched PR (avoids re-downloading the diff per agent). */
  pr?: LoadedPullRequest;
  /** Shared PR overview (generated once for multi-agent runs). */
  overview?: PrOverview;
  /** Free-text reviewer guidance for every specialist pass. */
  extraInstructions?: string;
  /**
   * Isolate pipeline writes under `outputDir/.work/<agent>/` so multiple
   * agents can run concurrently without clobbering prompts/artifacts.
   */
  isolateWork?: boolean;
  /** Skip archive (caller already archived once for a multi-agent batch). */
  skipArchive?: boolean;
  /** Serialize snapshot+merge when agents finish in parallel. */
  versionGate?: <T>(fn: () => Promise<T>) => Promise<T>;
}): Promise<{
  prNumber: number;
  outputDir: string;
  runId: string;
  agent: string;
  rawFindingCount: number;
  mergedFindingCount: number;
  runCount: number;
  overview?: PrOverview;
}> {
  const log = options.log ?? ((line: string) => console.log(line));
  if (!isRunnableReviewAgent(options.providerId, options.providers)) {
    const known = [...options.providers.keys()]
      .filter((id) => id !== "demo")
      .join(" | ");
    throw new Error(
      `Unknown provider "${options.providerId}". Use: ${known || "cursor | claude-code | command-code"}`,
    );
  }

  const agent = options.agent ?? options.providerId;
  log(`████ PRism · run via ${options.providerId} (agent=${agent})`);
  let pr = options.pr;
  if (!pr) {
    log(`Fetching ${options.prRef}...`);
    pr = await fetchPullRequest(options.prRef);
  } else {
    log(`Using cached PR #${pr.number} diff (${pr.files.length} files)`);
  }
  log(`Loaded PR #${pr.number}: ${pr.title}`);

  const outputDir = path.resolve(
    options.repoRoot,
    options.config.outputDir,
    String(pr.number),
  );
  if (!options.skipArchive) {
    const archived = await archiveLegacyTopLevelIfNeeded(outputDir);
    if (archived) {
      log(`Archived prior review → ${archived.path}`);
    }
  }

  const pipelineOutputDir = options.isolateWork
    ? path.join(outputDir, ".work", agent)
    : outputDir;
  if (options.isolateWork) {
    await mkdir(pipelineOutputDir, { recursive: true });
    log(`Isolated work dir: .work/${agent}/`);
  }

  const extraInstructions = await resolveExtraInstructions(
    outputDir,
    options.extraInstructions,
  );
  if (extraInstructions) {
    log("Using extra reviewer instructions (reviews/*/extra-instructions.md)");
  }

  let overview = options.overview;
  if (!overview && options.providerId !== "anthropic") {
    try {
      overview = await generatePrOverview({
        providerId: options.providerId,
        repoRoot: options.repoRoot,
        outputDir: pipelineOutputDir,
        prNumber: pr.number,
        title: pr.title,
        prUrl: pr.url,
        base: pr.base,
        head: pr.head,
        files: pr.files.map((file) => file.path),
        diff: pr.diff,
        log,
        extraCliSpecs: await loadCustomAgents(),
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      log(`Overview skipped — ${detail}`);
    }
  }

  log(
    "Running specialist passes in parallel (each pass is a full local CLI agent call)…",
  );

  const { run } = await runPipeline(
    {
      config: withProviderPasses(options.config, options.providerId),
      prNumber: pr.number,
      prUrl: pr.url,
      title: pr.title,
      base: pr.base,
      head: pr.head,
      demo: false,
      loadOnly: false,
      load: {
        source: "pr",
        additions: pr.additions,
        deletions: pr.deletions,
        files: pr.files,
        diffTruncated: pr.diffTruncated,
        diffPath: "diff.patch",
        note: `Live run via provider=${options.providerId}`,
      },
      changedFiles: pr.files.map((file) => file.path),
      cwd: options.repoRoot,
      diffText: pr.diff,
      outputDirOverride: pipelineOutputDir,
      parallelPasses: true,
      ...(overview !== undefined ? { overview } : {}),
      ...(extraInstructions !== undefined ? { extraInstructions } : {}),
      log,
    },
    {
      providers: options.providers,
      passes: defaultPasses,
      render: writeReviewArtifacts,
    },
  );

  const gate = options.versionGate ?? (<T>(fn: () => Promise<T>) => fn());
  const versioned = await gate(() =>
    versionCompletedReview({
      outputDir,
      run,
      agent,
      diffText: pr.diff,
      render: writeReviewArtifacts,
      rebuild: rebuildMergedReview,
    }),
  );

  log(
    `Done · agent ${versioned.agent} · raw ${run.findings.length} · merged ${versioned.mergedFindingCount} across ${versioned.runCount} run(s)`,
  );

  return {
    prNumber: run.prNumber,
    outputDir,
    runId: versioned.runId,
    agent: versioned.agent,
    rawFindingCount: run.findings.length,
    mergedFindingCount: versioned.mergedFindingCount,
    runCount: versioned.runCount,
    ...(overview !== undefined ? { overview } : {}),
  };
}

/** Simple async mutex so parallel agents serialize snapshot+merge. */
export function createAsyncMutex(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = tail.then(fn, fn);
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}

export type AgentRunResult = {
  agent: string;
  status: "ok" | "skipped" | "error";
  detail: string;
  rawFindingCount?: number;
  mergedFindingCount?: number;
  runCount?: number;
  runId?: string;
};

export type AgentProgressEvent = {
  prNumber?: number;
  outputDir?: string;
  mergedFindingCount?: number;
  runCount?: number;
  result?: AgentRunResult;
};

export async function runAllCliAgents(options: {
  prRef: string;
  repoRoot: string;
  config: AppConfig;
  agents?: string[];
  log?: LogFn;
  shouldCancel?: () => boolean;
  extraInstructions?: string;
  /** Fired as soon as the PR is fetched, and again each time an agent finishes. */
  onProgress?: (event: AgentProgressEvent) => void;
}): Promise<{
  prNumber: number;
  outputDir: string;
  results: AgentRunResult[];
  mergedFindingCount: number;
  cancelled: boolean;
}> {
  const log = options.log ?? ((line: string) => console.log(line));
  const extras = await loadCustomAgents();
  const providers = createProviderRegistry(extras);
  const available = new Set(await listAvailableProviders(providers));
  const agents = options.agents?.length
    ? options.agents
    : [...DEFAULT_MULTI_AGENTS];

  const results: AgentRunResult[] = [];
  let prNumber = 0;
  let outputDir = "";
  let mergedFindingCount = 0;
  let cancelled = false;

  log(`Fetching PR once for ${agents.length} agent(s)…`);
  let sharedPr: LoadedPullRequest | undefined;
  let sharedOverview: PrOverview | undefined;
  try {
    sharedPr = await fetchPullRequest(options.prRef);
    prNumber = sharedPr.number;
    outputDir = path.resolve(
      options.repoRoot,
      options.config.outputDir,
      String(sharedPr.number),
    );
    log(
      `Cached PR #${sharedPr.number}: ${sharedPr.title} (${sharedPr.files.length} files, ~${Math.round((sharedPr.diff?.length ?? 0) / 1024)}KB diff)`,
    );
    options.onProgress?.({ prNumber, outputDir });
    log(
      `Expect ~1 overview + wall clock ≈ slowest agent (3 specialist passes in parallel × ${agents.length} agent(s) in parallel).`,
    );
    if (options.extraInstructions?.trim() && outputDir) {
      await resolveExtraInstructions(outputDir, options.extraInstructions);
      log("Wrote extra-instructions.md for this review");
    }
    const archived = await archiveLegacyTopLevelIfNeeded(outputDir);
    if (archived) {
      log(`Archived prior review → ${archived.path}`);
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    log(`PR prefetch failed (${detail}); each agent will fetch separately.`);
  }

  const overviewProvider = agents.find((agent) => available.has(agent));
  if (sharedPr && overviewProvider && outputDir) {
    try {
      sharedOverview = await generatePrOverview({
        providerId: overviewProvider,
        repoRoot: options.repoRoot,
        outputDir,
        prNumber: sharedPr.number,
        title: sharedPr.title,
        prUrl: sharedPr.url,
        base: sharedPr.base,
        head: sharedPr.head,
        files: sharedPr.files.map((file) => file.path),
        diff: sharedPr.diff,
        log,
        extraCliSpecs: extras,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      log(`Shared overview skipped — ${detail}`);
    }
  }

  if (options.shouldCancel?.()) {
    cancelled = true;
    log("Cancel requested — stopping before agents start.");
    return { prNumber, outputDir, results, mergedFindingCount, cancelled };
  }

  const runnable: string[] = [];
  for (const agent of agents) {
    if (!isParallelCliAgent(agent, providers)) {
      results.push({
        agent,
        status: "skipped",
        detail: "Not a local CLI agent",
      });
      continue;
    }
    if (!available.has(agent)) {
      results.push({
        agent,
        status: "skipped",
        detail: "Provider not available on this machine",
      });
      log(`Skipping ${agent} — not available`);
      continue;
    }
    runnable.push(agent);
  }

  const versionGate = createAsyncMutex();
  const multi = runnable.length > 1;

  if (runnable.length > 0) {
    log(
      `\n—— Starting ${runnable.length} agent(s)${multi ? " in parallel" : ""}: ${runnable.join(", ")} ——`,
    );
  }

  const settled = await Promise.all(
    runnable.map(async (agent) => {
      const agentLog: LogFn = (line) => {
        const prefix = multi ? `[${agent}] ` : "";
        log(`${prefix}${line}`);
      };
      try {
        agentLog(`Starting…`);
        const result = await runWithProvider({
          prRef: options.prRef,
          repoRoot: options.repoRoot,
          config: options.config,
          providers,
          providerId: agent,
          agent,
          log: agentLog,
          isolateWork: multi,
          skipArchive: Boolean(sharedPr && outputDir),
          versionGate,
          ...(sharedPr ? { pr: sharedPr } : {}),
          ...(sharedOverview ? { overview: sharedOverview } : {}),
          ...(options.extraInstructions?.trim()
            ? { extraInstructions: options.extraInstructions }
            : {}),
        });
        const okResult: AgentRunResult = {
          agent,
          status: "ok",
          detail: `runs/${result.runId}`,
          rawFindingCount: result.rawFindingCount,
          mergedFindingCount: result.mergedFindingCount,
          runCount: result.runCount,
          runId: result.runId,
        };
        options.onProgress?.({
          prNumber: result.prNumber,
          outputDir: result.outputDir,
          mergedFindingCount: result.mergedFindingCount,
          runCount: result.runCount,
          result: okResult,
        });
        return {
          ...okResult,
          prNumber: result.prNumber,
          outputDir: result.outputDir,
          overview: result.overview,
        };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const shown = describeProviderFailure(detail);
        if (isFatalProviderError(detail)) {
          agentLog(
            `Stopped (credit/quota/auth): ${shown}\n  → other agents continue`,
          );
        } else {
          agentLog(`Failed: ${shown}\n  → other agents continue`);
        }
        const errResult: AgentRunResult = {
          agent,
          status: "error",
          detail: shown,
        };
        options.onProgress?.({ result: errResult });
        return errResult;
      }
    }),
  );

  for (const item of settled) {
    if (item.status !== "ok") {
      results.push({
        agent: item.agent,
        status: "error",
        detail: item.detail,
      });
      continue;
    }
    const okItem = item as AgentRunResult & {
      prNumber: number;
      outputDir: string;
      overview?: PrOverview;
    };
    prNumber = okItem.prNumber;
    outputDir = okItem.outputDir;
    mergedFindingCount = okItem.mergedFindingCount ?? mergedFindingCount;
    if (!sharedOverview && okItem.overview) {
      sharedOverview = okItem.overview;
    }
    results.push({
      agent: okItem.agent,
      status: "ok",
      detail: okItem.detail,
      ...(okItem.rawFindingCount != null
        ? { rawFindingCount: okItem.rawFindingCount }
        : {}),
      ...(okItem.mergedFindingCount != null
        ? { mergedFindingCount: okItem.mergedFindingCount }
        : {}),
      ...(okItem.runCount != null ? { runCount: okItem.runCount } : {}),
    });
  }

  if (options.shouldCancel?.()) {
    cancelled = true;
  }

  if (!prNumber || !outputDir) {
    try {
      const pr = sharedPr ?? (await fetchPullRequest(options.prRef));
      prNumber = pr.number;
      outputDir = path.resolve(
        options.repoRoot,
        options.config.outputDir,
        String(pr.number),
      );
    } catch {
      // leave zeros
    }
  }

  const okCount = results.filter((r) => r.status === "ok").length;
  if (okCount === 0 && !cancelled) {
    throw new Error(
      `No agents completed successfully.\n${results
        .map((r) => `- ${r.agent}: ${r.status} — ${r.detail}`)
        .join("\n")}`,
    );
  }

  if (cancelled) {
    log(
      `\nStopped early. ${okCount}/${results.length} agent(s) finished before cancel.`,
    );
  } else {
    const errCount = results.filter((r) => r.status === "error").length;
    if (errCount > 0 && okCount > 0) {
      log(
        `\nFinished with partial success. ${okCount} ok · ${errCount} failed · ${results.length - okCount - errCount} skipped. Merged review is available.`,
      );
    } else {
      log(`\nAll done. ${okCount}/${results.length} agent(s) succeeded.`);
    }
  }
  return { prNumber, outputDir, results, mergedFindingCount, cancelled };
}
