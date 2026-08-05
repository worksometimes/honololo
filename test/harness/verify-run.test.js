import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { verifyRun } from '../../harness/scripts/verify-run.mjs';
import {
  addTraversal, addUnapprovedKind, duplicateKind,
  fixtureWithFailedFirstAttemptAndSuccessfulSecond,
  fixtureWithHistoricalFreshFailure, fixtureWithHistoricalMissingFresh,
  fixtureWithInterruptedFirstAttemptAndSuccessfulSecond, missingStatusEvidence,
  replaceWithSymlink, tamperApprovedPlan, tamperByteCount, tamperHash, treeDigest,
  validRunFixture, writeFakePng, writeOversizeEvidence, wrongStepStatusEvidence,
} from './helpers.mjs';

const verifierScript = fileURLToPath(new URL('../../harness/scripts/verify-run.mjs', import.meta.url));

test('verifies the latest complete attempt without mutating the run', async () => {
  const runDir = await validRunFixture();
  const before = await treeDigest(runDir);
  const result = await verifyRun({ runDir });

  assert.deepEqual(Object.keys(result), [
    'ok', 'run_id', 'attempt', 'plan_sha256', 'history', 'files', 'errors',
    'requires_human_review',
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.attempt, 1);
  assert.equal(result.run_id, 'valid-run');
  assert.match(result.plan_sha256, /^sha256:[a-f0-9]{64}$/u);
  assert.deepEqual(result.files.map(({ kind }) => kind), ['url', 'snapshot']);
  assert.equal(await treeDigest(runDir), before);
});

test('rejects a schema-invalid run record', async () => {
  const runDir = await validRunFixture();
  const path = join(runDir, 'run.json');
  const run = JSON.parse(await readFile(path, 'utf8'));
  run.unapproved_field = true;
  await writeFile(path, `${JSON.stringify(run)}\n`);

  const result = await verifyRun({ runDir });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /HONOLOLO_RUN_INVALID/u);
});

test('rejects noncanonical traversal and symlinked evidence paths', async (t) => {
  for (const mutate of [addTraversal, replaceWithSymlink]) {
    await t.test(mutate.name, async () => {
      const runDir = await validRunFixture();
      await mutate(runDir);
      assert.equal((await verifyRun({ runDir })).ok, false);
    });
  }
});

test('rejects missing evidence and wrong byte or hash claims', async (t) => {
  const mutations = {
    missing: async (runDir) => rm(join(runDir, 'attempts/001/evidence/home/url.txt')),
    wrong_byte_count: tamperByteCount,
    wrong_hash: tamperHash,
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    await t.test(name, async () => {
      const runDir = await validRunFixture();
      await mutate(runDir);
      assert.equal((await verifyRun({ runDir })).ok, false);
    });
  }
});

test('rejects evidence larger than the ordinary file-size bound', async () => {
  const runDir = await validRunFixture();
  await writeOversizeEvidence(runDir);
  assert.equal((await verifyRun({ runDir })).ok, false);
});

test('rejects malformed declared PNG bytes', async () => {
  const runDir = await validRunFixture();
  await writeFakePng(runDir);
  assert.equal((await verifyRun({ runDir })).ok, false);
});

test('requires the exact approved evidence-kind set once per step', async (t) => {
  for (const mutate of [duplicateKind, addUnapprovedKind]) {
    await t.test(mutate.name, async () => {
      const runDir = await validRunFixture();
      await mutate(runDir);
      assert.equal((await verifyRun({ runDir })).ok, false);
    });
  }
});

test('binds evidence manifests to the approved plan bytes', async () => {
  const runDir = await validRunFixture();
  await tamperApprovedPlan(runDir);
  const result = await verifyRun({ runDir });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /PLAN|EVIDENCE/iu);
});

test('binds cited review evidence to verified files from the criterion step', async (t) => {
  for (const mutate of [wrongStepStatusEvidence, missingStatusEvidence]) {
    await t.test(mutate.name, async () => {
      const runDir = await validRunFixture();
      await mutate(runDir);
      assert.equal((await verifyRun({ runDir })).ok, false);
    });
  }
});

test('requires contiguous numbered attempt directories', async (t) => {
  await t.test('gap', async () => {
    const runDir = await fixtureWithInterruptedFirstAttemptAndSuccessfulSecond();
    await rename(join(runDir, 'attempts/002'), join(runDir, 'attempts/003'));
    assert.equal((await verifyRun({ runDir })).ok, false);
  });

  await t.test('unknown entry', async () => {
    const runDir = await validRunFixture();
    await writeFile(join(runDir, 'attempts/notes.txt'), 'not an attempt\n');
    assert.equal((await verifyRun({ runDir })).ok, false);
  });

  await t.test('symlinked attempt directory', async () => {
    const runDir = await validRunFixture();
    await mkdir(join(runDir, 'elsewhere'));
    await rm(join(runDir, 'attempts/001'), { recursive: true });
    await symlink(join(runDir, 'elsewhere'), join(runDir, 'attempts/001'));
    assert.equal((await verifyRun({ runDir })).ok, false);
  });
});

test('preserves interrupted and failed history and qualifies a later pass', async (t) => {
  for (const [name, fixture, expected] of [
    ['interrupted', fixtureWithInterruptedFirstAttemptAndSuccessfulSecond, 'interrupted'],
    ['failed', fixtureWithFailedFirstAttemptAndSuccessfulSecond, 'fail'],
  ]) {
    await t.test(name, async () => {
      const runDir = await fixture();
      const result = await verifyRun({ runDir });
      assert.equal(result.ok, true);
      assert.deepEqual(result.history.map(({ outcome }) => outcome), [expected, 'pass']);
      assert.equal(result.requires_human_review, true);
    });
  }
});

test('preserves historical semantic failure or missing fresh review before a later pass', async (t) => {
  for (const [name, fixture, expected] of [
    ['fresh failure', fixtureWithHistoricalFreshFailure, 'fail'],
    ['missing fresh review', fixtureWithHistoricalMissingFresh, 'needs_human'],
  ]) {
    await t.test(name, async () => {
      const result = await verifyRun({ runDir: await fixture() });
      assert.equal(result.ok, true);
      assert.deepEqual(result.history.map(({ outcome }) => outcome), [expected, 'pass']);
      assert.equal(result.requires_human_review, true);
    });
  }
});

test('selects a requested complete attempt and rejects invalid selectors', async () => {
  const runDir = await fixtureWithFailedFirstAttemptAndSuccessfulSecond();
  const selected = await verifyRun({ runDir, attempt: 2 });
  assert.equal(selected.ok, true);
  assert.equal(selected.attempt, 2);
  assert.equal((await verifyRun({ runDir, attempt: 1 })).ok, true);
  assert.equal((await verifyRun({ runDir, attempt: 0 })).ok, false);
  assert.equal((await verifyRun({ runDir, attempt: 3 })).ok, false);
});

test('direct invocation emits one JSON record with status zero or one', async (t) => {
  await t.test('verified', async () => {
    const runDir = await validRunFixture();
    const child = spawnSync(process.execPath, [verifierScript, runDir], { encoding: 'utf8' });
    assert.equal(child.status, 0);
    assert.equal(child.stderr, '');
    assert.equal(child.stdout.trim().split('\n').length, 1);
    assert.equal(JSON.parse(child.stdout).ok, true);
  });

  await t.test('rejected', async () => {
    const runDir = await validRunFixture();
    await tamperHash(runDir);
    const child = spawnSync(process.execPath, [verifierScript, runDir], { encoding: 'utf8' });
    assert.equal(child.status, 1);
    assert.equal(child.stderr, '');
    assert.equal(child.stdout.trim().split('\n').length, 1);
    assert.equal(JSON.parse(child.stdout).ok, false);
  });
});
