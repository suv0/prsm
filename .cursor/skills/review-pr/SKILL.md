---
name: review-pr
description: >
  Run the PRism PR review pipeline end-to-end without API keys. Use when the
  user says prsm / review-pr, reviews a GitHub pull request URL, or asks to prepare
  paste-ready GitHub review comments for a PR/branch.
---

# PRism / review-pr (agent-first)

You are the model. **No API key.** Cursor / Claude / Command Code runs the specialist passes.

## Trigger examples

- `prsm https://github.com/org/repo/pull/123`
- `review-pr https://github.com/org/repo/pull/123`
- `review-pr owner/repo#123`

## Workflow (do all of this)

Prefer doing the specialist passes yourself in-chat (no API key).  
Optional CLI shortcut if the user wants hands-off: `pnpm prsm --run <url>` (uses `agent` / `claude` / `command-code` locally).

### 1) Prepare — or use the UI

**UI (recommended for multi-agent):**

```bash
pnpm prsm
```

Open http://127.0.0.1:8788/ → paste the PR URL → Run review (available agents in **parallel**; specialist passes also parallel).

When the first agent finishes, triage at `/pr/<n>/` is already usable. Later agents merge onto the same cards. Each agent’s own snapshot: `/pr/<n>/runs/<id>/`.

**CLI prepare only:**

```bash
pnpm build
pnpm prsm <pr-url-or-ref>
```

This writes `reviews/<n>/` with knowledge, plan, diff, and `agent/*.brief.md`.

### 2) Run specialist passes (blind)

For each `reviews/<n>/agent/<pass>.brief.md` listed in `agent/README.md`:

1. Read that brief, matching `prompts/<pass>.md` + `rules/<pass>.md`
2. Read `knowledge/*` and relevant hunks from `diff.patch` (prefer code files)
3. Do **not** read other `passes/*.findings.json` while writing this pass
4. Write `reviews/<n>/passes/<pass>.findings.json` as a **JSON array**

Finding object fields:

- `kind`: `issue` | `question` | `praise`
- `file`, `line`, optional `endLine`
- `severity`, `category`, `confidence` (0-1), `importance` (1-10)
- `currentCode`, `issueSimple`, `whyWeak`, `howToFix`, `betterCode`
- `reviewComment` (polite paste-ready GitHub comment)
- `evidence`: `[{ "quote", "file?", "line?" }]`
- `language`, `githubCommentTarget`: `{ "target": "line"|"summary", "reason" }`

Rules:

- Harsh analysis, polite `reviewComment`
- No invented issues — if unsure, `kind: "question"`
- Include real `currentCode` and evidence quotes from the diff
- **Line numbers must come from the PR diff head side only.** New file `+1,16` ⇒ lines 1–16. Never guess.
- If the line is unclear, use `githubCommentTarget.target: "summary"` instead of inventing a number
- **Documented intent:** if comments/docs explain why code is temporary/intentional, prefer `severity: suggestion` + `category: documented-debt` (follow-up reminder), not a gotcha blocker. Acknowledge the reasoning.

Default passes: `correctness`, `nitpick`, `devils-advocate`.

### 3) Finalize (versioned — never overwrites prior agents)

```bash
pnpm prsm --finalize <n> --agent <your-agent-name>
```

Examples: `--agent cursor`, `--agent claude-code`, `--agent command-code`.

This evidence-filters, dedupes, judges, and:

- Snapshots this agent under `reviews/<n>/runs/<timestamp>-<agent>/` (immutable)
- Clears working `passes/` for the next agent (copies kept inside that run)
- Rebuilds the **merged** top-level view:
  - `reviews/<n>/final-review.md`
  - `reviews/<n>/final-review.html`
  - `reviews/<n>/triage.html` (one finding at a time)
  - `reviews/<n>/agents-index.json`

Similar findings from different agents are **one card** with an **Agent perspectives** section (agree / extend / dissent). Nothing is lost — open any `runs/<id>/final-review.html` for that agent alone.

To migrate an older unversioned review without re-running passes:

```bash
pnpm prsm --rebuild-merge <n>
```

### 4) Stop and report

Tell the user to open triage via:

```bash
pnpm prsm
```

→ `http://127.0.0.1:8788/pr/<n>/` (hub **Home** lists every local review). Recheck / Teach me need the hub. Static `reviews/<n>/triage.html` is view-only. Do **not** post comments to GitHub.

## Triage Recheck (live, one finding)

With the hub running, **Recheck** / **Teach me**:

1. Sends notes + that finding to the **provider in the dropdown**
2. Provider returns a recheck object (`understood`, `conclusion`, `teachMe` / `teachMeLines`, `suggestedComment`, optional `finding`)
3. Server appends Recheck history, re-renders, does **not** auto-overwrite the paste box unless the user applies it

Paste comments should sound like a teammate (concrete scenario + ask), not a compressed “Could we…?” scanner line, and not a fixed “Hm… interesting.” opener.

Manual disk refresh without recheck: `pnpm prsm --render <n>`.

## Output quality bar

Each finding card must be dummy-friendly and copy-paste ready:

- file + line
- current code
- simple issue
- why weak
- how to fix
- better code
- paste comment (**super short** — prefer 1–3 sentences)
