import type {
  Provider,
  ProviderRequest,
  ProviderResponse,
} from "@review-os/core";
import { parseFindingsFromModelText } from "./parse-findings.js";
import {
  buildCliReviewInstruction,
  commandExists,
  createCliLogBridge,
  execCli,
  writePassPromptFile,
} from "./run-cli.js";

/**
 * Cursor Agent CLI (`agent -p`), not the IDE chat skill path.
 * Uses ask mode so the pass stays read-only.
 */
export class CursorAgentProvider implements Provider {
  readonly id = "cursor";

  async isAvailable(): Promise<boolean> {
    return commandExists("agent");
  }

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    const outputDir = request.context.outputDir;
    if (!outputDir) {
      throw new Error("CursorAgentProvider requires context.outputDir");
    }

    const promptPath = await writePassPromptFile(request, outputDir);
    const instruction = buildCliReviewInstruction(promptPath);
    const cwd = request.context.repoRoot ?? process.cwd();
    request.context.log?.(`  · spawning agent -p (prompt ${promptPath})`);

    const result = await execCli(
      "agent",
      [
        "-p",
        instruction,
        "--output-format",
        "text",
        "--mode",
        "ask",
        "--trust",
        "--workspace",
        cwd,
      ],
      {
        cwd,
        timeoutMs: 12 * 60 * 1000,
        ...createCliLogBridge(request.context.log, "agent"),
      },
    );

    if (result.code !== 0) {
      throw new Error(
        `cursor agent failed (${result.code}):\n${result.stderr || result.stdout}`,
      );
    }

    const findings = parseFindingsFromModelText(result.stdout, {
      passId: request.passId,
      provider: this.id,
    });

    return {
      provider: this.id,
      rawText: result.stdout,
      findings,
    };
  }
}
