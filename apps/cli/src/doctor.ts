import { access } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import {
  commandExists,
  createProviderRegistry,
  listAvailableProviders,
} from "@review-os/providers";

export type DoctorCheck = {
  id: string;
  ok: boolean;
  level: "required" | "recommended";
  label: string;
  detail: string;
};

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

function runGhAuthStatus(): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    const child = spawn("gh", ["auth", "status"], {
      shell: process.platform === "win32",
      windowsHide: true,
    });
    let out = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      out += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      out += chunk;
    });
    child.on("error", () => {
      resolve({ ok: false, detail: "gh not runnable" });
    });
    child.on("close", (code) => {
      const text = out.trim().replace(/\s+/g, " ").slice(0, 180);
      resolve({
        ok: code === 0,
        detail:
          text ||
          (code === 0 ? "logged in" : "not logged in — run: gh auth login"),
      });
    });
  });
}

export async function runDoctor(options: {
  repoRoot: string;
}): Promise<{ checks: DoctorCheck[]; ok: boolean }> {
  const checks: DoctorCheck[] = [];
  const nodeMajor = Number(process.versions.node.split(".")[0] ?? 0);
  checks.push({
    id: "node",
    ok: nodeMajor >= 20,
    level: "required",
    label: `Node.js >= 20 (found ${process.versions.node})`,
    detail:
      nodeMajor >= 20
        ? "OK"
        : "Install Node 20+ from https://nodejs.org/",
  });

  const cliDist = path.join(options.repoRoot, "apps", "cli", "dist", "index.js");
  const built = await pathExists(cliDist);
  checks.push({
    id: "build",
    ok: built,
    level: "required",
    label: "Project built (apps/cli/dist)",
    detail: built ? "OK" : "Run: pnpm install && pnpm build",
  });

  const promptsOk = await pathExists(
    path.join(options.repoRoot, "prompts", "correctness.md"),
  );
  const writingOk = await pathExists(
    path.join(options.repoRoot, "rules", "writing.md"),
  );
  checks.push({
    id: "prompts",
    ok: promptsOk && writingOk,
    level: "required",
    label: "prompts/ + rules/writing.md present",
    detail:
      promptsOk && writingOk
        ? "OK"
        : "Missing specialist prompts/rules — clone may be incomplete",
  });

  const ghInstalled = await commandExists("gh");
  checks.push({
    id: "gh",
    ok: ghInstalled,
    level: "required",
    label: "GitHub CLI (gh)",
    detail: ghInstalled
      ? "found"
      : "Install from https://cli.github.com/ then: gh auth login",
  });

  if (ghInstalled) {
    const auth = await runGhAuthStatus();
    checks.push({
      id: "gh-auth",
      ok: auth.ok,
      level: "required",
      label: "gh auth login",
      detail: auth.detail,
    });
  } else {
    checks.push({
      id: "gh-auth",
      ok: false,
      level: "required",
      label: "gh auth login",
      detail: "skipped — install gh first",
    });
  }

  const agentOk = await commandExists("agent");
  const claudeOk = await commandExists("claude");
  const commandCodeOk = await commandExists("command-code");

  checks.push({
    id: "cursor",
    ok: agentOk,
    level: "recommended",
    label: "Cursor Agent CLI (agent)",
    detail: agentOk
      ? "found — use agent login or CURSOR_API_KEY if runs fail"
      : "optional — install Cursor Agent CLI for --provider cursor",
  });
  checks.push({
    id: "claude-code",
    ok: claudeOk,
    level: "recommended",
    label: "Claude Code CLI (claude)",
    detail: claudeOk
      ? "found"
      : "optional — install Claude Code for --provider claude-code",
  });
  checks.push({
    id: "command-code",
    ok: commandCodeOk,
    level: "recommended",
    label: "Command Code CLI (command-code)",
    detail: commandCodeOk
      ? "found"
      : "optional — install Command Code for --provider command-code",
  });

  const registry = createProviderRegistry();
  const available = await listAvailableProviders(registry);
  const usable = available.filter((id) =>
    ["cursor", "claude-code", "command-code", "demo"].includes(id),
  );
  const hasLive =
    usable.includes("cursor") ||
    usable.includes("claude-code") ||
    usable.includes("command-code");
  checks.push({
    id: "providers",
    ok: hasLive,
    level: "recommended",
    label: "At least one live review provider",
    detail: hasLive
      ? `available: ${usable.join(", ")}`
      : "No cursor/claude-code/command-code detected — only demo will work",
  });

  const requiredFailed = checks.some((c) => c.level === "required" && !c.ok);
  return { checks, ok: !requiredFailed };
}

export function printDoctorReport(checks: DoctorCheck[], ok: boolean): void {
  console.log("████ PRism · doctor\n");
  for (const check of checks) {
    const mark = check.ok ? "✓" : check.level === "required" ? "✗" : "!";
    const tier = check.level === "required" ? "required" : "optional";
    console.log(`${mark} [${tier}] ${check.label}`);
    console.log(`    ${check.detail}`);
  }
  console.log("");
  if (ok) {
    console.log("Ready enough to try a review:");
    console.log("  pnpm prsm --serve-ui --port 8788");
    console.log("  pnpm prsm --run <github-pr-url>");
  } else {
    console.log("Fix the ✗ required items, then re-run: pnpm prsm --doctor");
  }
}
