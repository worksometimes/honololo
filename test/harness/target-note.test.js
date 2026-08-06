import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { rejectSensitive } from '../../harness/lib/sensitive.mjs';
import { appendNote } from '../../harness/scripts/target-note.mjs';

const noteScript = fileURLToPath(new URL('../../harness/scripts/target-note.mjs', import.meta.url));
const workspace = () => mkdtemp(join(tmpdir(), 'honololo-memory-'));

test('accumulates a target journal only under the gitignored local workspace', async () => {
  const root = await workspace();
  const written = await appendNote({
    root, host: 'app.example.com', kind: 'navigation',
    note: 'Connectors live under Tools, not Settings.', at: '2026-08-06',
  });

  assert.equal(written.path, '.honololo/targets/app.example.com/profile.md');
  const profile = await readFile(join(root, written.path), 'utf8');
  assert.equal(profile, '- 2026-08-06 (navigation) Connectors live under Tools, not Settings.\n');
});

test('appends rather than rewrites, so an earlier lesson cannot be edited away', async () => {
  const root = await workspace();
  const shared = { root, host: 'app.example.com', kind: 'hazard', at: '2026-08-06' };
  await appendNote({ ...shared, note: 'The publish control sits beside Save.' });
  await appendNote({ ...shared, kind: 'timing', note: 'Toasts clear after about two seconds.' });

  const profile = await readFile(join(root, '.honololo/targets/app.example.com/profile.md'), 'utf8');
  assert.deepEqual(profile.trimEnd().split('\n'), [
    '- 2026-08-06 (hazard) The publish control sits beside Save.',
    '- 2026-08-06 (timing) Toasts clear after about two seconds.',
  ]);
});

test('indexes a finished run separately from the profile', async () => {
  const root = await workspace();
  const written = await appendNote({
    root, host: 'app.example.com', run: 'connector-manual', outcome: 'needs_human',
    note: 'Screenshot manual for the connector flow.', at: '2026-08-06',
  });

  assert.equal(written.path, '.honololo/targets/app.example.com/runs.md');
  const index = await readFile(join(root, written.path), 'utf8');
  assert.match(index, /\(connector-manual needs_human\) Screenshot manual/u);
  await assert.rejects(
    stat(join(root, '.honololo/targets/app.example.com/profile.md')), /ENOENT/u,
  );
});

test('refuses a note carrying a credential or a personal identifier', async (t) => {
  const refused = {
    labelled_value: 'Sign in with token: aB3dE5gH7jK9mN1p',
    bearer: 'Send Bearer abcdef0123456789ABCDEF in the header.',
    jwt: 'Session cookie holds eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.sig',
    api_key: 'The seeded account uses sk-abcdefghijklmnopqrstuvwxyz.',
    email: 'Ask kyle.example@team.example.com to grant access.',
    hex_blob: `Workspace id ${'a'.repeat(32)} is the shared one.`,
  };
  for (const [name, note] of Object.entries(refused)) {
    await t.test(name, async () => {
      await assert.rejects(
        appendNote({ root: await workspace(), host: 'app.example.com', kind: 'auth', note }),
        /HONOLOLO_TARGET_NOTE_SENSITIVE/u,
      );
    });
  }
});

// Refusing the topic instead of the value would teach the operator to stop writing notes, which
// costs more than it protects.
test('keeps a note that names a credential concept without carrying one', () => {
  for (const note of [
    'Google SSO; the session token expires after about an hour.',
    'The API key field is masked once saved, so it cannot be re-read.',
    '토큰 만료 시 재연결 배너가 상단에 뜬다.',
  ]) {
    assert.equal(rejectSensitive(note), null, note);
  }
});

test('refuses a host that is not a hostname', async () => {
  for (const host of ['../escape', 'app.example.com/admin', '', 'APP.example.com']) {
    await assert.rejects(
      appendNote({ root: await workspace(), host, kind: 'lesson', note: 'ok' }),
      /HONOLOLO_TARGET_HOST_INVALID/u,
    );
  }
});

test('refuses an unknown journal kind and an unknown run outcome', async () => {
  const root = await workspace();
  await assert.rejects(
    appendNote({ root, host: 'app.example.com', kind: 'gossip', note: 'ok' }),
    /HONOLOLO_TARGET_KIND_INVALID/u,
  );
  await assert.rejects(
    appendNote({ root, host: 'app.example.com', run: 'r1', outcome: 'great', note: 'ok' }),
    /HONOLOLO_TARGET_OUTCOME_INVALID/u,
  );
});

test('direct invocation reports the written path and refuses unknown flags', async () => {
  const root = await workspace();
  const child = spawnSync(process.execPath, [
    noteScript, '--root', root, '--host', 'app.example.com',
    '--kind', 'glossary', '--note', 'The product calls a connector a "도구".',
  ], { encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(
    JSON.parse(child.stdout).path, '.honololo/targets/app.example.com/profile.md',
  );

  const rejected = spawnSync(process.execPath, [
    noteScript, '--root', root, '--host', 'app.example.com', '--publish', 'yes',
  ], { encoding: 'utf8' });
  assert.equal(rejected.status, 1);
  assert.match(rejected.stderr, /HONOLOLO_TARGET_USAGE/u);
});
