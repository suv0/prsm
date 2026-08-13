# PRism

**See every angle before you merge.**

Local, multi-agent pull request reviews — harsh analysis, polite paste-ready GitHub comments.

Point **`prsm`** at any GitHub PR URL. It fetches the diff (GitHub API — `gh` optional), runs specialist passes through local AI CLIs, and writes a triage-friendly review to disk.

**No PRism API key.** Auth lives in the agent CLIs you choose, plus an optional GitHub token for private repos.  
**Never auto-posts to GitHub** — you paste comments yourself.

> Internal workspace packages still use the `@review-os/*` codename. The product is **PRism**; the CLI is **`prsm`** (`review-pr` remains an alias).

Clone → `pnpm install` → `pnpm prsm`. The hub opens. Public PRs work with no GitHub CLI. Add agents from the UI.

What we **cannot** ship in git: Cursor / Claude / Command Code (or any other model). Those stay programs on your machine — the hub’s **Add your own agent** button is how you point PRism at them.

`pnpm demo` needs no GitHub and no model.

---

## Who it’s for

- Solo engineers who want a second (and third) set of AI eyes before merge
- Teams that want **local**, inspectable review artifacts instead of a black-box SaaS
- People already using Cursor / Claude Code / Command Code who want a repeatable PR pipeline

---

## Requirements

| Tool | Why |
|---|---|
| **Node.js 20+** | Runtime |
| **pnpm** | Workspace install / build (`corepack enable` if you don’t have it) |
| **Any one AI CLI** | Cursor `agent`, Claude Code `claude`, Command Code `command-code`, or **Add your own agent** in the hub |

GitHub CLI (`gh`) is **optional**. Public PRs use the GitHub API with no login. Private repos: hub → **Connect GitHub** (paste a token) or `gh auth login`.

Runs on **Windows, macOS, and Linux**. Not iOS — this is a Node CLI + localhost hub.

Optional: a browser (the hub tries to open one).

---

## Quick start (clone → first review)

```bash
git clone https://github.com/suv0/prsm.git
cd prsm
corepack enable          # if pnpm is missing
pnpm install
pnpm prsm
```

That last command installs/builds if needed, starts the hub, and opens **http://127.0.0.1:8788/**

1. **Connect GitHub** — skip for public PRs; paste a token for private repos  
2. **Connect agents** — Re-check a built-in, or **Add your own agent**  
3. Paste a GitHub PR URL → tick agents → **Run review**

Install **any one** agent (you do not need all three):

| Agent | CLI | Install | Login |
|---|---|---|---|
| Cursor Agent | `agent` | https://cursor.com/docs/cli/overview | `agent login` or `CURSOR_API_KEY` |
| Claude Code | `claude` | https://docs.anthropic.com/en/docs/claude-code | Claude Code / Anthropic login |
| Command Code | `command-code` | https://commandcode.ai/ | Command Code onboarding |
| Anything else | whatever is on PATH | hub → **Add your own agent** | that CLI’s login |

Custom CLIs and GitHub tokens are saved in `~/.prsm/` on this machine only.

Smoke test with no AI CLIs:

```bash
pnpm demo
```

---

## What a run does

- **Agents run in parallel.** Built-in CLIs and any you added in the hub start together.
- **Each agent’s 3 specialist passes also run in parallel** (correctness, nitpick, devil’s advocate).
- **Wall clock ≈ the slowest agent**, not “3 agents × 3 passes in a line.” Often ~5–15 minutes per agent if the model is slow; one fast agent can finish much sooner.
- **Merge is incremental.** When the first agent finishes, triage is already usable. Later agents fold in: similar findings become **one card** with extra agent views (agree / extend / dissent), not duplicates.
- Live **per-agent progress bars** and **color-coded logs**. Click an agent card to filter the log.
- **Force stop** / **Force stop & restart** if something stalls.

When at least one agent has merged, open:

```text
http://127.0.0.1:8788/pr/<n>/
```

or the files on disk:

```text
reviews/<n>/triage.html
reviews/<n>/final-review.html
```

`reviews/` is gitignored — PR text stays on your machine.

---

## Hub / triage

The hub (`pnpm prsm`, or `--serve-ui` / `--serve`) is the main UI:

| Page | What |
|---|---|
| `http://127.0.0.1:8788/` | Your reviews, **Connect GitHub**, **Connect agents** / **Add your own agent**, start a run |
| `http://127.0.0.1:8788/pr/<n>/` | One-finding-at-a-time triage |

On a finding you can:

- **Teach me** — deep teammate walkthrough (then **Copy lesson**)
- **Recheck** — ask a question; history stores the answer + a paste-ready GitHub comment
- **Verify author updates** — re-check after the PR author pushed or replied

Pick the agent in the dropdown (same CLIs as the review). One agent per Teach me / Recheck.

**Add your own agent** (hub home): name + command on PATH. PRism stores it in `~/.prsm/custom-agents.json` (this machine only). Tick it like the built-ins once it shows Detected.

Disk-only refresh (no model): `pnpm prsm --render <n>`.

---

## Option B — CLI one-shot

```bash
pnpm prsm --run https://github.com/org/repo/pull/123
# or a single provider:
pnpm prsm --provider cursor https://github.com/org/repo/pull/123
pnpm prsm --provider claude-code https://github.com/org/repo/pull/123
pnpm prsm --provider command-code https://github.com/org/repo/pull/123
```

`--run` uses every **available** local CLI agent in parallel.

### Option C — Chat skill (inside this repo)

```text
review-pr https://github.com/org/repo/pull/123
# or
prsm https://github.com/org/repo/pull/123
```

Follows `.cursor/skills/review-pr/SKILL.md` (prepare → specialist passes → finalize). Still no auto-post.

---

## Providers

PRism does **not** ship a model. Details: [docs/providers.md](docs/providers.md).

| Id | CLI | Auth (outside PRism) |
|---|---|---|
| `cursor` | `agent` | `agent login` or `CURSOR_API_KEY` |
| `claude-code` | `claude` | Claude Code / Anthropic login |
| `command-code` | `command-code` | Command Code login |
| *(your id)* | any CLI on PATH | hub → **Add your own agent** |
| `anthropic` | HTTP API | `ANTHROPIC_API_KEY` (optional; not the default path) |
| `demo` | fixtures | none |

`pnpm prsm --list-providers` shows what this machine can use.

---

## What you get

```text
reviews/<n>/
  final-review.md       # merged review (starts with PR overview)
  final-review.html
  triage.html           # one-finding-at-a-time queue
  findings.json
  runs/<id>-<agent>/    # per-agent snapshots
  agent/                # prompts sent to CLIs
  passes/
  knowledge/
  plan.md
  diff.patch
```

---

## Common commands

| Goal | Command |
|---|---|
| Hub UI | `pnpm prsm` (opens http://127.0.0.1:8788/) |
| Setup check | `pnpm prsm --doctor` |
| List agent CLIs | `pnpm prsm --list-providers` |
| Hands-off multi-agent | `pnpm prsm --run <url>` |
| Prepare only (briefs, no AI) | `pnpm prsm <url>` |
| Finalize after writing `passes/*.findings.json` | `pnpm prsm --finalize <n>` |
| Re-render HTML from disk | `pnpm prsm --render <n>` |
| Verify author updates | `pnpm prsm --verify <n>` |

`pnpm review-pr …` is the same CLI.

---

## Troubleshooting

| Symptom | What to try |
|---|---|
| Clone runs but **Run review** is disabled | Install + log into any one agent, **or Add your own agent**; hub → **Connect agents** → Re-check |
| Private PR 404 / GitHub errors | Hub → **Connect GitHub** (paste a `repo` token), or `gh auth login` |
| Provider missing | Install CLI; `pnpm prsm --doctor` / `--list-providers` |
| Claude “no stdin data received in 3s” | Upgrade to this PRism version (stdin is closed; prompts go via `-p`) |
| Cursor `Error: [unavailable]` | Transient Cursor API; re-run that agent, or rely on others |
| JSON / Teach me looks like raw JSON | Recheck again on current PRism (lesson is recovered from dumps) |
| “Already running” | Attach to that job, or **Force stop** then restart |
| Empty log for minutes | Heartbeats ~20s; per-agent bars show which pass is in flight |

---

## Project layout

```text
apps/cli/           # prsm CLI + hub + triage
packages/
  core/             # pipeline, finalize, merge, reverify, verify  (@review-os/core)
  providers/        # cursor / claude-code / command-code / custom CLIs
  github/           # PR fetch (GitHub API; gh optional)
  render/           # HTML / markdown / triage
  schemas/          # shared Zod types
prompts/ + rules/   # specialist pass prompts
.cursor/skills/     # agent-first chat skills
docs/               # vision, pipeline, providers
```

More: [docs/vision.md](docs/vision.md), [docs/pipeline.md](docs/pipeline.md), [docs/providers.md](docs/providers.md).

---

## License

MIT — see [LICENSE](LICENSE).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).
