import assert from 'node:assert/strict';
import { mkdir, readFile, rm, stat, truncate, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { renderRun } from '../../harness/scripts/render.mjs';
import {
  addReviewedRetry, fixtureWithHistoricalFreshFailure, fixtureWithHistoricalMissingFresh,
  reviewedManualFixture, reviewedManualFixtureWithPartialStep, reviewedQaFixture, treeDigest,
  unverifiedFixture,
} from './helpers.mjs';

test('aggregates criterion verdicts with fail over needs_human over pass', async () => {
  const runDir = await reviewedQaFixture();
  const statusPath = join(runDir, 'attempts/001/status.json');
  const freshPath = join(runDir, 'attempts/001/fresh.json');
  const status = JSON.parse(await readFile(statusPath, 'utf8'));
  const fresh = JSON.parse(await readFile(freshPath, 'utf8'));
  status.criteria[1].verdict = 'needs_human';
  fresh.criteria[0].verdict = 'fail';
  await writeFile(statusPath, `${JSON.stringify(status)}\n`);
  await writeFile(freshPath, `${JSON.stringify(fresh)}\n`);

  const output = await renderRun({ runDir, attempt: 1, type: 'qa' });
  const markdown = await readFile(output, 'utf8');
  assert.match(markdown, /Overall: fail/u);
  assert.match(markdown, /home-ready/u);
  assert.match(markdown, /home-clarity/u);
});

test('qualifies non-pass terminal review outcomes', async (t) => {
  for (const [outcome, expected] of [
    ['fail', 'fail'],
    ['needs_human', 'needs_human'],
    ['blocked', 'needs_human'],
    ['interrupted', 'needs_human'],
  ]) {
    await t.test(outcome, async () => {
      const runDir = await reviewedQaFixture({ outcome });
      const output = await renderRun({ runDir, attempt: 1, type: 'qa' });
      assert.match(await readFile(output, 'utf8'), new RegExp(`Overall: ${expected}`, 'u'));
    });
  }
});

test('marks a declared semantic criterion needs_human without a fresh review', async () => {
  const runDir = await reviewedQaFixture();
  await rm(join(runDir, 'attempts/001/fresh.json'));
  const output = await renderRun({ runDir, attempt: 1, type: 'qa' });
  const markdown = await readFile(output, 'utf8');
  assert.match(markdown, /Overall: needs_human/u);
  assert.match(markdown, /home-clarity/u);
});

test('binds reviews to their declared source, attempt, criterion, and evidence step', async (t) => {
  const mutations = {
    source: async (runDir) => {
      const path = join(runDir, 'attempts/001/fresh.json');
      const review = JSON.parse(await readFile(path, 'utf8'));
      review.source = 'deterministic';
      await writeFile(path, `${JSON.stringify(review)}\n`);
    },
    attempt: async (runDir) => {
      const path = join(runDir, 'attempts/001/fresh.json');
      const review = JSON.parse(await readFile(path, 'utf8'));
      review.attempt = 2;
      await writeFile(path, `${JSON.stringify(review)}\n`);
    },
  };
  for (const [name, mutate] of Object.entries(mutations)) {
    await t.test(name, async () => {
      const runDir = await reviewedQaFixture();
      await mutate(runDir);
      await assert.rejects(() => renderRun({ runDir, attempt: 1, type: 'qa' }));
    });
  }

  await t.test('step', async () => {
    const runDir = await reviewedQaFixture({ freshEvidence: 'wrong_step' });
    await assert.rejects(
      () => renderRun({ runDir, attempt: 1, type: 'qa' }),
      /HONOLOLO_REVIEW_EVIDENCE_INVALID/u,
    );
  });
});

test('renders a portable five-part manual from verified screenshot bytes', async () => {
  const runDir = await reviewedManualFixture();
  const output = await renderRun({ runDir, attempt: 1, type: 'manual' });
  const markdown = await readFile(output, 'utf8');
  const source = await readFile(join(runDir, 'attempts/001/evidence/settings/screen.png'));
  const asset = await readFile(join(runDir, 'output/assets/001-settings.png'));

  assert.match(markdown, /### 1\. Open settings/u);
  assert.match(markdown, /Title: Open settings/u);
  assert.match(markdown, /Action:/u);
  assert.match(markdown, /Expected:/u);
  assert.match(markdown, /Image: !\[Open settings\]\(assets\/001-settings\.png\)/u);
  assert.match(markdown, /Caution:/u);
  assert.doesNotMatch(markdown, /attempts\/001\/evidence/u);
  assert.deepEqual(asset, source);
});

test('renders manual image alt text for a valid step ID with empty hyphen segments', async () => {
  const runDir = await reviewedManualFixture({
    stepId: 'settings--panel-', manualTitle: 'Open [settings]',
  });
  const output = await renderRun({ runDir, attempt: 1, type: 'manual' });
  assert.equal(
    (await readFile(output, 'utf8')).includes(
      'Image: ![Open \\[settings\\]](assets/001-settings--panel-.png)',
    ),
    true,
  );
});

test('refuses rendering when deterministic verification fails', async () => {
  const runDir = await unverifiedFixture();
  await assert.rejects(
    () => renderRun({ runDir, attempt: 1, type: 'qa' }),
    /RUN_NOT_VERIFIED/u,
  );
});

test('withholds manual screenshots for failed, unresolved, or unsafe-history runs', async (t) => {
  for (const [name, fixture] of [
    ['failed', () => reviewedManualFixture({ outcome: 'fail' })],
    ['missing fresh review', async () => {
      const runDir = await reviewedManualFixture();
      await rm(join(runDir, 'attempts/001/fresh.json'));
      return runDir;
    }],
    ['interrupted history', () => reviewedManualFixture({ historicalInterrupt: true })],
  ]) {
    await t.test(name, async () => {
      const runDir = await fixture();
      const attempt = name === 'interrupted history' ? 2 : 1;
      const output = await renderRun({ runDir, attempt, type: 'manual' });
      const markdown = await readFile(output, 'utf8');
      assert.doesNotMatch(markdown, /!\[Settings\]/u);
      await assert.rejects(readFile(join(runDir, 'output/assets/001-settings.png')), /ENOENT/u);
    });
  }
});

test('publishes screenshots per step for a qualified needs_human manual', async () => {
  const runDir = await reviewedManualFixtureWithPartialStep();
  const output = await renderRun({ runDir, attempt: 1, type: 'manual' });
  const markdown = await readFile(output, 'utf8');

  assert.match(markdown, /Overall: needs_human/u);
  assert.match(markdown, /published only for steps whose criteria all passed \(1 of 2\)/u);
  assert.match(markdown, /Image: !\[Open settings\]\(assets\/001-settings\.png\)/u);
  assert.match(markdown, /Image: Unpublished pending review\./u);
  await readFile(join(runDir, 'output/assets/001-settings.png'));
  await assert.rejects(readFile(join(runDir, 'output/assets/002-profile.png')), /ENOENT/u);
});

test('qualifies a later pass after historical semantic failure or missing fresh review', async (t) => {
  for (const [name, fixture] of [
    ['fresh failure', fixtureWithHistoricalFreshFailure],
    ['missing fresh review', fixtureWithHistoricalMissingFresh],
  ]) {
    await t.test(name, async () => {
      const runDir = await fixture();
      const output = await renderRun({ runDir, attempt: 2, type: 'qa' });
      assert.match(await readFile(output, 'utf8'), /Overall: needs_human/u);
    });
  }
});

test('rerendering identical bytes is idempotent', async () => {
  const runDir = await reviewedManualFixture();
  const first = await renderRun({ runDir, attempt: 1, type: 'manual' });
  const before = await treeDigest(join(runDir, 'output'));
  const second = await renderRun({ runDir, attempt: 1, type: 'manual' });
  assert.equal(second, first);
  assert.equal(await treeDigest(join(runDir, 'output')), before);
});

test('preflights conflicting document and asset bytes before writing anything', async (t) => {
  await t.test('document', async () => {
    const runDir = await reviewedQaFixture();
    await mkdir(join(runDir, 'output'), { recursive: true });
    await writeFile(join(runDir, 'output/result.md'), 'occupied\n');
    const before = await treeDigest(join(runDir, 'output'));
    await assert.rejects(() => renderRun({ runDir, attempt: 1, type: 'qa' }), /OUTPUT_CONFLICT/u);
    assert.equal(await treeDigest(join(runDir, 'output')), before);
  });

  await t.test('sparse document with a different size', async () => {
    const runDir = await reviewedQaFixture();
    const output = join(runDir, 'output/result.md');
    await mkdir(join(runDir, 'output'), { recursive: true });
    await writeFile(output, '');
    await truncate(output, 3 * 1024 * 1024 * 1024);
    await assert.rejects(
      () => renderRun({ runDir, attempt: 1, type: 'qa' }),
      /OUTPUT_CONFLICT/u,
    );
    assert.equal((await stat(output)).size, 3 * 1024 * 1024 * 1024);
  });

  await t.test('asset', async () => {
    const runDir = await reviewedManualFixture();
    await mkdir(join(runDir, 'output/assets'), { recursive: true });
    await writeFile(join(runDir, 'output/assets/001-settings.png'), 'occupied');
    const before = await treeDigest(join(runDir, 'output'));
    await assert.rejects(
      () => renderRun({ runDir, attempt: 1, type: 'manual' }),
      /OUTPUT_ASSET_CONFLICT/u,
    );
    assert.equal(await treeDigest(join(runDir, 'output')), before);
    await assert.rejects(readFile(join(runDir, 'output/manual.md')), /ENOENT/u);
  });
});

test('a new retry cannot overwrite immutable prior output', async () => {
  const runDir = await reviewedQaFixture();
  const output = await renderRun({ runDir, attempt: 1, type: 'qa' });
  const original = await readFile(output);
  await addReviewedRetry(runDir, { outcome: 'fail' });

  await assert.rejects(
    () => renderRun({ runDir, attempt: 2, type: 'qa' }),
    /OUTPUT_CONFLICT/u,
  );
  assert.deepEqual(await readFile(output), original);
});

test('escapes structured Markdown text and omits evaluator reasons', async () => {
  const runDir = await reviewedQaFixture();
  const runPath = join(runDir, 'run.json');
  const run = JSON.parse(await readFile(runPath, 'utf8'));
  run.goal = 'Goal\r\n# injected [link](https://other.example)';
  await writeFile(runPath, `${JSON.stringify(run)}\n`);
  const statusPath = join(runDir, 'attempts/001/status.json');
  const status = JSON.parse(await readFile(statusPath, 'utf8'));
  status.criteria[1].verdict = 'needs_human';
  status.criteria[1].reason = 'DO-NOT-RENDER [unsafe](../run.json)';
  await writeFile(statusPath, `${JSON.stringify(status)}\n`);

  const output = await renderRun({ runDir, attempt: 1, type: 'qa' });
  const markdown = await readFile(output, 'utf8');
  assert.doesNotMatch(markdown, /\r|DO-NOT-RENDER|\[unsafe\]\(\.\.\/run\.json\)/u);
  assert.equal(markdown.includes('Goal: Goal \\# injected \\[link\\]\\(https://other.example\\)'), true);
});
