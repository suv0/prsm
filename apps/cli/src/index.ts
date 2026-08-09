#!/usr/bin/env node
import path from "node:path";
import { readFile } from "node:fs/promises";
import {
  archiveLegacyTopLevelIfNeeded,
  finalizeReviewRun,
  loadConfig,
  resolveDefaultConfigPath,
  rebuildMergedReview,
  runPipeline,
  versionCompletedReview,
  writeAgentWorkspace,
  type Provider,
  type RunPipelineOptions,
} from "@review-os/core";
import { compareBranches } from "@review-os/git";
import { fetchPullRequest } from "@review-os/github";
import {
  createProviderRegistry,
  defaultPasses,
  detectDefaultCliProvider,
  listAvailableProviders,
  type ProviderId,
} from "@review-os/providers";
import { renderReviewFromDir, writeReviewArtifacts } from "@review-os/render";
import type { AppConfig } from "@review-os/schemas";
import { serveTriage } from "./serve-triage.js";
import { serveUi } from "./serve-ui.js";
import { printDoctorReport, runDoctor } from "./doctor.js";
import { CLI_PROVIDERS, runWithProvider } from "./run-provider.js";

function printHelp(): void {
  console.log(`PRism — see every angle before you merge

Chat (no API key) — recommended:
  In Cursor / Claude Code / Command Code:
    prsm https://github.com/org/repo/pull/123
    review-pr https://github.com/org/repo/pull/123   # alias

CLI prepare + finalize:
  pnpm prsm <pr-url>                 # prepare briefs for chat/agents
  pnpm prsm --finalize <n>           # after passes/*.findings.json exist
  pnpm prsm --finalize <n> --agent cursor

Each finalize/run is versioned under reviews/<n>/runs/<timestamp>-<agent>/.
Top-level final-review.* is a merged view across agents (similar findings combined).

CLI auto-run with local agent tools (no PRism API key):
  pnpm prsm --run <pr-url>           # auto-pick cursor|claude-code|command-code
  pnpm prsm --provider cursor <url>
  pnpm prsm --provider claude-code <url>
  pnpm prsm --provider command-code <url>
  pnpm prsm --provider anthropic <url>   # needs ANTHROPIC_API_KEY

Other:
  prsm --demo
  prsm --load-only <pr-url>
  prsm --list-providers
  prsm --doctor                       # check Node, gh, agent CLIs
  prsm --base <base> --head <head>
  prsm --agent <name>                # label this agent in runs/ + merge
  prsm --rebuild-merge <n>           # archive legacy + rebuild merged view
  prsm --render <n>                  # re-render md/html/triage from run.json (no re-merge)
  prsm --serve <n> [--port 8787]     # local triage UI + live Recheck API
  prsm --serve-ui [--port 8788]      # paste PR URL → run cursor+claude+command-code

Alias: pnpm prsm … works the same as pnpm prsm …
`);
}

function parseArgs(argv: string[]): {
  demo: boolean;
  help: boolean;
  loadOnly: boolean;
  prepare: boolean;
  run: boolean;
  listProviders: boolean;
  doctor: boolean;
  finalize?: number;
  rebuildMerge?: number;
  render?: number;
  serve?: number;
  serveUi: boolean;
  port: number;
  provider?: string;
  agent?: string;
  configPath?: string;
  prRef?: string;
  base?: string;
  head?: string;
} {
  const args = [...argv];
  let demo = false;
  let help = false;
  let loadOnly = false;
  let prepare = false;
  let run = false;
  let listProviders = false;
  let doctor = false;
  let finalize: number | undefined;
  let rebuildMerge: number | undefined;
  let render: number | undefined;
  let serve: number | undefined;
  let serveUi = false;
  let port = 8787;
  let provider: string | undefined;
  let agent: string | undefined;
  let configPath: string | undefined;
  let prRef: string | undefined;
  let base: string | undefined;
  let head: string | undefined;

  while (args.length > 0) {
    const token = args.shift();
    if (!token) break;
    switch (token) {
      case "--demo":
        demo = true;
        break;
      case "--load-only":
        loadOnly = true;
        break;
      case "--prepare":
        prepare = true;
        break;
      case "--run":
        run = true;
        break;
      case "--list-providers":
        listProviders = true;
        break;
      case "--doctor":
        doctor = true;
        break;
      case "--api":
        provider = "anthropic";
        run = true;
        break;
      case "--provider": {
        const value = args.shift();
        if (!value) throw new Error("--provider requires an id");
        provider = value;
        run = true;
        break;
      }
      case "--agent": {
        const value = args.shift();
        if (!value) throw new Error("--agent requires a name");
        agent = value;
        break;
      }
      case "--finalize": {
        const value = args.shift();
        if (!value) throw new Error("--finalize requires a PR number");
        finalize = Number(value);
        if (!Number.isFinite(finalize) || finalize <= 0) {
          throw new Error(`Invalid --finalize value: ${value}`);
        }
        break;
      }
      case "--rebuild-merge": {
        const value = args.shift();
        if (!value) throw new Error("--rebuild-merge requires a PR number");
        rebuildMerge = Number(value);
        if (!Number.isFinite(rebuildMerge) || rebuildMerge <= 0) {
          throw new Error(`Invalid --rebuild-merge value: ${value}`);
        }
        break;
      }
      case "--render": {
        const value = args.shift();
        if (!value) throw new Error("--render requires a PR number");
        render = Number(value);
        if (!Number.isFinite(render) || render <= 0) {
          throw new Error(`Invalid --render value: ${value}`);
        }
        break;
      }
      case "--serve": {
        const value = args.shift();
        if (!value) throw new Error("--serve requires a PR number");
        serve = Number(value);
        if (!Number.isFinite(serve) || serve <= 0) {
          throw new Error(`Invalid --serve value: ${value}`);
        }
        break;
      }
      case "--serve-ui":
        serveUi = true;
        port = 8788;
        break;
      case "--port": {
        const value = args.shift();
        if (!value) throw new Error("--port requires a number");
        port = Number(value);
        if (!Number.isFinite(port) || port <= 0 || port > 65535) {
          throw new Error(`Invalid --port value: ${value}`);
        }
        break;
      }
      case "--help":
      case "-h":
        help = true;
        break;
      case "--config": {
        const value = args.shift();
        if (!value) throw new Error("--config requires a path");
        configPath = value;
        break;
      }
      case "--base": {
        const value = args.shift();
        if (!value) throw new Error("--base requires a ref");
        base = value;
        break;
      }
      case "--head": {
        const value = args.shift();
        if (!value) throw new Error("--head requires a ref");
        head = value;
        break;
      }
      case "--":
        break;
      default:
        if (token.startsWith("-")) {
          throw new Error(`Unknown flag: ${token}`);
        }
        prRef = token;
        break;
    }
  }

  return {
    demo,
    help,
    loadOnly,
    prepare,
    run,
    listProviders,
    doctor,
    ...(finalize !== undefined ? { finalize } : {}),
    ...(rebuildMerge !== undefined ? { rebuildMerge } : {}),
    ...(render !== undefined ? { render } : {}),
    ...(serve !== undefined ? { serve } : {}),
    serveUi,
    port,
    ...(provider !== undefined ? { provider } : {}),
    ...(agent !== undefined ? { agent } : {}),
    ...(configPath !== undefined ? { configPath } : {}),
    ...(prRef !== undefined ? { prRef } : {}),
    ...(base !== undefined ? { base } : {}),
    ...(head !== undefined ? { head } : {}),
  };
}

const preserveFinalRender = (
  run: Parameters<typeof writeReviewArtifacts>[0],
  outputDir: string,
  diffText?: string,
) =>
  writeReviewArtifacts(run, outputDir, diffText, {
    preserveExistingFinal: true,
  });

function printDone(
  prNumber: number,
  findingCount: number,
  outputDir: string,
  extra?: string,
): void {
  console.log("Done.");
  console.log(`PR #${prNumber}`);
  console.log(`Findings: ${findingCount}`);
  console.log(`Output: ${outputDir}`);
  console.log(`Open: ${path.join(outputDir, "triage.html")}`);
  console.log(`Or:   ${path.join(outputDir, "final-review.html")}`);
  if (extra) console.log(extra);
}

async function resolveRepoRoot(cwd: string, configPathFlag?: string) {
  const configPath = configPathFlag
    ? path.resolve(cwd, configPathFlag)
    : await resolveDefaultConfigPath(cwd);
  const repoRoot = path.dirname(path.dirname(configPath));
  const config = await loadConfig(configPath);
  return { configPath, repoRoot, config };
}

async function prepareFromPr(options: {
  prRef: string;
  repoRoot: string;
  config: AppConfig;
  providers: Map<string, Provider>;
}): Promise<void> {
  console.log("████ PRism · prepare (agent-first, no API key)");
  console.log(`Fetching ${options.prRef}...`);
  const pr = await fetchPullRequest(options.prRef);
  console.log(`Loaded PR #${pr.number}: ${pr.title}`);
  console.log(
    `Changed files: ${pr.files.length} (+${pr.additions}/-${pr.deletions})`,
  );

  const pipelineOptions: RunPipelineOptions = {
    config: options.config,
    prNumber: pr.number,
    prUrl: pr.url,
    title: pr.title,
    base: pr.base,
    head: pr.head,
    demo: false,
    loadOnly: true,
    load: {
      source: "pr",
      additions: pr.additions,
      deletions: pr.deletions,
      files: pr.files,
      diffTruncated: pr.diffTruncated,
      diffPath: "diff.patch",
      note: "Prepared for agent specialists (Cursor / Claude / Command Code).",
    },
    changedFiles: pr.files.map((file) => file.path),
    cwd: options.repoRoot,
    diffText: pr.diff,
  };

  console.log("Building knowledge + plan + agent briefs...");
  const { outputDir, run } = await runPipeline(pipelineOptions, {
    providers: options.providers,
    passes: defaultPasses,
    render: preserveFinalRender,
  });

  const passIds =
    run.plan?.skippedPasses
      .filter((p) => p.reason.toLowerCase().includes("deferred"))
      .map((p) => p.id) ??
    options.config.passes.filter((p) => p.enabled).map((p) => p.id);

  if (!run.plan) {
    throw new Error("Pipeline did not produce a plan");
  }

  await writeAgentWorkspace({
    outputDir,
    repoRoot: options.repoRoot,
    run,
    plan: run.plan,
    passIds: passIds.length
      ? passIds
      : ["correctness", "nitpick", "devils-advocate"],
  });

  printDone(
    run.prNumber,
    0,
    outputDir,
    [
      "",
      "Next:",
      "  • Chat: continue with the review-pr skill (writes passes + finalize)",
      `  • Or: pnpm prsm --run ${options.prRef}`,
      `  • Or: fill passes/*.findings.json then pnpm prsm --finalize ${run.prNumber}`,
    ].join("\n"),
  );
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
    printHelp();
    return;
  }

  const cwd = process.cwd();
  const providers = createProviderRegistry();

  if (parsed.listProviders) {
    const available = await listAvailableProviders(providers);
    console.log("Available providers:");
    for (const id of available) console.log(`  - ${id}`);
    const auto = await detectDefaultCliProvider(providers);
    console.log(`Auto --run pick: ${auto ?? "(none found)"}`);
    return;
  }

  const { repoRoot, config } = await resolveRepoRoot(cwd, parsed.configPath);

  if (parsed.doctor) {
    const report = await runDoctor({ repoRoot });
    printDoctorReport(report.checks, report.ok);
    if (!report.ok) process.exitCode = 1;
    return;
  }

  if (parsed.rebuildMerge !== undefined) {
    console.log(`████ PRism · rebuild-merge PR #${parsed.rebuildMerge}`);
    const outputDir = path.resolve(
      repoRoot,
      config.outputDir,
      String(parsed.rebuildMerge),
    );
    const archived = await archiveLegacyTopLevelIfNeeded(outputDir);
    if (archived) {
      console.log(`Archived prior review → ${archived.path}`);
    }
    let diffText: string | undefined;
    try {
      diffText = await readFile(path.join(outputDir, "diff.patch"), "utf8");
    } catch {
      diffText = undefined;
    }
    const merged = await rebuildMergedReview({
      outputDir,
      prNumber: parsed.rebuildMerge,
      render: writeReviewArtifacts,
      ...(diffText !== undefined ? { diffText } : {}),
    });
    printDone(
      parsed.rebuildMerge,
      merged.findingCount,
      outputDir,
      `Merged across ${merged.runCount} agent run(s)`,
    );
    return;
  }

  if (parsed.render !== undefined) {
    console.log(`████ PRism · render PR #${parsed.render}`);
    const outputDir = path.resolve(
      repoRoot,
      config.outputDir,
      String(parsed.render),
    );
    const rendered = await renderReviewFromDir(outputDir);
    printDone(
      rendered.prNumber,
      rendered.findingCount,
      outputDir,
      "Re-rendered final-review.md|html + triage.html from run.json (no re-merge)",
    );
    return;
  }

  if (parsed.serveUi) {
    await serveUi({
      repoRoot,
      config,
      port: parsed.port,
    });
    return;
  }

  if (parsed.serve !== undefined) {
    const outputDir = path.resolve(
      repoRoot,
      config.outputDir,
      String(parsed.serve),
    );
    // Ensure triage.html is current before serving.
    await renderReviewFromDir(outputDir);
    await serveTriage({
      repoRoot,
      outputDir,
      config,
      port: parsed.port,
    });
    return;
  }

  if (parsed.finalize !== undefined) {
    console.log(`████ PRism · finalize PR #${parsed.finalize}`);
    const outputDir = path.resolve(
      repoRoot,
      config.outputDir,
      String(parsed.finalize),
    );
    const result = await finalizeReviewRun({
      outputDir,
      confidenceFloor: config.confidenceFloor,
      ...(parsed.agent !== undefined ? { agent: parsed.agent } : {}),
      render: writeReviewArtifacts,
    });
    printDone(
      parsed.finalize,
      result.mergedFindingCount,
      outputDir,
      [
        `Agent run: runs/${result.runId} (${result.agent}, ${result.findingCount} raw)`,
        `Merged across ${result.runCount} agent run(s)`,
        `Evidence: corrected ${result.corrected} line(s), removed ${result.removed}, demoted ${result.demoted}`,
      ].join("\n"),
    );
    return;
  }

  const hasBranchPair = Boolean(parsed.base && parsed.head);
  const hasPartialBranch =
    Boolean(parsed.base || parsed.head) && !hasBranchPair;
  if (hasPartialBranch) {
    throw new Error("Provide both --base and --head");
  }

  if (!parsed.demo && !parsed.prRef && !hasBranchPair) {
    printHelp();
    process.exitCode = 1;
    return;
  }

  if (parsed.demo) {
    console.log("████ PRism · demo mode");
    const { outputDir, run } = await runPipeline(
      {
        config,
        prNumber: 1,
        prUrl: "https://github.com/example/repo/pull/1",
        title: "Demo PR — fixture findings",
        demo: true,
        load: {
          source: "demo",
          additions: 12,
          deletions: 3,
          files: [
            {
              path: "apps/api/user/service.ts",
              additions: 8,
              deletions: 2,
              changeType: "MODIFIED",
            },
          ],
          diffTruncated: false,
        },
        changedFiles: ["apps/api/user/service.ts"],
        cwd: repoRoot,
      },
      {
        providers,
        passes: defaultPasses,
        render: writeReviewArtifacts,
      },
    );
    printDone(run.prNumber, run.findings.length, outputDir);
    return;
  }

  if (parsed.prRef && parsed.run) {
    let providerId = parsed.provider as ProviderId | undefined;
    if (!providerId) {
      const detected = await detectDefaultCliProvider(providers);
      if (!detected) {
        throw new Error(
          "No CLI provider found (cursor agent / claude / command-code). " +
            "Install one, or use chat: review-pr <url>",
        );
      }
      providerId = detected;
      console.log(`Auto-selected provider: ${providerId}`);
    }

    const result = await runWithProvider({
      prRef: parsed.prRef,
      repoRoot,
      config,
      providers,
      providerId,
      ...(parsed.agent !== undefined ? { agent: parsed.agent } : {}),
    });
    printDone(
      result.prNumber,
      result.mergedFindingCount,
      result.outputDir,
      [
        `This run: runs/${result.runId} (${result.agent}, ${result.rawFindingCount} raw)`,
        `Merged across ${result.runCount} agent run(s) → final-review.html`,
      ].join("\n"),
    );
    return;
  }

  if (parsed.prRef) {
    if (parsed.loadOnly) {
      console.log("████ PRism · load-only");
      const pr = await fetchPullRequest(parsed.prRef);
      const { outputDir, run } = await runPipeline(
        {
          config,
          prNumber: pr.number,
          prUrl: pr.url,
          title: pr.title,
          base: pr.base,
          head: pr.head,
          demo: false,
          loadOnly: true,
          load: {
            source: "pr",
            additions: pr.additions,
            deletions: pr.deletions,
            files: pr.files,
            diffTruncated: pr.diffTruncated,
            diffPath: "diff.patch",
            note: "Load-only.",
          },
          changedFiles: pr.files.map((file) => file.path),
          cwd: repoRoot,
          diffText: pr.diff,
        },
        {
          providers,
          passes: defaultPasses,
          render: preserveFinalRender,
        },
      );
      printDone(run.prNumber, 0, outputDir);
      return;
    }

    await prepareFromPr({
      prRef: parsed.prRef,
      repoRoot,
      config,
      providers,
    });
    return;
  }

  if (parsed.base && parsed.head) {
    console.log("████ PRism · prepare branch compare");
    const compare = await compareBranches({
      base: parsed.base,
      head: parsed.head,
      cwd,
    });
    const { outputDir, run } = await runPipeline(
      {
        config,
        prNumber: compare.syntheticPrNumber,
        title: `Branch compare ${parsed.base}...${parsed.head}`,
        base: parsed.base,
        head: parsed.head,
        demo: false,
        loadOnly: true,
        load: {
          source: "branch",
          additions: 0,
          deletions: 0,
          files: compare.files.map((filePath) => ({
            path: filePath,
            additions: 0,
            deletions: 0,
            changeType: "MODIFIED",
          })),
          diffTruncated: compare.diffTruncated,
          diffPath: "diff.patch",
          note: "Prepared for agent specialists.",
        },
        changedFiles: compare.files,
        cwd: repoRoot,
        diffText: compare.diff,
      },
      {
        providers,
        passes: defaultPasses,
        render: preserveFinalRender,
      },
    );

    if (!run.plan) throw new Error("Pipeline did not produce a plan");
    const passIds = config.passes.filter((p) => p.enabled).map((p) => p.id);
    await writeAgentWorkspace({
      outputDir,
      repoRoot,
      run,
      plan: run.plan,
      passIds,
    });
    printDone(
      run.prNumber,
      0,
      outputDir,
      `Next: fill passes/*.findings.json then pnpm prsm --finalize ${run.prNumber}`,
    );
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`prsm failed: ${message}`);
  process.exitCode = 1;
});
