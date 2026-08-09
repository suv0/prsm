# Pipeline

```text
Load → Knowledge → Planner → Blind specialists → Enrich → Evidence → Judge → Render → Stop
```

```text
prepare (CLI) → agent specialist passes (Cursor/Claude/Command Code)
  → finalize (evidence + dedupe + judge) → reviews/<n>/final-review.md
```

Default path is **agent-first** (no API key). Optional `--api` uses Anthropic.

Markdown is render-only. `findings.json` / `run.json` are the source of truth.
