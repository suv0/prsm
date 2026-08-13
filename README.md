# PRism

**See every angle before you merge.**

Local, multi-agent pull request reviews — harsh analysis, polite paste-ready GitHub comments.

Point **`prsm`** at any GitHub PR URL. It fetches the diff with the GitHub CLI, runs specialist passes (correctness, nitpick, devil’s advocate) through local AI CLIs you already use (Cursor Agent, Claude Code, Command Code), and writes a triage-friendly review to disk.

**No PRism API key.** Auth lives in the agent CLIs you choose.  
**Never auto-posts to GitHub** — you paste comments yourself.

> Internal workspace packages still use the `@review-os/*` codename. The product is **PRism**; the CLI is **`prsm`** (`review-pr` remains an alias).

Anyone can clone this repo and run it. You still need **GitHub CLI login** plus **at least one AI agent CLI** for a real review. `pnpm demo` works with neither.

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
| **[GitHub CLI](https://cli.github.com/) (`gh`)** | Fetches PR metadata + diff (`gh auth login`) |
| **Any one AI CLI** | Cursor `agent`, Claude Code `claude`, or Command Code `command-code` |

Optional: a browser for the local hub UI.

---

## Quick start (clone → first review)

```bash
git clone https://github.com/suv0/prsm.git
cd prsm
corepack enable          # if pnpm is missing
pnpm install
pnpm build
pnpm prsm --doctor       # Node, build, gh, agent CLIs — prints install links
```

```bash
gh auth login
gh auth status
```

Install **any one** agent (you do not need all three):

| Agent | CLI | Install | Login |
|---|---|---|---|
| Cursor Agent | `agent` | https://cursor.com/docs/cli/overview | `agent login` or `CURSOR_API_KEY` |
| Claude Code | `claude` | https://docs.anthropic.com/en/docs/claude-code | Claude Code / Anthropic login |
| Command Code | `command-code` | https://commandcode.ai/ | Command Code onboarding |

Then:

```bash
pnpm prsm --serve-ui --port 8788
```

Open **http://127.0.0.1:8788/**

1. **Connect agents** — Re-check until at least one shows Detected  
2. Paste a GitHub PR URL  
3. Tick the agents you want → **Run review**

Adding a second or third agent later: install its CLI, log in, hit **Re-check**, tick the new box. No PRism config file.

Smoke test with no AI CLIs:

```bash
pnpm demo
```

---

## What a run does

- **Agents run in parallel.** Cursor, Claude Code, and Command Code start together.
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

The hub (`--serve-ui` / `--serve`) is the main UI:

| Page | What |
|---|---|
| `http://127.0.0.1:8788/` | Your reviews, Connect agents, start a run |
| `http://127.0.0.1:8788/pr/<n>/` | One-finding-at-a-time triage |

On a finding you can:

- **Teach me** — deep teammate walkthrough (then **Copy lesson**)
- **Recheck** — ask a question; history stores the answer + a paste-ready GitHub comment
- **Verify author updates** — re-check after the PR author pushed or replied

Pick the agent in the dropdown (same CLIs as the review). One agent per Teach me / Recheck.

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
| Hub UI | `pnpm prsm --serve-ui --port 8788` |
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
| Clone runs but **Run review** is disabled | Install + log into any one agent; hub → **Connect agents** → Re-check |
| `gh` / auth errors | `gh auth login`, then `gh pr view <n> --repo owner/repo` |
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
  providers/        # cursor / claude-code / command-code / …
  github/           # gh-backed PR fetch
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
