import { GenericCliProvider, resolveCliSpec } from "./cli-agents.js";

/** Same argv as overview / recheck / verify — see BUILTIN_CLI_SPECS. */
export class ClaudeCodeProvider extends GenericCliProvider {
  constructor() {
    super(resolveCliSpec("claude-code"));
  }
}
