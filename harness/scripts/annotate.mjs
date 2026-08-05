import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { buildOverlaySvg, roundedRectMaskSvg } from '../lib/annotate-svg.mjs';
import { validateContract } from '../lib/contracts.mjs';
import { readCropSidecar } from './crop.mjs';

const MAX_IMAGE_BYTES = 64 * 1024 * 1024;
const MAX_SPEC_BYTES = 2 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
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

function snapshotIndex(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.elements)) {
    throw annotateError('HONOLOLO_ANNOTATE_SNAPSHOT_INVALID');
  }
  const index = new Map();
  for (const element of snapshot.elements) {
    if (typeof element?.ref === 'string' && Array.isArray(element.box) &&
        element.box.length === 4 && element.box.every(Number.isSafeInteger)) {
      index.set(element.ref, element.box);
    }
  }
  return index;
}

function translateRect(rect, pad, offset) {
  const [x, y, width, height] = rect;
  const padded = [x - pad, y - pad, width + pad * 2, height + pad * 2];
  const shifted = [padded[0] - offset[0], padded[1] - offset[1], padded[2], padded[3]];
  const clampedX = Math.max(shifted[0], 0);
  const clampedY = Math.max(shifted[1], 0);
  return [
    clampedX,
    clampedY,
    shifted[2] - (clampedX - shifted[0]),
    shifted[3] - (clampedY - shifted[1]),
  ];
}

function translatePoint(point, offset) {
  return [point[0] - offset[0], point[1] - offset[1]];
}

function resolveAnnotations(checked, { refs, offset }) {
  const sourceSpace = checked.coordinate_space === 'source';
  const rectOffset = sourceSpace ? offset : [0, 0];
  return checked.annotations.map((annotation) => {
    const resolved = { ...annotation };
    if (annotation.ref !== undefined) {
      if (refs === null) throw annotateError('HONOLOLO_ANNOTATE_SNAPSHOT_REQUIRED', annotation.ref);
      const box = refs.get(annotation.ref);
      if (!box) throw annotateError('HONOLOLO_ANNOTATE_REF_UNKNOWN', annotation.ref);
      resolved.rect = translateRect(box, annotation.pad ?? 0, offset);
      delete resolved.ref;
      delete resolved.pad;
    } else if (annotation.rect) {
      resolved.rect = translateRect(annotation.rect, annotation.pad ?? 0, rectOffset);
      delete resolved.pad;
    }
    for (const key of ['at', 'from', 'to']) {
      if (annotation[key]) resolved[key] = translatePoint(annotation[key], rectOffset);
    }
    return resolved;
  });
}

function checkBounds(annotation, width, height) {
  const rects = annotation.rect ? [annotation.rect] : [];
  const points = [annotation.at, annotation.from, annotation.to].filter(Boolean);
  for (const [x, y, w, h] of rects) {
    if (x < 0 || y < 0 || w < 1 || h < 1 || x + w > width || y + h > height) {
      throw annotateError('HONOLOLO_ANNOTATE_RECT_OUT_OF_BOUNDS', `${x},${y},${w},${h}`);
    }
  }
  for (const [x, y] of points) {
    if (x < 0 || y < 0 || x > width || y > height) {
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

export async function annotateImage({ input, spec, output, snapshot = null, force = false } = {}) {
  if (typeof input !== 'string' || input === '') throw annotateError('HONOLOLO_ANNOTATE_USAGE', 'input');
  if (typeof output !== 'string' || output === '') throw annotateError('HONOLOLO_ANNOTATE_USAGE', 'output');
  const checked = validateContract('annotate', spec);

  const sidecar = await readCropSidecar(input);
  if (checked.coordinate_space === 'source' && !sidecar) {
    throw annotateError('HONOLOLO_ANNOTATE_SIDECAR_MISSING', input);
  }
  const offset = sidecar ? [sidecar.rect[0], sidecar.rect[1]] : [0, 0];
  const usesRefs = checked.annotations.some((annotation) => annotation.ref !== undefined);
  const refs = usesRefs && snapshot !== null ? snapshotIndex(snapshot) : (usesRefs ? null : new Map());
  const annotations = resolveAnnotations(checked, { refs, offset });

  const baseBuffer = await readRegular(input, input, MAX_IMAGE_BYTES);
  const image = sharp(baseBuffer);
  const metadata = await image.metadata();
  if (metadata.format !== 'png' || !metadata.width || !metadata.height) {
    throw annotateError('HONOLOLO_ANNOTATE_INPUT_INVALID', 'png required');
  }
  for (const annotation of annotations) {
    checkBounds(annotation, metadata.width, metadata.height);
  }

  const composites = [];
  for (const annotation of annotations) {
    if (annotation.type === 'blur') composites.push(await blurComposite(baseBuffer, annotation));
  }
  composites.push({
    input: Buffer.from(buildOverlaySvg({
      width: metadata.width,
      height: metadata.height,
      annotations,
    })),
    left: 0,
    top: 0,
  });

  const annotated = await image.composite(composites).png().toBuffer();
  await mkdir(dirname(resolve(output)), { recursive: true, mode: 0o700 });
  try {
    await writeFile(output, annotated, { flag: force ? 'w' : 'wx', mode: 0o600 });
  } catch (error) {
    if (error?.code === 'EEXIST') throw annotateError('HONOLOLO_ANNOTATE_OUTPUT_CONFLICT', output);
    throw error;
  }
  return {
    output: resolve(output),
    width: metadata.width,
    height: metadata.height,
    annotations: annotations.length,
  };
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
    if (typeof value !== 'string' || value === '') throw annotateError('HONOLOLO_ANNOTATE_USAGE', flag);
    if (flag === '--input') options.input = value;
    else if (flag === '--spec') options.specPath = value;
    else if (flag === '--output') options.output = value;
    else if (flag === '--snapshot') options.snapshotPath = value;
    else throw annotateError('HONOLOLO_ANNOTATE_USAGE', String(flag));
    index += 1;
  }
  if (!options.input || !options.specPath || !options.output) {
    throw annotateError(
      'HONOLOLO_ANNOTATE_USAGE',
      '--input <png> --spec <json-file> --output <png> [--snapshot <json-file>] [--force]',
    );
  }
  return options;
}

async function readJsonFile(path, maxBytes, invalidCode) {
  const bytes = await readRegular(path, path, maxBytes);
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) throw annotateError(invalidCode, path);
    throw error;
  }
}

async function main(argv) {
  const { input, specPath, output, snapshotPath, force } = parseArguments(argv);
  const spec = await readJsonFile(specPath, MAX_SPEC_BYTES, 'HONOLOLO_ANNOTATE_SPEC_INVALID');
  const snapshot = snapshotPath
    ? await readJsonFile(snapshotPath, MAX_SNAPSHOT_BYTES, 'HONOLOLO_ANNOTATE_SNAPSHOT_INVALID')
    : null;
  const result = await annotateImage({ input, spec, output, snapshot, force });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
