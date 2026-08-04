# Run artifact contract

Run artifacts are append-only evidence, not scratch output. Paths are relative to the repository
root and must not contain credentials, cookies, authorization headers, or raw secret form values.

The run id is `<YYYYMMDD_HHMMSS>_<plan-id>` (the format `bin/venti-run` generates). When the
orchestrator creates the run directory before execution — for scout artifacts — it chooses the id
itself in the same format and passes it to the core with `--run-id`, so one flow lands in one
directory.

```text
runs/<YYYYMMDD_HHMMSS>_<plan-id>/
├── manifest.json
├── state.json
├── events.jsonl
├── results.jsonl
├── audit.jsonl
├── report.md
├── summary.json
├── evidence/
│   └── <item-id>/
│       ├── attempt-1/
│       │   ├── actions.jsonl
│       │   ├── execution.json
│       │   ├── page.txt
│       │   ├── url.txt
│       │   ├── screenshot.png
│       │   └── trace.zip
│       └── attempt-2/
└── agents/
    └── <task-id>/
```

## Manifest minimum

```json
{
  "run_id": "20260803_230000_example-web-smoke",
  "plan_id": "example-web-smoke",
  "plan_hash": "sha256:...",
  "target": {"url": "https://example.com", "allowed_domains": ["example.com"]},
  "execution_mode": "native_subagents|inline_degraded|standalone_deterministic",
  "channel": "browser|api|hybrid",
  "started_at": "",
  "versions": {"agent_browser": "", "browser": "", "prompt_revision": ""},
  "budgets": {"items": 1, "attempts": 2, "tool_calls": 30, "llm_calls": 0},
  "baseline_run_id": null
}
```

## Events

`events.jsonl` has one JSON object per graph transition:

```json
{"ts":"2026-08-03T23:00:00Z","run_id":"...","node":"VERIFY","item_id":"home","status":"complete","attempt":1,"artifacts":["evidence/home/attempt-1/verdict.json"]}
```

Events are never deleted or rewritten. Corrections are appended as amendments with a reference to
the original event/result.
