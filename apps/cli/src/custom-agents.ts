import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  assertSafeCliCommand,
  RESERVED_PROVIDER_IDS,
  slugAgentId,
  type CliAgentSpec,
  type PromptStyle,
} from "@review-os/providers";

const FILE_NAME = "custom-agents.json";

export function prsmHomeDir(): string {
  const override = process.env.PRSM_HOME?.trim();
  if (override) return path.resolve(override);
  return path.join(os.homedir(), ".prsm");
}

export function customAgentsPath(): string {
  return path.join(prsmHomeDir(), FILE_NAME);
}

export type SavedCustomAgent = CliAgentSpec & {
  name: string;
};

function parseExtraFlags(raw: string): string[] {
  const flags = raw
    .trim()
    .split(/\s+/)
    .map((flag) => flag.trim())
    .filter(Boolean);
  for (const flag of flags) {
    if (/[|&;<>$`"'()]/.test(flag)) {
      throw new Error(`Unsafe extra flag: ${flag}`);
    }
  }
  return flags;
}

export async function loadCustomAgents(): Promise<SavedCustomAgent[]> {
  try {
    const raw = JSON.parse(await readFile(customAgentsPath(), "utf8")) as {
      agents?: SavedCustomAgent[];
    };
    if (!Array.isArray(raw.agents)) return [];
    return raw.agents.filter(
      (agent) =>
        agent &&
        typeof agent.id === "string" &&
        typeof agent.command === "string" &&
        !RESERVED_PROVIDER_IDS.has(agent.id),
    );
  } catch {
    return [];
  }
}

async function writeCustomAgents(agents: SavedCustomAgent[]): Promise<void> {
  const dir = path.dirname(customAgentsPath());
  await mkdir(dir, { recursive: true });
  await writeFile(
    customAgentsPath(),
    `${JSON.stringify({ agents }, null, 2)}\n`,
    "utf8",
  );
}

export async function addCustomAgent(input: {
  name: string;
  command: string;
  extraFlags?: string;
  promptStyle?: PromptStyle;
}): Promise<SavedCustomAgent> {
  const name = input.name.trim();
  const command = assertSafeCliCommand(input.command);
  const id = slugAgentId(name || command);
  if (!id) throw new Error("Give the agent a name (letters/numbers)");
  if (RESERVED_PROVIDER_IDS.has(id)) {
    throw new Error(`“${id}” is a built-in PRism agent — pick another name`);
  }
  const extraArgs = parseExtraFlags(input.extraFlags ?? "");
  const promptStyle: PromptStyle =
    input.promptStyle === "trailing" ? "trailing" : "dash-p";
  const next: SavedCustomAgent = {
    id,
    name: name || command,
    command,
    extraArgs,
    promptStyle,
  };
  const existing = await loadCustomAgents();
  const without = existing.filter((agent) => agent.id !== id);
  without.push(next);
  await writeCustomAgents(without);
  return next;
}

export async function removeCustomAgent(id: string): Promise<boolean> {
  const existing = await loadCustomAgents();
  const next = existing.filter((agent) => agent.id !== id);
  if (next.length === existing.length) return false;
  await writeCustomAgents(next);
  return true;
}
