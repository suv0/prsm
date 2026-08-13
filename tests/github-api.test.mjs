import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  explainGithubApiError,
  GithubApiError,
  mapGithubRestPull,
  parseGithubNextLink,
  parsePrRef,
  saveGithubToken,
  resolveGithubToken,
  clearGithubToken,
} from "../packages/github/dist/index.js";

test("parseGithubNextLink reads rel=next", () => {
  const link =
    '<https://api.github.com/repos/o/r/pulls/1/files?page=2>; rel="next", <https://api.github.com/repos/o/r/pulls/1/files?page=5>; rel="last"';
  assert.equal(
    parseGithubNextLink(link),
    "https://api.github.com/repos/o/r/pulls/1/files?page=2",
  );
  assert.equal(parseGithubNextLink(null), undefined);
});

test("mapGithubRestPull maps REST payload to LoadedPullRequest", () => {
  const ref = parsePrRef("https://github.com/acme/app/pull/9");
  const loaded = mapGithubRestPull({
    ref,
    pr: {
      number: 9,
      title: "Fix login",
      html_url: "https://github.com/acme/app/pull/9",
      additions: 4,
      deletions: 1,
      base: { ref: "main" },
      head: { ref: "fix-login" },
    },
    files: [
      {
        filename: "src/auth.ts",
        additions: 4,
        deletions: 1,
        status: "modified",
      },
    ],
    diff: "diff --git a/src/auth.ts b/src/auth.ts\n",
    diffTruncated: false,
  });
  assert.equal(loaded.number, 9);
  assert.equal(loaded.base, "main");
  assert.equal(loaded.head, "fix-login");
  assert.equal(loaded.files[0]?.path, "src/auth.ts");
  assert.equal(loaded.files[0]?.changeType, "MODIFIED");
});

test("explainGithubApiError points at hub Connect GitHub", () => {
  assert.match(
    explainGithubApiError(new GithubApiError(404, "{}", "nope"), "acme/app"),
    /Connect GitHub/,
  );
  assert.match(
    explainGithubApiError(new GithubApiError(401, "{}", "nope")),
    /invalid/i,
  );
  assert.match(
    explainGithubApiError(
      new GithubApiError(403, "API rate limit exceeded", "nope"),
    ),
    /rate limit/i,
  );
});

test("saveGithubToken persists under PRSM_HOME", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "prsm-gh-"));
  const prevHome = process.env.PRSM_HOME;
  const prevGh = process.env.GH_TOKEN;
  const prevGithub = process.env.GITHUB_TOKEN;
  process.env.PRSM_HOME = dir;
  delete process.env.GH_TOKEN;
  delete process.env.GITHUB_TOKEN;
  try {
    await saveGithubToken("ghp_testtoken");
    const raw = JSON.parse(
      await readFile(path.join(dir, "github.json"), "utf8"),
    );
    assert.equal(raw.token, "ghp_testtoken");
    const resolved = await resolveGithubToken();
    assert.equal(resolved.source, "file");
    assert.equal(resolved.token, "ghp_testtoken");
    assert.equal(await clearGithubToken(), true);
    const after = await resolveGithubToken();
    assert.equal(after.source, "none");
  } finally {
    if (prevHome === undefined) delete process.env.PRSM_HOME;
    else process.env.PRSM_HOME = prevHome;
    if (prevGh === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = prevGh;
    if (prevGithub === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = prevGithub;
  }
});
