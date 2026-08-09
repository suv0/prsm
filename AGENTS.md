# Agents — PRism

This repo is **agent-first**. Cursor, Claude Code, and Command Code AI are the models.
Product: **PRism** · CLI: **`prsm`** (`review-pr` alias) · packages: `@review-os/*` (internal).

## Command

```text
prsm <github-pr-url>
# or
review-pr <github-pr-url>
```

## Process

Follow `.cursor/skills/review-pr/SKILL.md`.

Summary:

1. Prepare with `pnpm prsm <url>`
2. Fill `reviews/<n>/passes/*.findings.json` using `agent/*.brief.md`
3. Finalize with `pnpm prsm --finalize <n>`
4. Deliver via `pnpm prsm --serve-ui` (paste PR URL, run all 3 agents) or `pnpm prsm --serve <n>`

Or hands-off CLI: `pnpm prsm --run <url>` / `--provider command-code <url>`.

Recheck from the triage UI (provider dropdown + notes). Disk-only refresh: `pnpm prsm --render <n>`.

No API keys required for the default path (local CLI providers).
