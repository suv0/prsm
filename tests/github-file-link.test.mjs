import assert from "node:assert/strict";
import test from "node:test";
import { githubFileUrl } from "../packages/render/dist/github-file-link.js";

test("githubFileUrl builds PR changes link with diff hash and right-side lines", () => {
  const url = githubFileUrl({
    prUrl: "https://github.com/realallchrono/allchrono-monorepo/pull/41",
    head: "ACEN-47-SMS-Module",
    file: "services/backend/src/auth/auth.service.ts",
    line: 105,
    endLine: 117,
  });
  assert.equal(
    url,
    "https://github.com/realallchrono/allchrono-monorepo/pull/41/changes#diff-8af3626d87d1351472977850e8c256f5bcc430e3bf8efc5a02de3af5eddfa2f7R105-R117",
  );
});

test("githubFileUrl uses single R line when no endLine", () => {
  const url = githubFileUrl({
    prUrl: "https://github.com/acme/app/pull/7",
    file: "src/main.ts",
    line: 10,
  });
  assert.match(url ?? "", /\/pull\/7\/changes#diff-[a-f0-9]{64}R10$/);
});

test("githubFileUrl returns null without prUrl", () => {
  assert.equal(githubFileUrl({ file: "a.ts", line: 1 }), null);
});
