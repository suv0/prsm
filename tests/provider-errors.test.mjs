import assert from "node:assert/strict";
import test from "node:test";
import {
  describeProviderFailure,
  isFatalProviderError,
} from "../packages/core/dist/provider-errors.js";

test("isFatalProviderError detects credits and quota", () => {
  assert.equal(isFatalProviderError("Error: out of credits"), true);
  assert.equal(isFatalProviderError("rate limit exceeded"), true);
  assert.equal(isFatalProviderError("402 Payment Required"), true);
  assert.equal(isFatalProviderError("model timed out after 30s"), false);
});

test("describeProviderFailure prefixes limit errors", () => {
  assert.match(describeProviderFailure("no credits left"), /provider limit/i);
  assert.equal(
    describeProviderFailure("temporary network glitch"),
    "temporary network glitch",
  );
});
