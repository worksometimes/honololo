import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { buildOverlaySvg, roundedRectMaskSvg } from '../lib/annotate-svg.mjs';
import { validateContract } from '../lib/contracts.mjs';

const MAX_IMAGE_BYTES = 64 * 1024 * 1024;
const MAX_SPEC_BYTES = 2 * 1024 * 1024;
const DEFAULT_BLUR_SIGMA = 14;

function annotateError(code, detail) {
  const error = new Error(detail ? `${code}: ${detail}` : code);
  error.code = code;
  return error;
}

async function readRegular(path, label, maxBytes) {
  let stat;
  try {
    stat = await lstat(path);
  } catch (error) {
    if (error?.code === 'ENOENT') throw annotateError('HONOLOLO_ANNOTATE_INPUT_MISSING', label);
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > maxBytes) {
    throw annotateError('HONOLOLO_ANNOTATE_INPUT_INVALID', label);
  }
  return readFile(path);
}

function checkBounds(annotation, width, height) {
  const rects = annotation.rect ? [annotation.rect] : [];
  const points = [annotation.at, annotation.from, annotation.to].filter(Boolean);
  for (const [x, y, w, h] of rects) {
    if (x + w > width || y + h > height) {
      throw annotateError('HONOLOLO_ANNOTATE_RECT_OUT_OF_BOUNDS', `${x},${y},${w},${h}`);
    }
  }
  for (const [x, y] of points) {
    if (x > width || y > height) {
      throw annotateError('HONOLOLO_ANNOTATE_POINT_OUT_OF_BOUNDS', `${x},${y}`);
    }
  }
}

async function blurComposite(baseBuffer, annotation) {
  const [left, top, width, height] = annotation.rect;
  const sigma = annotation.sigma ?? DEFAULT_BLUR_SIGMA;
  const patch = await sharp(baseBuffer)
    .extract({ left, top, width, height })
    .blur(sigma)
    .composite([{ input: Buffer.from(roundedRectMaskSvg(width, height)), blend: 'dest-in' }])
    .png()
    .toBuffer();
  return { input: patch, left, top };
}

export async function annotateImage({ input, spec, output } = {}) {
  if (typeof input !== 'string' || input === '') throw annotateError('HONOLOLO_ANNOTATE_USAGE', 'input');
  if (typeof output !== 'string' || output === '') throw annotateError('HONOLOLO_ANNOTATE_USAGE', 'output');
  const checked = validateContract('annotate', spec);

  const baseBuffer = await readRegular(input, input, MAX_IMAGE_BYTES);
  const image = sharp(baseBuffer);
  const metadata = await image.metadata();
  if (metadata.format !== 'png' || !metadata.width || !metadata.height) {
    throw annotateError('HONOLOLO_ANNOTATE_INPUT_INVALID', 'png required');
  }
  for (const annotation of checked.annotations) {
    checkBounds(annotation, metadata.width, metadata.height);
  }

  const composites = [];
  for (const annotation of checked.annotations) {
    if (annotation.type === 'blur') composites.push(await blurComposite(baseBuffer, annotation));
  }
  composites.push({
    input: Buffer.from(buildOverlaySvg({
      width: metadata.width,
      height: metadata.height,
      annotations: checked.annotations,
    })),
    left: 0,
    top: 0,
  });

  const annotated = await image.composite(composites).png().toBuffer();
  await mkdir(dirname(resolve(output)), { recursive: true, mode: 0o700 });
  try {
    await writeFile(output, annotated, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error?.code === 'EEXIST') throw annotateError('HONOLOLO_ANNOTATE_OUTPUT_CONFLICT', output);
    throw error;
  }
  return {
    output: resolve(output),
    width: metadata.width,
    height: metadata.height,
    annotations: checked.annotations.length,
  };
}

function parseArguments(argv) {
  if (argv.length !== 6 || argv[0] !== '--input' || argv[2] !== '--spec' || argv[4] !== '--output') {
    throw annotateError(
      'HONOLOLO_ANNOTATE_USAGE', '--input <png> --spec <json-file> --output <png>',
    );
  }
  return { input: argv[1], specPath: argv[3], output: argv[5] };
}

async function main(argv) {
  const { input, specPath, output } = parseArguments(argv);
  const specBytes = await readRegular(specPath, specPath, MAX_SPEC_BYTES);
  let spec;
  try {
    spec = JSON.parse(specBytes.toString('utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) throw annotateError('HONOLOLO_ANNOTATE_SPEC_INVALID', specPath);
    throw error;
  }
  const result = await annotateImage({ input, spec, output });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
