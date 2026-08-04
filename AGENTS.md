# AGENTS.md — Venti repository instructions

Venti is a generic, evidence-first web QA harness. Read these files before changing or operating
the harness:

1. `.claude/skills/mini-venti/SKILL.md` — the canonical English orchestration prompt;
2. `docs/architecture.md` — graph, channel, recovery, and evidence design;
3. `docs/contracts/` — plan, result, subagent, and run artifact contracts;
4. `agents/` — portable specialist role prompts.
5. `config/` — machine-readable graph topology and safety defaults.

## Working rules

- Keep the core target-agnostic. Private or environment-specific target data belongs only under
  the gitignored `.local-targets/` directory.
- Preserve user changes and never reset or discard unrelated work.
- Use `apply_patch` for repository file edits.
- Do not add credentials, cookies, tokens, raw secret form values, or personal data to plans,
  prompts, target packs, or run artifacts.
- Do not weaken assertions, add silent retries, or turn self-healed interactions into ordinary
  passes.
- A plan is immutable once a run begins; create a revision for changes.
- Verify shell syntax, JSON syntax, and relevant repository structure after edits.
- Keep Claude Code and Codex behavior aligned through the portable files in `agents/` and
  `docs/contracts/`; `.claude/agents/` should remain a thin compatibility layer.

## Safe verification

```bash
./bin/venti doctor
bash -n lib/venti.sh bin/venti
npm run check
npm run doctor
npm audit --audit-level=high
```

For browser checks, use the target's explicit allowed-domain and forbidden-action boundary.
