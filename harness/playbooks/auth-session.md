# Playbook — authentication and sessions

Load this when the target requires a signed-in session, or when a step touches a consent, SSO, or
re-authentication screen.

## Detection signals

A login form, an identity-provider redirect, a consent screen naming scopes, a "session expired"
banner, a re-connect prompt on an integration, a popup opened by a Connect control.

## Safe interaction

- Never type a credential. Ask the operator to authenticate directly in the runtime-controlled
  browser, then continue from the signed-in tab. Credentials, cookies, tokens, and profiles are
  prohibited inputs to every contract, prompt, evidence file, review, and output.
- An identity provider is a different host. It is outside `allowed_domains` unless the run's intake
  put it there deliberately, and the transport will stop the batch rather than navigate to it. That
  stop is the correct outcome: hand the sign-in back to the operator.
- Consent screens are consequential. Granting scopes to a third party is an external consequence
  and needs product-level confirmation, whatever the runtime permission prompt says.
- A Connect control usually opens a new tab. The transport reports it as `new_tab` and keeps
  operating on the original page; re-target the next invocation at the new URL rather than assuming
  the click failed.

## Evidence capture

Signed-in chrome shows the account name, avatar, and often a workspace or organization. Scope every
capture with `"within"` to the product surface under test. If no scoped view excludes the identity,
persist nothing, record the criterion as withheld, and seal with `--needs-human`.

## Useful done_when criteria

- `snapshot_contains` on a permission or scope label the connected state displays.
- `snapshot_not_contains` on the re-connect or expired banner, which proves the session was live at
  capture time.
- Avoid asserting on the account name: it is the identity the gate exists to keep out of evidence.

## Failure smells

A capture that includes an avatar or an email; a step that passed because a stale session had not
yet been invalidated; a consent screen reached without product confirmation; a run whose evidence
would not reproduce for a different operator because it depended on one account's data.
