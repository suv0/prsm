# Claude Code — PRism

When the user says:

```text
prsm https://github.com/org/repo/pull/123
# or
review-pr https://github.com/org/repo/pull/123
```

follow `.cursor/skills/review-pr/SKILL.md` exactly.

**No API key.** You are the reviewer.

1. `pnpm prsm <url>` — prepare
2. Write each `passes/<pass>.findings.json` from `agent/*.brief.md` (blind)
3. `pnpm prsm --finalize <n>`
4. Stop. Point to `pnpm prsm --serve <n>` → http://127.0.0.1:8787/. Never auto-post to GitHub.

Optional hands-off CLI (uses local Claude Code binary):  
`pnpm prsm --provider claude-code <url>`

Triage Recheck runs through `--serve` (provider dropdown). Disk refresh only: `pnpm prsm --render <n>`.
