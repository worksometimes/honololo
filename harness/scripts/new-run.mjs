import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { validateContract } from '../lib/contracts.mjs';
import { jobRelative, safeSlug, writeExclusiveJson } from '../lib/files.mjs';

const DIRECTORIES = ['inputs', 'scout', 'plan', 'attempts', 'output', 'output/assets'];

function runContractInvalid(details) {
  const error = new TypeError('RUN_CONTRACT_INVALID');
  error.details = details;
  return error;
}

function timestamp(now) {
  if (!(now instanceof Date) || Number.isNaN(now.getTime())) throw new TypeError('HONOLOLO_TIME_INVALID');
  return now.toISOString().replace(/[-:]/g, '').replace('T', '-').replace(/\.\d{3}Z$/, '');
}

export async function createRun({ root, request, now = new Date() }) {
  let run;
  try {
    run = validateContract('run', request);
  } catch (error) {
    if (error?.message !== 'HONOLOLO_RUN_INVALID') throw error;
    throw runContractInvalid(error.details);
  }
  if (typeof root !== 'string' || root === '') throw new TypeError('HONOLOLO_ROOT_INVALID');
  if (!run.target.allowed_domains.includes(new URL(run.target.url).hostname)) {
    throw runContractInvalid([{ instancePath: '/target', message: 'url host is not allowed' }]);
  }

  const base = `.honololo/runs/${timestamp(now)}-${safeSlug(run.id)}`;
  const runsDir = jobRelative(root, '.honololo/runs');
  await mkdir(runsDir, { recursive: true, mode: 0o700 });

  for (let suffix = 1; ; suffix += 1) {
    const relativeRunDir = suffix === 1 ? base : `${base}-${suffix}`;
    const runDir = jobRelative(root, relativeRunDir);
    try {
      await mkdir(runDir, { mode: 0o700 });
    } catch (error) {
      if (error?.code === 'EEXIST') continue;
      throw error;
    }

    for (const directory of DIRECTORIES) {
      await mkdir(jobRelative(runDir, directory), { recursive: true, mode: 0o700 });
    }
    await writeExclusiveJson(jobRelative(runDir, 'run.json'), run);
    return { runDir, relativeRunDir, run, directories: [...DIRECTORIES] };
  }
}

function parseArguments(argv) {
  if (argv.length !== 4 || argv[0] !== '--root' || argv[2] !== '--request') {
    throw new TypeError('HONOLOLO_NEW_RUN_USAGE: --root <path> --request <json-file>');
  }
  return { root: argv[1], requestPath: argv[3] };
}

async function main(argv) {
  const { root, requestPath } = parseArguments(argv);
  const request = JSON.parse(await readFile(requestPath, 'utf8'));
  const created = await createRun({ root, request });
  process.stdout.write(`${JSON.stringify({ run_dir: created.runDir })}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
