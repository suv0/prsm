import assert from "node:assert/strict";
import test from "node:test";
import { applyDocumentedIntent } from "../packages/core/dist/documented-intent.js";

const DIFF = `diff --git a/services/backend/src/sms/sms-provider.factory.ts b/services/backend/src/sms/sms-provider.factory.ts
new file mode 100644
index 0000000..1111111
--- /dev/null
+++ b/services/backend/src/sms/sms-provider.factory.ts
@@ -0,0 +1,10 @@
+import { Injectable } from "@nestjs/common";
+import { MockSmsAdapter } from "./adapters/mock-sms.adapter";
+import { SmsProvider } from "./sms-provider.interface";
+
+@Injectable()
+export class SmsProviderFactory {
+  // Chosen here rather than by configuration: there is one adapter, and a
+  // real one (Unifonic) needs delivery credentials before it can be selected.
+  private readonly provider: SmsProvider = new MockSmsAdapter();
+}
`;

const COURIER_DIFF = `diff --git a/services/backend/src/sms/sms.controller.ts b/services/backend/src/sms/sms.controller.ts
new file mode 100644
index 0000000..2222222
--- /dev/null
+++ b/services/backend/src/sms/sms.controller.ts
@@ -0,0 +1,40 @@
+import { Body, Controller, Logger, Post } from "@nestjs/common";
+
+@Controller("sms")
+export class SmsController {
+  private readonly logger = new Logger(SmsController.name);
+
+  async send(@Body() payload: Record<string, unknown>) {
+    // The whole payload, so a template change is visible rather than silently
+    // dropped. Safe only because delivery is mocked and no number is reachable.
+    this.logger.log(\`[sms] courier payload: \${JSON.stringify(payload)}\`);
+  }
+}
`;

function baseFinding(overrides = {}) {
  return {
    id: "x",
    kind: "issue",
    file: "services/backend/src/sms/sms-provider.factory.ts",
    line: 9,
    severity: "major",
    category: "correctness",
    confidence: 0.95,
    importance: 9,
    currentCode:
      "private readonly provider: SmsProvider = new MockSmsAdapter();",
    issueSimple: "Hardcoded mock SMS provider",
    whyWeak: "Production OTPs will not send",
    howToFix: "Select provider from config",
    betterCode: "return selectProvider(config);",
    reviewComment: "Could we avoid hardcoding MockSmsAdapter here?",
    evidence: [],
    githubCommentTarget: { target: "line", reason: "single line" },
    autofixPossible: true,
    views: [],
    language: "ts",
    ...overrides,
  };
}

test("demotes major finding when nearby comment documents intent", () => {
  const result = applyDocumentedIntent([baseFinding()], DIFF);

  assert.equal(result.demoted.length, 1);
  assert.equal(result.findings[0]?.severity, "suggestion");
  assert.equal(result.findings[0]?.category, "documented-debt");
  assert.match(result.findings[0]?.reviewComment ?? "", /follow-up/i);
});

test("demotes courier OTP logging when comment says safe only because mocked", () => {
  const result = applyDocumentedIntent(
    [
      baseFinding({
        id: "courier-log",
        file: "services/backend/src/sms/sms.controller.ts",
        line: 10,
        category: "security",
        currentCode:
          "this.logger.log(`[sms] courier payload: ${JSON.stringify(payload)}`);",
        issueSimple:
          "The courier endpoint logs the entire unvalidated payload, including phone numbers and OTP bodies.",
        whyWeak: "OTP becomes searchable in logs",
        howToFix: "Redact body",
        betterCode: "this.logger.log({ to: mask(to) });",
        reviewComment: "Can we avoid logging the raw courier payload here?",
      }),
    ],
    COURIER_DIFF,
  );

  assert.equal(result.demoted.length, 1);
  assert.equal(result.findings[0]?.severity, "suggestion");
  assert.equal(result.findings[0]?.category, "documented-debt");
  assert.match(result.findings[0]?.issueSimple ?? "", /Documented tradeoff/i);
});

test("demotes from finding evidence quote even without nearby diff hit", () => {
  const result = applyDocumentedIntent(
    [
      baseFinding({
        id: "via-evidence",
        file: "services/backend/src/sms/sms.controller.ts",
        line: 999,
        evidence: [
          {
            quote:
              "Safe only because delivery is mocked and no number is reachable.",
            file: "services/backend/src/sms/sms.controller.ts",
            line: 9,
          },
        ],
      }),
    ],
    "", // no diff — evidence alone should be enough
  );

  assert.equal(result.demoted.length, 1);
  assert.equal(result.findings[0]?.severity, "suggestion");
});
