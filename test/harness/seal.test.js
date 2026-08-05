import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { evaluateCriterion, snapshotHaystack, weakerThanEvidence } from '../../harness/lib/criteria.mjs';
import { sealAttempt } from '../../harness/scripts/seal.mjs';
import { verifyRun } from '../../harness/scripts/verify-run.mjs';
import { sealableFixture } from './helpers.mjs';

const sealScript = fileURLToPath(new URL('../../harness/scripts/seal.mjs', import.meta.url));

function stepOf(files) {
  return {
    id: 'home',
    files: new Map(files.map((file) => [file.kind, {
      size: file.bytes.length, ...file, bytes: Buffer.from(file.bytes),
    }])),
  };
}

test('snapshot criteria search visible text only, never structural JSON keys', () => {
  const file = {
    kind: 'snapshot',
    bytes: Buffer.from(JSON.stringify({
      url: 'https://app.example.com/', title: 'Home', text: 'Ready',
      elements: [{ ref: 'e1', role: 'combobox', name: 'Account' }],
    })),
  };
  const haystack = snapshotHaystack(file);
  assert.equal(haystack.includes('Account'), true);
  assert.equal(haystack.includes('app.example.com'), false);
  assert.equal(haystack.includes('Ready'), true);
  assert.equal(haystack.includes('combobox'), false);
  assert.equal(haystack.includes('elements'), false);
});

test('falls back to raw bytes for a non-JSON snapshot', () => {
  const file = { kind: 'snapshot', bytes: Buffer.from('# Home\n\nReady\n') };
  assert.equal(snapshotHaystack(file).includes('Ready'), true);
});

test('evaluates each deterministic criterion type from evidence bytes', () => {
  const step = stepOf([
    { kind: 'url', path: 'e/url.txt', bytes: Buffer.from('https://app.example.com/settings\n') },
    { kind: 'snapshot', path: 'e/snapshot.md', bytes: Buffer.from('# Settings\n\nReady\n') },
    { kind: 'screenshot', path: 'e/screen.png', bytes: Buffer.from('89504e470d0a1a0a', 'hex') },
  ]);
  const verdict = (criterion) => evaluateCriterion(criterion, step).verdict;

  assert.equal(verdict({ id: 'a', type: 'url_matches', value: '/settings' }), 'pass');
  assert.equal(verdict({ id: 'b', type: 'url_matches', value: '/billing' }), 'fail');
  assert.equal(verdict({ id: 'c', type: 'snapshot_contains', value: 'Ready' }), 'pass');
  assert.equal(verdict({ id: 'd', type: 'snapshot_contains', value: 'Absent' }), 'fail');
  assert.equal(verdict({ id: 'e', type: 'snapshot_not_contains', value: 'Absent' }), 'pass');
  assert.equal(verdict({ id: 'f', type: 'snapshot_not_contains', value: 'Ready' }), 'fail');
  assert.equal(verdict({ id: 'g', type: 'file_exists', value: 'snapshot.md' }), 'pass');
  assert.equal(verdict({ id: 'h', type: 'file_exists', value: 'absent.md' }), 'fail');
  assert.equal(verdict({ id: 'i', type: 'image_exists', value: 'screen.png' }), 'pass');
  assert.equal(verdict({ id: 'j', type: 'image_exists', value: 'e/screen.png' }), 'pass');
});

test('reads the observed URL from a snapshot when no url evidence exists', () => {
  const step = stepOf([{
    kind: 'snapshot', path: 'e/snapshot.json',
    bytes: Buffer.from(JSON.stringify({ url: 'https://app.example.com/settings', text: '' })),
  }]);
  const record = evaluateCriterion({ id: 'a', type: 'url_matches', value: '/settings' }, step);
  assert.equal(record.verdict, 'pass');
  assert.deepEqual(record.evidence, ['e/snapshot.json']);
});

test('withholds rather than guesses when the required evidence kind is absent', () => {
  const step = stepOf([
    { kind: 'actions', path: 'e/actions.json', bytes: Buffer.from('[]') },
  ]);
  assert.equal(
    evaluateCriterion({ id: 'a', type: 'snapshot_contains', value: 'Ready' }, step).verdict,
    'needs_human',
  );
});

test('criterion reasons never quote captured page content', () => {
  const step = stepOf([
    { kind: 'url', path: 'e/url.txt', bytes: Buffer.from('https://app.example.com/?token=s3cret') },
  ]);
  const record = evaluateCriterion({ id: 'a', type: 'url_matches', value: '/?token' }, step);
  assert.equal(record.verdict, 'pass');
  assert.equal(record.reason.includes('s3cret'), false);
});

test('a claim weaker than the evidence is rejected; a more conservative one is allowed', () => {
  assert.equal(weakerThanEvidence('pass', 'fail'), true);
  assert.equal(weakerThanEvidence('pass', 'needs_human'), true);
  assert.equal(weakerThanEvidence('needs_human', 'fail'), true);
  assert.equal(weakerThanEvidence('pass', 'pass'), false);
  assert.equal(weakerThanEvidence('needs_human', 'pass'), false);
  assert.equal(weakerThanEvidence('fail', 'pass'), false);
  assert.equal(weakerThanEvidence('fail', 'needs_human'), false);
});

test('a snapshot criterion cannot be satisfied by the URL the executor chose', () => {
  const step = stepOf([{
    kind: 'snapshot', path: 'e/snapshot.json',
    bytes: Buffer.from(JSON.stringify({
      url: 'https://app.example.com/?note=Payment%20complete',
      title: 'Home', text: 'No results', elements: [],
    })),
  }]);
  assert.equal(
    evaluateCriterion({ id: 'a', type: 'snapshot_contains', value: 'Payment complete' }, step).verdict,
    'fail',
  );
  assert.equal(
    evaluateCriterion({ id: 'b', type: 'snapshot_contains', value: 'No results' }, step).verdict,
    'pass',
  );
});

test('seals captured evidence into a manifest and a graded status', async () => {
  const runDir = await sealableFixture();
  const { evidence, status } = await sealAttempt({ runDir, attempt: 1 });

  assert.equal(evidence.steps.length, 1);
  assert.deepEqual(evidence.steps[0].files.map(({ kind }) => kind).sort(), ['snapshot', 'url']);
  for (const file of evidence.steps[0].files) {
    assert.match(file.sha256, /^sha256:[a-f0-9]{64}$/u);
    assert.equal(file.bytes > 0, true);
  }
  assert.equal(status.source, 'deterministic');
  assert.equal(status.outcome, 'pass');
  assert.deepEqual(status.criteria.map(({ verdict }) => verdict), ['pass', 'pass']);
  assert.equal((await verifyRun({ runDir })).ok, true);
});

test('seal records a failing criterion instead of an optimistic pass', async () => {
  const runDir = await sealableFixture();
  await writeFile(
    join(runDir, 'attempts/001/evidence/home/snapshot.md'), '# Home\n\nStill loading\n',
  );
  const { status } = await sealAttempt({ runDir, attempt: 1 });
  assert.equal(status.outcome, 'fail');
  assert.equal(status.criteria.find(({ id }) => id === 'home-ready').verdict, 'fail');
  assert.equal((await verifyRun({ runDir })).ok, true);
});

test('seal accepts an operator downgrade for a criterion the gate withheld', async () => {
  const runDir = await sealableFixture();
  const { status } = await sealAttempt({
    runDir, attempt: 1, withheld: new Map([['home-ready', 'personal data was visible']]),
  });
  const criterion = status.criteria.find(({ id }) => id === 'home-ready');
  assert.equal(criterion.verdict, 'needs_human');
  assert.match(criterion.reason, /withheld by operator: personal data was visible/u);
  assert.equal(status.outcome, 'needs_human');
  assert.equal((await verifyRun({ runDir })).ok, true);
});

test('seal refuses unknown files, missing steps, and a second seal', async (t) => {
  await t.test('unknown evidence file name', async () => {
    const runDir = await sealableFixture();
    await writeFile(join(runDir, 'attempts/001/evidence/home/notes.txt'), 'stray\n');
    await assert.rejects(
      () => sealAttempt({ runDir, attempt: 1 }), /HONOLOLO_SEAL_FILE_UNKNOWN/u,
    );
  });

  await t.test('missing declared evidence kind', async () => {
    const runDir = await sealableFixture();
    await rm(join(runDir, 'attempts/001/evidence/home/url.txt'));
    await assert.rejects(
      () => sealAttempt({ runDir, attempt: 1 }), /HONOLOLO_SEAL_KIND_MISSING/u,
    );
  });

  await t.test('step with no evidence directory', async () => {
    const runDir = await sealableFixture();
    await rm(join(runDir, 'attempts/001/evidence/home'), { recursive: true });
    await assert.rejects(
      () => sealAttempt({ runDir, attempt: 1 }), /HONOLOLO_SEAL_STEP_MISSING/u,
    );
  });

  await t.test('resealing never replaces a sealed manifest', async () => {
    const runDir = await sealableFixture();
    await sealAttempt({ runDir, attempt: 1 });
    const before = await readFile(join(runDir, 'attempts/001/evidence.json'));
    await assert.rejects(() => sealAttempt({ runDir, attempt: 1 }), /EEXIST/u);
    assert.deepEqual(await readFile(join(runDir, 'attempts/001/evidence.json')), before);
  });
});

test('seal rejects a screenshot that does not match its paired snapshot', async () => {
  const runDir = await sealableFixture();
  const directory = join(runDir, 'attempts/001/evidence/home');
  const planPath = join(runDir, 'plan/approved.json');
  const plan = JSON.parse(await readFile(planPath, 'utf8'));
  plan.steps[0].evidence.push('screenshot');
  await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`);
  await writeFile(join(directory, 'screenshot.png'), Buffer.from('89504e470d0a1a0a', 'hex'));
  await rm(join(directory, 'snapshot.md'));
  await writeFile(join(directory, 'screenshot.snapshot.json'), `${JSON.stringify({
    url: 'https://app.example.com/', title: 'Home', text: 'Ready', elements: [],
    paired_screenshot: 'screenshot.png', paired_sha256: `sha256:${'0'.repeat(64)}`,
  })}\n`);

  await assert.rejects(
    () => sealAttempt({ runDir, attempt: 1 }), /HONOLOLO_SEAL_CAPTURE_PAIR_INVALID/u,
  );
});

test('direct invocation prints one summary record', async () => {
  const runDir = await sealableFixture();
  const child = spawnSync(
    process.execPath, [sealScript, runDir, '--attempt', '1'], { encoding: 'utf8' },
  );
  assert.equal(child.status, 0);
  assert.equal(child.stderr, '');
  const summary = JSON.parse(child.stdout);
  assert.deepEqual(summary, {
    sealed: 'attempts/001', steps: 1, files: 2, outcome: 'pass', verdicts: { pass: 2 },
  });
});

test('direct invocation rejects a malformed selector', async () => {
  const runDir = await sealableFixture();
  for (const argv of [[runDir], [runDir, '--attempt', 'x'], [runDir, '--needs-human', 'bad']]) {
    const child = spawnSync(process.execPath, [sealScript, ...argv], { encoding: 'utf8' });
    assert.equal(child.status, 1);
    assert.match(child.stderr, /HONOLOLO_SEAL_USAGE/u);
  }
});

test('seal rejects a withheld criterion the plan does not declare', async () => {
  const runDir = await sealableFixture();
  await assert.rejects(
    () => sealAttempt({ runDir, attempt: 1, withheld: new Map([['absent', 'why']]) }),
    /HONOLOLO_SEAL_WITHHELD_UNKNOWN/u,
  );
});

test('withholding cannot soften a criterion the evidence deterministically fails', async () => {
  const runDir = await sealableFixture();
  await writeFile(
    join(runDir, 'attempts/001/evidence/home/snapshot.md'), '# Home\n\nStill loading\n',
  );
  const { status } = await sealAttempt({
    runDir, attempt: 1, withheld: new Map([['home-ready', 'operator judgment']]),
  });
  const criterion = status.criteria.find(({ id }) => id === 'home-ready');
  assert.equal(criterion.verdict, 'fail');
  assert.match(criterion.reason, /withheld by operator: operator judgment/u);
  assert.equal(status.outcome, 'fail');
  assert.equal((await verifyRun({ runDir })).ok, true);
});
