# Playbook — timing, toasts, and asynchronous UI

Load this when a step depends on something appearing, disappearing, or finishing.

## Detection signals

Skeleton placeholders, spinners, a progress bar, a toast or snackbar, optimistic UI that renders a
result before the server confirms it, infinite scroll, a lazily loaded panel or image.

## Safe interaction

- Wait for the condition, not for a duration. `wait_for` with a selector or a text fragment states
  what the step is actually waiting for; `wait` states only how long you guessed.
- Wait for the spinner to leave (`"gone": true`) rather than for the content to arrive, when the
  content is what you intend to assert on. Otherwise the wait and the criterion test the same thing
  and a slow render passes both or neither.
- Optimistic UI shows success before the write lands. Re-snapshot after a reload, or wait for the
  server-confirmed state (a toast that names the saved value, a row that leaves the pending style),
  before treating a step as done.
- A toast is gone within seconds. Capture in the same op batch as the action that raised it; a
  separate invocation will usually miss it.
- Lazily loaded content below the fold does not exist in the snapshot until it is scrolled into
  view. Scroll, then re-snapshot, before asserting it is absent.

## Evidence capture

The transport settles the document before every capture, so an ordinary page needs no explicit
wait. Add `wait_for` when the thing you are capturing arrives on its own schedule — a toast, a
polled status, a chart that renders after its data.

## Useful done_when criteria

- `snapshot_contains` on the confirmed state's text, not the pending state's.
- `snapshot_not_contains` on the loading text (`"Loading"`, `"불러오는 중"`), which proves the
  capture was not taken mid-render.
- Pair `url_matches` with a content criterion. A route changes before its page finishes.

## Failure smells

A capture whose text still shows a skeleton; a criterion that passes on the optimistic state and
fails after reload; a toast assertion that passes only when the machine is slow; two consecutive
captures with identical bytes where the page was supposed to have changed.
