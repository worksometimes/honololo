# Proposal — valid-run

## Scope

Observe the settled home page of the generic fixture target `https://app.example.com/`.

## Steps

1. `home` — observe the settled home page; evidence: url, snapshot.

## Criteria

- `home-url` — the observed URL is the approved target.
- `home-ready` — the snapshot shows the settled state.

## Risks

Low. No consequential control is touched and no product state changes.

## Excluded

Any navigation away from the target origin, and any product action.
