import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { validateContract } from '../../harness/lib/contracts.mjs';
import { createRun } from '../../harness/scripts/new-run.mjs';
import { emitOps, extractRecipe } from '../../harness/scripts/recipe.mjs';
import { sealAttempt } from '../../harness/scripts/seal.mjs';
import { tamperHash } from './helpers.mjs';

const ORIGIN = 'http://127.0.0.1';
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const digest = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

const DEFAULT_OPS = [
  { op: 'goto', url: `${ORIGIN}/` },
  { op: 'snapshot', path_prefix: 'attempts/001/evidence/home/capture' },
];

// A verified single-step QA run whose actions evidence is the transport op list itself — the state
// recipe extraction is meant to consume.
async function recipeableRun({ ops = DEFAULT_OPS, text = 'Ready' } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'honololo-recipe-'));
  const request = {
    schema_version: '1', id: 'recipe-qa', type: 'qa',
    target: { url: `${ORIGIN}/`, allowed_domains: ['127.0.0.1'] },
    goal: 'Verify the deterministic fixture home state.',
    deliverables: ['output/result.md'],
    completion: ['Every declared criterion has reviewed evidence.'],
    forbidden: ['delete', 'purchase', 'publish', 'send', 'invite', 'change_permissions'],
    limits: { max_actions: 10 },
  };
  const { runDir } = await createRun({ root, request, now: new Date('2026-08-05T04:05:06Z') });
  const proposal = Buffer.from('# QA fixture proposal\n\nScope: deterministic fixture only.\n');
  await writeFile(join(runDir, 'plan/proposal.md'), proposal);
  const plan = {
    schema_version: '1', run_id: 'recipe-qa', revision: 1,
    approved: { by: 'user', at: '2026-08-05T04:05:06Z', proposal_sha256: digest(proposal) },
    steps: [{
      id: 'home', goal: 'Observe the settled fixture home page.', risk: 'low',
      evidence: ['url', 'snapshot', 'actions'],
      done_when: [
        { id: 'home-url', type: 'url_matches', value: `${ORIGIN}/` },
        { id: 'home-ready', type: 'snapshot_contains', value: 'Ready' },
        { id: 'home-actions', type: 'file_exists', value: 'actions.json' },
      ],
    }],
    review: { fresh_evaluator: false, criteria: [] },
  };
  await writeFile(join(runDir, 'plan/approved.json'), json(plan), { flag: 'wx' });
  const evidence = 'attempts/001/evidence/home';
  await mkdir(join(runDir, evidence), { recursive: true });
  await writeFile(join(runDir, evidence, 'url.txt'), `${ORIGIN}/\n`);
  await writeFile(join(runDir, evidence, 'capture.snapshot.json'), json({
    url: `${ORIGIN}/`, title: 'Fixture', elements: [], text,
  }));
  await writeFile(join(runDir, evidence, 'actions.json'), json(ops));
  await sealAttempt({ runDir, attempt: 1 });
  return { root, runDir };
}

const RECIPE = {
  schema_version: '1',
  slug: 'settings-check',
  host: 'app.example.com',
  goal: 'Verify the settings screen.',
  request: {},
  plan: {},
  steps: [{ id: 'home', ops: [{ op: 'goto', url: 'https://app.example.com/' }] }],
  source: {
    run: '20260806-010203-settings-check', attempt: 1,
    plan_sha256: `sha256:${'a'.repeat(64)}`, extracted_at: '2026-08-06T01:02:03.000Z',
  },
};

test('the recipe contract accepts the envelope and refuses a step without ops', () => {
  assert.deepEqual(validateContract('recipe', RECIPE), RECIPE);
  assert.throws(
    () => validateContract('recipe', { ...RECIPE, steps: [{ id: 'home', ops: [] }] }),
    /HONOLOLO_RECIPE_INVALID/u,
  );
  assert.throws(
    () => validateContract('recipe', { ...RECIPE, host: 'App.Example.com' }),
    /HONOLOLO_RECIPE_INVALID/u,
  );
});

test('a verified passing run distills into a recipe with evidence paths abstracted', async () => {
  const { root, runDir } = await recipeableRun();
  const { path, recipe } = await extractRecipe({
    runDir, attempt: 1, slug: 'home-check', root, now: new Date('2026-08-06T01:02:03Z'),
  });
  assert.equal(path.endsWith('.honololo/targets/127.0.0.1/recipes/home-check.json'), true);
  const persisted = JSON.parse(await readFile(path, 'utf8'));
  assert.deepEqual(persisted, recipe);
  assert.equal(recipe.host, '127.0.0.1');
  assert.equal(recipe.goal, 'Verify the deterministic fixture home state.');
  assert.equal(recipe.request.id, 'recipe-qa');
  assert.equal(recipe.plan.run_id, 'recipe-qa');
  assert.deepEqual(recipe.steps, [{
    id: 'home',
    ops: [
      { op: 'goto', url: `${ORIGIN}/` },
      { op: 'snapshot', path_prefix: '@evidence/home/capture' },
    ],
  }]);
  assert.equal(recipe.source.attempt, 1);
});

test('extraction is exclusive unless forced', async () => {
  const { root, runDir } = await recipeableRun();
  await extractRecipe({ runDir, attempt: 1, slug: 'home-check', root });
  await assert.rejects(
    extractRecipe({ runDir, attempt: 1, slug: 'home-check', root }),
    /EEXIST/u,
  );
  await extractRecipe({ runDir, attempt: 1, slug: 'home-check', root, force: true });
});

test('a run that does not verify cannot become a recipe', async () => {
  const { root, runDir } = await recipeableRun();
  await tamperHash(runDir);
  await assert.rejects(
    extractRecipe({ runDir, attempt: 1, slug: 'home-check', root }),
    /HONOLOLO_RECIPE_RUN_UNVERIFIED/u,
  );
});

test('an attempt that did not pass cannot become a recipe', async () => {
  const { root, runDir } = await recipeableRun({ text: 'Loading' });
  await assert.rejects(
    extractRecipe({ runDir, attempt: 1, slug: 'home-check', root }),
    /HONOLOLO_RECIPE_ATTEMPT_NOT_PASS/u,
  );
});

test('a step without an op-list actions file refuses extraction', async () => {
  const { root, runDir } = await recipeableRun({ ops: [{ note: 'not an op' }] });
  await assert.rejects(
    extractRecipe({ runDir, attempt: 1, slug: 'home-check', root }),
    /HONOLOLO_RECIPE_ACTIONS_INVALID: home/u,
  );
});

test('a redacted or credential-shaped op value never becomes replayable', async () => {
  const redacted = await recipeableRun({
    ops: [...DEFAULT_OPS, { op: 'type', ref: 'e1', text: 'hunter2-secret', redact: true }],
  });
  await assert.rejects(
    extractRecipe({ runDir: redacted.runDir, attempt: 1, slug: 'home-check', root: redacted.root }),
    /HONOLOLO_RECIPE_OP_SENSITIVE: home/u,
  );
  const bearing = await recipeableRun({
    ops: [...DEFAULT_OPS, { op: 'type', ref: 'e1', text: 'Bearer abcdefghijklmnop' }],
  });
  await assert.rejects(
    extractRecipe({ runDir: bearing.runDir, attempt: 1, slug: 'home-check', root: bearing.root }),
    /HONOLOLO_RECIPE_OP_SENSITIVE: home/u,
  );
});

test('an evidence path outside the attempt evidence tree refuses extraction', async () => {
  const { root, runDir } = await recipeableRun({
    ops: [{ op: 'goto', url: `${ORIGIN}/` }, { op: 'snapshot', path_prefix: '/tmp/loose' }],
  });
  await assert.rejects(
    extractRecipe({ runDir, attempt: 1, slug: 'home-check', root }),
    /HONOLOLO_RECIPE_PATH_INVALID/u,
  );
});

test('emit resolves evidence placeholders for the attempt about to run', async () => {
  const { root, runDir } = await recipeableRun();
  const { path } = await extractRecipe({ runDir, attempt: 1, slug: 'home-check', root });
  const ops = await emitOps({ recipePath: path, evidenceDir: 'RUN/attempts/002/evidence' });
  assert.deepEqual(ops, [
    { op: 'goto', url: `${ORIGIN}/` },
    { op: 'snapshot', path_prefix: 'RUN/attempts/002/evidence/home/capture' },
  ]);
  // The recipe on disk is untouched by emission.
  const persisted = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(persisted.steps[0].ops[1].path_prefix, '@evidence/home/capture');
});

test('emit can select one step and refuses one it does not hold', async () => {
  const { root, runDir } = await recipeableRun();
  const { path } = await extractRecipe({ runDir, attempt: 1, slug: 'home-check', root });
  const ops = await emitOps({ recipePath: path, evidenceDir: 'E', stepId: 'home' });
  assert.equal(ops.length, 2);
  await assert.rejects(
    emitOps({ recipePath: path, evidenceDir: 'E', stepId: 'missing' }),
    /HONOLOLO_RECIPE_STEP_UNKNOWN/u,
  );
});

test('emit refuses a recipe whose stored request or plan no longer validates', async () => {
  const { root, runDir } = await recipeableRun();
  const { path } = await extractRecipe({ runDir, attempt: 1, slug: 'home-check', root });
  const recipe = JSON.parse(await readFile(path, 'utf8'));
  recipe.plan = { tampered: true };
  await writeFile(path, json(recipe));
  await assert.rejects(
    emitOps({ recipePath: path, evidenceDir: 'E' }),
    /HONOLOLO_PLAN_INVALID/u,
  );
});
