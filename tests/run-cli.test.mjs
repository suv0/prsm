import assert from "node:assert/strict";
import test from "node:test";
import {
  attachLineSplitter,
  assertPrintModeCliOutput,
  createNdjsonCollector,
  extractHeadlessJsonFinalText,
  quoteWinShellArgs,
} from "../packages/providers/dist/run-cli.js";

test("quoteWinShellArgs wraps spaced prompts for cmd.exe", () => {
  assert.deepEqual(quoteWinShellArgs(["-p", "hello world", "--flag"]), [
    "-p",
    '"hello world"',
    "--flag",
  ]);
  assert.deepEqual(quoteWinShellArgs(['say "hi"']), ['"say ""hi"""']);
  assert.deepEqual(quoteWinShellArgs(["plain"]), ["plain"]);
});

test("assertPrintModeCliOutput rejects Claude interactive greeting", () => {
  assert.throws(
    () =>
      assertPrintModeCliOutput(
        "What would you like to work on? I don't see a request yet.",
        "claude",
      ),
    /interactive mode/i,
  );
  assert.doesNotThrow(() => assertPrintModeCliOutput("[]", "claude"));
});

test("createNdjsonCollector keeps only the last result frame's finalText", () => {
  const collector = createNdjsonCollector();
  collector.addLine(
    JSON.stringify({ type: "event", event: { type: "tool_running", toolName: "read_file" } }),
  );
  for (let i = 0; i < 2_000; i += 1) {
    collector.addLine(
      JSON.stringify({ type: "thinking_delta", text: `reasoning ${i} `.repeat(50) }),
    );
  }
  collector.addLine(
    JSON.stringify({ type: "result", subtype: "success", finalText: "[]" }),
  );
  collector.addLine(
    JSON.stringify({ type: "result", subtype: "success", finalText: '[{"file":"a.ts"}]' }),
  );
  assert.equal(collector.finalStdout(), '[{"file":"a.ts"}]');
});

test("createNdjsonCollector never grows past its bounds on 100k delta lines", () => {
  const collector = createNdjsonCollector({ tailMaxBytes: 4_096, tailMaxLines: 20 });
  for (let i = 0; i < 100_000; i += 1) {
    collector.addLine(
      JSON.stringify({ type: "thinking_delta", text: "reasoning token ".repeat(100) }),
    );
  }
  // No result frame ever arrived — this is the "process died mid-thought" case.
  assert.equal(collector.finalStdout(), "");
});

test("createNdjsonCollector keeps error/unknown frames in a bounded tail for diagnostics", () => {
  const collector = createNdjsonCollector({ tailMaxBytes: 4_096, tailMaxLines: 20 });
  for (let i = 0; i < 5_000; i += 1) {
    collector.addLine(
      JSON.stringify({ type: "thinking_delta", text: "reasoning token ".repeat(100) }),
    );
  }
  collector.addLine(
    JSON.stringify({ type: "result", subtype: "error_max_turns", error: "hit max turns" }),
  );
  const out = collector.finalStdout();
  assert.match(out, /error_max_turns/);
  assert.ok(out.length < 8_192, `tail should stay bounded, got ${out.length} bytes`);
});

test("createNdjsonCollector falls back to a bounded tail of non-JSON lines (e.g. a session banner)", () => {
  const collector = createNdjsonCollector();
  collector.addLine("session: f91c3f00-0c34-40e7-b012-ad0abfdf011f");
  collector.addLine('[{"kind":"issue","file":"a.ts"}]');
  assert.equal(
    collector.finalStdout(),
    'session: f91c3f00-0c34-40e7-b012-ad0abfdf011f\n[{"kind":"issue","file":"a.ts"}]',
  );
});

test("extractHeadlessJsonFinalText keeps the last result frame amid discard-type noise", () => {
  const lines = [
    JSON.stringify({ type: "thinking_delta", text: "…".repeat(1_000) }),
    JSON.stringify({ type: "text_delta", text: "…".repeat(1_000) }),
    JSON.stringify({ type: "message_update", message: {} }),
    JSON.stringify({ type: "run_end", messages: new Array(500).fill("history") }),
    JSON.stringify({ type: "result", finalText: "[]" }),
    JSON.stringify({ type: "result", finalText: '["final"]' }),
  ];
  assert.equal(extractHeadlessJsonFinalText(lines.join("\n")), '["final"]');
});

test("attachLineSplitter bounds an undrained line and marks it truncated", () => {
  const lines = [];
  const splitter = attachLineSplitter(() => {}, (line) => lines.push(line), 1_000);

  // One giant "line" (a stand-in for Command Code's run_end frame) split
  // across many small chunks, none of which contain a newline.
  const chunk = "a".repeat(100);
  for (let i = 0; i < 500; i += 1) {
    splitter.push(chunk);
  }
  splitter.push("\n");
  splitter.push("next line\n");

  assert.equal(lines.length, 2);
  assert.match(lines[0], /^a+…\[truncated, dropped \d+ bytes\]$/);
  assert.ok(lines[0].length < 1_200, `line should stay near the cap, got ${lines[0].length}`);
  assert.equal(lines[1], "next line");
});

test("attachLineSplitter passes short lines through unchanged", () => {
  const lines = [];
  const splitter = attachLineSplitter(() => {}, (line) => lines.push(line));
  splitter.push("hello\nworld\n");
  splitter.flush();
  assert.deepEqual(lines, ["hello", "world"]);
});
