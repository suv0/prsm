import assert from "node:assert/strict";
import test from "node:test";
import {
  applyLogToProgress,
  initJobProgress,
  syncTracksFromResults,
  trackPercent,
} from "../apps/cli/dist/job-progress.js";

test("applyLogToProgress tracks parallel passes per agent", () => {
  const agents = ["cursor", "claude-code"];
  const progress = initJobProgress(agents);

  applyLogToProgress(progress, "Fetching PR once for 2 agent(s)…", agents);
  assert.equal(progress.sharedLabel, "Fetching pull request");

  applyLogToProgress(progress, "[cursor] Starting…", agents);
  applyLogToProgress(
    progress,
    "[cursor] ▶ pass 1/3: correctness via cursor…",
    agents,
  );
  applyLogToProgress(
    progress,
    "[claude-code] ▶ pass 2/3: nitpick via claude-code…",
    agents,
  );
  applyLogToProgress(
    progress,
    "[cursor] ✓ pass correctness done — 4 finding(s) in 135.1s",
    agents,
  );

  const cursor = progress.agents[0];
  const claude = progress.agents[1];
  assert.equal(cursor?.status, "running");
  assert.equal(
    cursor?.passes.find((p) => p.id === "correctness")?.status,
    "done",
  );
  assert.equal(cursor?.passes.find((p) => p.id === "correctness")?.findings, 4);
  assert.match(cursor?.label ?? "", /running|passes done/);
  assert.equal(
    claude?.passes.find((p) => p.id === "nitpick")?.status,
    "running",
  );
  assert.ok(trackPercent(cursor) > 30);
  assert.ok(trackPercent(cursor) < 100);
  assert.ok(trackPercent(claude) > 0);
  assert.ok(trackPercent(claude) < 50);
});

test("syncTracksFromResults marks finished agents", () => {
  const progress = initJobProgress(["cursor"]);
  applyLogToProgress(progress, "[cursor] Starting…", ["cursor"]);
  syncTracksFromResults(progress, [{ agent: "cursor", status: "ok" }]);
  assert.equal(progress.agents[0]?.status, "done");
  assert.equal(trackPercent(progress.agents[0]), 100);
});
