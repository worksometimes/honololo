import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import sharp from 'sharp';
import { cropImage, readCropSidecar } from '../../harness/scripts/crop.mjs';

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
  return path;
}

test('cropImage writes the cropped region and an offset sidecar', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'honololo-crop-'));
  const input = await fixtureImage(directory);
  const output = join(directory, 'cropped.png');

  const result = await cropImage({ input, rect: [30, 20, 200, 150], output });
  assert.equal(result.width, 200);
  assert.equal(result.height, 150);

  const metadata = await sharp(output).metadata();
  assert.equal(metadata.width, 200);
  assert.equal(metadata.height, 150);

  const sidecar = JSON.parse(await readFile(`${output}.crop.json`, 'utf8'));
  assert.equal(sidecar.schema_version, '1');
  assert.deepEqual(sidecar.rect, [30, 20, 200, 150]);
  assert.equal(sidecar.source_width, WIDTH);
  assert.equal(sidecar.source_height, HEIGHT);

  const loaded = await readCropSidecar(output);
  assert.deepEqual(loaded.rect, [30, 20, 200, 150]);
  assert.equal(await readCropSidecar(input), null);
});

test('cropImage rejects out-of-bounds rects and output conflicts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'honololo-crop-'));
  const input = await fixtureImage(directory);

  await assert.rejects(
    cropImage({ input, rect: [300, 200, 200, 150], output: join(directory, 'oob.png') }),
    /HONOLOLO_CROP_RECT_OUT_OF_BOUNDS/u,
  );
  await assert.rejects(
    cropImage({ input, rect: [0, 0, 0, 10], output: join(directory, 'zero.png') }),
    /HONOLOLO_CROP_RECT_INVALID/u,
  );

  const output = join(directory, 'once.png');
  await cropImage({ input, rect: [0, 0, 50, 50], output });
  await assert.rejects(
    cropImage({ input, rect: [0, 0, 50, 50], output }),
    /HONOLOLO_CROP_OUTPUT_CONFLICT/u,
  );
  await cropImage({ input, rect: [0, 0, 50, 50], output, force: true });
});
