# Writing rules (all specialists)

These apply to every pass. User-facing text must be easy to skim and paste.

## issueSimple

- One short sentence (~8–20 words).
- Say what goes wrong in plain English.
- Avoid thick jargon when a simple phrase works.

## reviewComment

This field is what humans paste onto GitHub. It must sound like the reviewer
**reading the code out loud**, not like a scanner report.

Write in this thought order when it fits:

1. What did I notice? (optional natural reaction — only if it feels right)
2. What question does that raise?
3. What realistic scenario could happen?
4. Why would that matter? (simple consequence)
5. What could we do differently?

Prefer that conversational walk over a compressed “Could we …?” conclusion.
Do **not** stamp every comment with “Hm… interesting.” or the same So…/Then…/Is there any way… script — that was one good example of tone, not a house template. Vary openings; many comments can just state the notice and ask plainly.

### Do

- Sound like a teammate: “I was reading this and noticed something — am I understanding this correctly?”
- Keep concrete names (`Unifonic`, timeout, SMS) and simple stakes (“costing us twice”).
- Slightly informal English is fine when it stays clear.
- Multi-sentence comments are OK when they follow the notice → scenario → ask shape.

### Don’t

- Don’t compress into abstract reviewer-ese (“classify retry-safe errors”, “unsafe failover condition”).
- Don’t upgrade casual stakes into corporate phrasing (“resulting in duplicate delivery and unnecessary provider cost”).
- Don’t shame the author (“you forgot”, “this is wrong”). “Obviously costing us twice” about the *system* is fine; “you obviously messed up” is not.
- Don’t write like a security scanner or formal finding dump.
- Don’t reuse a fixed opener on every finding.

### Style reference (tone example — invent fresh wording; do not copy verbatim)

> Looking at the Unifonic timeout path — even on timeout we fail over to the other service?
>
> Unifonic might already have sent the SMS, then we’d send again on Twilio. That’s costing us twice.
>
> Can we only failover when the service tells us the send actually failed?

### Weaker (technically fine, wrong voice)

> Could we avoid failing over on Unifonic timeouts / “accepted but no MessageID”? Those can mean the SMS already went out, so a Twilio retry would double-deliver the same OTP. Mind if we only failover on clearly pre-send failures?

“Could we…?” / “Mind if we…?” are still OK for tiny nits. Prefer the longer thought-process shape for real behavior risks.

## whyWeak / howToFix

- Keep readable. Short paragraphs or a few bullets.
- howToFix = concrete steps, not abstract advice.

## Field consistency (critical)

- howToFix, betterCode, and reviewComment must describe the **same** fix.
- If betterCode shows a new file/path (comment or import), howToFix and reviewComment must name that same path — not a vague “data/utils” while the example uses `src/data/permission-matrix.ts`.
- Prefer one concrete module path everywhere (e.g. `apps/operator/src/data/permission-matrix.ts` or `@/data/permission-matrix`), not mixed nicknames.
- Do not invent one location in prose and another in the code sample.
