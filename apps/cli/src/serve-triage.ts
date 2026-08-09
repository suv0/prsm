import http from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  applyDispositionToRun,
  applyReverifyToRun,
  buildJudgeResult,
  buildReverifyPrompt,
  ensureUniqueFindingIds,
  extractDiffForFile,
  type PassContext,
  type Provider,
} from "@review-os/core";
import {
  createProviderRegistry,
  listAvailableProviders,
} from "@review-os/providers";
import { renderReviewFromDir } from "@review-os/render";
import {
  ReviewRunSchema,
  type AppConfig,
  type Finding,
  type ReviewRun,
} from "@review-os/schemas";

export type ServeTriageOptions = {
  repoRoot: string;
  outputDir: string;
  config: AppConfig;
  port: number;
};

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

async function loadRun(outputDir: string): Promise<ReviewRun> {
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

async function serveStatic(
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

function buildPassContext(options: {
  config: AppConfig;
  repoRoot: string;
  outputDir: string;
  run: ReviewRun;
  diffText?: string;
}): PassContext {
  const { config, repoRoot, outputDir, run, diffText } = options;
  return {
    config,
    prNumber: run.prNumber,
    ...(run.prUrl !== undefined ? { prUrl: run.prUrl } : {}),
    ...(run.title !== undefined ? { title: run.title } : {}),
    ...(run.base !== undefined ? { base: run.base } : {}),
    ...(run.head !== undefined ? { head: run.head } : {}),
    demo: Boolean(run.demo),
    repoRoot,
    outputDir,
    changedFiles: run.load?.files?.map((f) => f.path) ?? [],
    ...(diffText !== undefined ? { diffText } : {}),
    knowledge: run.knowledgeDocs ?? {},
    rules: {},
    ...(run.plan !== undefined ? { plan: run.plan } : {}),
  };
}

function toTriagePayload(run: ReviewRun) {
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
    findings: ordered.map((finding) => ({
      id: finding.id,
      storageId: encodeURIComponent(finding.id),
      kind: finding.kind,
      file: finding.file,
      line: finding.line,
      endLine: finding.endLine,
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
    })),
  };
}

export async function serveTriage(options: ServeTriageOptions): Promise<void> {
  const { repoRoot, outputDir, config, port } = options;
  const registry = createProviderRegistry();
  let busy = false;

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://127.0.0.1:${port}`);
      const method = req.method ?? "GET";

      if (method === "GET" && url.pathname === "/api/health") {
        json(res, 200, { ok: true, pr: (await loadRun(outputDir)).prNumber });
        return;
      }

      if (method === "GET" && url.pathname === "/api/providers") {
        const available = await listAvailableProviders(registry);
        json(res, 200, {
          providers: available.filter((id) => id !== "demo"),
          all: available,
        });
        return;
      }

      if (method === "GET" && url.pathname === "/api/findings") {
        const run = await loadRun(outputDir);
        json(res, 200, toTriagePayload(run));
        return;
      }

      if (method === "POST" && url.pathname === "/api/disposition") {
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
          return;
        }
        const findingId = body.findingId?.trim();
        const disposition = body.disposition;
        if (!findingId || (disposition !== "open" && disposition !== "false_alarm")) {
          json(res, 400, {
            error: "findingId and disposition (open|false_alarm) are required",
          });
          return;
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
        return;
      }

      if (method === "POST" && url.pathname === "/api/reverify") {
        if (busy) {
          json(res, 409, {
            error: "Another recheck is already running. Wait for it to finish.",
          });
          return;
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
          return;
        }

        const findingId = body.findingId?.trim();
        const userPrompt = body.prompt ?? "";
        const providerId = body.provider?.trim();
        if (!findingId || !providerId) {
          json(res, 400, {
            error: "findingId and provider are required",
          });
          return;
        }

        const provider = registry.get(providerId) as Provider | undefined;
        if (!provider) {
          json(res, 400, { error: `Unknown provider: ${providerId}` });
          return;
        }

        busy = true;
        try {
          const run = await loadRun(outputDir);
          const finding = run.findings.find((f) => f.id === findingId);
          if (!finding) {
            json(res, 404, { error: `Finding not found: ${findingId}` });
            return;
          }

          let diffText: string | undefined;
          try {
            diffText = await readFile(path.join(outputDir, "diff.patch"), "utf8");
          } catch {
            diffText = undefined;
          }

          const fileDiff = extractDiffForFile(diffText, finding.file);
          const prompt = buildReverifyPrompt({
            finding,
            userPrompt,
            prNumber: run.prNumber,
            ...(run.title !== undefined ? { title: run.title } : {}),
            fileDiff,
          });

          const context = buildPassContext({
            config,
            repoRoot,
            outputDir,
            run,
            ...(diffText !== undefined ? { diffText } : {}),
          });

          const response = await provider.complete({
            passId: "reverify",
            prompt,
            rules:
              "Re-verify one finding only. Always return one finding object. Use disposition false_alarm (never delete). Keep reviewComment 1–3 short sentences.",
            context,
          });

          const applied = applyReverifyToRun(
            run,
            findingId,
            response.findings,
            userPrompt,
          );
          await saveRun(outputDir, applied.run);
          await renderReviewFromDir(outputDir);

          json(res, 200, {
            action: applied.action,
            note: applied.note,
            provider: response.provider,
            finding: applied.finding,
            payload: toTriagePayload(applied.run),
          });
        } finally {
          busy = false;
        }
        return;
      }

      if (method === "GET" && (url.pathname === "/" || url.pathname === "/triage.html")) {
        await serveStatic(res, path.join(outputDir, "triage.html"));
        return;
      }

      if (method === "GET" && url.pathname === "/final-review.html") {
        await serveStatic(res, path.join(outputDir, "final-review.html"));
        return;
      }

      if (method === "GET" && url.pathname === "/findings.json") {
        await serveStatic(res, path.join(outputDir, "findings.json"));
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
  console.log(`████ PRism · serve PR #${run.prNumber}`);
  console.log(`Triage: http://127.0.0.1:${port}/`);
  console.log(`List:   http://127.0.0.1:${port}/final-review.html`);
  console.log("Recheck uses the provider you pick in the dropdown.");
  console.log("Ctrl+C to stop.");
}
