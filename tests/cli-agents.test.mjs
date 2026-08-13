import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  assertSafeCliCommand,
  buildCliArgs,
  RESERVED_PROVIDER_IDS,
  slugAgentId,
} from "../packages/providers/dist/cli-agents.js";
import {
  addCustomAgent,
  loadCustomAgents,
  removeCustomAgent,
} from "../apps/cli/dist/custom-agents.js";

test("slugAgentId lowercases and strips junk", () => {
  assert.equal(slugAgentId(" Codex CLI "), "codex-cli");
  assert.equal(slugAgentId("Gemini!!!"), "gemini");
});

test("reserved provider ids stay blocked", () => {
  for (const id of ["cursor", "claude-code", "command-code", "demo", "anthropic"]) {
    assert.equal(RESERVED_PROVIDER_IDS.has(id), true);
  }
});

test("assertSafeCliCommand rejects shell metacharacters", () => {
  assert.equal(assertSafeCliCommand("codex"), "codex");
  assert.throws(() => assertSafeCliCommand("codex&&rm"), /unsafe/i);
  assert.throws(() => assertSafeCliCommand("codex;id"), /unsafe/i);
  assert.throws(() => assertSafeCliCommand("codex --foo"), /single executable/i);
});

test("buildCliArgs dash-p vs trailing vs workspace", () => {
  assert.deepEqual(
    buildCliArgs(
      {
        id: "codex",
        command: "codex",
        extraArgs: ["--output-format", "text"],
        promptStyle: "dash-p",
      },
      "do the review",
      "/repo",
    ),
    ["-p", "do the review", "--output-format", "text"],
  );
  assert.deepEqual(
    buildCliArgs(
      {
        id: "aider",
        command: "aider",
        extraArgs: ["--yes"],
        promptStyle: "trailing",
      },
      "do the review",
      "/repo",
    ),
    ["--yes", "do the review"],
  );
  assert.deepEqual(
    buildCliArgs(
      {
        id: "cursor",
        command: "agent",
        extraArgs: ["--trust"],
        promptStyle: "dash-p",
        workspaceFlag: true,
      },
      "do the review",
      "/repo",
    ),
    ["-p", "do the review", "--trust", "--workspace", "/repo"],
  );
});

test("addCustomAgent persists under PRSM_HOME and rejects reserved names", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "prsm-custom-"));
  const prev = process.env.PRSM_HOME;
  process.env.PRSM_HOME = dir;
  try {
    const saved = await addCustomAgent({
      name: "Codex",
      command: "codex",
      extraFlags: "--output-format text",
    });
    assert.equal(saved.id, "codex");
    assert.deepEqual(saved.extraArgs, ["--output-format", "text"]);
    const listed = await loadCustomAgents();
    assert.equal(listed.length, 1);
    const raw = JSON.parse(
      await readFile(path.join(dir, "custom-agents.json"), "utf8"),
    );
    assert.equal(raw.agents[0].command, "codex");

    await assert.rejects(
      () => addCustomAgent({ name: "Cursor", command: "agent" }),
      /built-in/i,
    );
    await assert.rejects(
      () =>
        addCustomAgent({
          name: "evil",
          command: "codex",
          extraFlags: "; rm -rf /",
        }),
      /unsafe extra flag/i,
    );

    assert.equal(await removeCustomAgent("codex"), true);
    assert.equal((await loadCustomAgents()).length, 0);
  } finally {
    if (prev === undefined) delete process.env.PRSM_HOME;
    else process.env.PRSM_HOME = prev;
  }
});
