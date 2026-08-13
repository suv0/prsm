import type {
  Provider,
  ProviderRequest,
  ProviderResponse,
} from "@review-os/core";
import { parseFindingsFromModelText } from "./parse-findings.js";
import {
  buildCliReviewInstruction,
  commandExists,
  createCliLogBridge,
  execCli,
  writePassPromptFile,
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
    extraArgs: ["--output-format", "text"],
    promptStyle: "dash-p",
  },
  {
    id: "command-code",
    name: "Command Code",
    command: "command-code",
    extraArgs: [
      "--skip-onboarding",
      "--no-session",
      "--output-format",
      "text",
    ],
    promptStyle: "dash-p",
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
} {
  const spec = resolveCliSpec(providerId, extras);
  return {
    command: spec.command,
    args: (instruction, cwd) => buildCliArgs(spec, instruction, cwd),
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

    const result = await execCli(
      this.spec.command,
      buildCliArgs(this.spec, instruction, cwd),
      {
        cwd,
        timeoutMs: 12 * 60 * 1000,
        ...createCliLogBridge(request.context.log, this.spec.command),
      },
    );

    if (result.code !== 0) {
      throw new Error(
        `${this.id} failed (${result.code}):\n${result.stderr || result.stdout}`,
      );
    }

    const findings = parseFindingsFromModelText(result.stdout, {
      passId: request.passId,
      provider: this.id,
    });

    return {
      provider: this.id,
      rawText: result.stdout,
      findings,
    };
  }
}
