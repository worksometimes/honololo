# Contributing to Venti

Thanks for helping make browser QA more reproducible and safer.

## Before you open a pull request

```bash
npm ci
npm run check
npm run doctor
```

For provider changes, also run the smallest real smoke test available for that provider and include
the command and result in the pull request description. Do not commit `runs/`, screenshots, traces,
credentials, cookies, tokens, or target data.

## Design rules

- Keep the core provider-neutral and target-agnostic.
- Extend the provider protocol instead of putting vendor-specific branching in the runner.
- Keep plans immutable after execution starts; create a revision for behavior changes.
- Prefer deterministic assertions and user-facing locators.
- Preserve evidence for both passes and failures.
- Treat self-healing as review-required; never hide a product failure behind a new locator.
- Add or update a contract test when changing runner or adapter behavior.

## Pull requests

Keep each PR focused. Explain the behavior change, safety implications, compatibility impact, and
the verification performed. Documentation and example plans should be updated when the public
contract changes.
