import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import sharp from 'sharp';
import { annotateImage } from '../../harness/scripts/annotate.mjs';

const WIDTH = 400;
const HEIGHT = 300;

async function fixtureImage(directory) {
  const path = join(directory, 'base.png');
  const contrast = Buffer.from(
    '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80">' +
    '<rect width="120" height="80" fill="#191F28"/></svg>',
  );
  const base = await sharp({
    create: {
      width: WIDTH, height: HEIGHT, channels: 3, background: { r: 255, g: 255, b: 255 },
    },
  }).composite([{ input: contrast, left: 40, top: 40 }]).png().toBuffer();
  await writeFile(path, base);
  return { path, base };
}

function pixelAt(raw, x, y) {
  const offset = (y * WIDTH + x) * 3;
  return [raw[offset], raw[offset + 1], raw[offset + 2]];
}

const fullSpec = {
  schema_version: '1',
  annotations: [
    { type: 'box', rect: [40, 40, 120, 80], label: '더 보기 버튼', badge: 1 },
    { type: 'cover', rect: [250, 20, 120, 30] },
    { type: 'blur', rect: [60, 150, 100, 60] },
    { type: 'arrow', from: [300, 250], to: [200, 200], color: 'red' },
    { type: 'badge', at: [350, 150], number: 2 },
    { type: 'label', at: [200, 260], text: 'Notion 연결', color: 'gray' },
  ],
};

test('annotateImage renders Toss-style overlay layers onto the capture', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'honololo-annotate-'));
  const { path, base } = await fixtureImage(directory);
  const output = join(directory, 'annotated.png');

  const result = await annotateImage({ input: path, spec: fullSpec, output });
  assert.equal(result.width, WIDTH);
  assert.equal(result.height, HEIGHT);
  assert.equal(result.annotations, fullSpec.annotations.length);

  const annotated = sharp(result.output);
  const metadata = await annotated.metadata();
  assert.equal(metadata.width, WIDTH);
  assert.equal(metadata.height, HEIGHT);

  const raw = await annotated.removeAlpha().raw().toBuffer();
  const baseRaw = await sharp(base).removeAlpha().raw().toBuffer();
  assert.notDeepEqual(raw, baseRaw);

  const [coverR, coverG, coverB] = pixelAt(raw, 310, 35);
  for (const [channel, expected] of [[coverR, 0xe5], [coverG, 0xe8], [coverB, 0xeb]]) {
    assert.equal(Math.abs(channel - expected) <= 8, true, 'cover fill should be neutral gray');
  }

  const [badgeR, , badgeB] = pixelAt(raw, 350, 150);
  assert.equal(badgeB > badgeR, true, 'badge center should be blue-dominant');

  const boxEdge = pixelAt(raw, 100, 40);
  assert.notDeepEqual(boxEdge, [255, 255, 255], 'box stroke should cross the top edge');
});

test('annotateImage blurs the requested region without moving other pixels', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'honololo-annotate-'));
  const { path, base } = await fixtureImage(directory);
  const output = join(directory, 'blurred.png');

  await annotateImage({
    input: path,
    spec: { schema_version: '1', annotations: [{ type: 'blur', rect: [30, 30, 140, 100] }] },
    output,
  });

  const raw = await sharp(output).removeAlpha().raw().toBuffer();
  const baseRaw = await sharp(base).removeAlpha().raw().toBuffer();
  assert.notDeepEqual(pixelAt(raw, 45, 45), pixelAt(baseRaw, 45, 45), 'contrast edge should change');
  assert.deepEqual(pixelAt(raw, 380, 280), pixelAt(baseRaw, 380, 280), 'far corner should not change');
});

test('annotateImage rejects invalid specs, bounds, and output conflicts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'honololo-annotate-'));
  const { path } = await fixtureImage(directory);

  await assert.rejects(
    annotateImage({
      input: path,
      spec: { schema_version: '1', annotations: [{ type: 'sticker', rect: [0, 0, 10, 10] }] },
      output: join(directory, 'invalid.png'),
    }),
    /HONOLOLO_ANNOTATE_INVALID/u,
  );

  await assert.rejects(
    annotateImage({
      input: path,
      spec: { schema_version: '1', annotations: [{ type: 'cover', rect: [390, 290, 40, 40] }] },
      output: join(directory, 'bounds.png'),
    }),
    /HONOLOLO_ANNOTATE_RECT_OUT_OF_BOUNDS/u,
  );

  const output = join(directory, 'once.png');
  const spec = { schema_version: '1', annotations: [{ type: 'badge', at: [50, 50], number: 3 }] };
  await annotateImage({ input: path, spec, output });
  await assert.rejects(
    annotateImage({ input: path, spec, output }),
    /HONOLOLO_ANNOTATE_OUTPUT_CONFLICT/u,
  );
});
