# Venti role prompts

These role files are the portable source of truth for Claude Code, Codex, and any other agent
runtime. `.claude/agents/` contains thin Claude Code entry points that load the same contracts.

The roles are deliberately narrow. The coordinator owns the graph, the frozen plan, approval
gates, budgets, and the final verdict. Workers write detailed artifacts and return references;
they do not pass work through a long chat transcript.

## Roles

| Role | Owns | Must not do |
|---|---|---|
| `scout` | Surface discovery, state map, locator candidates, risk map | Execute destructive actions or invent expected behavior |
| `planner` | Test selection, plan compilation, expectation contract, budgets | Start a run or weaken an assertion to make it pass |
| `runner` | Exact actions and evidence capture | Judge product correctness or modify the plan |
| `verifier` | Deterministic checks and rubric-based judgment | Hide missing evidence or infer success from vibes |
| `healer` | One bounded locator recovery proposal | Heal assertions, skip steps, or click risky controls |
| `auditor` | False-pass challenge, self-heal review, spot checks | Re-run the whole suite or rewrite history |
| `reporter` | Human-readable report and regression comparison | State hypotheses as facts |
| `curator` | Durable target knowledge updates | Store secrets, stale refs, or unverified guesses |

Every role file follows the same shape — Mission, You receive, Read first, Procedure, hard
limits, Output with a filled example — so a runtime can load any role the same way. All workers
use the dispatch and return envelopes specified in `docs/contracts/subagent-contract.md`; the
orchestration procedure that dispatches them is `.claude/skills/mini-venti/SKILL.md`.
