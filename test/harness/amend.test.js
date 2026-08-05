import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import sharp from 'sharp';
import { amendAsset } from '../../harness/scripts/amend.mjs';
import { renderRun } from '../../harness/scripts/render.mjs';
import { verifyRun } from '../../harness/scripts/verify-run.mjs';
import { reviewedManualFixture } from './helpers.mjs';

async function replacementPng(directory, name = 'replacement.png') {
  const path = join(directory, name);
  const bytes = await sharp({
    create: { width: 20, height: 20, channels: 3, background: { r: 10, g: 120, b: 240 } },
  }).png().toBuffer();
  await writeFile(path, bytes);
  return { path, bytes };
}

test('amendAsset replaces a rendered asset and records provenance', async () => {
  const runDir = await reviewedManualFixture();
  await renderRun({ runDir, attempt: 1, type: 'manual' });
  const assetPath = join(runDir, 'output/assets/001-settings.png');
  const original = await readFile(assetPath);
  const { path: file, bytes } = await replacementPng(runDir);

  const result = await amendAsset({
    runDir, asset: '001-settings.png', file,
    reason: 'User feedback: re-annotated the expanded permission groups.',
  });
  assert.deepEqual(await readFile(assetPath), bytes);
  assert.match(result.record.sha256, /^sha256:[a-f0-9]{64}$/u);
  assert.notEqual(result.record.replaced_sha256, undefined);

  const log = JSON.parse(await readFile(join(runDir, 'output/amendments.json'), 'utf8'));
  assert.equal(log.amendments.length, 1);
  assert.equal(log.amendments[0].asset, '001-settings.png');
  assert.notDeepEqual(bytes, original);

  const verified = await verifyRun({ runDir, attempt: 1 });
  assert.equal(verified.ok, true);
  assert.equal(verified.amendments.length, 1);
});

test('verifyRun fails when an amended asset is tampered after amendment', async () => {
  const runDir = await reviewedManualFixture();
  await renderRun({ runDir, attempt: 1, type: 'manual' });
  const { path: file } = await replacementPng(runDir);
  await amendAsset({
    runDir, asset: '001-settings.png', file, reason: 'Replace with expanded view.',
  });
  await writeFile(
    join(runDir, 'output/assets/001-settings.png'),
    Buffer.from('89504e470d0a1a0a00', 'hex'),
  );

  const verified = await verifyRun({ runDir, attempt: 1 });
  assert.equal(verified.ok, false);
  assert.match(verified.errors.join(';'), /HONOLOLO_AMENDMENT_DIGEST_INVALID/u);
});

test('amendAsset rejects missing reasons, non-PNG files, and path-like asset names', async () => {
  const runDir = await reviewedManualFixture();
  await renderRun({ runDir, attempt: 1, type: 'manual' });
  const { path: file } = await replacementPng(runDir);

  await assert.rejects(
    amendAsset({ runDir, asset: '001-settings.png', file, reason: '  ' }),
    /HONOLOLO_AMEND_REASON_MISSING/u,
  );
  const textPath = join(runDir, 'not-a-png.png');
  await writeFile(textPath, 'plain text');
  await assert.rejects(
    amendAsset({ runDir, asset: '001-settings.png', file: textPath, reason: 'x' }),
    /HONOLOLO_AMEND_PNG_INVALID/u,
  );
  await assert.rejects(
    amendAsset({ runDir, asset: '../escape.png', file, reason: 'x' }),
    /HONOLOLO_AMEND_ASSET_INVALID/u,
  );
});
