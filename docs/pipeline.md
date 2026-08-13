# Pipeline

```text
Load PR (gh) → knowledge + plan → shared overview
  → agents in parallel
       each agent: 3 specialist passes in parallel (correctness, nitpick, devil’s advocate)
       each finished agent: snapshot under runs/ + rebuild merged triage
  → evidence / documented-intent / judge → render
```

Default path is **agent-first** (local CLIs, no PRism API key). Optional `--provider anthropic` uses `ANTHROPIC_API_KEY`.

## Merge

Similar findings from different agents become **one card** (`mergeAgentFindings`). Extra agents attach as views (agree / extend / dissent). Unique findings stay separate.

This rebuild happens **when each agent finishes**, not only at the end. You can open `http://127.0.0.1:8788/pr/<n>/` after the first agent.

Markdown/HTML are render-only. `findings.json` / `run.json` are the source of truth.

Hands-off: `pnpm prsm --run <url>` or the hub **Run review** button.  
Chat path: prepare → write `passes/*.findings.json` → `--finalize <n>`.
