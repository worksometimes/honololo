# Contributing

Keep changes small, target-agnostic, and evidence-first.

```bash
npm ci
npm run check
npm audit --audit-level=high
```

Do not commit `.honololo/`, screenshots from real targets, credentials, cookies, tokens, personal
data, or target-specific plans. Contract changes need focused tests. Skill changes must keep Codex
and Claude Code behavior aligned.
