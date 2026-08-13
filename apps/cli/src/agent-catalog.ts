import { commandExists } from "@review-os/providers";
import { loadCustomAgents } from "./custom-agents.js";

export type AgentCatalogEntry = {
  id: string;
  name: string;
  command: string;
  summary: string;
  installUrl?: string;
  docsUrl?: string;
  setupSteps: string[];
  loginHint: string;
  custom?: boolean;
};

/** First-party agents PRism knows how to detect and guide users through. */
export const AGENT_CATALOG: AgentCatalogEntry[] = [
  {
    id: "cursor",
    name: "Cursor Agent",
    command: "agent",
    summary: "Cursor’s local agent CLI — strong for code edits & review.",
    installUrl: "https://cursor.com/docs/cli/overview",
    docsUrl: "https://cursor.com/docs",
    setupSteps: [
      "Install the Cursor Agent CLI (`agent`) from Cursor docs",
      "Run `agent login` (or set CURSOR_API_KEY)",
      "Confirm with `agent --help`",
    ],
    loginHint: "agent login",
  },
  {
    id: "claude-code",
    name: "Claude Code",
    command: "claude",
    summary: "Anthropic’s Claude Code CLI for terminal agent work.",
    installUrl: "https://docs.anthropic.com/en/docs/claude-code",
    setupSteps: [
      "Install Claude Code (`claude`) from Anthropic docs",
      "Complete Claude Code login / Anthropic auth",
      "Confirm with `claude --help`",
    ],
    loginHint: "Open Claude Code and finish login",
  },
  {
    id: "command-code",
    name: "Command Code",
    command: "command-code",
    summary: "Command Code local agent CLI.",
    installUrl: "https://commandcode.ai/",
    setupSteps: [
      "Install Command Code (`command-code`)",
      "Complete its onboarding / login",
      "Confirm with `command-code --help`",
    ],
    loginHint: "command-code (finish onboarding if prompted)",
  },
];

export type AgentStatus = AgentCatalogEntry & {
  available: boolean;
};

export async function detectAgentStatuses(): Promise<{
  agents: AgentStatus[];
  readyCount: number;
  readyIds: string[];
}> {
  const agents: AgentStatus[] = [];
  for (const entry of AGENT_CATALOG) {
    const available = await commandExists(entry.command);
    agents.push({ ...entry, available });
  }
  const customs = await loadCustomAgents();
  for (const custom of customs) {
    const available = await commandExists(custom.command);
    const extra =
      custom.extraArgs.length > 0 ? ` ${custom.extraArgs.join(" ")}` : "";
    const promptHint =
      custom.promptStyle === "trailing" ? "prompt as last arg" : "-p <prompt>";
    agents.push({
      id: custom.id,
      name: custom.name,
      command: custom.command,
      summary: `Your CLI (${promptHint}${extra ? `; extra:${extra}` : ""}). Saved on this machine.`,
      setupSteps: available
        ? []
        : [
            `Put “${custom.command}” on your PATH (or re-add with a full path)`,
            "Hit Re-check",
          ],
      loginHint: "Log in however that CLI expects",
      custom: true,
      available,
    });
  }
  const readyIds = agents.filter((a) => a.available).map((a) => a.id);
  return {
    agents,
    readyCount: readyIds.length,
    readyIds,
  };
}
