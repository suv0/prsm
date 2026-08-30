import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  applyExternalMatchesToRun,
  buildExternalMatchPrompt,
  chunkPairs,
  describeProviderFailure,
  isFatalProviderError,
  matchFindingsToExternalThreads,
  parseExternalMatchModelResponse,
  toExternalMatch,
  type ExternalMatchCandidate,
  type VerifyThread,
} from "@review-os/core";
import { fetchPrReviewThreads } from "@review-os/github";
import {
  cliInvocation,
  createCliLogBridge,
  execCli,
  execOptionsForSpec,
  type CliAgentSpec,
} from "@review-os/providers";
import { renderReviewFromDir } from "@review-os/render";
import { ReviewRunSchema, type ExternalMatch } from "@review-os/schemas";
import { loadCustomAgents } from "./custom-agents.js";

export type LogFn = (line: string) => void;

const BATCH_SIZE = 8;

async function cliForProvider(providerId: string): Promise<{
  command: string;
  args: (instruction: string, cwd: string) => string[];
  spec: CliAgentSpec;
}> {
  const extras = await loadCustomAgents();
  return cliInvocation(providerId, extras);
}

async function runExternalCheckPrompt(options: {
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
  const promptPath = path.join(agentDir, `external-check-${safe}.prompt.txt`);
  await writeFile(promptPath, options.prompt, "utf8");
  const instruction = [
    "You check whether our review findings duplicate someone else's existing GitHub comments.",
    `Read and follow: ${promptPath}`,
    "Return ONLY a JSON array of {findingId, action, followUpComment?} objects.",
    "Do not modify repository files.",
  ].join(" ");
  const { command, args, spec } = await cliForProvider(options.providerId);
  const result = await execCli(command, args(instruction, options.repoRoot), {
    cwd: options.repoRoot,
    timeoutMs: 10 * 60 * 1000,
    ...execOptionsForSpec(spec, instruction),
    ...createCliLogBridge(options.log, command),
  });
  if (result.code !== 0) {
    throw new Error(
      `external-check ${options.providerId} failed (${result.code}): ${result.stderr || result.stdout}`,
    );
  }
  return result.stdout;
}

export type ExternalCheckSummary = {
  candidates: number;
  skipped: number;
  followUps: number;
};

/**
 * Best-effort pass: does any OPEN finding overlap a pre-existing GitHub review
 * thread from someone else (human or bot — PRism never posts, so every thread
 * fetched here is third-party)? If so, badge it and, when the existing
 * comment genuinely misses something, propose a follow-up instead of a
 * restated comment.
 *
 * Never throws — a GitHub/agent hiccup here should not fail the review run
 * that triggered it. Returns undefined when the check could not run at all
 * (no threads reachable) and a summary otherwise (0 candidates is normal).
 */
export async function runExternalDuplicateCheck(options: {
  repoRoot: string;
  outputDir: string;
  prRef: string;
  providerId: string;
  log?: LogFn;
}): Promise<ExternalCheckSummary | undefined> {
  const log = options.log ?? ((line: string) => console.log(line));

  let run;
  try {
    run = ReviewRunSchema.parse(
      JSON.parse(await readFile(path.join(options.outputDir, "run.json"), "utf8")),
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    log(`External-comment check skipped — could not read run.json (${detail})`);
    return undefined;
  }

  let threads: VerifyThread[];
  try {
    const bundle = await fetchPrReviewThreads(options.prRef);
    threads = bundle.threads as VerifyThread[];
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    log(`External-comment check skipped — GitHub threads unavailable (${detail})`);
    return undefined;
  }

  if (threads.length === 0) {
    log("External-comment check: no existing GitHub review threads on this PR.");
    return { candidates: 0, skipped: 0, followUps: 0 };
  }

  const candidates: ExternalMatchCandidate[] = matchFindingsToExternalThreads(
    run.findings,
    threads,
  );
  if (candidates.length === 0) {
    log(
      `External-comment check: ${threads.length} existing thread(s), no confident overlap with our open findings.`,
    );
    return { candidates: 0, skipped: 0, followUps: 0 };
  }

  log(
    `External-comment check: ${candidates.length} finding(s) overlap an existing GitHub thread — asking ${options.providerId}…`,
  );

  const byId = new Map<string, ExternalMatch>();
  const chunks = chunkPairs(candidates, BATCH_SIZE);
  for (let c = 0; c < chunks.length; c += 1) {
    const chunk = chunks[c]!;
    const prompt = buildExternalMatchPrompt({
      candidates: chunk,
      prNumber: run.prNumber,
      ...(run.title ? { title: run.title } : {}),
    });
    try {
      const raw = await runExternalCheckPrompt({
        providerId: options.providerId,
        prompt,
        repoRoot: options.repoRoot,
        outputDir: options.outputDir,
        label: `batch-${c + 1}`,
        log,
      });
      const parsed = parseExternalMatchModelResponse(raw);
      for (let i = 0; i < chunk.length; i += 1) {
        const cand = chunk[i]!;
        const entry =
          parsed.find((p) => p.findingId === cand.finding.id) ?? parsed[i];
        if (!entry) continue;
        byId.set(
          cand.finding.id,
          toExternalMatch(entry, {
            provider: options.providerId,
            thread: cand.thread,
            score: cand.score,
          }),
        );
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const shown = describeProviderFailure(detail);
      log(`External-comment check batch ${c + 1} failed — ${shown}`);
      if (isFatalProviderError(detail)) break;
    }
  }

  if (byId.size === 0) {
    log("External-comment check: no results applied (agent returned nothing usable).");
    return { candidates: candidates.length, skipped: 0, followUps: 0 };
  }

  const nextRun = applyExternalMatchesToRun(run, byId);
  await writeFile(
    path.join(options.outputDir, "run.json"),
    JSON.stringify(nextRun, null, 2),
    "utf8",
  );
  await renderReviewFromDir(options.outputDir);

  const followUps = [...byId.values()].filter((m) => m.action === "follow_up").length;
  const skipped = byId.size - followUps;
  log(
    `External-comment check done · ${byId.size} finding(s) matched · ${skipped} already covered · ${followUps} follow-up(s) proposed`,
  );
  return { candidates: candidates.length, skipped, followUps };
}
