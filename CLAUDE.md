# CLAUDE.md — Venti

Use `AGENTS.md` as the repository-wide contract. The canonical QA workflow is
`.claude/skills/mini-venti/SKILL.md`; the portable specialist prompts are in `agents/`.

When asked to QA a site, follow the graph:

```text
intake → scout → plan → approval → freeze → execute → verify → audit → report → learn
```

Use Claude subagents from `.claude/agents/` only within their narrow roles. Default execution is
the deterministic core (`./bin/venti-run run <plan> --run-id <run-id>`); agent-driven execution is
only for items the plan schema cannot express. Keep detailed work in run artifacts, preserve the
frozen plan, require evidence for passes, and mark locator recovery as `pass_needs_review` until
audited. Do not perform destructive or externally visible actions without an explicit plan and
immediate user approval.

Before changing the repository, run `npm run check` and `npm run validate`; keep provider-specific
runtime dependencies optional and preserve the public contracts in `schemas/` and `docs/contracts/`.
