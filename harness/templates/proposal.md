# Proposal — reference shape

Structural reference for `plan/proposal.md`, the document the operator and the user write together
before anything is approved. Unlike the output templates beside it, nothing fills this one in: the
headings name sections rather than mark substitutions, and they are not required strings. Write the
proposal in the user's language, and keep it short enough to read in one screen per round.

## Goal

What this run is for, in the user's own framing, and the observable state that means it is done.

## Coverage

The heart of the document. One row per thing worth checking, ordered by what would hurt most if it
broke. A row the user strikes out moves to Excluded rather than disappearing, so the conversation
keeps its own history.

| # | Area | Why it matters | How we would check it | Evidence | Risk |
|---|------|----------------|-----------------------|----------|------|
| 1 |      |                |                       |          | low  |

`How we would check it` is an outcome, not a click script. `Evidence` is the kinds the step will
declare — `url`, `snapshot`, `screenshot`, `actions` — and a QA row usually needs no screenshot.
`Risk` is `low`, `medium`, `high`, or `critical`; anything above `low` names its confirmation gate.

## Excluded

What this run deliberately does not cover, and why — out of scope, too costly, needs data we will
not create, or the user cut it. This section is what prevents the same argument next run.

## Open decisions

Each with a recommended answer, so agreeing costs one word. Drop a decision once its answer would
no longer change what the run does.

- **<decision>** — recommend: <answer>, because <reason>.

## Budget and deliverables

Action limit, roughly how many browser round trips, what files land under `output/`, and which
attempt path they take.

## Confirmation gates

Every externally consequential action this plan would reach, stated plainly. Empty is the expected
answer for a read-only run, and an empty list is what makes a standing grant applicable.
