# Architecture

HONOLOLO separates flexible agent work from deterministic trust decisions.

```text
Codex / Claude Code
  ├─ HONOLOLO Skill: intake, scout, approval, execution
  ├─ agent-browser: live browser actions and evidence capture
  ├─ verifier: schema, hashes, paths, attempts, criteria
  ├─ fresh evaluator: rubric criteria only, read-only and isolated
  └─ renderer: portable QA result or screenshot manual
```

The Skill is the public interface. `harness/scripts/` are internal helpers and never browse,
request approval, recover work, or make semantic judgments.

## Trust boundary

One local user session owns one run. The harness defends canonical paths, schema boundaries,
immutable approved plans, evidence byte/hash integrity, append-only attempts, and isolated semantic
review. It does not implement a daemon, lock service, browser wrapper, generic Markdown parser, or
hostile concurrent-writer protocol.

## Run lifecycle

`intake → prepare → scout → propose → approve → execute → verify → review → deliver`

The approved plan bytes are immutable. A retry allocates the next attempt and preserves every
earlier outcome. Deterministic criteria are checked by the verifier. Rubric criteria require a fresh
read-only evaluator that receives only the approved plan, exact verifier result, and verified
evidence paths.

See [harness/workflow.md](../harness/workflow.md) for the operational contract.
