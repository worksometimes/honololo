import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const MAX_IMAGE_BYTES = 64 * 1024 * 1024;

function cropError(code, detail) {
  const error = new Error(detail ? `${code}: ${detail}` : code);
  error.code = code;
  return error;
}

async function readRegular(path, label, maxBytes) {
  let stat;
  try {
    stat = await lstat(path);
  } catch (error) {
    if (error?.code === 'ENOENT') throw cropError('HONOLOLO_CROP_INPUT_MISSING', label);
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > maxBytes) {
    throw cropError('HONOLOLO_CROP_INPUT_INVALID', label);
  }
  return readFile(path);
}

async function writeChecked(path, bytes, force) {
  await mkdir(dirname(resolve(path)), { recursive: true, mode: 0o700 });
  try {
    await writeFile(path, bytes, { flag: force ? 'w' : 'wx', mode: 0o600 });
  } catch (error) {
    if (error?.code === 'EEXIST') throw cropError('HONOLOLO_CROP_OUTPUT_CONFLICT', path);
    throw error;
  }
}

export async function cropImage({ input, rect, output, force = false } = {}) {
  if (typeof input !== 'string' || input === '') throw cropError('HONOLOLO_CROP_USAGE', 'input');
  if (typeof output !== 'string' || output === '') throw cropError('HONOLOLO_CROP_USAGE', 'output');
  if (!Array.isArray(rect) || rect.length !== 4 ||
      rect.some((value) => !Number.isSafeInteger(value)) ||
      rect[0] < 0 || rect[1] < 0 || rect[2] < 1 || rect[3] < 1) {
    throw cropError('HONOLOLO_CROP_RECT_INVALID', JSON.stringify(rect));
  }

  const baseBuffer = await readRegular(input, input, MAX_IMAGE_BYTES);
  const metadata = await sharp(baseBuffer).metadata();
  if (metadata.format !== 'png' || !metadata.width || !metadata.height) {
    throw cropError('HONOLOLO_CROP_INPUT_INVALID', 'png required');
  }
  const [x, y, width, height] = rect;
  if (x + width > metadata.width || y + height > metadata.height) {
    throw cropError('HONOLOLO_CROP_RECT_OUT_OF_BOUNDS', `${x},${y},${width},${height}`);
  }

  const cropped = await sharp(baseBuffer)
    .extract({ left: x, top: y, width, height })
    .png()
    .toBuffer();
  const sidecar = {
    schema_version: '1',
    source: resolve(input),
    source_width: metadata.width,
    source_height: metadata.height,
    rect: [x, y, width, height],
  };
  await writeChecked(output, cropped, force);
  await writeChecked(
    `${output}.crop.json`,
    Buffer.from(`${JSON.stringify(sidecar, null, 2)}\n`, 'utf8'),
    true,
  );
  return { output: resolve(output), sidecar: resolve(`${output}.crop.json`), width, height };
}

export async function readCropSidecar(imagePath) {
  const path = `${imagePath}.crop.json`;
  let bytes;
  try {
    bytes = await readRegular(path, path, 1024 * 1024);
  } catch (error) {
    if (error?.code === 'HONOLOLO_CROP_INPUT_MISSING') return null;
    throw error;
  }
  let value;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) throw cropError('HONOLOLO_CROP_SIDECAR_INVALID', path);
    throw error;
  }
  if (value?.schema_version !== '1' || !Array.isArray(value.rect) || value.rect.length !== 4 ||
      value.rect.some((entry) => !Number.isSafeInteger(entry) || entry < 0)) {
    throw cropError('HONOLOLO_CROP_SIDECAR_INVALID', path);
  }
  return value;
}

function parseArguments(argv) {
  const options = { force: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--force') {
      options.force = true;
      continue;
    }
    const value = argv[index + 1];
    if (typeof value !== 'string' || value === '') throw cropError('HONOLOLO_CROP_USAGE', flag);
    if (flag === '--input') options.input = value;
    else if (flag === '--output') options.output = value;
    else if (flag === '--rect') {
      options.rect = value.split(',').map((part) => Number(part));
    } else throw cropError('HONOLOLO_CROP_USAGE', String(flag));
    index += 1;
  }
  if (!options.input || !options.output || !options.rect) {
    throw cropError('HONOLOLO_CROP_USAGE', '--input <png> --rect <x,y,w,h> --output <png> [--force]');
  }
  return options;
}

async function main(argv) {
  const result = await cropImage(parseArguments(argv));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
