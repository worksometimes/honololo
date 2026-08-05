import { createHash } from 'node:crypto';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateContract } from '../lib/contracts.mjs';
import { jobRelative } from '../lib/files.mjs';

const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');
const MAX_IMAGE_BYTES = 64 * 1024 * 1024;
const MAX_JSON_BYTES = 2 * 1024 * 1024;

function amendError(code, detail) {
  const error = new Error(detail ? `${code}: ${detail}` : code);
  error.code = code;
  return error;
}

function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

async function readRegular(path, label, maxBytes) {
  let stat;
  try {
    stat = await lstat(path);
  } catch (error) {
    if (error?.code === 'ENOENT') throw amendError('HONOLOLO_AMEND_INPUT_MISSING', label);
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > maxBytes) {
    throw amendError('HONOLOLO_AMEND_INPUT_INVALID', label);
  }
  return readFile(path);
}

async function optionalBytes(path, label, maxBytes) {
  try {
    return await readRegular(path, label, maxBytes);
  } catch (error) {
    if (error?.code === 'HONOLOLO_AMEND_INPUT_MISSING') return null;
    throw error;
  }
}

export async function amendAsset({ runDir, asset, file, reason, at } = {}) {
  if (typeof runDir !== 'string' || runDir === '') throw amendError('HONOLOLO_AMEND_USAGE', 'runDir');
  if (typeof asset !== 'string' || asset === '') throw amendError('HONOLOLO_AMEND_USAGE', 'asset');
  if (typeof file !== 'string' || file === '') throw amendError('HONOLOLO_AMEND_USAGE', 'file');
  if (typeof reason !== 'string' || reason.trim() === '') {
    throw amendError('HONOLOLO_AMEND_REASON_MISSING');
  }
  if (asset.includes('/') || asset.includes('\\')) {
    throw amendError('HONOLOLO_AMEND_ASSET_INVALID', asset);
  }

  const runBytes = await readRegular(jobRelative(runDir, 'run.json'), 'run.json', MAX_JSON_BYTES);
  const run = validateContract('run', JSON.parse(runBytes.toString('utf8')));

  const replacement = await readRegular(file, file, MAX_IMAGE_BYTES);
  if (!replacement.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw amendError('HONOLOLO_AMEND_PNG_INVALID', file);
  }

  const assetPath = jobRelative(runDir, `output/assets/${asset}`);
  const previous = await optionalBytes(assetPath, asset, MAX_IMAGE_BYTES);

  const logPath = jobRelative(runDir, 'output/amendments.json');
  const existingBytes = await optionalBytes(logPath, 'output/amendments.json', MAX_JSON_BYTES);
  let log = { schema_version: '1', run_id: run.id, amendments: [] };
  if (existingBytes !== null) {
    log = validateContract('amendment', JSON.parse(existingBytes.toString('utf8')));
    if (log.run_id !== run.id) throw amendError('HONOLOLO_AMEND_RUN_ID_MISMATCH');
  }

  const record = {
    asset,
    at: at ?? new Date().toISOString(),
    reason: reason.trim(),
    sha256: sha256(replacement),
    ...(previous !== null ? { replaced_sha256: sha256(previous) } : {}),
  };
  log.amendments.push(record);
  validateContract('amendment', log);

  await writeFile(assetPath, replacement, { mode: 0o600 });
  await writeFile(logPath, `${JSON.stringify(log, null, 2)}\n`, {
    encoding: 'utf8', mode: 0o600,
  });
  return { asset: assetPath, log: logPath, record };
}

function parseArguments(argv) {
  if (argv.length < 1) throw amendError('HONOLOLO_AMEND_USAGE', '<run-dir> required');
  const options = { runDir: argv[0] };
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (typeof value !== 'string' || value === '') throw amendError('HONOLOLO_AMEND_USAGE', flag);
    if (flag === '--asset') options.asset = value;
    else if (flag === '--file') options.file = value;
    else if (flag === '--reason') options.reason = value;
    else throw amendError('HONOLOLO_AMEND_USAGE', String(flag));
  }
  if (!options.asset || !options.file || !options.reason) {
    throw amendError(
      'HONOLOLO_AMEND_USAGE',
      '<run-dir> --asset <name.png> --file <replacement.png> --reason "<why>"',
    );
  }
  return options;
}

async function main(argv) {
  const result = await amendAsset(parseArguments(argv));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
