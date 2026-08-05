import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { validateContract, validateReviewForPlan } from '../../harness/lib/contracts.mjs';
import { createRun } from '../../harness/scripts/new-run.mjs';

const request = {
  schema_version: '1', id: 'settings-manual', type: 'manual',
  target: { url: 'https://app.example.com/settings', allowed_domains: ['app.example.com'] },
  goal: 'Document the settings flow.', deliverables: ['output/manual.md'],
  completion: ['Every step has verified evidence.'],
  forbidden: ['delete', 'purchase', 'publish', 'send', 'change_permissions'],
  limits: { max_actions: 30 },
};

const approvedPlan = {
  schema_version: '1', run_id: 'settings-manual', revision: 1,
  approved: { by: 'user', at: '2026-08-05T04:05:06Z', proposal_sha256: `sha256:${'0'.repeat(64)}` },
  steps: [{
    id: 'open-settings', goal: 'Open settings.', risk: 'low', evidence: ['url'],
    done_when: [{ id: 'settings-url', type: 'url_matches', value: '/settings' }],
  }],
  review: { fresh_evaluator: false, criteria: [] },
};

const semanticPlan = {
  ...approvedPlan,
  steps: [
    ...approvedPlan.steps,
    {
      id: 'assess-settings', goal: 'Assess the settings screen.', risk: 'low', evidence: ['snapshot'],
      done_when: [{ id: 'settings-rubric', type: 'rubric', criterion: 'Settings is understandable.' }],
    },
  ],
  review: { fresh_evaluator: true, criteria: [{ id: 'settings-rubric', criterion: 'Settings is understandable.' }] },
};

test('creates a unique private run with no lifecycle machinery', async () => {
  const root = await mkdtemp(join(tmpdir(), 'honololo-new-run-'));
  const created = await createRun({ root, request, now: new Date('2026-08-05T04:05:06Z') });
  assert.equal(created.relativeRunDir, '.honololo/runs/20260805-040506-settings-manual');
  assert.deepEqual(JSON.parse(await readFile(join(created.runDir, 'run.json'))), request);
  assert.deepEqual(created.directories, ['inputs', 'scout', 'plan', 'attempts', 'output', 'output/assets']);
  const second = await createRun({ root, request, now: new Date('2026-08-05T04:05:06Z') });
  assert.equal(second.relativeRunDir, '.honololo/runs/20260805-040506-settings-manual-2');
});

test('rejects credentials and noncanonical target contracts before writing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'honololo-new-run-invalid-'));
  await assert.rejects(() => createRun({ root, request: { ...request, token: 'secret' } }), /RUN_CONTRACT_INVALID/);
  await assert.rejects(() => createRun({ root, request: { ...request, target: { ...request.target, url: 'file:///tmp/x' } } }), /RUN_CONTRACT_INVALID/);
});

test('rejects a target host outside its declared allowed domains before writing', async () => {
  const root = await mkdtemp(join(tmpdir(), 'honololo-new-run-boundary-'));
  await assert.rejects(() => createRun({
    root,
    request: { ...request, target: { url: 'https://other.example/settings', allowed_domains: ['app.example.com'] } },
  }), /RUN_CONTRACT_INVALID/);
});

test('requires an approval gate for a high-risk plan step', () => {
  assert.throws(() => validateContract('plan', {
    ...approvedPlan,
    steps: [{ ...approvedPlan.steps[0], risk: 'high' }],
  }), /PLAN_INVALID/);
});

test('requires a fresh evaluator when a plan declares a rubric criterion', () => {
  assert.throws(() => validateContract('plan', {
    ...approvedPlan,
    steps: [{
      ...approvedPlan.steps[0],
      done_when: [{ id: 'settings-rubric', type: 'rubric', criterion: 'Settings is understandable.' }],
    }],
  }), /PLAN_INVALID/);
});

test('rejects a deterministic review verdict for a rubric criterion', () => {
  assert.throws(() => validateReviewForPlan(semanticPlan, {
    schema_version: '1', run_id: 'settings-manual', attempt: 1,
    source: 'deterministic', outcome: 'pass',
    criteria: [{ id: 'settings-rubric', verdict: 'pass', reason: 'Looks understandable.', evidence: ['attempts/001/evidence/settings/snapshot.md'] }],
  }), /REVIEW_PLAN_INVALID/);
});

test('accepts deterministic and fresh reviews for their respective plan criteria', () => {
  const deterministic = {
    schema_version: '1', run_id: 'settings-manual', attempt: 1,
    source: 'deterministic', outcome: 'pass',
    criteria: [{ id: 'settings-url', verdict: 'pass', reason: 'The URL matches.', evidence: ['attempts/001/evidence/settings/url.txt'] }],
  };
  const fresh = {
    schema_version: '1', run_id: 'settings-manual', attempt: 1,
    source: 'fresh_evaluator', outcome: 'pass',
    criteria: [{ id: 'settings-rubric', verdict: 'pass', reason: 'The screen is understandable.', evidence: ['attempts/001/evidence/settings/snapshot.md'] }],
  };
  assert.equal(validateReviewForPlan(semanticPlan, deterministic), deterministic);
  assert.equal(validateReviewForPlan(semanticPlan, fresh), fresh);
});

test('rejects review criteria with unknown or duplicate IDs', () => {
  const base = {
    schema_version: '1', run_id: 'settings-manual', attempt: 1,
    source: 'deterministic', outcome: 'pass',
  };
  assert.throws(() => validateReviewForPlan(semanticPlan, {
    ...base,
    criteria: [{ id: 'unknown', verdict: 'pass', reason: 'Unknown.', evidence: ['attempts/001/evidence/settings/url.txt'] }],
  }), /REVIEW_PLAN_INVALID/);
  assert.throws(() => validateReviewForPlan(semanticPlan, {
    ...base,
    criteria: [
      { id: 'settings-url', verdict: 'pass', reason: 'Matches.', evidence: ['attempts/001/evidence/settings/url.txt'] },
      { id: 'settings-url', verdict: 'pass', reason: 'Still matches.', evidence: ['attempts/001/evidence/settings/url.txt'] },
    ],
  }), /REVIEW_PLAN_INVALID/);
});
