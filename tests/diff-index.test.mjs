import assert from "node:assert/strict";
import test from "node:test";
import {
  buildDiffIndex,
  reconcileFindingLines,
} from "../packages/core/dist/diff-index.js";

const SAMPLE_DIFF = `diff --git a/services/backend/src/sms/sms-provider.factory.ts b/services/backend/src/sms/sms-provider.factory.ts
new file mode 100644
index 0000000..1111111
--- /dev/null
+++ b/services/backend/src/sms/sms-provider.factory.ts
@@ -0,0 +1,16 @@
+import { Injectable } from "@nestjs/common";
+import { MockSmsAdapter } from "./adapters/mock-sms.adapter";
+import type { SmsProvider } from "./sms-provider";
+
+@Injectable()
+export class SmsProviderFactory {
+  // TODO: replace with real provider selection
+  private readonly provider: SmsProvider = new MockSmsAdapter();
+
+  getProvider(): SmsProvider {
+    return this.provider;
+  }
+}
+
+export default SmsProviderFactory;
+
`;

test("buildDiffIndex maps new-file lines 1..N", () => {
  const index = buildDiffIndex(SAMPLE_DIFF);
  const file = index.get("services/backend/src/sms/sms-provider.factory.ts");
  assert.ok(file);
  assert.equal(file.maxLine, 16);
  assert.match(file.lines.get(8) ?? "", /MockSmsAdapter/);
});

test("reconcileFindingLines corrects hallucinated line 42 to real line", () => {
  const result = reconcileFindingLines(
    [
      {
        id: "f1",
        kind: "issue",
        file: "services/backend/src/sms/sms-provider.factory.ts",
        line: 42,
        severity: "major",
        category: "correctness",
        confidence: 0.95,
        importance: 9,
        currentCode:
          "private readonly provider: SmsProvider = new MockSmsAdapter();",
        issueSimple: "Hardcoded mock provider",
        whyWeak: "Production SMS will not send",
        howToFix: "Select provider from config",
        betterCode: "return selectProvider(config);",
        reviewComment: "Could we avoid hardcoding MockSmsAdapter?",
        evidence: [
          {
            quote: "new MockSmsAdapter()",
            file: "services/backend/src/sms/sms-provider.factory.ts",
            line: 42,
          },
        ],
        githubCommentTarget: { target: "line", reason: "single line" },
        autofixPossible: true,
        views: [],
        language: "ts",
      },
    ],
    SAMPLE_DIFF,
  );

  assert.equal(result.corrected.length, 1);
  assert.equal(result.findings[0]?.line, 8);
  assert.equal(result.findings[0]?.evidence[0]?.line, 8);
});
