# Playbook — writing the manual

Load this whenever the run type is `manual`.

A manual is judged as a document, by a reader who was not there. The plan's `document` block and each
step's `manual` block are where that document is written, and an approved plan that fills them with
one imperative sentence per step produces a list of clicks nobody learns from. Write them at the
quality you would accept in the product's own help centre.

- **Open with what the feature is and why someone wants it**, in `document.overview`, before any step
  tells the reader to press something. Name the problem it solves in their words.
- **Group steps into tasks** with `manual.section` — "시작하기", "처음 연결하기", "연결 관리" — so the
  document reads as a few things a person might want to do, not as a numbered run of screens.
- **Give a step its context** in `manual.intro` when the screen is not self-evident: where it lives,
  what it is for, what state the reader should already be in.
- **Break a multi-move step into `actions`**, one ordered sentence each, naming the exact control in
  bold: `Choose the **＋** button at the lower left`. Bold is the only markup manual prose may carry,
  and it exists for this. A single-move step keeps one `instruction` sentence instead.
- **Say what to look at**, not only what to press. `checkpoints` turns a dense screenshot into a
  reading: which field decides what, which list is the one that matters, which URL to verify.
- **Show one real example** in `example` where the feature is used rather than configured — the
  actual sentence a user would type, and what comes back.
- **Use `tips` for the edge a reader will hit** (an empty state, a permission that hides the menu)
  and `cautions` for what they must not get wrong. A caution that is merely a tip trains readers to
  skip both.
- **Explain states in their own words.** "다시 연결 필요" is not self-explanatory: say what caused it,
  what stops working, and how to get out of it.

Absent blocks are dropped whole, so a step with nothing to add stays short. Write in the reader's
language, and ship a run-local template under `<run-dir>/templates/` when the section labels
themselves should be in that language.
