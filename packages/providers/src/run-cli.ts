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

export type CliQueuedHandler = (info: {
  command: string;
  waitedSec: number;
}) => void;

export interface ExecCliOptions {
  cwd?: string;
  maxBuffer?: number;
  timeoutMs?: number;
  /**
   * Kill the process if stdout+stderr stay silent this long (after spawn).
   * Use for CLIs that can sit on a hidden prompt or a stuck model call.
   */
  stallTimeoutMs?: number;
  /** Extra env merged over `process.env`. */
  env?: NodeJS.ProcessEnv;
  /**
   * When set, stdin is a pipe and this text is written then closed.
   * When omitted, stdin is ignored (NUL) so CLIs do not wait for a prompt.
   */
  stdin?: string;
  /** Fired for each newline-delimited chunk from the child process. */
  onLine?: CliLineHandler;
  /** Fired while the process is alive (default every 20s). */
  onHeartbeat?: CliHeartbeatHandler;
  heartbeatMs?: number;
  /** Fired when this CLI waited on another in-flight instance of the same command. */
  onQueued?: CliQueuedHandler;
  /**
   * stdout is newline-delimited JSON event frames (Command Code `--output-format
   * json`). Only the last `result` frame's `finalText` is kept in memory; bulk
   * `thinking_delta` / `text_delta` / `message_update` / `run_end` frames are
   * dropped right after being used for the activity heartbeat, so a long
   * "thinking" run cannot exhaust `maxBuffer`. See `createNdjsonCollector`.
   */
  ndjsonEvents?: boolean;
}

const activeChildren = new Set<ChildProcess>();

/**
 * Quote argv for cmd.exe when Node joins args under `shell: true` on Windows
 * (DEP0190: args are concatenated, not escaped). Without this, a long
 * `-p "read this file…"` prompt splits on spaces and the CLI never sees print mode.
 */
export function quoteWinShellArgs(args: string[]): string[] {
  return args.map((arg) => {
    if (arg.length === 0) return '""';
    if (!/[\s"&<>|^%!]/.test(arg)) return arg;
    return `"${arg.replace(/"/g, '""')}"`;
  });
}

/** Fail fast when a CLI printed its interactive greeting instead of findings. */
export function assertPrintModeCliOutput(stdout: string, command: string): void {
  const trimmed = stdout.trim();
  if (/^What would you like to work on\?/i.test(trimmed)) {
    throw new Error(
      `${command} started interactive mode instead of print mode ` +
        `(got the greeting, not findings JSON). Prompt must reach -p via stdin ` +
        `or a quoted argv — restart the hub after upgrading PRism.`,
    );
  }
}

/** Kill the CLI process and, on Windows, its cmd.exe → node grandchild tree. */
function killCliChild(child: ChildProcess): void {
  try {
    if (process.platform === "win32" && child.pid) {
      spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        windowsHide: true,
        stdio: "ignore",
      });
      return;
    }
    child.kill("SIGTERM");
  } catch {
    // ignore
  }
}

/** Force-kill in-flight CLI agent processes (cursor/claude/command-code). */
export function killActiveCliChildren(): number {
  let killed = 0;
  for (const child of [...activeChildren]) {
    killCliChild(child);
    killed += 1;
    activeChildren.delete(child);
  }
  return killed;
}

/**
 * Frame types that are pure streaming noise on a Command Code NDJSON line:
 * incremental thinking/text tokens and the full-history end-of-run dump.
 * Never worth keeping once logged — only the final `result` frame matters.
 */
const NDJSON_DISCARD_TYPES = new Set([
  "thinking_delta",
  "text_delta",
  "message_update",
  "run_end",
]);

type NdjsonLineVerdict =
  | { kind: "result"; finalText: string }
  | { kind: "discard" }
  | { kind: "keep" };

/** Classify one NDJSON line from Command Code `--output-format json`. */
function classifyNdjsonLine(line: string): NdjsonLineVerdict | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{") || !trimmed.includes('"type"')) return null;
  let obj: { type?: string; finalText?: unknown };
  try {
    obj = JSON.parse(trimmed) as { type?: string; finalText?: unknown };
  } catch {
    return null;
  }
  if (obj.type === "result" && typeof obj.finalText === "string") {
    return { kind: "result", finalText: obj.finalText };
  }
  if (typeof obj.type === "string" && NDJSON_DISCARD_TYPES.has(obj.type)) {
    return { kind: "discard" };
  }
  // Unrecognized type, a `result` frame without `finalText` (e.g. an error
  // subtype), tool/turn events — keep these; they may carry the only
  // diagnostic for a failed run.
  return { kind: "keep" };
}

/** Pull `finalText` from Command Code `--output-format json` NDJSON, if present. */
export function extractHeadlessJsonFinalText(text: string): string | null {
  let finalText: string | null = null;
  for (const line of text.split(/\r?\n/)) {
    const parsed = classifyNdjsonLine(line);
    if (parsed?.kind === "result") finalText = parsed.finalText;
  }
  return finalText;
}

export interface NdjsonCollector {
  /** Feed one line of stdout. */
  addLine(line: string): void;
  /** The text findings-parsing should see once the process exits. */
  finalStdout(): string;
}

/**
 * Bounded accumulator for Command Code's NDJSON event stream. Keeps only the
 * last `result` frame's `finalText`; everything else that isn't pure noise
 * (see `NDJSON_DISCARD_TYPES`) goes into a small ring-buffered tail so a
 * failed/errored run still has *some* diagnostic text, without ever holding
 * the full multi-minute event stream in memory.
 */
export function createNdjsonCollector(
  options: {
    tailMaxLines?: number;
    tailMaxBytes?: number;
    lineMaxChars?: number;
  } = {},
): NdjsonCollector {
  const tailMaxLines = options.tailMaxLines ?? 200;
  const tailMaxBytes = options.tailMaxBytes ?? 256 * 1024;
  const lineMaxChars = options.lineMaxChars ?? 4_000;

  let finalText: string | null = null;
  const tail: string[] = [];
  let tailBytes = 0;

  function pushTail(line: string): void {
    const clipped =
      line.length > lineMaxChars
        ? `${line.slice(0, lineMaxChars)}…[clipped]`
        : line;
    tail.push(clipped);
    tailBytes += clipped.length + 1;
    while (tail.length > 0 && (tailBytes > tailMaxBytes || tail.length > tailMaxLines)) {
      const dropped = tail.shift();
      if (dropped === undefined) break;
      tailBytes -= dropped.length + 1;
    }
  }

  return {
    addLine(line: string) {
      const parsed = classifyNdjsonLine(line);
      if (parsed === null) {
        pushTail(line);
        return;
      }
      if (parsed.kind === "result") {
        finalText = parsed.finalText;
        return;
      }
      if (parsed.kind === "discard") {
        return;
      }
      pushTail(line);
    },
    finalStdout() {
      return finalText ?? tail.join("\n");
    },
  };
}

/** Drop print-mode banners / NDJSON wrappers before findings parse. */
export function stripHeadlessCliBanners(text: string): string {
  const fromJson = extractHeadlessJsonFinalText(text);
  const body = fromJson ?? text;
  return body.replace(/^(?:\s*session:\s*[0-9a-f-]{8,}[^\n]*\r?\n)+/i, "");
}

/**
 * Bound how large a single undrained line can grow while its `\n` hasn't
 * arrived yet. Without this, one pathological line (e.g. Command Code's
 * `run_end` frame, which embeds the full message history) grows `buffer`
 * unbounded *before* any per-line discard logic ever runs on it.
 */
export const DEFAULT_MAX_LINE_BYTES = 8 * 1024 * 1024;

export function attachLineSplitter(
  onChunk: (chunk: string) => void,
  onLine: (line: string) => void,
  maxLineBytes: number = DEFAULT_MAX_LINE_BYTES,
): { push: (chunk: string) => void; flush: () => void } {
  let buffer = "";
  let droppedBytes = 0;
  return {
    push(chunk: string) {
      onChunk(chunk);
      buffer += chunk;
      let idx = buffer.indexOf("\n");
      while (idx !== -1) {
        let line = buffer.slice(0, idx).replace(/\r$/, "");
        buffer = buffer.slice(idx + 1);
        if (droppedBytes > 0) {
          line += `…[truncated, dropped ${droppedBytes} bytes]`;
          droppedBytes = 0;
        }
        onLine(line);
        idx = buffer.indexOf("\n");
      }
      if (buffer.length > maxLineBytes) {
        droppedBytes += buffer.length - maxLineBytes;
        buffer = buffer.slice(0, maxLineBytes);
      }
    },
    flush() {
      if (buffer.length > 0 || droppedBytes > 0) {
        let line = buffer.replace(/\r$/, "");
        if (droppedBytes > 0) {
          line += `…[truncated, dropped ${droppedBytes} bytes]`;
        }
        onLine(line);
        buffer = "";
        droppedBytes = 0;
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

  // Collapse large JSON blobs and skip JSON fragment lines (pretty-printed findings).
  const looksJsonHeavy =
    (trimmed.startsWith("[") || trimmed.startsWith("{")) && trimmed.length > 120;
  if (looksJsonHeavy) {
    return `  · ${prefix}: …JSON (${trimmed.length} chars)`;
  }
  if (
    /^[{}\[\],]$/.test(trimmed) ||
    /^"[^"]+"\s*:/.test(trimmed) ||
    /^…JSON\b/.test(trimmed)
  ) {
    return null;
  }

  const max = 220;
  const body =
    trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
  return `  · ${prefix}: ${body}`;
}

function formatHeadlessEventLine(line: string): string | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{") || !trimmed.includes('"type"')) return null;
  try {
    const obj = JSON.parse(trimmed) as {
      type?: string;
      subtype?: string;
      event?: { type?: string; toolName?: string; description?: string };
      error?: string;
    };
    if (obj.type === "result") {
      const extra = obj.subtype ? ` ${obj.subtype}` : "";
      return `  · cli: print-mode result${extra}`;
    }
    if (obj.type === "event") {
      const ev = obj.event;
      const name = ev?.toolName || ev?.type || "event";
      const desc = ev?.description ? ` — ${ev.description}` : "";
      const body = `${name}${desc}`;
      const clipped = body.length > 180 ? `${body.slice(0, 180)}…` : body;
      return `  · cli: ${clipped}`;
    }
  } catch {
    return null;
  }
  return null;
}

export function createCliLogBridge(
  log: ((line: string) => void) | undefined,
  command: string,
): Pick<ExecCliOptions, "onLine" | "onHeartbeat" | "onQueued"> {
  if (!log) return {};

  let emitted = 0;
  const maxLines = 40;
  let mutedNotice = false;
  let hidingFindingsJson = false;

  return {
    onLine(stream, line) {
      const trimmed = line.trim();
      if (
        !hidingFindingsJson &&
        (trimmed.startsWith("```json") ||
          (trimmed.startsWith("[") &&
            (trimmed.includes('"kind"') || trimmed === "[")))
      ) {
        hidingFindingsJson = true;
        if (emitted < maxLines) {
          emitted += 1;
          log(`  · cli: …findings JSON (hiding dump)`);
        }
        return;
      }
      if (hidingFindingsJson) {
        // Drop pretty-printed finding dumps; keep rare stderr outside JSON shape.
        if (
          stream === "stderr" &&
          !trimmed.startsWith("{") &&
          !trimmed.startsWith('"') &&
          !trimmed.startsWith("}") &&
          !trimmed.startsWith("[") &&
          !trimmed.startsWith("]") &&
          !trimmed.startsWith("```")
        ) {
          // fall through
        } else {
          return;
        }
      }
      if (emitted >= maxLines) {
        if (!mutedNotice) {
          mutedNotice = true;
          log(`  · cli: …suppressing further output (cap ${maxLines} lines)`);
        }
        return;
      }
      const eventLine = formatHeadlessEventLine(line);
      if (eventLine) {
        if (emitted < maxLines) {
          emitted += 1;
          log(eventLine);
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
          `  · … ${command} still running (${elapsed} elapsed, no CLI output for ${silentSec}s — waiting on the model)`,
        );
      } else {
        log(`  · … ${command} still running (${elapsed} elapsed)`);
      }
    },
    onQueued({ waitedSec }) {
      log(
        `  · ${command} waiting ${waitedSec}s for another ${command} process to finish (one at a time — avoids a hang)`,
      );
    },
  };
}

/** Diagnostic-only; keep the most recent bytes rather than growing forever. */
const STDERR_CAP_BYTES = 512 * 1024;

const SERIAL_CLI_NAMES = new Set(["command-code", "cmdc"]);
const cliGates = new Map<string, Promise<void>>();

function serialCliKey(command: string): string | null {
  const base = command.replace(/\\/g, "/").split("/").pop() ?? command;
  const name = base.replace(/\.(cmd|exe|bat)$/i, "").toLowerCase();
  return SERIAL_CLI_NAMES.has(name) ? name : null;
}

function withSerialCliGate<T>(
  command: string,
  work: () => Promise<T>,
  onQueued?: CliQueuedHandler,
): Promise<T> {
  const key = serialCliKey(command);
  if (!key) return work();
  const prev = cliGates.get(key) ?? Promise.resolve();
  const queuedAt = Date.now();
  const run = prev.then(() => {
    const waitedSec = Math.round((Date.now() - queuedAt) / 1000);
    if (waitedSec >= 1) onQueued?.({ command, waitedSec });
    return work();
  });
  cliGates.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

export function execCli(
  command: string,
  args: string[],
  options: ExecCliOptions = {},
): Promise<CliExecResult> {
  return withSerialCliGate(
    command,
    () => execCliOnce(command, args, options),
    options.onQueued,
  );
}

function execCliOnce(
  command: string,
  args: string[],
  options: ExecCliOptions = {},
): Promise<CliExecResult> {
  const maxBuffer = options.maxBuffer ?? 20 * 1024 * 1024;
  const timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;
  const stallTimeoutMs = options.stallTimeoutMs;
  const heartbeatMs = options.heartbeatMs ?? 20_000;
  const isWin = process.platform === "win32";
  const stdinText = options.stdin;
  const useStdin = typeof stdinText === "string";
  const stdio = [useStdin ? "pipe" : "ignore", "pipe", "pipe"] as const;
  const env = options.env
    ? { ...process.env, ...options.env }
    : process.env;

  return new Promise((resolve, reject) => {
    // Claude Code treats a piped empty stdin as "prompt incoming" (~3s then exit 1).
    // Default: close stdin (NUL). Opt into piping the query via options.stdin
    // (Claude Code + Command Code use bare `-p` + stdin so Windows cannot mangle it).
    // When shell:true on Windows, quote each arg ourselves (Node only concatenates).
    const spawnArgs = isWin ? quoteWinShellArgs(args) : args;
    const child = spawn(command, spawnArgs, {
      cwd: options.cwd,
      shell: isWin,
      windowsHide: true,
      stdio: [...stdio],
      env,
    });

    activeChildren.add(child);

    let stdout = "";
    let stderr = "";
    const ndjsonCollector = options.ndjsonEvents
      ? createNdjsonCollector()
      : null;
    let settled = false;
    const startedAt = Date.now();
    let lastActivityAt = startedAt;

    const markActivity = () => {
      lastActivityAt = Date.now();
    };

    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      killCliChild(child);
      cleanup();
      reject(error);
    };

    const cleanup = () => {
      activeChildren.delete(child);
      clearTimeout(timer);
      clearInterval(heartbeatTimer);
    };

    const timer = setTimeout(() => {
      fail(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const heartbeatTimer = setInterval(() => {
      if (settled) return;
      const silentMs = Date.now() - lastActivityAt;
      const silentSec = Math.round(silentMs / 1000);
      options.onHeartbeat?.({
        command,
        elapsedSec: Math.round((Date.now() - startedAt) / 1000),
        silentSec,
      });
      if (stallTimeoutMs !== undefined && silentMs >= stallTimeoutMs) {
        fail(
          new Error(
            `${command} stalled after ${silentSec}s with no CLI output. ` +
              `Not a GitHub permission issue — print mode started then the model never streamed.`,
          ),
        );
      }
    }, heartbeatMs);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");

    const stdoutSplit = attachLineSplitter(
      (chunk) => {
        markActivity();
        // In ndjson mode, per-line classification (below) is what bounds
        // memory — the raw stream is never appended to `stdout`.
        if (!ndjsonCollector) {
          stdout += chunk;
          if (stdout.length > maxBuffer) {
            fail(new Error(`${command} output exceeded ${maxBuffer} bytes`));
          }
        }
      },
      (line) => {
        options.onLine?.("stdout", line);
        ndjsonCollector?.addLine(line);
      },
    );

    const stderrSplit = attachLineSplitter(
      (chunk) => {
        markActivity();
        // Diagnostic-only: keep the tail rather than growing unbounded if a
        // CLI streams verbose/thinking output to stderr instead of stdout.
        stderr += chunk;
        if (stderr.length > STDERR_CAP_BYTES) {
          stderr = stderr.slice(stderr.length - STDERR_CAP_BYTES);
        }
      },
      (line) => options.onLine?.("stderr", line),
    );

    child.stdout?.on("data", (chunk: string) => stdoutSplit.push(chunk));
    child.stderr?.on("data", (chunk: string) => stderrSplit.push(chunk));

    if (useStdin) {
      child.stdin?.on("error", () => {
        /* child already closed stdin */
      });
      child.stdin?.end(stdinText);
    }

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
      const rawStdout = ndjsonCollector ? ndjsonCollector.finalStdout() : stdout;
      resolve({
        stdout: stripHeadlessCliBanners(rawStdout),
        stderr,
        code: code ?? 1,
      });
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
