import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { sealAttempt } from '../../harness/scripts/seal.mjs';
import { verifyRun } from '../../harness/scripts/verify-run.mjs';
import {
  addTraversal, addUnapprovedKind, duplicateKind, fixtureWithCopiedSnapshotOnlyStep,
  fixtureWithDuplicatedCapture, fixtureWithFailedFirstAttemptAndSuccessfulSecond,
  fixtureWithHistoricalFreshFailure, fixtureWithHistoricalMissingFresh,
  fixtureWithInheritedRetry, fixtureWithInterruptedFirstAttemptAndSuccessfulSecond,
  fixtureWithSharedSnapshotDistinctScreenshots, missingStatusEvidence, refreshEvidenceOnly,
  replaceWithSymlink, reviewedQaFixture, sealableFixture, tamperApprovedPlan, tamperByteCount,
  tamperHash, treeDigest, validRunFixture, writeFakePng, writeOversizeEvidence,
  wrongStepStatusEvidence,
} from './helpers.mjs';

const verifierScript = fileURLToPath(new URL('../../harness/scripts/verify-run.mjs', import.meta.url));

test('verifies the latest complete attempt without mutating the run', async () => {
  const runDir = await validRunFixture();
  const before = await treeDigest(runDir);
  const result = await verifyRun({ runDir });

  assert.deepEqual(Object.keys(result), [
    'ok', 'run_id', 'attempt', 'plan_sha256', 'approval_mode', 'history', 'files', 'amendments',
    'duplicate_captures', 'inherited_steps', 'contested_steps', 'errors', 'requires_human_review',
  ]);
  assert.equal(result.approval_mode, 'interactive');
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

test('binds the approved plan to the proposal it was approved from', async () => {
  const runDir = await validRunFixture();
  await writeFile(join(runDir, 'plan/proposal.md'), '# Rewritten after approval\n');
  const result = await verifyRun({ runDir });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /HONOLOLO_PROPOSAL_SHA256_INVALID/u);
});

test('rejects a deterministic pass the captured evidence does not support', async () => {
  const runDir = await validRunFixture();
  await writeFile(join(runDir, 'attempts/001/evidence/home/snapshot.md'), '# Home\n\nLoading\n');
  await refreshEvidenceOnly(runDir);
  const result = await verifyRun({ runDir });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /HONOLOLO_STATUS_VERDICT_UNSUPPORTED: home-ready/u);
});

test('rejects a deterministic criterion the status never reports', async () => {
  const runDir = await validRunFixture();
  const path = join(runDir, 'attempts/001/status.json');
  const status = JSON.parse(await readFile(path, 'utf8'));
  status.criteria = status.criteria.filter(({ id }) => id !== 'home-ready');
  await writeFile(path, `${JSON.stringify(status)}\n`);
  const result = await verifyRun({ runDir });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /HONOLOLO_STATUS_CRITERION_MISSING: home-ready/u);
});

test('reports a step whose snapshot and screenshot both repeat another step', async () => {
  const runDir = await fixtureWithDuplicatedCapture();
  const result = await verifyRun({ runDir });
  assert.equal(result.ok, true);
  assert.deepEqual(result.duplicate_captures.map(({ steps }) => steps), [['home', 'copy']]);
  assert.equal(result.requires_human_review, true);
});

test('records its own exact result bytes once per stage', async () => {
  const runDir = await validRunFixture();
  const record = join(runDir, 'attempts/001/verifier.initial.json');
  const first = spawnSync(
    process.execPath, [verifierScript, runDir, '--write', 'initial'], { encoding: 'utf8' },
  );
  assert.equal(first.status, 0);
  assert.equal(await readFile(record, 'utf8'), first.stdout);
  assert.equal(JSON.parse(await readFile(record, 'utf8')).ok, true);

  const second = spawnSync(
    process.execPath, [verifierScript, runDir, '--write', 'initial'], { encoding: 'utf8' },
  );
  assert.equal(second.status, 1);
  assert.match(second.stderr, /HONOLOLO_VERIFIER_RECORD_EXISTS/u);
  assert.equal(await readFile(record, 'utf8'), first.stdout);
});

test('rejects an unknown write stage and skips recording an unresolvable attempt', async () => {
  const runDir = await validRunFixture();
  const bad = spawnSync(
    process.execPath, [verifierScript, runDir, '--write', 'middle'], { encoding: 'utf8' },
  );
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /HONOLOLO_VERIFY_USAGE/u);

  await rm(join(runDir, 'run.json'));
  const skipped = spawnSync(
    process.execPath, [verifierScript, runDir, '--write', 'final'], { encoding: 'utf8' },
  );
  assert.equal(skipped.status, 1);
  assert.match(skipped.stderr, /HONOLOLO_VERIFIER_RECORD_SKIPPED/u);
});

test('reports a missing proposal with a harness code, not a filesystem path', async () => {
  const runDir = await validRunFixture();
  await rm(join(runDir, 'plan/proposal.md'));
  const result = await verifyRun({ runDir });
  assert.equal(result.ok, false);
  const errors = result.errors.join('\n');
  assert.match(errors, /HONOLOLO_PROPOSAL_MISSING: plan\/proposal\.md/u);
  assert.doesNotMatch(errors, /ENOENT/u);
  assert.equal(errors.includes(runDir), false);
});

test('rejects a deterministic failure recorded as merely unresolved', async () => {
  const runDir = await validRunFixture();
  await writeFile(join(runDir, 'attempts/001/evidence/home/snapshot.md'), '# Home\n\nLoading\n');
  await refreshEvidenceOnly(runDir);
  const path = join(runDir, 'attempts/001/status.json');
  const status = JSON.parse(await readFile(path, 'utf8'));
  status.criteria.find(({ id }) => id === 'home-ready').verdict = 'needs_human';
  status.outcome = 'needs_human';
  await writeFile(path, `${JSON.stringify(status)}\n`);

  const result = await verifyRun({ runDir });
  assert.equal(result.ok, false);
  assert.match(
    result.errors.join('\n'),
    /HONOLOLO_STATUS_VERDICT_UNSUPPORTED: home-ready: claimed needs_human, evidence supports fail/u,
  );
});

test('reports a copied capture even when the steps have no screenshots', async () => {
  const runDir = await fixtureWithCopiedSnapshotOnlyStep();
  const result = await verifyRun({ runDir });
  assert.equal(result.ok, true);
  assert.deepEqual(result.duplicate_captures.map(({ steps }) => steps), [['home', 'copy']]);
  assert.equal(result.requires_human_review, true);
});

test('leaves a shared snapshot alone when the screenshots differ', async () => {
  const runDir = await fixtureWithSharedSnapshotDistinctScreenshots();
  const result = await verifyRun({ runDir });
  assert.equal(result.ok, true);
  assert.deepEqual(result.duplicate_captures, []);
  assert.equal(result.requires_human_review, false);
});

test('a rejected verification never consumes the attempt record slot', async () => {
  const runDir = await sealableFixture();
  const record = join(runDir, 'attempts/001/verifier.initial.json');
  const premature = spawnSync(
    process.execPath, [verifierScript, runDir, '--attempt', '1', '--write', 'initial'],
    { encoding: 'utf8' },
  );
  assert.equal(premature.status, 1);
  assert.equal(JSON.parse(premature.stdout).ok, false);
  assert.match(premature.stderr, /HONOLOLO_VERIFIER_RECORD_SKIPPED/u);
  await assert.rejects(readFile(record), /ENOENT/u);

  await sealAttempt({ runDir, attempt: 1 });
  const sealed = spawnSync(
    process.execPath, [verifierScript, runDir, '--attempt', '1', '--write', 'initial'],
    { encoding: 'utf8' },
  );
  assert.equal(sealed.status, 0);
  assert.equal(sealed.stderr, '');
  assert.equal(await readFile(record, 'utf8'), sealed.stdout);
});

test('records a final result after a fresh review is added', async () => {
  const runDir = await reviewedQaFixture();
  const final = spawnSync(
    process.execPath, [verifierScript, runDir, '--attempt', '1', '--write', 'final'],
    { encoding: 'utf8' },
  );
  assert.equal(final.status, 0);
  assert.equal(final.stderr, '');
  const record = JSON.parse(
    await readFile(join(runDir, 'attempts/001/verifier.final.json'), 'utf8'),
  );
  assert.equal(record.ok, true);
  assert.deepEqual(record.history, [{ attempt: 1, outcome: 'pass' }]);
});

test('verifies a retry whose settled steps carry earlier evidence forward', async () => {
  const runDir = await fixtureWithInheritedRetry();
  const result = await verifyRun({ runDir, attempt: 2 });

  assert.equal(result.ok, true, result.errors.join('; '));
  assert.deepEqual(result.inherited_steps, [{ step_id: 'home', from: 1 }]);
  assert.deepEqual(result.history, [
    { attempt: 1, outcome: 'needs_human' }, { attempt: 2, outcome: 'pass' },
  ]);
});

// The point of a retry is that the steps it did not need to touch stay publishable. Only the step
// whose earlier verdict the retry overturns is contested.
test('contests only the step whose history disagrees with the retry', async () => {
  const runDir = await fixtureWithInheritedRetry();
  const result = await verifyRun({ runDir, attempt: 2 });

  assert.deepEqual(result.contested_steps, ['settings']);
  assert.equal(result.requires_human_review, true);
});

test('rejects evidence claimed as inherited from the attempt itself or a later one', async () => {
  const runDir = await fixtureWithInheritedRetry();
  const manifestPath = join(runDir, 'attempts/002/evidence.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  manifest.steps.find(({ id }) => id === 'home').inherited_from = 2;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const result = await verifyRun({ runDir, attempt: 2 });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('; '), /HONOLOLO_EVIDENCE_INHERIT_INVALID/u);
});

test('rejects inherited evidence pointing outside its own step directory', async () => {
  const runDir = await fixtureWithInheritedRetry();
  const manifestPath = join(runDir, 'attempts/002/evidence.json');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  const home = manifest.steps.find(({ id }) => id === 'home');
  home.files[0].path = 'attempts/001/evidence/settings/url.txt';
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const result = await verifyRun({ runDir, attempt: 2 });
  assert.equal(result.ok, false);
  assert.match(result.errors.join('; '), /HONOLOLO_EVIDENCE_SCOPE_INVALID/u);
});

// A standing grant is what makes a low-risk walk a one-sentence delegation. It authorises a shape
// of work in advance, so the contract has to refuse it the moment the work stops being that shape.
test('a standing grant covers only a plan of low-risk steps', async (t) => {
  const withApproval = async (mutate) => {
    const runDir = await validRunFixture();
    const planPath = join(runDir, 'plan/approved.json');
    const plan = JSON.parse(await readFile(planPath, 'utf8'));
    mutate(plan);
    await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`);
    return verifyRun({ runDir });
  };

  await t.test('accepted for low-risk steps', async () => {
    const result = await withApproval((plan) => {
      plan.approved.mode = 'standing';
      plan.approved.grant = 'connector-walk';
    });
    // The plan bytes changed, so the manifest no longer matches; the approval itself is what is
    // under test here, and it is read before any evidence is.
    assert.equal(result.approval_mode, 'standing');
    assert.equal(result.errors.join('; ').includes('HONOLOLO_PLAN_INVALID'), false);
  });

  await t.test('refused without a named grant', async () => {
    const result = await withApproval((plan) => { plan.approved.mode = 'standing'; });
    assert.match(result.errors.join('; '), /HONOLOLO_PLAN_INVALID/u);
  });

  await t.test('refused once a step carries more than low risk', async () => {
    const result = await withApproval((plan) => {
      plan.approved.mode = 'standing';
      plan.approved.grant = 'connector-walk';
      plan.steps[0].risk = 'medium';
    });
    assert.match(result.errors.join('; '), /HONOLOLO_PLAN_INVALID/u);
  });
});
