# Public release checklist

Run this checklist before the first public push:

```bash
git status --short
npm ci
npm run check
npm run doctor
npm audit --audit-level=high
git diff --check
```

Review the staged diff manually. Confirm that it contains no `.local-targets/`, `runs/`,
credentials, cookies, tokens, personal data, internal URLs, or unredacted screenshots/traces.

On GitHub:

1. Select the intended repository visibility and apply the MIT license in `LICENSE`.
2. Protect `main` and require the `CI` and `Security` checks before merging.
3. Enable private vulnerability reporting if available.
4. Enable Dependabot updates and dismiss no security alert without review.
5. Add repository topics such as `qa`, `browser-automation`, `browser-agents`, `playwright`, and
   `testing` only if they accurately describe the public project.

This checkout deliberately does not create a remote, commit, push, or rewrite existing history.
