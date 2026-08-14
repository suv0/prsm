# Agents — PRism

This repo is **agent-first**. Cursor, Claude Code, and Command Code are the models.
Product: **PRism** · CLI: **`prsm`** (`review-pr` alias) · packages: `@review-os/*` (internal).

## Easiest path (clone / other users)

```bash
pnpm install
pnpm prsm
```

Open http://127.0.0.1:8788/ → **Settings** (Connect GitHub; public PRs skip this) → agents or **Add your own agent** → **New Review** with a PR URL. AI CLIs are not vendored in this repo.

## Chat command

```text
prsm https://github.com/org/repo/pull/123
# or
review-pr https://github.com/org/repo/pull/123
```

Follow `.cursor/skills/review-pr/SKILL.md`.

Hands-off CLI: `pnpm prsm --run <url>` (available agents in parallel).

Triage lives at `http://127.0.0.1:8788/pr/<n>/` (merged). Each agent’s own findings: hub card **This agent’s findings**, or `/pr/<n>/runs/<id>/`. Disk refresh: `pnpm prsm --render <n>`.

No PRism API key for the default path. Never auto-post to GitHub.

User-facing CLI/hub changes: update `README.md` and `docs/` in the same turn.
