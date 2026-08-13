import type http from "node:http";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  applyDispositionToRun,
  buildJudgeResult,
  ensureUniqueFindingIds,
  extractDiffForFile,
} from "@review-os/core";
import {
  listAvailableProviders,
} from "@review-os/providers";
import { githubFileUrl, renderReviewFromDir } from "@review-os/render";
import {
  ReviewRunSchema,
  type AppConfig,
  type Finding,
  type RecheckEntry,
  type ReviewRun,
} from "@review-os/schemas";
import { createLiveRegistry } from "./live-registry.js";
import { runRecheckFinding } from "./run-recheck.js";
import { runVerifyAuthorUpdates } from "./run-verify.js";

export type TriageControllerOptions = {
  repoRoot: string;
  outputDir: string;
  config: AppConfig;
  /** Shared across PR controllers so only one agent job runs at a time. */
  isBusy: () => boolean;
  setBusy: (busy: boolean) => void;
};

type VerifyJobStatus = "running" | "done" | "error";

type VerifyJob = {
  id: string;
  prNumber: number;
  status: VerifyJobStatus;
  logs: string[];
  createdAt: string;
  updatedAt: string;
  progress?: {
    current: number;
    total: number;
    findingId?: string;
    label: string;
  };
  counts?: {
    resolved: number;
    accepted: number;
    needs_look: number;
    still_open: number;
  };
  error?: string;
  payload?: ReturnType<typeof toTriagePayload>;
};

const verifyJobs = new Map<string, VerifyJob>();
let activeVerifyJobId: string | null = null;

type RecheckJob = {
  id: string;
  prNumber: number;
  findingId: string;
  status: VerifyJobStatus;
  logs: string[];
  createdAt: string;
  updatedAt: string;
  label?: string;
  error?: string;
  action?: string;
  note?: string;
  finding?: Finding;
  latestRecheck?: RecheckEntry;
  payload?: ReturnType<typeof toTriagePayload>;
};

const recheckJobs = new Map<string, RecheckJob>();
let activeRecheckJobId: string | null = null;

function touchRecheck(job: RecheckJob): void {
  job.updatedAt = new Date().toISOString();
}

function appendRecheckLog(job: RecheckJob, line: string): void {
  const stamp = new Date().toISOString().slice(11, 19);
  job.logs.push(`[${stamp}] ${line}`);
  if (job.logs.length > 400) job.logs.splice(0, job.logs.length - 400);
  touchRecheck(job);
}

function publicRecheckJob(job: RecheckJob) {
  return {
    id: job.id,
    prNumber: job.prNumber,
    findingId: job.findingId,
    status: job.status,
    logs: job.logs,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    ...(job.label ? { label: job.label } : {}),
    ...(job.error ? { error: job.error } : {}),
    ...(job.action ? { action: job.action } : {}),
    ...(job.note ? { note: job.note } : {}),
    ...(job.finding ? { finding: job.finding } : {}),
    ...(job.latestRecheck ? { latestRecheck: job.latestRecheck } : {}),
    ...(job.payload ? { payload: job.payload } : {}),
  };
}

function touchVerify(job: VerifyJob): void {
  job.updatedAt = new Date().toISOString();
}

function appendVerifyLog(job: VerifyJob, line: string): void {
  const stamp = new Date().toISOString().slice(11, 19);
  job.logs.push(`[${stamp}] ${line}`);
  if (job.logs.length > 500) job.logs.splice(0, job.logs.length - 500);
  touchVerify(job);
}

function publicVerifyJob(job: VerifyJob) {
  return {
    id: job.id,
    prNumber: job.prNumber,
    status: job.status,
    logs: job.logs,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    ...(job.progress ? { progress: job.progress } : {}),
    ...(job.counts ? { counts: job.counts } : {}),
    ...(job.error ? { error: job.error } : {}),
    ...(job.payload ? { payload: job.payload } : {}),
    reportUrl: job.status === "done" ? "verify-report.html" : undefined,
  };
}

function json(
  res: http.ServerResponse,
  status: number,
  body: unknown,
): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(payload);
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function loadRun(outputDir: string): Promise<ReviewRun> {
  const raw = await readFile(path.join(outputDir, "run.json"), "utf8");
  const parsed = ReviewRunSchema.parse(JSON.parse(raw));
  const unique = ensureUniqueFindingIds(parsed.findings);
  const changed = unique.some((f, i) => f.id !== parsed.findings[i]?.id);
  if (!changed) return parsed;

  const repaired: ReviewRun = {
    ...parsed,
    findings: unique,
    judge: buildJudgeResult(unique),
  };
  await saveRun(outputDir, repaired);
  await renderReviewFromDir(outputDir);
  console.log("Repaired duplicate finding ids in run.json");
  return repaired;
}

async function saveRun(outputDir: string, run: ReviewRun): Promise<void> {
  await writeFile(
    path.join(outputDir, "run.json"),
    JSON.stringify(run, null, 2),
    "utf8",
  );
}

function contentType(filePath: string): string {
  if (filePath.endsWith(".html")) return "text/html; charset=utf-8";
  if (filePath.endsWith(".json")) return "application/json; charset=utf-8";
  if (filePath.endsWith(".md")) return "text/markdown; charset=utf-8";
  if (filePath.endsWith(".css")) return "text/css; charset=utf-8";
  if (filePath.endsWith(".js")) return "text/javascript; charset=utf-8";
  return "application/octet-stream";
}

export async function serveReviewStatic(
  res: http.ServerResponse,
  filePath: string,
): Promise<void> {
  try {
    const body = await readFile(filePath);
    res.writeHead(200, {
      "content-type": contentType(filePath),
      "cache-control": "no-store",
    });
    res.end(body);
  } catch {
    json(res, 404, { error: "Not found" });
  }
}

export function toTriagePayload(run: ReviewRun) {
  const ordered = [...run.findings]
    .filter((f) => f.kind !== "praise")
    .sort((a, b) => {
      const rank: Record<Finding["severity"], number> = {
        blocker: 6,
        major: 5,
        minor: 4,
        suggestion: 3,
        nit: 2,
        question: 1,
      };
      const sev = rank[b.severity] - rank[a.severity];
      if (sev !== 0) return sev;
      if (b.importance !== a.importance) return b.importance - a.importance;
      return b.confidence - a.confidence;
    });

  return {
    prNumber: run.prNumber,
    title: run.title ?? "",
    ...(run.prUrl !== undefined ? { prUrl: run.prUrl } : {}),
    ...(run.head !== undefined ? { head: run.head } : {}),
    findings: ordered.map((finding) => {
      const githubUrl = githubFileUrl({
        ...(run.prUrl !== undefined ? { prUrl: run.prUrl } : {}),
        ...(run.head !== undefined ? { head: run.head } : {}),
        file: finding.file,
        line: finding.line,
        ...(finding.endLine !== undefined ? { endLine: finding.endLine } : {}),
      });
      return {
        id: finding.id,
        storageId: encodeURIComponent(finding.id),
        kind: finding.kind,
        file: finding.file,
        line: finding.line,
        endLine: finding.endLine,
        ...(githubUrl ? { githubUrl } : {}),
        severity: finding.severity,
        category: finding.category,
        disposition: finding.disposition ?? "open",
        falseAlarmNote: finding.falseAlarmNote,
        issueSimple: finding.issueSimple,
        whyWeak: finding.whyWeak,
        howToFix: finding.howToFix,
        betterCode: finding.betterCode,
        currentCode: finding.currentCode,
        reviewComment: finding.reviewComment,
        language: finding.language || "ts",
        rechecks: finding.rechecks ?? [],
      };
    }),
  };
}

/**
 * Handle triage JSON API paths under a PR mount.
 * @param apiPath path after `/api`, e.g. `/providers`, `/verify`
 */
export async function handleTriageApi(
  options: TriageControllerOptions,
  method: string,
  apiPath: string,
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<boolean> {
  const { repoRoot, outputDir, config, isBusy, setBusy } = options;
  const { providers: registry } = await createLiveRegistry();

  if (method === "GET" && apiPath === "/health") {
    json(res, 200, { ok: true, pr: (await loadRun(outputDir)).prNumber });
    return true;
  }

  if (method === "GET" && apiPath === "/providers") {
    const available = await listAvailableProviders(registry);
    json(res, 200, {
      providers: available.filter((id) => id !== "demo"),
      all: available,
    });
    return true;
  }

  if (method === "GET" && apiPath === "/findings") {
    const run = await loadRun(outputDir);
    json(res, 200, toTriagePayload(run));
    return true;
  }

  if (method === "POST" && apiPath === "/disposition") {
    const raw = await readBody(req);
    let body: {
      findingId?: string;
      disposition?: "open" | "false_alarm";
      note?: string;
    };
    try {
      body = JSON.parse(raw) as typeof body;
    } catch {
      json(res, 400, { error: "Invalid JSON body" });
      return true;
    }
    const findingId = body.findingId?.trim();
    const disposition = body.disposition;
    if (!findingId || (disposition !== "open" && disposition !== "false_alarm")) {
      json(res, 400, {
        error: "findingId and disposition (open|false_alarm) are required",
      });
      return true;
    }
    const run = await loadRun(outputDir);
    const applied = applyDispositionToRun(
      run,
      findingId,
      disposition,
      body.note ?? "",
    );
    await saveRun(outputDir, applied.run);
    await renderReviewFromDir(outputDir);
    json(res, 200, {
      action: applied.action,
      note: applied.note,
      finding: applied.finding,
      payload: toTriagePayload(applied.run),
    });
    return true;
  }

  if (method === "POST" && apiPath === "/reverify") {
    if (isBusy() || activeRecheckJobId || activeVerifyJobId) {
      const existing = activeRecheckJobId
        ? recheckJobs.get(activeRecheckJobId)
        : undefined;
      json(res, 409, {
        error: existing
          ? "Recheck already running — attaching to that job."
          : "Another job is already running. Wait for it to finish.",
        ...(existing
          ? { jobId: existing.id, job: publicRecheckJob(existing) }
          : {}),
      });
      return true;
    }

    const raw = await readBody(req);
    let body: {
      findingId?: string;
      prompt?: string;
      provider?: string;
    };
    try {
      body = JSON.parse(raw) as typeof body;
    } catch {
      json(res, 400, { error: "Invalid JSON body" });
      return true;
    }

    const findingId = body.findingId?.trim();
    const userPrompt = body.prompt ?? "";
    const providerId = body.provider?.trim();
    if (!findingId || !providerId) {
      json(res, 400, {
        error: "findingId and provider are required",
      });
      return true;
    }

    let run: ReviewRun;
    try {
      run = await loadRun(outputDir);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      json(res, 400, { error: `Cannot load review: ${detail}` });
      return true;
    }
    const finding = run.findings.find((f) => f.id === findingId);
    if (!finding) {
      json(res, 404, { error: `Finding not found: ${findingId}` });
      return true;
    }

    const job: RecheckJob = {
      id: randomUUID(),
      prNumber: run.prNumber,
      findingId,
      status: "running",
      logs: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      label: `Rechecking with ${providerId}…`,
    };
    recheckJobs.set(job.id, job);
    activeRecheckJobId = job.id;
    setBusy(true);
    appendRecheckLog(job, `Recheck job ${job.id}`);
    appendRecheckLog(job, `finding=${findingId} provider=${providerId}`);

    void (async () => {
      try {
        let diffText: string | undefined;
        try {
          diffText = await readFile(path.join(outputDir, "diff.patch"), "utf8");
        } catch {
          diffText = undefined;
        }
        const fileDiff = extractDiffForFile(diffText, finding.file);
        const applied = await runRecheckFinding({
          repoRoot,
          outputDir,
          run,
          finding,
          userPrompt,
          providerId,
          fileDiff,
          log: (line) => {
            appendRecheckLog(job, line);
            console.log(line);
          },
        });
        await saveRun(outputDir, applied.run);
        await renderReviewFromDir(outputDir);
        job.action = applied.action;
        job.note = applied.note;
        if (applied.finding) job.finding = applied.finding;
        const latest = applied.finding?.rechecks?.[0];
        if (latest) job.latestRecheck = latest;
        job.payload = toTriagePayload(applied.run);
        job.status = "done";
        job.label = applied.note;
        appendRecheckLog(job, `Done · ${applied.action}`);
      } catch (error) {
        job.status = "error";
        job.error = error instanceof Error ? error.message : String(error);
        appendRecheckLog(job, `FAILED: ${job.error}`);
      } finally {
        touchRecheck(job);
        if (activeRecheckJobId === job.id) activeRecheckJobId = null;
        setBusy(false);
      }
    })();

    json(res, 202, { jobId: job.id, job: publicRecheckJob(job) });
    return true;
  }

  if (method === "GET" && apiPath === "/reverify/active") {
    const job = activeRecheckJobId
      ? recheckJobs.get(activeRecheckJobId)
      : undefined;
    json(res, 200, { job: job ? publicRecheckJob(job) : null });
    return true;
  }

  const recheckJobMatch = apiPath.match(/^\/reverify\/([^/]+)$/);
  if (method === "GET" && recheckJobMatch) {
    const job = recheckJobs.get(recheckJobMatch[1]!);
    if (!job) {
      json(res, 404, { error: "Recheck job not found" });
      return true;
    }
    json(res, 200, publicRecheckJob(job));
    return true;
  }

  if (method === "POST" && apiPath === "/verify") {
    if (isBusy() || activeVerifyJobId) {
      const existing = activeVerifyJobId
        ? verifyJobs.get(activeVerifyJobId)
        : undefined;
      json(res, 409, {
        error: existing
          ? "Verify already running — attaching to that job."
          : "Another job is already running. Wait for it to finish.",
        ...(existing ? { jobId: existing.id, job: publicVerifyJob(existing) } : {}),
      });
      return true;
    }

    const raw = await readBody(req);
    let body: { provider?: string; providers?: string[]; prRef?: string } = {};
    if (raw.trim()) {
      try {
        body = JSON.parse(raw) as typeof body;
      } catch {
        json(res, 400, { error: "Invalid JSON body" });
        return true;
      }
    }

    const providerIds = [
      ...(Array.isArray(body.providers) ? body.providers.map(String) : []),
      ...(body.provider?.trim() ? [body.provider.trim()] : []),
    ];

    let prNumber: number;
    try {
      prNumber = (await loadRun(outputDir)).prNumber;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      json(res, 400, { error: `Cannot load review: ${detail}` });
      return true;
    }

    const job: VerifyJob = {
      id: randomUUID(),
      prNumber,
      status: "running",
      logs: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      progress: {
        current: 0,
        total: 0,
        label: "Starting verify…",
      },
    };
    verifyJobs.set(job.id, job);
    activeVerifyJobId = job.id;
    setBusy(true);
    appendVerifyLog(job, `Verify job ${job.id} for PR #${prNumber}`);

    void (async () => {
      try {
        const { report } = await runVerifyAuthorUpdates({
          repoRoot,
          outputDir,
          ...(providerIds.length ? { providerIds } : {}),
          ...(body.prRef?.trim() ? { prRef: body.prRef.trim() } : {}),
          log: (line) => {
            appendVerifyLog(job, line);
            console.log(line);
          },
          onProgress: (progress) => {
            job.progress = progress;
            touchVerify(job);
          },
        });
        const run = await loadRun(outputDir);
        job.counts = {
          resolved: report.counts.resolved,
          accepted: report.counts.accepted,
          needs_look: report.counts.needs_look,
          still_open: report.counts.still_open,
        };
        job.payload = toTriagePayload(run);
        job.status = "done";
        job.progress = {
          current: report.items.length,
          total: report.items.length,
          label: "Verify complete",
        };
        appendVerifyLog(
          job,
          `Done · resolved ${report.counts.resolved} · accepted ${report.counts.accepted} · needs_look ${report.counts.needs_look} · still_open ${report.counts.still_open}`,
        );
      } catch (error) {
        job.status = "error";
        job.error = error instanceof Error ? error.message : String(error);
        appendVerifyLog(job, `FAILED: ${job.error}`);
      } finally {
        touchVerify(job);
        if (activeVerifyJobId === job.id) activeVerifyJobId = null;
        setBusy(false);
      }
    })();

    json(res, 202, { jobId: job.id, job: publicVerifyJob(job) });
    return true;
  }

  if (method === "GET" && apiPath === "/verify/active") {
    const job = activeVerifyJobId
      ? verifyJobs.get(activeVerifyJobId)
      : undefined;
    json(res, 200, { job: job ? publicVerifyJob(job) : null });
    return true;
  }

  const verifyJobMatch = apiPath.match(/^\/verify\/([^/]+)$/);
  if (method === "GET" && verifyJobMatch) {
    const job = verifyJobs.get(verifyJobMatch[1]!);
    if (!job) {
      json(res, 404, { error: "Verify job not found" });
      return true;
    }
    // Only expose jobs for this PR mount
    try {
      const run = await loadRun(outputDir);
      if (job.prNumber !== run.prNumber) {
        json(res, 404, { error: "Verify job not found" });
        return true;
      }
    } catch {
      json(res, 404, { error: "Verify job not found" });
      return true;
    }
    json(res, 200, publicVerifyJob(job));
    return true;
  }

  return false;
}

export type ServeTriageOptions = {
  repoRoot: string;
  outputDir: string;
  config: AppConfig;
  port: number;
};

/** Legacy single-PR server. Prefer the multi-PR hub (`--serve-ui` / `--serve`). */
export async function serveTriage(options: ServeTriageOptions): Promise<void> {
  const { repoRoot, outputDir, config, port } = options;
  let busy = false;
  const ctrl: TriageControllerOptions = {
    repoRoot,
    outputDir,
    config,
    isBusy: () => busy,
    setBusy: (v) => {
      busy = v;
    },
  };

  const http = await import("node:http");
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      const method = req.method ?? "GET";

      if (url.pathname.startsWith("/api/")) {
        const handled = await handleTriageApi(
          ctrl,
          method,
          url.pathname.slice("/api".length) || "/",
          req,
          res,
        );
        if (handled) return;
      }

      if (method === "GET" && (url.pathname === "/" || url.pathname === "/triage.html")) {
        await serveReviewStatic(res, path.join(outputDir, "triage.html"));
        return;
      }
      if (method === "GET" && url.pathname === "/final-review.html") {
        await serveReviewStatic(res, path.join(outputDir, "final-review.html"));
        return;
      }
      if (method === "GET" && url.pathname === "/verify-report.html") {
        await serveReviewStatic(res, path.join(outputDir, "verify-report.html"));
        return;
      }
      if (method === "GET" && url.pathname === "/findings.json") {
        await serveReviewStatic(res, path.join(outputDir, "findings.json"));
        return;
      }

      json(res, 404, { error: "Not found" });
    } catch (error) {
      busy = false;
      const message = error instanceof Error ? error.message : String(error);
      json(res, 500, { error: message });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });

  const run = await loadRun(outputDir);
  console.log(`████ PRism · serve PR #${run.prNumber} (single-PR mode)`);
  console.log(`Prefer hub: pnpm prsm --serve-ui → /pr/${run.prNumber}/`);
  console.log(`Triage: http://127.0.0.1:${port}/`);
  console.log("Ctrl+C to stop.");
}
