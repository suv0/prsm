import type {
  Provider,
  ProviderRequest,
  ProviderResponse,
} from "@review-os/core";
import { parseFindingsFromModelText } from "./parse-findings.js";
import {
  assertPrintModeCliOutput,
  buildCliReviewInstruction,
  commandExists,
  createCliLogBridge,
  execCli,
  writePassPromptFile,
  writePassRawOutput,
  type ExecCliOptions,
} from "./run-cli.js";

export type PromptStyle = "dash-p" | "trailing";

export type CliAgentSpec = {
  id: string;
  name?: string;
  command: string;
  extraArgs: string[];
  promptStyle: PromptStyle;
  /** Append `--workspace <cwd>` (Cursor Agent). */
  workspaceFlag?: boolean;
  /** Put extraArgs before `-p` (Command Code treats flags after `-p` unreliably). */
  extraBeforePrompt?: boolean;
  /** Pipe the prompt on stdin with bare `-p` (avoids Windows argv quoting). */
  promptViaStdin?: boolean;
  /** Override the default 12-minute CLI timeout. */
  timeoutMs?: number;
  /** Kill if the CLI stays silent this long (Command Code max-effort hangs). */
  stallTimeoutMs?: number;
  /**
   * stdout is NDJSON event frames (Command Code `--output-format json`).
   * Only the last `result` frame's `finalText` is kept in memory — see
   * `createNdjsonCollector` in run-cli.ts — so long thinking runs cannot
   * exhaust the process output buffer.
   */
  ndjsonEvents?: boolean;
  env?: NodeJS.ProcessEnv;
};

export const RESERVED_PROVIDER_IDS = new Set([
  "demo",
  "anthropic",
  "cursor",
  "claude-code",
  "command-code",
]);

export const BUILTIN_CLI_SPECS: CliAgentSpec[] = [
  {
    id: "cursor",
    name: "Cursor Agent",
    command: "agent",
    extraArgs: ["--output-format", "text", "--mode", "ask", "--trust"],
    promptStyle: "dash-p",
    workspaceFlag: true,
  },
  {
    id: "claude-code",
    name: "Claude Code",
    command: "claude",
    // Flags before bare `-p`; prompt on stdin — Windows `shell: true` concatenates
    // argv without escaping (DEP0190), which turned long `-p "…"` into Claude's
    // interactive greeting ("What would you like to work on?").
    extraArgs: ["--output-format", "text"],
    promptStyle: "dash-p",
    extraBeforePrompt: true,
    promptViaStdin: true,
    env: {
      CI: "1",
      NO_COLOR: "1",
    },
  },
  {
    id: "command-code",
    name: "Command Code",
    command: "command-code",
    extraArgs: [
      // Headless: trust + dont-ask so a missing TTY cannot sit on a permission prompt.
      // --effort high is the lowest this CLI accepts for deepseek-v4-pro (only high|max).
      // Interactive "max" sat silent for 18 minutes with no tool stream.
      // --no-skills skips repo skills (graphify / review-pr) that spawn extra tools.
      // Prompt goes on stdin with bare `-p` so Windows cmd.exe cannot truncate `-p "…"`.
      "--trust",
      "--skip-onboarding",
      "--no-session",
      "--permission-mode",
      "dont-ask",
      "--effort",
      "high",
      "--no-skills",
      "--output-format",
      "json",
      "--verbose",
      "--no-auto-update",
      "--max-turns",
      "20",
    ],
    promptStyle: "dash-p",
    extraBeforePrompt: true,
    promptViaStdin: true,
    timeoutMs: 12 * 60 * 1000,
    stallTimeoutMs: 5 * 60 * 1000,
    ndjsonEvents: true,
    env: {
      CI: "1",
      NO_COLOR: "1",
    },
  },
];

export function slugAgentId(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return slug;
}

/** Single executable name or path — no shell metacharacters. */
export function assertSafeCliCommand(command: string): string {
  const trimmed = command.trim();
  if (!trimmed) throw new Error("Command is required");
  if (/\s/.test(trimmed)) {
    throw new Error(
      "Command must be a single executable name or path (no spaces or flags)",
    );
  }
  if (/[|&;<>$`"'()]/.test(trimmed)) {
    throw new Error("Command contains unsafe shell characters");
  }
  return trimmed;
}

export function buildCliArgs(
  spec: CliAgentSpec,
  instruction: string,
  cwd: string,
): string[] {
  const extra = [...spec.extraArgs];
  if (spec.workspaceFlag) extra.push("--workspace", cwd);
  if (spec.promptStyle === "trailing") return [...extra, instruction];
  if (spec.promptViaStdin) {
    return spec.extraBeforePrompt ? [...extra, "-p"] : ["-p", ...extra];
  }
  if (spec.extraBeforePrompt) return [...extra, "-p", instruction];
  return ["-p", instruction, ...extra];
}

export function resolveCliSpec(
  providerId: string,
  extras: CliAgentSpec[] = [],
): CliAgentSpec {
  const builtin = BUILTIN_CLI_SPECS.find((spec) => spec.id === providerId);
  if (builtin) return builtin;
  const custom = extras.find((spec) => spec.id === providerId);
  if (custom) return custom;
  throw new Error(`No CLI spec for provider "${providerId}"`);
}

export function cliInvocation(
  providerId: string,
  extras: CliAgentSpec[] = [],
): {
  command: string;
  args: (instruction: string, cwd: string) => string[];
  spec: CliAgentSpec;
} {
  const spec = resolveCliSpec(providerId, extras);
  return {
    command: spec.command,
    args: (instruction, cwd) => buildCliArgs(spec, instruction, cwd),
    spec,
  };
}

export function execOptionsForSpec(
  spec: CliAgentSpec,
  instruction: string,
): Pick<
  ExecCliOptions,
  "stdin" | "timeoutMs" | "stallTimeoutMs" | "env" | "ndjsonEvents"
> {
  return {
    ...(spec.timeoutMs !== undefined ? { timeoutMs: spec.timeoutMs } : {}),
    ...(spec.stallTimeoutMs !== undefined
      ? { stallTimeoutMs: spec.stallTimeoutMs }
      : {}),
    ...(spec.env ? { env: spec.env } : {}),
    ...(spec.promptViaStdin ? { stdin: instruction } : {}),
    ...(spec.ndjsonEvents ? { ndjsonEvents: true } : {}),
  };
}

/** Any local `-p` style CLI (built-in or user-added). */
export class GenericCliProvider implements Provider {
  readonly id: string;

  constructor(private readonly spec: CliAgentSpec) {
    this.id = spec.id;
  }

  async isAvailable(): Promise<boolean> {
    return commandExists(this.spec.command);
  }

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    const outputDir = request.context.outputDir;
    if (!outputDir) {
      throw new Error(`${this.id} requires context.outputDir`);
    }

    const promptPath = await writePassPromptFile(request, outputDir);
    const instruction = buildCliReviewInstruction(promptPath);
    const cwd = request.context.repoRoot ?? process.cwd();
    request.context.log?.(
      `  · spawning ${this.spec.command} (${promptPath})`,
    );
    if (this.spec.id === "command-code") {
      request.context.log?.(
        "  · command-code unattended: --effort high --no-skills --permission-mode dont-ask (overrides interactive max-effort)",
      );
    }
    if (this.spec.id === "claude-code") {
      request.context.log?.(
        "  · claude-code unattended: bare -p with prompt on stdin (Windows-safe)",
      );
    }

    const result = await execCli(
      this.spec.command,
      buildCliArgs(this.spec, instruction, cwd),
      {
        cwd,
        timeoutMs: this.spec.timeoutMs ?? 12 * 60 * 1000,
        ...execOptionsForSpec(this.spec, instruction),
        ...createCliLogBridge(request.context.log, this.spec.command),
      },
    );

    if (result.code !== 0) {
      throw new Error(
        `${this.id} failed (${result.code}):\n${result.stderr || result.stdout}`,
      );
    }

    assertPrintModeCliOutput(result.stdout, this.spec.command);

    let findings;
    try {
      findings = parseFindingsFromModelText(result.stdout, {
        passId: request.passId,
        provider: this.id,
      });
    } catch (error) {
      const rawPath = await writePassRawOutput(
        outputDir,
        request.passId,
        result.stdout,
      );
      request.context.log?.(`  · wrote raw CLI output: ${rawPath}`);
      throw error;
    }

    return {
      provider: this.id,
      rawText: result.stdout,
      findings,
    };
  }
}
