import {
  createProviderRegistry,
  type CliAgentSpec,
} from "@review-os/providers";
import type { Provider } from "@review-os/core";
import { loadCustomAgents, type SavedCustomAgent } from "./custom-agents.js";

export async function createLiveRegistry(): Promise<{
  providers: Map<string, Provider>;
  customs: SavedCustomAgent[];
  extraSpecs: CliAgentSpec[];
}> {
  const customs = await loadCustomAgents();
  return {
    providers: createProviderRegistry(customs),
    customs,
    extraSpecs: customs,
  };
}
