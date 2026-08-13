import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  applyVerificationsToRun,
  buildBatchVerifyFixPrompt,
  buildVerifyReport,
  chunkPairs,
  describeProviderFailure,
  isFatalProviderError,
  matchFindingsToThreads,
  parseBatchVerifyModelResponse,
  rollupVerifications,
  toFindingVerification,
  type VerifyThread,
} from "@review-os/core";
import { fetchPrReviewThreads, fetchPullRequest } from "@review-os/github";
import {
  createCliLogBridge,
  cliInvocation,
  detectDefaultCliProvider,
  execCli,
  listAvailableProviders,
} from "@review-os/providers";
import { renderReviewFromDir, renderVerifyReportHtml } from "@review-os/render";
import {
  ReviewRunSchema,
  type Finding,
  type FindingVerification,
  type VerifyItem,
  type VerifyReport,
} from "@review-os/schemas";
import { createLiveRegistry } from "./live-registry.js";

export type LogFn = (line: string) => void;

/** Max findings per CLI call — keeps prompts/responses reliable. */
const BATCH_SIZE = 8;
const SKIP_VERIFY_PROVIDERS = new Set(["demo", "anthropic"]);

async function loadRun(outputDir: string) {
  const raw = await readFile(path.join(outputDir, "run.json"), "utf8");
  return ReviewRunSchema.parse(JSON.parse(raw));
}

async function cliForProvider(providerId: string): Promise<{
  command: string;
  args: (instruction: string, cwd: string) => string[];
}> {
  const { extraSpecs } = await createLiveRegistry();
  return cliInvocation(providerId, extraSpecs);
}

async function runVerifyPrompt(options: {
  providerId: string;
  prompt: string;
  repoRoot: string;
  outputDir: string;
  label: string;
  log: LogFn;
}): Promise<string> {
  const agentDir = path.join(options.outputDir, "agent");
  await mkdir(agentDir, { recursive: true });
  const safe = options.label.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80);
  const promptPath = path.join(agentDir, `verify-${safe}.prompt.txt`);
  await writeFile(promptPath, options.prompt, "utf8");
  const instruction = [
    "You verify whether a PR author addressed prior review findings.",
    `Read and follow: ${promptPath}`,
    "Return ONLY a JSON array of status/summary objects (one per findingId).",
    "Do not modify repository files.",
  ].join(" ");
  const { command, args } = await cliForProvider(options.providerId);
  const result = await execCli(command, args(instruction, options.repoRoot), {
    cwd: options.repoRoot,
    timeoutMs: 12 * 60 * 1000,
    ...createCliLogBridge(options.log, command),
  });
  if (result.code !== 0) {
    throw new Error(
      `verify ${options.providerId} failed (${result.code}): ${result.stderr || result.stdout}`,
    );
  }
  return result.stdout;
}

export type VerifyProgress = {
  current: number;
  total: number;
  findingId?: string;
  label: string;
};

function normalizeProviders(
  requested: string[] | undefined,
  available: string[],
  fallback: string | undefined,
): string[] {
  const fromRequest = (requested ?? [])
    .map((id) => id.trim())
    .filter((id) => !SKIP_VERIFY_PROVIDERS.has(id));
  const unique = [...new Set(fromRequest)];
  if (unique.length) return unique.filter((id) => available.includes(id));
  if (
    fallback &&
    !SKIP_VERIFY_PROVIDERS.has(fallback) &&
    available.includes(fallback)
  ) {
    return [fallback];
  }
  const first = available.find((id) => !SKIP_VERIFY_PROVIDERS.has(id));
  return first ? [first] : [];
}

async function verifyWithOneAgent(options: {
  providerId: string;
  pairs: Array<{ finding: Finding; thread?: VerifyThread }>;
  diffText: string;
  prNumber: number;
  title?: string;
  repoRoot: string;
  outputDir: string;
  log: LogFn;
  onChunk?: (info: {
    chunk: number;
    chunks: number;
    providerId: string;
  }) => void;
}): Promise<Map<string, FindingVerification>> {
  const {
    providerId,
    pairs,
    diffText,
    prNumber,
    title,
    repoRoot,
    outputDir,
    log,
  } = options;
  const out = new Map<string, FindingVerification>();
  const chunks = chunkPairs(pairs, BATCH_SIZE);
  log(
    `▶ ${providerId}: ${pairs.length} finding(s) in ${chunks.length} batch(es)`,
  );

  for (let c = 0; c < chunks.length; c += 1) {
    const chunk = chunks[c]!;
    log(
      `  · ${providerId} batch ${c + 1}/${chunks.length} (${chunk.length} findings)`,
    );
    const prompt = buildBatchVerifyFixPrompt({
      pairs: chunk,
      diffText,
      prNumber,
      ...(title ? { title } : {}),
    });
    try {
      const raw = await runVerifyPrompt({
        providerId,
        prompt,
        repoRoot,
        outputDir,
        label: `${providerId}-batch-${c + 1}`,
        log,
      });
      const parsed = parseBatchVerifyModelResponse(raw);
      const byId = new Map(
        parsed
          .filter((p) => p.findingId)
          .map((p) => [p.findingId!, p] as const),
      );

      for (const { finding, thread } of chunk) {
        let entry = byId.get(finding.id);
        if (!entry) {
          const idx = chunk.findIndex((p) => p.finding.id === finding.id);
          entry = parsed[idx];
        }
        const authorReplyExcerpt = thread
          ? thread.messages
              .slice(1)
              .map((m) => `@${m.author}: ${m.body}`)
              .join(" | ")
              .slice(0, 280) || undefined
          : undefined;
        if (!entry) {
          log(`  · ${providerId}: missing result for ${finding.id}`);
          out.set(
            finding.id,
            toFindingVerification(
              {
                status: "needs_look",
                summary: `${providerId} did not return a judgment for this finding.`,
                betterThanSuggested: false,
              },
              {
                provider: providerId,
                threadMatched: Boolean(thread),
                ...(authorReplyExcerpt ? { authorReplyExcerpt } : {}),
              },
            ),
          );
          continue;
        }
        const verification = toFindingVerification(entry, {
          provider: providerId,
          threadMatched: Boolean(thread),
          ...(authorReplyExcerpt ? { authorReplyExcerpt } : {}),
        });
        out.set(finding.id, verification);
        log(`  ✓ ${providerId} ${finding.id} → ${verification.status}`);
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const shown = describeProviderFailure(detail);
      log(`  ✗ ${providerId} batch ${c + 1} failed — ${shown}`);
      const markRest = (fromIndex: number) => {
        for (let k = fromIndex; k < pairs.length; k += 1) {
          const { finding, thread } = pairs[k]!;
          if (out.has(finding.id)) continue;
          out.set(
            finding.id,
            toFindingVerification(
              {
                status: "needs_look",
                summary: `${providerId} unavailable: ${shown.slice(0, 140)}`,
                betterThanSuggested: false,
              },
              { provider: providerId, threadMatched: Boolean(thread) },
            ),
          );
        }
      };
      for (const { finding, thread } of chunk) {
        out.set(
          finding.id,
          toFindingVerification(
            {
              status: "needs_look",
              summary: `${providerId} tool error: ${shown.slice(0, 160)}`,
              betterThanSuggested: false,
            },
            { provider: providerId, threadMatched: Boolean(thread) },
          ),
        );
      }
      if (isFatalProviderError(detail)) {
        log(
          `  → ${providerId} hit credit/quota/auth — skipping remaining batches for this agent (other agents continue)`,
        );
        const startRest = (c + 1) * BATCH_SIZE;
        markRest(startRest);
        for (let rest = c + 1; rest < chunks.length; rest += 1) {
          options.onChunk?.({
            chunk: rest + 1,
            chunks: chunks.length,
            providerId,
          });
        }
        break;
      }
    }
    options.onChunk?.({
      chunk: c + 1,
      chunks: chunks.length,
      providerId,
    });
  }

  return out;
}

export async function runVerifyAuthorUpdates(options: {
  repoRoot: string;
  outputDir: string;
  prRef?: string;
  /** @deprecated Prefer providerIds */
  providerId?: string;
  providerIds?: string[];
  log?: LogFn;
  onProgress?: (progress: VerifyProgress) => void;
}): Promise<{ report: VerifyReport; outputDir: string }> {
  const log = options.log ?? ((line: string) => console.log(line));
  const onProgress = options.onProgress;
  const run = await loadRun(options.outputDir);
  const { providers: registry } = await createLiveRegistry();
  const available = await listAvailableProviders(registry);
  const auto = await detectDefaultCliProvider(registry);
  const providerIds = normalizeProviders(
    options.providerIds ??
      (options.providerId ? [options.providerId] : undefined),
    available,
    auto ?? undefined,
  );
  if (!providerIds.length) {
    throw new Error(
      "No local agent available for verify. Install a CLI, or Add your own agent in the hub.",
    );
  }

  const refInput = options.prRef?.trim() || run.prUrl;
  if (!refInput) {
    throw new Error(
      "Need a PR URL. Pass a PR-backed review dir, or provide --verify with prUrl in run.json.",
    );
  }

  log(
    `████ PRism · verify author updates (agents=${providerIds.join(", ")})`,
  );
  log(`Loading fresh PR + review threads for ${refInput}…`);
  onProgress?.({
    current: 0,
    total: 1,
    label: "Fetching PR + GitHub threads…",
  });
  const [pr, threadBundle] = await Promise.all([
    fetchPullRequest(refInput),
    fetchPrReviewThreads(refInput).catch((error) => {
      const detail = error instanceof Error ? error.message : String(error);
      log(`GitHub threads unavailable (${detail}) — verifying from diff only.`);
      return { threads: [] as VerifyThread[] };
    }),
  ]);

  await writeFile(path.join(options.outputDir, "diff.patch"), pr.diff, "utf8");

  const threads = threadBundle.threads as VerifyThread[];
  const { pairs, unmatchedThreads } = matchFindingsToThreads(
    run.findings,
    threads,
  );
  const batchCount = Math.max(1, Math.ceil(pairs.length / BATCH_SIZE));
  const totalSteps = providerIds.length * batchCount;
  let finishedSteps = 0;

  log(
    `Verifying ${pairs.length} finding(s) with ${providerIds.length} agent(s); unmatched threads: ${unmatchedThreads.length}`,
  );
  onProgress?.({
    current: 0,
    total: totalSteps,
    label: `${pairs.length} findings · ${providerIds.join("+")} · ${batchCount} batch(es) each`,
  });

  // Agents run in parallel; each batches findings into fewer CLI cold starts.
  // Isolate failures so one out-of-credit agent cannot abort the others.
  const agentMaps = await Promise.all(
    providerIds.map(async (providerId) => {
      try {
        return await verifyWithOneAgent({
          providerId,
          pairs,
          diffText: pr.diff,
          prNumber: run.prNumber,
          ...(run.title ? { title: run.title } : {}),
          repoRoot: options.repoRoot,
          outputDir: options.outputDir,
          log,
          onChunk: ({ chunk, chunks, providerId: pid }) => {
            finishedSteps += 1;
            onProgress?.({
              current: Math.min(finishedSteps, totalSteps),
              total: totalSteps,
              label: `${pid} batch ${chunk}/${chunks}`,
            });
          },
        });
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        const shown = describeProviderFailure(detail);
        log(
          `✗ ${providerId} aborted — ${shown}\n  → other selected agents keep going`,
        );
        const fallback = new Map<string, FindingVerification>();
        for (const { finding, thread } of pairs) {
          fallback.set(
            finding.id,
            toFindingVerification(
              {
                status: "needs_look",
                summary: `${providerId} unavailable: ${shown.slice(0, 140)}`,
                betterThanSuggested: false,
              },
              { provider: providerId, threadMatched: Boolean(thread) },
            ),
          );
        }
        finishedSteps += batchCount;
        onProgress?.({
          current: Math.min(finishedSteps, totalSteps),
          total: totalSteps,
          label: `${providerId} failed — continuing others`,
        });
        return fallback;
      }
    }),
  );

  const byId = new Map<string, FindingVerification[]>();
  for (const map of agentMaps) {
    for (const [findingId, verification] of map) {
      const list = byId.get(findingId) ?? [];
      list.push(verification);
      byId.set(findingId, list);
    }
  }

  const items: VerifyItem[] = pairs.map(({ finding }) => {
    const agents = byId.get(finding.id) ?? [];
    const rollup =
      rollupVerifications(agents) ??
      toFindingVerification(
        {
          status: "needs_look",
          summary: "No agent returned a verification.",
          betterThanSuggested: false,
        },
        { provider: providerIds.join("+"), threadMatched: false },
      );
    return {
      findingId: finding.id,
      file: finding.file,
      line: finding.line,
      issueSimple: finding.issueSimple,
      verification: rollup,
      byAgent: agents,
    };
  });

  const report = buildVerifyReport({
    run: { ...run, prUrl: run.prUrl ?? pr.url, title: run.title ?? pr.title },
    providers: providerIds,
    items,
    unmatchedThreads,
  });

  const nextRun = applyVerificationsToRun(
    {
      ...run,
      prUrl: run.prUrl ?? pr.url,
      title: run.title ?? pr.title,
    },
    byId,
  );

  await writeFile(
    path.join(options.outputDir, "run.json"),
    JSON.stringify(nextRun, null, 2),
    "utf8",
  );
  await writeFile(
    path.join(options.outputDir, "verify-report.json"),
    JSON.stringify(report, null, 2),
    "utf8",
  );
  await writeFile(
    path.join(options.outputDir, "verify-report.html"),
    renderVerifyReportHtml(report),
    "utf8",
  );
  await renderReviewFromDir(options.outputDir);

  log(
    `Done · agents ${providerIds.join("+")} · resolved ${report.counts.resolved} · accepted ${report.counts.accepted} · needs_look ${report.counts.needs_look} · still_open ${report.counts.still_open}`,
  );
  log(`Report: ${path.join(options.outputDir, "verify-report.html")}`);

  return { report, outputDir: options.outputDir };
}
