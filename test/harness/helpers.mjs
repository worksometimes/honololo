import { createHash } from 'node:crypto';
import {
  appendFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rename, rm, symlink,
  truncate, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const fixtureRoot = fileURLToPath(new URL('./fixtures/valid-run/', import.meta.url));
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const digest = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const PNG = Buffer.from('89504e470d0a1a0a', 'hex');

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function refreshFixture(runDir, attempt = 1) {
  const planPath = join(runDir, 'plan/approved.json');
  const planBytes = await readFile(planPath);
  const attemptName = String(attempt).padStart(3, '0');
  const manifestPath = join(runDir, `attempts/${attemptName}/evidence.json`);
  const manifest = await readJson(manifestPath);
  manifest.attempt = attempt;
  manifest.plan_sha256 = digest(planBytes);
  for (const step of manifest.steps) {
    for (const file of step.files) {
      const bytes = await readFile(join(runDir, file.path));
      file.bytes = bytes.length;
      file.sha256 = digest(bytes);
    }
  }
  await writeFile(manifestPath, json(manifest));

  const plan = JSON.parse(planBytes);
  const evidenceByStep = new Map(manifest.steps.map((step) => [
    step.id, new Map(step.files.map((file) => [file.kind, file.path])),
  ]));
  const evidenceKind = (criterion) => {
    if (criterion.type === 'url_matches') return 'url';
    if (criterion.type === 'image_exists') return 'screenshot';
    if (criterion.type.startsWith('snapshot_')) return 'snapshot';
    return 'actions';
  };
  const status = {
    schema_version: '1', run_id: plan.run_id, attempt, source: 'deterministic', outcome: 'pass',
    criteria: plan.steps.flatMap((step) => step.done_when
      .filter(({ type }) => type !== 'rubric')
      .map((criterion) => ({
        id: criterion.id, verdict: 'pass', reason: 'Verified from captured evidence.',
        evidence: [evidenceByStep.get(step.id).get(evidenceKind(criterion))],
      }))),
  };
  await writeFile(join(runDir, `attempts/${attemptName}/status.json`), json(status));
}

// A run with captured evidence but no manifest and no status: the state `seal` is meant to consume.
export async function sealableFixture() {
  const parent = await mkdtemp(join(tmpdir(), 'honololo-sealable-'));
  const runDir = join(parent, 'run');
  await cp(fixtureRoot, runDir, { recursive: true });
  await rm(join(runDir, 'attempts/001/evidence.json'));
  return runDir;
}

export async function validRunFixture() {
  const parent = await mkdtemp(join(tmpdir(), 'honololo-valid-run-'));
  const runDir = join(parent, 'run');
  await cp(fixtureRoot, runDir, { recursive: true });
  await refreshFixture(runDir);
  return runDir;
}

async function walk(root, directory = root, entries = []) {
  const names = (await readdir(directory)).sort();
  for (const name of names) {
    const absolute = join(directory, name);
    const path = relative(root, absolute).split('\\').join('/');
    const stat = await lstat(absolute);
    entries.push({ path, absolute, stat });
    if (stat.isDirectory()) await walk(root, absolute, entries);
  }
  return entries;
}

export async function treeDigest(runDir) {
  const hash = createHash('sha256');
  for (const { path, absolute, stat } of await walk(runDir)) {
    hash.update(path);
    hash.update('\0');
    hash.update(String(stat.mode));
    hash.update('\0');
    if (stat.isSymbolicLink()) hash.update(await readlink(absolute));
    else if (stat.isFile()) hash.update(await readFile(absolute));
    hash.update('\0');
  }
  return hash.digest('hex');
}

// Rebuilds the manifest digests while leaving the recorded verdicts untouched, so a status claim can
// be tested against evidence that no longer supports it.
export async function refreshEvidenceOnly(runDir) {
  const path = join(runDir, 'attempts/001/evidence.json');
  const manifest = await readJson(path);
  for (const step of manifest.steps) {
    for (const file of step.files) {
      const bytes = await readFile(join(runDir, file.path));
      file.bytes = bytes.length;
      file.sha256 = digest(bytes);
    }
  }
  await writeFile(path, json(manifest));
}

// Two steps declaring only url and snapshot, with one step's captures copied into the other: a
// copied snapshot is easier to fake than a copied snapshot-and-screenshot pair.
export async function fixtureWithCopiedSnapshotOnlyStep() {
  const runDir = await validRunFixture();
  const planPath = join(runDir, 'plan/approved.json');
  const plan = await readJson(planPath);
  plan.steps.push({
    id: 'copy', goal: 'Observe the same state again.', risk: 'low', evidence: ['url', 'snapshot'],
    done_when: [{ id: 'copy-ready', type: 'snapshot_contains', value: 'Ready' }],
  });
  await writeFile(planPath, json(plan));

  await mkdir(join(runDir, 'attempts/001/evidence/copy'), { recursive: true });
  for (const name of ['url.txt', 'snapshot.md']) {
    await cp(
      join(runDir, `attempts/001/evidence/home/${name}`),
      join(runDir, `attempts/001/evidence/copy/${name}`),
    );
  }

  const manifestPath = join(runDir, 'attempts/001/evidence.json');
  const manifest = await readJson(manifestPath);
  manifest.steps.push({
    id: 'copy',
    files: manifest.steps[0].files.map((file) => ({
      ...file, path: file.path.replace('/home/', '/copy/'),
    })),
  });
  await writeFile(manifestPath, json(manifest));
  await refreshFixture(runDir);
  return runDir;
}

// Two steps sharing one snapshot but holding distinct screenshots. Scrolling a page changes its
// pixels without changing its text, so this shape is ordinary and must not be reported.
export async function fixtureWithSharedSnapshotDistinctScreenshots() {
  const runDir = await fixtureWithDuplicatedCapture();
  const second = join(runDir, 'attempts/001/evidence/copy/screen.png');
  await writeFile(second, Buffer.concat([PNG, Buffer.from('scrolled')]));
  await refreshFixture(runDir);
  return runDir;
}

export async function fixtureWithDuplicatedCapture() {
  const runDir = await validRunFixture();
  const planPath = join(runDir, 'plan/approved.json');
  const plan = await readJson(planPath);
  plan.steps[0].evidence.push('screenshot');
  plan.steps.push({
    id: 'copy', goal: 'Observe the same state again.', risk: 'low',
    evidence: ['snapshot', 'screenshot'],
    done_when: [{ id: 'copy-ready', type: 'snapshot_contains', value: 'Ready' }],
  });
  await writeFile(planPath, json(plan));

  const snapshot = await readFile(join(runDir, 'attempts/001/evidence/home/snapshot.md'));
  await mkdir(join(runDir, 'attempts/001/evidence/copy'), { recursive: true });
  await writeFile(join(runDir, 'attempts/001/evidence/home/screen.png'), PNG);
  await writeFile(join(runDir, 'attempts/001/evidence/copy/snapshot.md'), snapshot);
  await writeFile(join(runDir, 'attempts/001/evidence/copy/screen.png'), PNG);

  const manifestPath = join(runDir, 'attempts/001/evidence.json');
  const manifest = await readJson(manifestPath);
  const entry = (kind, path) => ({
    kind, path, bytes: 1, sha256: `sha256:${'0'.repeat(64)}`, captured_at: '2026-08-05T04:05:06Z',
  });
  manifest.steps[0].files.push(entry('screenshot', 'attempts/001/evidence/home/screen.png'));
  manifest.steps.push({
    id: 'copy',
    files: [
      entry('snapshot', 'attempts/001/evidence/copy/snapshot.md'),
      entry('screenshot', 'attempts/001/evidence/copy/screen.png'),
    ],
  });
  await writeFile(manifestPath, json(manifest));
  await refreshFixture(runDir);
  return runDir;
}

export async function tamperHash(runDir) {
  const path = join(runDir, 'attempts/001/evidence.json');
  const manifest = await readJson(path);
  manifest.steps[0].files[0].sha256 = `sha256:${'f'.repeat(64)}`;
  await writeFile(path, json(manifest));
}

export async function tamperByteCount(runDir) {
  const path = join(runDir, 'attempts/001/evidence.json');
  const manifest = await readJson(path);
  manifest.steps[0].files[0].bytes += 1;
  await writeFile(path, json(manifest));
}

export async function tamperApprovedPlan(runDir) {
  await appendFile(join(runDir, 'plan/approved.json'), ' ');
}

export async function addTraversal(runDir) {
  const path = join(runDir, 'attempts/001/evidence.json');
  const manifest = await readJson(path);
  manifest.steps[0].files[0].path = 'attempts/001/evidence/home/../home/url.txt';
  await writeFile(path, json(manifest));
}

export async function replaceWithSymlink(runDir) {
  const path = join(runDir, 'attempts/001/evidence/home/url.txt');
  const outside = join(dirname(runDir), 'outside-url.txt');
  const bytes = await readFile(path);
  await writeFile(outside, bytes);
  await rm(path);
  await symlink(outside, path);
}

export async function writeFakePng(runDir) {
  const planPath = join(runDir, 'plan/approved.json');
  const plan = await readJson(planPath);
  plan.steps[0].evidence.push('screenshot');
  await writeFile(planPath, json(plan));

  const filePath = join(runDir, 'attempts/001/evidence/home/fake.png');
  const bytes = Buffer.from('this is not a PNG');
  await writeFile(filePath, bytes);
  const path = join(runDir, 'attempts/001/evidence.json');
  const manifest = await readJson(path);
  manifest.steps[0].files.push({
    kind: 'screenshot', path: 'attempts/001/evidence/home/fake.png', bytes: bytes.length,
    sha256: digest(bytes), captured_at: '2026-08-05T04:05:06Z',
  });
  await writeFile(path, json(manifest));
  await refreshFixture(runDir);
}

export async function duplicateKind(runDir) {
  const duplicatePath = join(runDir, 'attempts/001/evidence/home/url-copy.txt');
  await writeFile(duplicatePath, await readFile(join(runDir, 'attempts/001/evidence/home/url.txt')));
  const path = join(runDir, 'attempts/001/evidence.json');
  const manifest = await readJson(path);
  manifest.steps[0].files.push({
    ...manifest.steps[0].files[0], path: 'attempts/001/evidence/home/url-copy.txt',
  });
  await writeFile(path, json(manifest));
  await refreshFixture(runDir);
}

export async function addUnapprovedKind(runDir) {
  const filePath = join(runDir, 'attempts/001/evidence/home/unapproved.png');
  await writeFile(filePath, PNG);
  const path = join(runDir, 'attempts/001/evidence.json');
  const manifest = await readJson(path);
  manifest.steps[0].files.push({
    kind: 'screenshot', path: 'attempts/001/evidence/home/unapproved.png', bytes: PNG.length,
    sha256: digest(PNG), captured_at: '2026-08-05T04:05:06Z',
  });
  await writeFile(path, json(manifest));
  await refreshFixture(runDir);
}

async function addSecondStep(runDir) {
  const planPath = join(runDir, 'plan/approved.json');
  const plan = await readJson(planPath);
  plan.steps.push({
    id: 'settings', goal: 'Observe settings.', risk: 'low', evidence: ['url'],
    done_when: [{ id: 'settings-url', type: 'url_matches', value: '/settings' }],
  });
  await writeFile(planPath, json(plan));

  const evidencePath = 'attempts/001/evidence/settings/url.txt';
  await mkdir(join(runDir, 'attempts/001/evidence/settings'), { recursive: true });
  await writeFile(join(runDir, evidencePath), 'https://app.example.com/settings\n');
  const manifestPath = join(runDir, 'attempts/001/evidence.json');
  const manifest = await readJson(manifestPath);
  manifest.steps.push({
    id: 'settings', files: [{
      kind: 'url', path: evidencePath, bytes: 1,
      sha256: `sha256:${'0'.repeat(64)}`, captured_at: '2026-08-05T04:05:06Z',
    }],
  });
  await writeFile(manifestPath, json(manifest));
  await refreshFixture(runDir);
}

async function replaceStatusEvidence(runDir, criterionId, evidencePath) {
  const statusPath = join(runDir, 'attempts/001/status.json');
  const status = await readJson(statusPath);
  status.criteria.find(({ id }) => id === criterionId).evidence = [evidencePath];
  await writeFile(statusPath, json(status));
}

export async function wrongStepStatusEvidence(runDir) {
  await addSecondStep(runDir);
  await replaceStatusEvidence(
    runDir, 'home-url', 'attempts/001/evidence/settings/url.txt',
  );
}

export async function missingStatusEvidence(runDir) {
  await replaceStatusEvidence(
    runDir, 'home-url', 'attempts/001/evidence/home/missing.txt',
  );
}

export async function writeOversizeEvidence(runDir) {
  await truncate(join(runDir, 'attempts/001/evidence/home/snapshot.md'), (64 * 1024 * 1024) + 1);
}

async function cloneAttempt(runDir, attempt = 2) {
  const source = join(runDir, 'attempts/001');
  const destination = join(runDir, `attempts/${String(attempt).padStart(3, '0')}`);
  await cp(source, destination, { recursive: true });
  const manifestPath = join(destination, 'evidence.json');
  const manifest = await readJson(manifestPath);
  manifest.attempt = attempt;
  for (const step of manifest.steps) {
    for (const file of step.files) {
      file.path = file.path.replace('attempts/001/', `attempts/${String(attempt).padStart(3, '0')}/`);
    }
  }
  await writeFile(manifestPath, json(manifest));
  await refreshFixture(runDir, attempt);
  return { source, destination };
}

export async function fixtureWithInterruptedFirstAttemptAndSuccessfulSecond() {
  const runDir = await validRunFixture();
  const { source } = await cloneAttempt(runDir);
  await rm(join(source, 'status.json'));
  return runDir;
}

export async function fixtureWithFailedFirstAttemptAndSuccessfulSecond() {
  const runDir = await validRunFixture();
  const { source } = await cloneAttempt(runDir);
  const firstStatusPath = join(source, 'status.json');
  const firstStatus = await readJson(firstStatusPath);
  firstStatus.outcome = 'fail';
  firstStatus.criteria[0].verdict = 'fail';
  await writeFile(firstStatusPath, json(firstStatus));
  return runDir;
}

function reviewRecord({ plan, attempt, source, outcome, criteria }) {
  return {
    schema_version: '1', run_id: plan.run_id, attempt, source, outcome, criteria,
  };
}

async function writeReviewedAttempt(runDir, { attempt = 1, outcome, deterministic, fresh }) {
  const plan = await readJson(join(runDir, 'plan/approved.json'));
  const attemptName = String(attempt).padStart(3, '0');
  await writeFile(
    join(runDir, `attempts/${attemptName}/status.json`),
    json(reviewRecord({ plan, attempt, source: 'deterministic', outcome, criteria: deterministic })),
  );
  await writeFile(
    join(runDir, `attempts/${attemptName}/fresh.json`),
    json(reviewRecord({ plan, attempt, source: 'fresh_evaluator', outcome, criteria: fresh })),
  );
}

export async function addReviewedRetry(runDir, { outcome = 'fail' } = {}) {
  const { source, destination } = await cloneAttempt(runDir);

  for (const name of ['status.json', 'fresh.json']) {
    const review = await readJson(join(source, name));
    review.attempt = 2;
    review.outcome = outcome;
    review.criteria = review.criteria.map((criterion, index) => ({
      ...criterion,
      verdict: outcome === 'fail' && index === review.criteria.length - 1
        ? 'fail'
        : criterion.verdict,
      evidence: criterion.evidence.map((path) => path.replace('attempts/001/', 'attempts/002/')),
    }));
    await writeFile(join(destination, name), json(review));
  }
}

export async function fixtureWithHistoricalFreshFailure() {
  const runDir = await reviewedQaFixture();
  await addReviewedRetry(runDir, { outcome: 'pass' });
  const path = join(runDir, 'attempts/001/fresh.json');
  const fresh = await readJson(path);
  fresh.outcome = 'fail';
  fresh.criteria[0].verdict = 'fail';
  await writeFile(path, json(fresh));
  return runDir;
}

export async function fixtureWithHistoricalMissingFresh() {
  const runDir = await reviewedQaFixture();
  await addReviewedRetry(runDir, { outcome: 'pass' });
  await rm(join(runDir, 'attempts/001/fresh.json'));
  return runDir;
}

export async function reviewedQaFixture({ outcome = 'pass', freshEvidence = 'home' } = {}) {
  const runDir = await validRunFixture();
  const planPath = join(runDir, 'plan/approved.json');
  const plan = await readJson(planPath);
  plan.steps[0].done_when.push({
    id: 'home-clarity', type: 'rubric', criterion: 'The home page purpose is clear.',
  });
  plan.review = {
    fresh_evaluator: true,
    criteria: [{ id: 'home-clarity', criterion: 'The home page purpose is clear.' }],
  };
  await writeFile(planPath, json(plan));
  let freshPath = 'attempts/001/evidence/home/snapshot.md';
  if (freshEvidence === 'wrong_step') {
    await addSecondStep(runDir);
    freshPath = 'attempts/001/evidence/settings/url.txt';
  } else await refreshFixture(runDir);

  const url = 'attempts/001/evidence/home/url.txt';
  const snapshot = 'attempts/001/evidence/home/snapshot.md';
  const criterionOutcome = ['pass', 'fail', 'needs_human'].includes(outcome) ? outcome : 'pass';
  await writeReviewedAttempt(runDir, {
    outcome,
    deterministic: [
      { id: 'home-url', verdict: 'pass', reason: 'URL matches the approved target.', evidence: [url] },
      { id: 'home-ready', verdict: criterionOutcome, reason: 'Expected heading was evaluated.', evidence: [snapshot] },
      ...(freshEvidence === 'wrong_step'
        ? [{
          id: 'settings-url', verdict: 'pass', reason: 'The settings route was captured.',
          evidence: ['attempts/001/evidence/settings/url.txt'],
        }]
        : []),
    ],
    fresh: [{
      id: 'home-clarity', verdict: criterionOutcome, reason: 'The page purpose was independently reviewed.',
      evidence: [freshPath],
    }],
  });
  return runDir;
}

export async function reviewedManualFixture({
  outcome = 'pass', historicalInterrupt = false, stepId = 'settings',
  manualTitle = 'Open settings',
} = {}) {
  const runDir = await validRunFixture();
  const runPath = join(runDir, 'run.json');
  const run = await readJson(runPath);
  run.type = 'manual';
  run.deliverables = ['output/manual.md'];
  await writeFile(runPath, json(run));

  const evidenceRoot = join(runDir, 'attempts/001/evidence');
  await rename(join(evidenceRoot, 'home'), join(evidenceRoot, stepId));
  const screenshotPath = `attempts/001/evidence/${stepId}/screen.png`;
  await writeFile(join(runDir, screenshotPath), PNG);

  const planPath = join(runDir, 'plan/approved.json');
  const plan = await readJson(planPath);
  plan.steps = [{
    id: stepId, goal: 'Open the settings screen.', risk: 'low',
    evidence: ['url', 'snapshot', 'screenshot'],
    done_when: [
      { id: 'settings-url', type: 'url_matches', value: 'https://app.example.com/' },
      { id: 'settings-ready', type: 'snapshot_contains', value: 'Ready' },
      { id: 'settings-clarity', type: 'rubric', criterion: 'The settings screen is clear.' },
    ],
    manual: {
      title: manualTitle, instruction: 'Choose Settings from the account menu.',
      expected: 'The Settings heading is visible.', cautions: ['Do not change account settings.'],
    },
  }];
  plan.review = {
    fresh_evaluator: true,
    criteria: [{ id: 'settings-clarity', criterion: 'The settings screen is clear.' }],
  };
  await writeFile(planPath, json(plan));

  const manifestPath = join(runDir, 'attempts/001/evidence.json');
  const manifest = await readJson(manifestPath);
  manifest.steps[0].id = stepId;
  for (const file of manifest.steps[0].files) {
    file.path = file.path.replace('/home/', `/${stepId}/`);
  }
  manifest.steps[0].files.push({
    kind: 'screenshot', path: screenshotPath, bytes: PNG.length, sha256: digest(PNG),
    captured_at: '2026-08-05T04:05:06Z',
  });
  await writeFile(manifestPath, json(manifest));
  await refreshFixture(runDir);

  const url = `attempts/001/evidence/${stepId}/url.txt`;
  const snapshot = `attempts/001/evidence/${stepId}/snapshot.md`;
  const criterionOutcome = ['pass', 'fail', 'needs_human'].includes(outcome) ? outcome : 'pass';
  await writeReviewedAttempt(runDir, {
    outcome,
    deterministic: [
      { id: 'settings-url', verdict: 'pass', reason: 'URL matches the approved target.', evidence: [url] },
      { id: 'settings-ready', verdict: criterionOutcome, reason: 'Settings content is visible.', evidence: [snapshot] },
    ],
    fresh: [{
      id: 'settings-clarity', verdict: criterionOutcome, reason: 'The settings screen was independently reviewed.',
      evidence: [snapshot],
    }],
  });
  if (historicalInterrupt) {
    await addReviewedRetry(runDir, { outcome: 'pass' });
    await rm(join(runDir, 'attempts/001/status.json'));
  }
  return runDir;
}

export async function reviewedManualFixtureWithPartialStep() {
  const runDir = await reviewedManualFixture();
  const planPath = join(runDir, 'plan/approved.json');
  const plan = await readJson(planPath);
  plan.steps.push({
    id: 'profile', goal: 'Open the profile screen.', risk: 'low',
    evidence: ['screenshot'],
    done_when: [{ id: 'profile-ready', type: 'image_exists', value: 'screen.png' }],
    manual: {
      title: 'Open profile', instruction: 'Choose Profile from the account menu.',
      expected: 'The Profile heading is visible.', cautions: [],
    },
  });
  await writeFile(planPath, json(plan));

  const screenshotPath = 'attempts/001/evidence/profile/screen.png';
  await mkdir(join(runDir, 'attempts/001/evidence/profile'), { recursive: true });
  await writeFile(join(runDir, screenshotPath), PNG);
  const manifestPath = join(runDir, 'attempts/001/evidence.json');
  const manifest = await readJson(manifestPath);
  manifest.plan_sha256 = digest(await readFile(planPath));
  manifest.steps.push({
    id: 'profile', files: [{
      kind: 'screenshot', path: screenshotPath, bytes: PNG.length, sha256: digest(PNG),
      captured_at: '2026-08-05T04:05:06Z',
    }],
  });
  await writeFile(manifestPath, json(manifest));

  const url = 'attempts/001/evidence/settings/url.txt';
  const snapshot = 'attempts/001/evidence/settings/snapshot.md';
  await writeReviewedAttempt(runDir, {
    outcome: 'needs_human',
    deterministic: [
      { id: 'settings-url', verdict: 'pass', reason: 'URL matches the approved target.', evidence: [url] },
      { id: 'settings-ready', verdict: 'pass', reason: 'Settings content is visible.', evidence: [snapshot] },
      {
        id: 'profile-ready', verdict: 'needs_human',
        reason: 'Screenshot provenance is unverified.', evidence: [screenshotPath],
      },
    ],
    fresh: [{
      id: 'settings-clarity', verdict: 'pass',
      reason: 'The settings screen was independently reviewed.', evidence: [snapshot],
    }],
  });
  return runDir;
}

export async function unverifiedFixture() {
  const runDir = await validRunFixture();
  await tamperHash(runDir);
  return runDir;
}
