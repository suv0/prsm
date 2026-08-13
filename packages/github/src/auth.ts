import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { commandExists, execOrThrow } from "./exec.js";

export type GithubTokenSource = "env" | "file" | "none";

export function prsmHomeDir(): string {
  const override = process.env.PRSM_HOME?.trim();
  if (override) return path.resolve(override);
  return path.join(os.homedir(), ".prsm");
}

export function githubTokenPath(): string {
  return path.join(prsmHomeDir(), "github.json");
}

export async function readStoredGithubToken(): Promise<string | undefined> {
  try {
    const raw = JSON.parse(await readFile(githubTokenPath(), "utf8")) as {
      token?: unknown;
    };
    if (typeof raw.token !== "string") return undefined;
    const token = raw.token.trim();
    return token || undefined;
  } catch {
    return undefined;
  }
}

export async function saveGithubToken(token: string): Promise<void> {
  const trimmed = token.trim();
  if (!trimmed) throw new Error("Token is empty");
  if (/\s/.test(trimmed)) throw new Error("Token must be a single value (no spaces)");
  await mkdir(prsmHomeDir(), { recursive: true });
  const file = githubTokenPath();
  await writeFile(file, `${JSON.stringify({ token: trimmed }, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
}

export async function clearGithubToken(): Promise<boolean> {
  try {
    await unlink(githubTokenPath());
    return true;
  } catch {
    return false;
  }
}

export async function resolveGithubToken(): Promise<{
  token?: string;
  source: GithubTokenSource;
}> {
  const env =
    process.env.GH_TOKEN?.trim() || process.env.GITHUB_TOKEN?.trim() || "";
  if (env) return { token: env, source: "env" };
  const stored = await readStoredGithubToken();
  if (stored) return { token: stored, source: "file" };
  return { source: "none" };
}

export type GithubAccess = {
  ok: boolean;
  source: "env" | "file" | "gh" | "anonymous";
  login?: string;
  detail: string;
};

export async function fetchUserLogin(token: string): Promise<string> {
  const res = await fetch("https://api.github.com/user", {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "PRism-prsm",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(
      res.status === 401
        ? "GitHub token is invalid"
        : `GitHub /user failed (${res.status}): ${text.slice(0, 180)}`,
    );
  }
  const body = JSON.parse(text) as { login?: string };
  const login = body.login?.trim();
  if (!login) throw new Error("GitHub token worked but returned no login");
  return login;
}

async function probeGhCli(): Promise<{ ok: boolean; login?: string; detail: string }> {
  if (!(await commandExists("gh"))) {
    return { ok: false, detail: "gh not installed" };
  }
  try {
    const raw = await execOrThrow("gh", ["api", "user", "--jq", ".login"]);
    const login = raw.trim();
    if (login) return { ok: true, login, detail: `gh CLI as @${login}` };
  } catch {
    // fall through to auth status
  }
  try {
    await execOrThrow("gh", ["auth", "status"]);
    return { ok: true, detail: "gh CLI logged in" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, detail: message.slice(0, 160) };
  }
}

/** Hub / doctor: how this machine can talk to GitHub. */
export async function probeGithubAccess(): Promise<GithubAccess> {
  const resolved = await resolveGithubToken();
  if (resolved.token) {
    try {
      const login = await fetchUserLogin(resolved.token);
      return {
        ok: true,
        source: resolved.source === "env" ? "env" : "file",
        login,
        detail:
          resolved.source === "env"
            ? `GH_TOKEN / GITHUB_TOKEN as @${login}`
            : `Saved token as @${login}`,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        ok: false,
        source: resolved.source === "env" ? "env" : "file",
        detail: message,
      };
    }
  }

  const gh = await probeGhCli();
  if (gh.ok) {
    return {
      ok: true,
      source: "gh",
      ...(gh.login ? { login: gh.login } : {}),
      detail: gh.detail,
    };
  }

  return {
    ok: true,
    source: "anonymous",
    detail:
      "No token yet — public PRs still work. Private repos: paste a token in the hub.",
  };
}
