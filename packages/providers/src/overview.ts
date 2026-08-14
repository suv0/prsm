import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { PrOverviewSchema, type PrOverview } from "@review-os/schemas";
import {
  cliInvocation,
  execOptionsForSpec,
  type CliAgentSpec,
} from "./cli-agents.js";
import { createCliLogBridge, execCli } from "./run-cli.js";

const MAX_DIFF_CHARS = 60_000;

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n\n…[truncated]`;
}

function softenJson(text: string): string {
  return text.trim().replace(/,(\s*[\]}])/g, "$1");
}

function extractJsonObject(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1]?.trim() || text.trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start === -1 || end <= start) {
    throw new Error("Overview response did not contain a JSON object");
  }
  return JSON.parse(softenJson(candidate.slice(start, end + 1)));
}

export function parseOverviewFromModelText(
  text: string,
  provider?: string,
): PrOverview {
  const raw = extractJsonObject(text);
  const parsed = PrOverviewSchema.safeParse({
    ...(typeof raw === "object" && raw !== null ? raw : {}),
    ...(provider ? { provider } : {}),
  });
  if (!parsed.success) {
    throw new Error(`Overview JSON failed validation: ${parsed.error.message}`);
  }
  return parsed.data;
}

function buildOverviewPrompt(input: {
  prNumber: number;
  title: string;
  prUrl?: string;
  base?: string;
  head?: string;
  files: string[];
  diff: string;
}): string {
  return [
    "# PR overview task",
    "",
    "You are briefing a human reviewer who has not opened the PR yet.",
    "Read the title, file list, and diff. Explain what the PR does in plain English.",
    "Do NOT list line-level code review findings — that happens in specialist passes.",
    "",
    "## PR",
    `- Number: #${input.prNumber}`,
    `- Title: ${input.title}`,
    input.prUrl ? `- URL: ${input.prUrl}` : "",
    input.base && input.head ? `- Branches: ${input.base} ← ${input.head}` : "",
    "",
    "## Changed files",
    ...input.files.slice(0, 80).map((file) => `- ${file}`),
    input.files.length > 80 ? `- …and ${input.files.length - 80} more` : "",
    "",
    "## Diff",
    truncate(input.diff || "(no diff)", MAX_DIFF_CHARS),
    "",
    "## Output",
    "Return ONLY a JSON object (no markdown fences if possible):",
    "{",
    '  "summary": "2-5 sentences: what this PR is trying to accomplish",',
    '  "whatChanged": ["short bullet", "..."],',
    '  "mainRisks": ["what could go wrong / what to watch", "..."],',
    '  "testFocus": ["concrete things a human should click/test", "..."]',
    "}",
    "Write for a busy teammate. Short sentences. No jargon when a simple word works.",
  ]
    .filter(Boolean)
    .join("\n");
}

export async function generatePrOverview(options: {
  providerId: string;
  repoRoot: string;
  outputDir: string;
  prNumber: number;
  title: string;
  prUrl?: string;
  base?: string;
  head?: string;
  files: string[];
  diff: string;
  log?: (line: string) => void;
  extraCliSpecs?: CliAgentSpec[];
}): Promise<PrOverview> {
  const log = options.log ?? (() => undefined);
  const agentDir = path.join(options.outputDir, "agent");
  await mkdir(agentDir, { recursive: true });
  const promptPath = path.join(agentDir, "overview.prompt.txt");
  await writeFile(
    promptPath,
    buildOverviewPrompt({
      prNumber: options.prNumber,
      title: options.title,
      ...(options.prUrl !== undefined ? { prUrl: options.prUrl } : {}),
      ...(options.base !== undefined ? { base: options.base } : {}),
      ...(options.head !== undefined ? { head: options.head } : {}),
      files: options.files,
      diff: options.diff,
    }),
    "utf8",
  );

  log(`▶ overview via ${options.providerId}…`);
  const startedAt = Date.now();
  const { command, args, spec } = cliInvocation(
    options.providerId,
    options.extraCliSpecs ?? [],
  );
  const instruction = [
    "You write PR overviews for human reviewers.",
    `Read this prompt and follow it exactly: ${promptPath}`,
    "Return ONLY a JSON object with keys summary, whatChanged, mainRisks, testFocus.",
    "Do not modify repository files.",
  ].join(" ");
  const result = await execCli(command, args(instruction, options.repoRoot), {
    cwd: options.repoRoot,
    ...execOptionsForSpec(spec, instruction),
    timeoutMs: 8 * 60 * 1000,
    ...createCliLogBridge(log, command),
  });

  if (result.code !== 0) {
    throw new Error(
      `overview ${options.providerId} failed (${result.code}): ${result.stderr || result.stdout}`,
    );
  }

  const overview = parseOverviewFromModelText(result.stdout, options.providerId);
  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  log(`✓ overview done in ${seconds}s`);
  return overview;
}
