import { GenericCliProvider, resolveCliSpec } from "./cli-agents.js";

/** Same argv as overview / recheck / verify — see BUILTIN_CLI_SPECS. */
export class CommandCodeProvider extends GenericCliProvider {
  constructor() {
    super(resolveCliSpec("command-code"));
  }
}
