import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Pass, PassContext, Provider } from "@review-os/core";
import type { PassResult } from "@review-os/schemas";

async function loadPrompt(passId: string, cwd: string): Promise<string> {
  const promptPath = path.resolve(cwd, "prompts", `${passId}.md`);
  try {
    return await readFile(promptPath, "utf8");
  } catch {
    return `You are the ${passId} reviewer. Find real issues with evidence.`;
  }
}

async function loadRules(passId: string, cwd: string): Promise<string> {
  const sharedPath = path.resolve(cwd, "rules", "writing.md");
  const rulesPath = path.resolve(cwd, "rules", `${passId}.md`);
  const chunks: string[] = [];
  try {
    chunks.push(await readFile(sharedPath, "utf8"));
  } catch {
    // optional shared writing rules
  }
  try {
    chunks.push(await readFile(rulesPath, "utf8"));
  } catch {
    // optional pass rules
  }
  return chunks.filter(Boolean).join("\n\n");
}

function createPass(id: string, title: string): Pass {
  return {
    id,
    title,
    async run(context: PassContext, provider: Provider): Promise<PassResult> {
      const cwd = context.repoRoot ?? process.cwd();
      const prompt = await loadPrompt(id, cwd);
      const fileRules = await loadRules(id, cwd);
      const response = await provider.complete({
        passId: id,
        prompt,
        rules: fileRules,
        context,
      });

      return {
        passId: id,
        provider: response.provider,
        findings: response.findings,
      };
    },
  };
}

export const correctnessPass = createPass("correctness", "Correctness");
export const nitpickPass = createPass("nitpick", "Nitpick");
export const devilsAdvocatePass = createPass(
  "devils-advocate",
  "Devil's Advocate",
);

export const defaultPasses: Pass[] = [
  correctnessPass,
  nitpickPass,
  devilsAdvocatePass,
];
