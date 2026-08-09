import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ProviderRequest } from "@review-os/core";
import { buildReviewUserPrompt } from "./build-prompt.js";

export interface CliExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export type CliLineHandler = (
  stream: "stdout" | "stderr",
  line: string,
) => void;

export type CliHeartbeatHandler = (info: {
  command: string;
  elapsedSec: number;
  silentSec: number;
}) => void;

export interface ExecCliOptions {
  cwd?: string;
  maxBuffer?: number;
  timeoutMs?: number;
  /** Fired for each newline-delimited chunk from the child process. */
  onLine?: CliLineHandler;
  /** Fired while the process is alive (default every 20s). */
  onHeartbeat?: CliHeartbeatHandler;
  heartbeatMs?: number;
}

const activeChildren = new Set<ChildProcess>();

/** Force-kill in-flight CLI agent processes (cursor/claude/command-code). */
export function killActiveCliChildren(): number {
  let killed = 0;
  for (const child of [...activeChildren]) {
    try {
      if (process.platform === "win32" && child.pid) {
        spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
          windowsHide: true,
          stdio: "ignore",
        });
      } else {
        child.kill("SIGTERM");
      }
      killed += 1;
    } catch {
      // ignore
    }
    activeChildren.delete(child);
  }
  return killed;
}

function quoteForWinShell(value: string): string {
  if (value.length === 0) return '""';
  if (!/[\s"]/g.test(value)) return value;
  return `"${value.replaceAll('"', '\\"')}"`;
}

function attachLineSplitter(
  onChunk: (chunk: string) => void,
  onLine: (line: string) => void,
): { push: (chunk: string) => void; flush: () => void } {
  let buffer = "";
  return {
    push(chunk: string) {
      onChunk(chunk);
      buffer += chunk;
      let idx = buffer.indexOf("\n");
      while (idx !== -1) {
        const line = buffer.slice(0, idx).replace(/\r$/, "");
        buffer = buffer.slice(idx + 1);
        onLine(line);
        idx = buffer.indexOf("\n");
      }
    },
    flush() {
      if (buffer.length > 0) {
        onLine(buffer.replace(/\r$/, ""));
        buffer = "";
      }
    },
  };
}

/** Format CLI text for the job log without flooding it with raw JSON. */
export function formatCliLogLine(
  stream: "stdout" | "stderr",
  line: string,
): string | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  const prefix = stream === "stderr" ? "cli!" : "cli";
  const looksJsonHeavy =
    (trimmed.startsWith("[") || trimmed.startsWith("{")) && trimmed.length > 160;
  if (looksJsonHeavy) {
    return `  · ${prefix}: …JSON (${trimmed.length} chars)`;
  }

  const max = 220;
  const body =
    trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
  return `  · ${prefix}: ${body}`;
}

export function createCliLogBridge(
  log: ((line: string) => void) | undefined,
  command: string,
): Pick<ExecCliOptions, "onLine" | "onHeartbeat"> {
  if (!log) return {};

  let emitted = 0;
  const maxLines = 100;
  let mutedNotice = false;

  return {
    onLine(stream, line) {
      if (emitted >= maxLines) {
        if (!mutedNotice) {
          mutedNotice = true;
          log(`  · cli: …suppressing further output (cap ${maxLines} lines)`);
        }
        return;
      }
      const formatted = formatCliLogLine(stream, line);
      if (!formatted) return;
      emitted += 1;
      log(formatted);
    },
    onHeartbeat({ elapsedSec, silentSec }) {
      const elapsed =
        elapsedSec >= 60
          ? `${Math.floor(elapsedSec / 60)}m${String(elapsedSec % 60).padStart(2, "0")}s`
          : `${elapsedSec}s`;
      if (silentSec >= 15) {
        log(
          `  · … ${command} still running (${elapsed} elapsed, no CLI output for ${silentSec}s — usually waiting on the model API)`,
        );
      } else {
        log(`  · … ${command} still running (${elapsed} elapsed)`);
      }
    },
  };
}

export function execCli(
  command: string,
  args: string[],
  options: ExecCliOptions = {},
): Promise<CliExecResult> {
  const maxBuffer = options.maxBuffer ?? 20 * 1024 * 1024;
  const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;
  const heartbeatMs = options.heartbeatMs ?? 20_000;
  const isWin = process.platform === "win32";

  return new Promise((resolve, reject) => {
    const child = isWin
      ? spawn(
          [command, ...args].map(quoteForWinShell).join(" "),
          {
            cwd: options.cwd,
            shell: true,
            windowsHide: true,
          },
        )
      : spawn(command, args, {
          cwd: options.cwd,
          shell: false,
          windowsHide: true,
        });

    activeChildren.add(child);

    let stdout = "";
    let stderr = "";
    let settled = false;
    const startedAt = Date.now();
    let lastActivityAt = startedAt;

    const markActivity = () => {
      lastActivityAt = Date.now();
    };

    const cleanup = () => {
      activeChildren.delete(child);
      clearTimeout(timer);
      clearInterval(heartbeatTimer);
    };

    const timer = setTimeout(() => {
      child.kill();
      if (!settled) {
        settled = true;
        cleanup();
        reject(new Error(`${command} timed out after ${timeoutMs}ms`));
      }
    }, timeoutMs);

    const heartbeatTimer = setInterval(() => {
      if (settled) return;
      options.onHeartbeat?.({
        command,
        elapsedSec: Math.round((Date.now() - startedAt) / 1000),
        silentSec: Math.round((Date.now() - lastActivityAt) / 1000),
      });
    }, heartbeatMs);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");

    const stdoutSplit = attachLineSplitter(
      (chunk) => {
        markActivity();
        stdout += chunk;
        if (stdout.length > maxBuffer) {
          child.kill();
          if (!settled) {
            settled = true;
            cleanup();
            reject(new Error(`${command} output exceeded ${maxBuffer} bytes`));
          }
        }
      },
      (line) => options.onLine?.("stdout", line),
    );

    const stderrSplit = attachLineSplitter(
      (chunk) => {
        markActivity();
        stderr += chunk;
      },
      (line) => options.onLine?.("stderr", line),
    );

    child.stdout?.on("data", (chunk: string) => stdoutSplit.push(chunk));
    child.stderr?.on("data", (chunk: string) => stderrSplit.push(chunk));

    child.on("error", (error) => {
      if (!settled) {
        settled = true;
        cleanup();
        reject(error);
      }
    });

    child.on("close", (code) => {
      stdoutSplit.flush();
      stderrSplit.flush();
      if (settled) {
        cleanup();
        return;
      }
      settled = true;
      cleanup();
      resolve({ stdout, stderr, code: code ?? 1 });
    });
  });
}

export async function commandExists(command: string): Promise<boolean> {
  try {
    const probe =
      process.platform === "win32"
        ? await execCli("where.exe", [command])
        : await execCli("which", [command]);
    return probe.code === 0 && probe.stdout.trim().length > 0;
  } catch {
    return false;
  }
}

export async function writePassPromptFile(
  request: ProviderRequest,
  outputDir: string,
): Promise<string> {
  const agentDir = path.join(outputDir, "agent");
  await mkdir(agentDir, { recursive: true });
  const promptPath = path.join(agentDir, `${request.passId}.prompt.txt`);
  const body = buildReviewUserPrompt(request);
  await writeFile(promptPath, body, "utf8");
  return promptPath;
}

export function buildCliReviewInstruction(promptPath: string): string {
  return [
    "You are a specialist reviewer in the PRism pipeline.",
    `Read this prompt file and follow it exactly: ${promptPath}`,
    "Return ONLY a JSON array of findings.",
    "No markdown fences if possible. No prose outside JSON.",
    "Do not modify repository files.",
  ].join(" ");
}
