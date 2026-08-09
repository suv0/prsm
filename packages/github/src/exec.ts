import { spawn } from "node:child_process";

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export function execCommand(
  command: string,
  args: string[],
  options: { cwd?: string; maxBuffer?: number } = {},
): Promise<ExecResult> {
  const maxBuffer = options.maxBuffer ?? 20 * 1024 * 1024;

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      shell: false,
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > maxBuffer) {
        child.kill();
        if (!settled) {
          settled = true;
          reject(new Error(`${command} output exceeded ${maxBuffer} bytes`));
        }
      }
    });

    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      if (!settled) {
        settled = true;
        reject(error);
      }
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      resolve({ stdout, stderr, code: code ?? 1 });
    });
  });
}

export async function execOrThrow(
  command: string,
  args: string[],
  options: { cwd?: string; maxBuffer?: number } = {},
): Promise<string> {
  const result = await execCommand(command, args, options);
  if (result.code !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.code}):\n${result.stderr || result.stdout}`,
    );
  }
  return result.stdout;
}
