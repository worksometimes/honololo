# Playbook — framing and annotating screenshots

Load this for a manual run, or whenever a step's evidence must show one region rather than a whole
document.

## Framing a region

`"clip": "within"` frames the screenshot on the same element `"within"` scoped the snapshot to. It
captures the full surface and crops it using the page's own `devicePixelRatio`.

That indirection is deliberate. Playwright's own `clip` and its element screenshots both map CSS
pixels to surface pixels with a scale they infer for the browser. When a human-operated Chrome has
page zoom enabled, that inferred scale disagrees with `window.devicePixelRatio`, and every region
capture comes out shifted and mis-sized — silently, producing evidence that looks plausible but
frames the wrong pixels. A full-surface screenshot needs no such mapping, so cropping it is exact at
any zoom.

Never hand-measure a pixel rectangle from a snapshot box. Name the element and let the transport
resolve it.

## Annotating

Screenshots in a manual may be annotated for readability with the deterministic helper:

```text
node harness/scripts/annotate.mjs --input <png> --spec <json-file> --output <png> \
  [--snapshot <json-file>] [--force]
```

The spec follows `harness/contracts/annotate.schema.json`: rounded boxes, numbered badges, label
pills, neutral covers, and region blur. Prefer element geometry over hand-measured pixels — an
annotation may name a snapshot `ref` instead of a `rect`, and the helper resolves that element's box
from the `--snapshot` file. Box labels accept a `labelPosition` override when automatic placement
would collide with content.

## Cropping

```text
node harness/scripts/crop.mjs --input <png> --rect <x,y,w,h> --output <png> [--force]
```

Crop writes a `<output>.crop.json` offset sidecar. Annotate then translates ref-resolved boxes —
and, with `"coordinate_space": "source"`, manual coordinates — into the cropped frame automatically.

## The gate still comes first

Annotate only a capture that already passed the pre-persistence gate. Covers and blur are
presentation, never a substitute for that gate or for masking secrets through the product UI: the
bytes under a cover are still in the file.

Persist the annotated file as the step's screenshot evidence and keep the raw capture out of
`attempts/`, or skip annotation entirely. Two files for one declared kind is what sealing refuses.
