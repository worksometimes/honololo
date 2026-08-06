# Playbook — third-party content editors

Load this before any step that edits content inside a rich-text CMS, wiki, or document tool. These
rules were earned from real incidents; violating them has caused data loss and an unauthorized
publish.

## Detection signals

A `contenteditable` region, a floating format toolbar, a slash or `/` command menu, an autosave
indicator, a comment sidebar, or a Publish control sitting beside Save.

## Safe interaction

- Treat merge, publish, approve, send, and delete controls as outside every approved step unless
  the approved plan names that exact control. A recovery attempt is never authorization to touch
  them.
- Never extend a selection and delete (`Shift+End`, `Cmd+A`, drag) without first verifying the
  selection's actual extent in the rendered page. Visual lines and logical paragraphs differ in
  rich-text editors, and one wrong selection can delete most of a document.
- Verify clipboard content immediately before every paste. On a shared machine the clipboard can
  change between copy and paste.
- Do not spam undo in an unfamiliar editor. After one failed undo, stop and re-inspect: undo
  shortcuts can trigger unrelated toolbar actions, including irreversible ones.
- Insert images and blocks through the editor's explicit insert control into an empty block, never
  by pasting into or typing after an existing paragraph, and confirm the picker actually has focus
  before typing into it.

## Evidence capture

Scope the capture to the editing surface with `"within"`. Editor chrome carries the document's
history, the author's name, and comment threads, none of which the product can hide and none of
which belongs in evidence.

## Useful done_when criteria

- `snapshot_contains` on the text the edit was supposed to produce, captured after autosave settles.
- `snapshot_not_contains` on the text it was supposed to replace — an edit that only appended is a
  common silent failure.
- Never `url_matches` alone: editor routes rarely change when the document does.

## Failure smells

Autosave still pending at capture time; a toolbar state that disagrees with the rendered text; an
undo that changed something other than the last edit; a paste that produced the previous
clipboard's content.
