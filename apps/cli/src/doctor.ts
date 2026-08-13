import { access } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { commandExists } from "@review-os/providers";
import { AGENT_CATALOG } from "./agent-catalog.js";

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

  for (const entry of AGENT_CATALOG) {
    const found = await commandExists(entry.command);
    checks.push({
      id: entry.id,
      ok: found,
      level: "recommended",
      label: `${entry.name} (${entry.command})`,
      detail: found
        ? `found — ${entry.loginHint}`
        : `not found — install: ${entry.installUrl} then ${entry.loginHint}`,
    });
  }

  const hasLive = checks.some(
    (check) =>
      AGENT_CATALOG.some((entry) => entry.id === check.id) && check.ok,
  );
  checks.push({
    id: "providers",
    ok: hasLive,
    level: "recommended",
    label: "At least one live review agent",
    detail: hasLive
      ? `ready: ${checks
          .filter(
            (check) =>
              AGENT_CATALOG.some((entry) => entry.id === check.id) && check.ok,
          )
          .map((check) => check.id)
          .join(", ")}`
      : "No agent CLI detected — `pnpm demo` still works. Install any one CLI above, then: pnpm prsm --serve-ui",
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
    const hasLive = checks.some((c) => c.id === "providers" && c.ok);
    if (hasLive) {
      console.log("Ready to review:");
      console.log("  pnpm prsm --serve-ui --port 8788");
      console.log("  → http://127.0.0.1:8788/  (paste a PR URL, pick agents)");
    } else {
      console.log("Build + GitHub look good. You still need one AI CLI:");
      console.log("  1. Install any one agent listed above (Cursor / Claude Code / Command Code)");
      console.log("  2. Finish that product's login");
      console.log("  3. pnpm prsm --serve-ui --port 8788 → Connect agents → Re-check");
      console.log("  Smoke test without an agent: pnpm demo");
    }
  } else {
    console.log("Fix the ✗ required items, then re-run: pnpm prsm --doctor");
  }
}
