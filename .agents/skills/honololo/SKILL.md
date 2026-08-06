---
name: honololo
description: Evidence-first browser QA and screenshot manuals from a URL and goal; use for real-site scouting, approved execution, fresh review, and portable output.
---

# HONOLOLO for Codex

Resolve the repository root three directories above this file, then read the repository-root file
`harness/workflow.md` completely before taking any other action. Treat it as the canonical workflow,
safety policy, contract guide, and output contract.

Invoke this Skill explicitly as `$honololo <URL> "<goal>"`; also activate it for requests to walk a
real website, QA a browser flow, or produce a screenshot guide. Ask for the target URL when it is
missing. Do not activate it for unrelated code work.

Before browser work, load and follow the installed `agent-browser` Skill. When the canonical
workflow calls for a scout or evaluator, start a fresh Codex subagent with no inherited conversation
and pass the raw role path plus only the inputs that role permits. Give `harness/roles/evaluator.md`
read-only access and no browser or edit tools. If fresh isolated delegation is unavailable, record
`needs_human` for semantic criteria.

Read the target's local memory under `.honololo/targets/<hostname>/` before scouting, and load a
playbook from `harness/playbooks/` when its signals appear. Speak as the workflow's Voice section
describes: Korean, brief, already moving — and exact about what the evidence does and does not say.
