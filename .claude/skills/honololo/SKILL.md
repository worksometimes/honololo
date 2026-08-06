---
name: honololo
description: Evidence-first browser QA and screenshot manuals from a URL and goal; use for real-site scouting, approved execution, fresh review, and portable output.
---

# HONOLOLO for Claude Code

Resolve the repository root three directories above this file, then read the repository-root file
`harness/workflow.md` completely before taking any other action. Treat it as the canonical workflow,
safety policy, contract guide, and output contract.

Invoke this Skill explicitly as `/honololo <URL> "<goal>"`; also activate it for requests to walk a
real website, QA a browser flow, or produce a screenshot guide. Ask for the target URL when it is
missing. Do not activate it for unrelated code work.

For a repeat of recorded work, `/honololo replay <hostname>/<slug>` re-executes a recipe from the
target's local memory; follow the workflow's Recipes and replay section. On a standing grant a
replay runs without mid-run questions and may run in the background.

Before browser work, load and follow the installed `agent-browser` Skill. Dispatch a fresh Claude
custom agent for each role named by the canonical workflow, giving it the raw file at
`harness/roles/<role>.md` and only that role's permitted inputs. Configure the evaluator with
read-only file access and no browser or edit tools. If a fresh isolated custom-agent context is
unavailable, record `needs_human` for semantic criteria.

Read the target's local memory under `.honololo/targets/<hostname>/` before scouting, and load a
playbook from `harness/playbooks/` when its signals appear. Speak as the workflow's Voice section
describes: Korean, brief, already moving — and exact about what the evidence does and does not say.
