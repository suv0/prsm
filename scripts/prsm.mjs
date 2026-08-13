#!/usr/bin/env node
/**
 * Clone-and-go entry: install + build if needed, then run the CLI.
 * Bare `pnpm prsm` starts the hub.
 */
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "apps", "cli", "dist", "index.js");
const nodeModules = path.join(root, "node_modules");

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      stdio: "inherit",
      shell: process.platform === "win32",
      windowsHide: true,
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited ${code}`));
    });
  });
}

const args = process.argv.slice(2);

if (!(await exists(nodeModules))) {
  console.log("PRism: installing dependencies (first run)…");
  await run("pnpm", ["install"]);
}

if (!(await exists(dist))) {
  console.log("PRism: building…");
  await run("pnpm", ["build"]);
}

const passthrough = args.length === 0 ? ["--serve-ui"] : args;
const child = spawn(process.execPath, [dist, ...passthrough], {
  cwd: process.cwd(),
  stdio: "inherit",
  windowsHide: true,
});
child.on("close", (code) => {
  process.exit(code ?? 1);
});
child.on("error", (error) => {
  console.error(`prsm failed: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
