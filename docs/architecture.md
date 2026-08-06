# Architecture

HONOLOLO separates flexible agent work from deterministic trust decisions.

```text
Codex / Claude Code
  ├─ HONOLOLO Skill: intake, scout, plan review, approval, execution
  ├─ agent-browser: live browser actions and evidence capture
  ├─ seal: evidence manifest and deterministic criterion evaluation
  ├─ verifier: schema, hashes, paths, attempts, criteria
  ├─ fresh evaluator: rubric criteria only, read-only and isolated
  └─ renderer: portable QA result or screenshot manual

reference, loaded on demand
  ├─ harness/playbooks/: target-agnostic recipes, loaded when their signals appear
  └─ .honololo/targets/<host>/: one operator's local memory of one target
```

The Skill is the public interface. `harness/scripts/` are internal helpers and never browse,
request approval, recover work, or make semantic judgments.

Two reference layers sit beside the run and never inside it. Playbooks are target-agnostic and
tracked; they keep the canonical workflow short by holding the depth a run needs only sometimes.
Target memory is target-specific, personal, and local: it names a real host, so it lives under the
gitignored workspace, is never shared or exported, and is treated as where to look rather than as
evidence. A lesson crosses from memory to playbook only after every trace of the target is gone.

Clerical artifacts are derived, not written by the agent. Sealing builds the evidence manifest and
the deterministic status from captured bytes; the verifier records its own result; the renderer builds
the deliverable. What remains for the agent to author is the proposal and the approved plan — the two
places where judgment actually belongs.

## Trust boundary

One local user session owns one run. The harness defends canonical paths, schema boundaries,
immutable approved plans, evidence byte/hash integrity, append-only attempts, and isolated semantic
review. It does not implement a daemon, lock service, browser wrapper, generic Markdown parser, or
hostile concurrent-writer protocol.

## Run lifecycle

`intake → prepare → scout → propose → approve → execute → verify → review → deliver`

The approved plan bytes are immutable. Deterministic criteria are checked by the verifier. Rubric
criteria require a fresh read-only evaluator that receives only the approved plan, exact verifier
result, and verified evidence paths.

A retry allocates the next attempt and preserves every earlier outcome. It may inherit the evidence
an earlier attempt already settled — the original bytes at their original paths, re-hashed against
the digest that attempt recorded, and only for steps whose every criterion passed there — so
re-observing one drifted step costs one step rather than the whole plan. What the history disputes
is recorded per step: a step the retry calls passed while an earlier attempt disagreed is contested
and withholds its own screenshot, while the steps around it still publish.

Approval is interactive by default. A plan may instead cite a standing grant the user gave that
target for a shape of read-only work; the contract accepts that only when every step is low risk, so
a grant can never carry a step that writes, sends, or publishes.

See [harness/workflow.md](../harness/workflow.md) for the operational contract.
