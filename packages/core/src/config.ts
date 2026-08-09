import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { ConfigSchema, type AppConfig } from "@review-os/schemas";

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** Walk upward from cwd until config/default.yaml is found. */
export async function resolveDefaultConfigPath(
  startDir: string = process.cwd(),
): Promise<string> {
  let current = path.resolve(startDir);
  for (;;) {
    const candidate = path.join(current, "config", "default.yaml");
    if (await fileExists(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(
        "Could not find config/default.yaml from current directory upward.",
      );
    }
    current = parent;
  }
}

export async function loadConfig(configPath?: string): Promise<AppConfig> {
  const resolved = configPath ?? (await resolveDefaultConfigPath());
  const raw = await readFile(resolved, "utf8");
  const data: unknown = parseYaml(raw);
  return ConfigSchema.parse(data ?? {});
}
