import path from "node:path";
import {
  archiveLegacyTopLevelIfNeeded,
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
  type ProviderId,
} from "@review-os/providers";
import type { PrOverview } from "@review-os/schemas";
import { writeReviewArtifacts } from "@review-os/render";
import type { AppConfig } from "@review-os/schemas";

export const LIVE_PASSES = new Set(["correctness", "nitpick", "devils-advocate"]);

export const CLI_PROVIDERS = new Set([
  "cursor",
  "claude-code",
  "command-code",
  "anthropic",
]);

export const DEFAULT_MULTI_AGENTS = [
  "cursor",
  "claude-code",
  "command-code",
] as const;

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
  if (!CLI_PROVIDERS.has(options.providerId)) {
    throw new Error(
      `Unknown provider "${options.providerId}". Use: cursor | claude-code | command-code | anthropic`,
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
  const archived = await archiveLegacyTopLevelIfNeeded(outputDir);
  if (archived) {
    log(`Archived prior review → ${archived.path}`);
  }

  let overview = options.overview;
  if (!overview && options.providerId !== "anthropic") {
    try {
      overview = await generatePrOverview({
        providerId: options.providerId,
        repoRoot: options.repoRoot,
        outputDir,
        prNumber: pr.number,
        title: pr.title,
        prUrl: pr.url,
        base: pr.base,
        head: pr.head,
        files: pr.files.map((file) => file.path),
        diff: pr.diff,
        log,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      log(`Overview skipped — ${detail}`);
    }
  }

  log("Running specialist passes (each pass is a full local CLI agent call)…");

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
      ...(overview !== undefined ? { overview } : {}),
      log,
    },
    {
      providers: options.providers,
      passes: defaultPasses,
      render: writeReviewArtifacts,
    },
  );

  const versioned = await versionCompletedReview({
    outputDir,
    run,
    agent,
    diffText: pr.diff,
    render: writeReviewArtifacts,
    rebuild: rebuildMergedReview,
  });

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

export type AgentRunResult = {
  agent: string;
  status: "ok" | "skipped" | "error";
  detail: string;
  rawFindingCount?: number;
};

export async function runAllCliAgents(options: {
  prRef: string;
  repoRoot: string;
  config: AppConfig;
  agents?: string[];
  log?: LogFn;
  shouldCancel?: () => boolean;
}): Promise<{
  prNumber: number;
  outputDir: string;
  results: AgentRunResult[];
  mergedFindingCount: number;
  cancelled: boolean;
}> {
  const log = options.log ?? ((line: string) => console.log(line));
  const providers = createProviderRegistry();
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
    log(
      `Expect 1 overview + (~3–6 min × 3 passes × ${agents.length} agent(s)) — sequential wall clock.`,
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    log(`PR prefetch failed (${detail}); each agent will fetch separately.`);
  }

  const overviewProvider = agents.find(
    (agent) =>
      CLI_PROVIDERS.has(agent) &&
      agent !== "anthropic" &&
      (available.has(agent as ProviderId) || available.has(agent)),
  );
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
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      log(`Shared overview skipped — ${detail}`);
    }
  }

  for (const agent of agents) {
    if (options.shouldCancel?.()) {
      cancelled = true;
      log("Cancel requested — stopping before remaining agents.");
      break;
    }

    if (!CLI_PROVIDERS.has(agent) || agent === "anthropic") {
      results.push({
        agent,
        status: "skipped",
        detail: "Not a default local CLI agent",
      });
      continue;
    }
    if (!available.has(agent as ProviderId) && !available.has(agent)) {
      results.push({
        agent,
        status: "skipped",
        detail: "Provider not available on this machine",
      });
      log(`Skipping ${agent} — not available`);
      continue;
    }

    try {
      log(`\n—— Starting agent: ${agent} ——`);
      const result = await runWithProvider({
        prRef: options.prRef,
        repoRoot: options.repoRoot,
        config: options.config,
        providers,
        providerId: agent,
        agent,
        log,
        ...(sharedPr ? { pr: sharedPr } : {}),
        ...(sharedOverview ? { overview: sharedOverview } : {}),
      });
      prNumber = result.prNumber;
      outputDir = result.outputDir;
      mergedFindingCount = result.mergedFindingCount;
      if (!sharedOverview && result.overview) {
        sharedOverview = result.overview;
      }
      results.push({
        agent,
        status: "ok",
        detail: `runs/${result.runId}`,
        rawFindingCount: result.rawFindingCount,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      results.push({ agent, status: "error", detail });
      log(`Agent ${agent} failed: ${detail}`);
    }
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
    log(`\nAll done. ${okCount}/${results.length} agent(s) succeeded.`);
  }
  return { prNumber, outputDir, results, mergedFindingCount, cancelled };
}
