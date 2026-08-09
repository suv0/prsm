import type {
  PassContext,
  Provider,
  ProviderRequest,
  ProviderResponse,
} from "@review-os/core";
import { buildReviewUserPrompt } from "./build-prompt.js";
import { parseFindingsFromModelText } from "./parse-findings.js";

function resolveAnthropicConfig(context: PassContext): {
  model: string;
  maxTokens: number;
} {
  const cfg = context.config.providers.anthropic;
  return {
    model: cfg?.model ?? "claude-sonnet-4-20250514",
    maxTokens: cfg?.maxTokens ?? 8192,
  };
}

export class AnthropicProvider implements Provider {
  readonly id = "anthropic";

  constructor(private readonly apiKey = process.env.ANTHROPIC_API_KEY ?? "") {}

  isConfigured(): boolean {
    return Boolean(this.apiKey);
  }

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    if (!this.apiKey) {
      throw new Error(
        "ANTHROPIC_API_KEY is not set. Export it, or use --demo / --load-only.",
      );
    }

    const { model, maxTokens } = resolveAnthropicConfig(request.context);
    const userPrompt = buildReviewUserPrompt(request);

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        max_tokens: maxTokens,
        temperature: 0.1,
        system:
          "You are a strict specialist code reviewer in the PRism pipeline. Return only valid JSON arrays of findings.",
        messages: [{ role: "user", content: userPrompt }],
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Anthropic API ${response.status}: ${body}`);
    }

    const data = (await response.json()) as {
      content?: Array<{ type: string; text?: string }>;
    };
    const rawText = (data.content ?? [])
      .filter((block) => block.type === "text" && block.text)
      .map((block) => block.text ?? "")
      .join("\n");

    const findings = parseFindingsFromModelText(rawText, {
      passId: request.passId,
      provider: this.id,
    });

    return {
      provider: this.id,
      rawText,
      findings,
    };
  }
}
