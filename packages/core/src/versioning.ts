import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { ReviewRunSchema, type Finding, type ReviewRun } from "@review-os/schemas";

export type ReviewRunMeta = {
  id: string;
  agent: string;
  createdAt: string;
  findingCount: number;
  path: string;
};

export type AgentsIndex = {
  prNumber: number;
  mergedAt?: string;
  runs: ReviewRunMeta[];
};

function slugAgent(agent: string): string {
  const slug = agent
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "agent";
}

/** Stable run folder id: 20260808T173012Z-command-code */
export function makeRunId(agent: string, at = new Date()): string {
  const iso = at.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `${iso}-${slugAgent(agent)}`;
}

export function resolveAgentName(
  explicit?: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (explicit?.trim()) return slugAgent(explicit);
  if (env.REVIEW_OS_AGENT?.trim()) return slugAgent(env.REVIEW_OS_AGENT);
  if (env.CURSOR_AGENT) return "cursor";
  if (env.CLAUDE_CODE || env.CLAUDECODE) return "claude-code";
  if (env.COMMAND_CODE) return "command-code";
  return "agent";
}

export async function listReviewRuns(
  outputDir: string,
): Promise<ReviewRunMeta[]> {
  const runsDir = path.join(outputDir, "runs");
  let entries: string[] = [];
  try {
    entries = await readdir(runsDir);
  } catch {
    return [];
  }

  const metas: ReviewRunMeta[] = [];
  for (const entry of entries) {
    const runDir = path.join(runsDir, entry);
    try {
      const info = await stat(runDir);
      if (!info.isDirectory()) continue;
    } catch {
      continue;
    }

    const metaPath = path.join(runDir, "meta.json");
    try {
      const raw = JSON.parse(await readFile(metaPath, "utf8")) as ReviewRunMeta;
      metas.push({
        id: raw.id ?? entry,
        agent: raw.agent ?? "agent",
        createdAt: raw.createdAt ?? new Date(0).toISOString(),
        findingCount: raw.findingCount ?? 0,
        path: `runs/${entry}`,
      });
      continue;
    } catch {
      // fall through — derive from findings/run.json
    }

    let findingCount = 0;
    let createdAt = new Date(0).toISOString();
    try {
      const findingsRaw = JSON.parse(
        await readFile(path.join(runDir, "findings.json"), "utf8"),
      ) as { findings?: unknown[] };
      findingCount = Array.isArray(findingsRaw.findings)
        ? findingsRaw.findings.length
        : 0;
    } catch {
      findingCount = 0;
    }
    try {
      const runRaw = JSON.parse(
        await readFile(path.join(runDir, "run.json"), "utf8"),
      ) as { createdAt?: string; agent?: string };
      if (runRaw.createdAt) createdAt = runRaw.createdAt;
      const fromId = entry.includes("-")
        ? entry.split("-").slice(1).join("-")
        : "agent";
      metas.push({
        id: entry,
        agent: runRaw.agent ?? (fromId || "agent"),
        createdAt,
        findingCount,
        path: `runs/${entry}`,
      });
    } catch {
      metas.push({
        id: entry,
        agent: "agent",
        createdAt,
        findingCount,
        path: `runs/${entry}`,
      });
    }
  }

  return metas.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export async function writeAgentsIndex(
  outputDir: string,
  prNumber: number,
  runs: ReviewRunMeta[],
): Promise<void> {
  const index: AgentsIndex = {
    prNumber,
    mergedAt: new Date().toISOString(),
    runs,
  };
  await writeFile(
    path.join(outputDir, "agents-index.json"),
    JSON.stringify(index, null, 2),
    "utf8",
  );
}

export function tagFindingsWithAgent(
  findings: Finding[],
  agent: string,
): Finding[] {
  return findings.map((finding) => {
    const already = finding.views.some(
      (view) => view.model === agent && view.stance === "new",
    );
    if (already) return finding;
    return {
      ...finding,
      views: [
        {
          model: agent,
          stance: "new" as const,
          note: finding.issueSimple,
        },
        ...finding.views,
      ],
    };
  });
}

async function copyDirContents(
  sourceDir: string,
  destDir: string,
): Promise<void> {
  let entries: string[] = [];
  try {
    entries = await readdir(sourceDir);
  } catch {
    return;
  }
  await mkdir(destDir, { recursive: true });
  for (const entry of entries) {
    const from = path.join(sourceDir, entry);
    const to = path.join(destDir, entry);
    const info = await stat(from);
    if (info.isDirectory()) {
      await copyDirContents(from, to);
    } else {
      await copyFile(from, to);
    }
  }
}

/**
 * If top-level already has a finalized review but no runs/, snapshot it once
 * so a later agent finalize cannot erase history.
 */
export async function archiveLegacyTopLevelIfNeeded(
  outputDir: string,
): Promise<ReviewRunMeta | null> {
  const existing = await listReviewRuns(outputDir);
  if (existing.length > 0) return null;

  let findingsCount = 0;
  try {
    const raw = JSON.parse(
      await readFile(path.join(outputDir, "findings.json"), "utf8"),
    ) as { findings?: unknown[] };
    findingsCount = Array.isArray(raw.findings) ? raw.findings.length : 0;
  } catch {
    return null;
  }
  if (findingsCount === 0) return null;

  let agent = "archived";
  let createdAt = new Date().toISOString();
  try {
    const run = ReviewRunSchema.parse(
      JSON.parse(await readFile(path.join(outputDir, "run.json"), "utf8")),
    );
    createdAt = run.createdAt;
    agent = run.agent ?? "archived";
  } catch {
    // keep defaults
  }

  const runId = makeRunId(agent, new Date(createdAt));
  const runDir = path.join(outputDir, "runs", runId);
  await mkdir(runDir, { recursive: true });

  const filesToCopy = [
    "findings.json",
    "run.json",
    "final-review.md",
    "final-review.html",
    "evidence-report.json",
    "plan.json",
    "plan.md",
  ];
  for (const file of filesToCopy) {
    try {
      await copyFile(path.join(outputDir, file), path.join(runDir, file));
    } catch {
      // optional
    }
  }
  await copyDirContents(
    path.join(outputDir, "passes"),
    path.join(runDir, "passes"),
  );

  const meta: ReviewRunMeta = {
    id: runId,
    agent,
    createdAt,
    findingCount: findingsCount,
    path: `runs/${runId}`,
  };
  await writeFile(
    path.join(runDir, "meta.json"),
    JSON.stringify(meta, null, 2),
    "utf8",
  );
  return meta;
}

export async function snapshotAgentRun(options: {
  outputDir: string;
  runId: string;
  agent: string;
  run: ReviewRun;
  evidenceReport?: unknown;
  render: (
    run: ReviewRun,
    outputDir: string,
    diffText?: string,
  ) => Promise<void>;
  diffText?: string;
}): Promise<ReviewRunMeta> {
  const runDir = path.join(options.outputDir, "runs", options.runId);
  await mkdir(runDir, { recursive: true });

  const taggedRun: ReviewRun = {
    ...options.run,
    agent: options.agent,
    runId: options.runId,
    findings: tagFindingsWithAgent(options.run.findings, options.agent),
  };

  if (options.diffText !== undefined) {
    await options.render(taggedRun, runDir, options.diffText);
  } else {
    await options.render(taggedRun, runDir);
  }
  await copyDirContents(
    path.join(options.outputDir, "passes"),
    path.join(runDir, "passes"),
  );

  if (options.evidenceReport !== undefined) {
    await writeFile(
      path.join(runDir, "evidence-report.json"),
      JSON.stringify(options.evidenceReport, null, 2),
      "utf8",
    );
  }

  const meta: ReviewRunMeta = {
    id: options.runId,
    agent: options.agent,
    createdAt: taggedRun.createdAt,
    findingCount: taggedRun.findings.length,
    path: `runs/${options.runId}`,
  };
  await writeFile(
    path.join(runDir, "meta.json"),
    JSON.stringify(meta, null, 2),
    "utf8",
  );

  return meta;
}

/** Move working passes aside after snapshot so the next agent starts clean. */
export async function clearWorkingPasses(outputDir: string): Promise<void> {
  const passesDir = path.join(outputDir, "passes");
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const trash = path.join(outputDir, ".passes-last", stamp);
  try {
    await mkdir(path.dirname(trash), { recursive: true });
    await rename(passesDir, trash);
  } catch {
    try {
      await rm(passesDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
  await mkdir(passesDir, { recursive: true });
  await writeFile(
    path.join(passesDir, "README.md"),
    [
      "# Working passes",
      "",
      "Write `<pass>.findings.json` here for the **current** agent run.",
      "Each `--finalize` snapshots this folder under `runs/<id>/passes/` and clears it.",
      "Prior agent work is never deleted from `runs/`.",
      "",
    ].join("\n"),
    "utf8",
  );
}

/**
 * After a live `--run` wrote top-level artifacts, snapshot that agent run and
 * rebuild the merged final-review across all runs.
 */
export async function versionCompletedReview(options: {
  outputDir: string;
  run: ReviewRun;
  agent?: string;
  diffText?: string;
  keepPasses?: boolean;
  render: (
    run: ReviewRun,
    outputDir: string,
    diffText?: string,
  ) => Promise<void>;
  rebuild: typeof import("./merge-runs.js").rebuildMergedReview;
}): Promise<{
  runId: string;
  agent: string;
  runCount: number;
  mergedFindingCount: number;
}> {
  const agent = resolveAgentName(options.agent ?? options.run.agent);
  // Caller should archiveLegacyTopLevelIfNeeded *before* overwriting top-level.

  const createdAt = options.run.createdAt || new Date().toISOString();
  const runId = options.run.runId ?? makeRunId(agent, new Date(createdAt));
  const meta = await snapshotAgentRun({
    outputDir: options.outputDir,
    runId,
    agent,
    run: {
      ...options.run,
      agent,
      runId,
      createdAt,
    },
    render: options.render,
    ...(options.diffText !== undefined ? { diffText: options.diffText } : {}),
  });

  if (!options.keepPasses) {
    await clearWorkingPasses(options.outputDir);
  }

  const merged = await options.rebuild({
    outputDir: options.outputDir,
    prNumber: options.run.prNumber,
    render: options.render,
    baseRun: options.run,
    ...(options.diffText !== undefined ? { diffText: options.diffText } : {}),
  });

  return {
    runId: meta.id,
    agent,
    runCount: merged.runCount,
    mergedFindingCount: merged.findingCount,
  };
}

export async function loadRunFindings(
  outputDir: string,
  meta: ReviewRunMeta,
): Promise<{ agent: string; findings: Finding[]; run: ReviewRun | null }> {
  const runDir = path.join(outputDir, meta.path);
  try {
    const raw = JSON.parse(
      await readFile(path.join(runDir, "findings.json"), "utf8"),
    ) as { findings?: Finding[] };
    const findings = Array.isArray(raw.findings) ? raw.findings : [];
    let run: ReviewRun | null = null;
    try {
      run = ReviewRunSchema.parse(
        JSON.parse(await readFile(path.join(runDir, "run.json"), "utf8")),
      );
    } catch {
      run = null;
    }
    return { agent: meta.agent, findings, run };
  } catch {
    return { agent: meta.agent, findings: [], run: null };
  }
}
