# AGENTS.md — HONOLOLO

HONOLOLO is a Skill-first evidence harness for browser QA and screenshot manuals.

Before changing or operating it, read:

1. `.agents/skills/honololo/SKILL.md`;
2. `harness/workflow.md`;
3. `harness/contracts/`;
4. `harness/roles/`.

## Rules

- Keep the harness target-agnostic. New real target identity and generated work belong only below
  the gitignored `.honololo/` directory. Legacy `.yolo/`, `runs/`, and `.local-targets/` paths stay
  ignored solely to protect preexisting user data; HONOLOLO never reads or writes them.
- Never commit credentials, cookies, tokens, secret form values, personal data, raw runtime
  artifacts, or a real target hostname.
- Preserve user changes and use `apply_patch` for text edits.
- Never weaken assertions, add silent retries, rewrite an approved plan, or promote a self-healed
  interaction to an ordinary pass.
- Never hand-author `evidence.json` or `status.json`; seal the attempt instead. Never repair a fresh
  evaluator's review record — return it to the evaluator to re-emit.
- Keep deterministic criterion evaluation in `harness/lib/criteria.mjs`, used by both the sealer that
  writes a verdict and the verifier that re-derives it. One implementation, two independent readers.
- Keep Claude Code and Codex aligned through `harness/` and the portable Skill. The Claude Skill
  remains a thin compatibility entrypoint.
- Browser actions must use the target's exact allowed-domain boundary and fresh semantic references.

## Verification

```bash
npm run check
npm audit --audit-level=high
git diff --check
```
