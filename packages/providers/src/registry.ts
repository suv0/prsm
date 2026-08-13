import type { Provider } from "@review-os/core";
import { AnthropicProvider } from "./anthropic.js";
import { ClaudeCodeProvider } from "./claude-code.js";
import {
  GenericCliProvider,
  RESERVED_PROVIDER_IDS,
  type CliAgentSpec,
} from "./cli-agents.js";
import { CommandCodeProvider } from "./command-code.js";
import { CursorAgentProvider } from "./cursor-agent.js";
import { DemoProvider } from "./demo.js";

export type ProviderId =
  | "demo"
  | "anthropic"
  | "claude-code"
  | "command-code"
  | "cursor";

const CLI_PROVIDER_ORDER: ProviderId[] = [
  "cursor",
  "claude-code",
  "command-code",
];

export function createProviderRegistry(
  extras: CliAgentSpec[] = [],
): Map<string, Provider> {
  const map = new Map<string, Provider>([
    ["demo", new DemoProvider()],
    ["anthropic", new AnthropicProvider()],
    ["claude-code", new ClaudeCodeProvider()],
    ["command-code", new CommandCodeProvider()],
    ["cursor", new CursorAgentProvider()],
  ]);
  for (const spec of extras) {
    if (!spec?.id || RESERVED_PROVIDER_IDS.has(spec.id)) continue;
    map.set(spec.id, new GenericCliProvider(spec));
  }
  return map;
}

type DetectableProvider = Provider & {
  isAvailable?: () => boolean | Promise<boolean>;
  isConfigured?: () => boolean;
};

async function providerAvailable(provider: Provider): Promise<boolean> {
  const detectable = provider as DetectableProvider;
  if (typeof detectable.isAvailable === "function") {
    return Boolean(await detectable.isAvailable());
  }
  if (typeof detectable.isConfigured === "function") {
    return Boolean(detectable.isConfigured());
  }
  return true;
}

/** Prefer Cursor Agent, then Claude Code, then Command Code, then custom CLIs. */
export async function detectDefaultCliProvider(
  registry: Map<string, Provider> = createProviderRegistry(),
): Promise<string | null> {
  for (const id of CLI_PROVIDER_ORDER) {
    const provider = registry.get(id);
    if (!provider) continue;
    if (await providerAvailable(provider)) return id;
  }
  for (const [id, provider] of registry.entries()) {
    if (id === "demo" || id === "anthropic") continue;
    if ((CLI_PROVIDER_ORDER as string[]).includes(id)) continue;
    if (await providerAvailable(provider)) return id;
  }
  return null;
}

export async function listAvailableProviders(
  registry: Map<string, Provider> = createProviderRegistry(),
): Promise<string[]> {
  const available: string[] = [];
  for (const [id, provider] of registry.entries()) {
    if (id === "demo") {
      available.push(id);
      continue;
    }
    if (await providerAvailable(provider)) available.push(id);
  }
  return available;
}
