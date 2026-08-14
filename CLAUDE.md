# Claude Code — PRism

When the user says:

```text
prsm https://github.com/org/repo/pull/123
# or
review-pr https://github.com/org/repo/pull/123
```

follow `.cursor/skills/review-pr/SKILL.md` exactly.

**No PRism API key.** You are the reviewer. Never auto-post to GitHub.

## Preferred for most people

```bash
pnpm prsm
```

http://127.0.0.1:8788/ — Settings (Connect GitHub, agents / Add your own), New Review, Live run, then triage at `/pr/<n>/`. Each agent’s own findings: `/pr/<n>/runs/<id>/`.

Hands-off CLI: `pnpm prsm --provider claude-code <url>` or `pnpm prsm --run <url>`.

## Chat prepare path

1. `pnpm prsm <url>` — prepare
2. Write each `passes/<pass>.findings.json` from `agent/*.brief.md` (blind)
3. `pnpm prsm --finalize <n>`
4. Open http://127.0.0.1:8788/pr/<n>/ (hub is `pnpm prsm` if it isn’t running)

Triage Recheck / Teach me use the provider dropdown. Disk refresh: `pnpm prsm --render <n>`.
