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

export class CommandCodeProvider implements Provider {
  readonly id = "command-code";

  async isAvailable(): Promise<boolean> {
    return commandExists("command-code");
  }

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    const outputDir = request.context.outputDir;
    if (!outputDir) {
      throw new Error("CommandCodeProvider requires context.outputDir");
    }

    const promptPath = await writePassPromptFile(request, outputDir);
    const instruction = buildCliReviewInstruction(promptPath);
    const cwd = request.context.repoRoot ?? process.cwd();
    request.context.log?.(
      `  · spawning command-code -p (prompt ${promptPath})`,
    );

    const result = await execCli(
      "command-code",
      [
        "-p",
        instruction,
        "--skip-onboarding",
        "--no-session",
        "--output-format",
        "text",
      ],
      {
        cwd,
        timeoutMs: 12 * 60 * 1000,
        ...createCliLogBridge(request.context.log, "command-code"),
      },
    );

    if (result.code !== 0) {
      throw new Error(
        `command-code failed (${result.code}):\n${result.stderr || result.stdout}`,
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
