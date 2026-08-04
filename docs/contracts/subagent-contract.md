# Subagent contract

Venti supports native subagents in Claude Code, Codex, or another runtime, but the QA semantics do
not depend on a particular orchestration product. The coordinator passes file references and a
small task envelope; the worker writes its detailed output to the run directory.

## Dispatch envelope

```json
{
  "task_id": "scout-home-001",
  "role": "scout",
  "objective": "Map the public checkout entry points without mutating state",
  "inputs": ["sites/example.com/map.md"],
  "target": {"url": "https://example.com", "allowed_domains": ["example.com"]},
  "artifacts_dir": "runs/20260803_230000_smoke/agents/scout-home-001",
  "allowed_tools": ["agent-browser", "Read", "Write"],
  "forbidden": ["delete", "purchase", "publish"],
  "limits": {"max_tool_calls": 30, "timeout_ms": 120000},
  "return": "agents/scout.md"
}
```

## Return envelope

```json
{
  "status": "ok|blocked|needs_human|error",
  "role": "scout|planner|runner|verifier|healer|auditor|reporter|curator",
  "artifacts": ["runs/<run-id>/agents/<task-id>/scout.json"],
  "facts": ["The search form submits with Enter"],
  "open_questions": [],
  "budget": {"tool_calls": 12, "elapsed_ms": 8400},
  "next": "Planner can use the verified placeholder locator"
}
```

## Coordination rules

- The coordinator is the only owner of global status, plan revisions, stop conditions, and approval
  gates.
- Workers may append artifacts, but may not rewrite a frozen plan or another worker's history.
- Large transcripts, screenshots, and page dumps stay in files. Return paths and short facts.
- A worker that cannot proceed asks a concrete question or returns `blocked`; it must not guess.
- A completion message means the worker's assigned artifact is complete, not that the entire run
  passed.
- If no native subagent runtime exists, the coordinator can execute the same role files inline and
  must record `execution_mode: inline_degraded` in `manifest.json`.

## Graph state

Persist these fields at every node boundary so an interrupted run can resume:

```json
{
  "run_id": "",
  "node": "SCOUT|PLAN|APPROVAL|EXECUTE|VERIFY|HEAL|AUDIT|REPORT|LEARN",
  "plan_id": "",
  "plan_hash": "",
  "item_id": "",
  "attempt": 1,
  "status": "running|paused|complete|blocked|failed",
  "budget": {"tool_calls": 0, "llm_calls": 0, "elapsed_ms": 0},
  "artifacts": []
}
```
