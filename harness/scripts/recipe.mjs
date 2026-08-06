import { readFile, rm } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateContract } from '../lib/contracts.mjs';
import { jobRelative, safeSlug, writeExclusiveJson } from '../lib/files.mjs';
import { rejectSensitive } from '../lib/sensitive.mjs';
import { verifyRun } from './verify-run.mjs';

// A recipe makes a repeat run a re-execution instead of a re-plan. It is derived, never authored:
// extraction re-verifies the source run and reads each step's recorded op list out of that
// attempt's own actions evidence, so a recipe can only say what a verified, fully-passed run
// already proved executable. It names a real host, so it lives only under the operator's
// gitignored target memory.
const MEMORY_ROOT = '.honololo/targets';
const EVIDENCE_TOKEN = '@evidence/';
const EVIDENCE_PATH = /(?:^|\/)attempts\/\d{3}\/evidence\/(.+)$/u;
const PATH_FIELDS = ['path', 'path_prefix'];

function recipeError(code, detail) {
  const error = new Error(detail ? `${code}: ${detail}` : code);
  error.code = code;
  return error;
}

function abstractOps(stepId, ops) {
  if (!Array.isArray(ops) || ops.length === 0 || ops.some((op) => typeof op?.op !== 'string')) {
    throw recipeError('HONOLOLO_RECIPE_ACTIONS_INVALID', stepId);
  }
  return ops.map((op) => {
    const rewritten = { ...op };
    for (const field of PATH_FIELDS) {
      if (rewritten[field] === undefined) continue;
      const located = EVIDENCE_PATH.exec(String(rewritten[field]));
      if (!located) {
        throw recipeError('HONOLOLO_RECIPE_PATH_INVALID', `${stepId}: ${rewritten[field]}`);
      }
      rewritten[field] = `${EVIDENCE_TOKEN}${located[1]}`;
    }
    return rewritten;
  });
}

// A secret never becomes replayable: a redacted input cannot be replayed truthfully, and a
// credential-shaped value must not outlive its run inside a file that persists across runs.
function checkReplayable(stepId, ops) {
  const serialized = JSON.stringify(ops);
  if (ops.some((op) => op.redact === true) || serialized.includes('[REDACTED_INPUT]')) {
    throw recipeError('HONOLOLO_RECIPE_OP_SENSITIVE', `${stepId}: redacted input`);
  }
  const sensitive = rejectSensitive(serialized);
  if (sensitive) throw recipeError('HONOLOLO_RECIPE_OP_SENSITIVE', `${stepId}: ${sensitive}`);
}

export async function extractRecipe({
  runDir, attempt, slug, root = '.', force = false, now = new Date(),
} = {}) {
  if (typeof runDir !== 'string' || runDir === '') throw recipeError('HONOLOLO_RUN_DIR_INVALID');
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw recipeError('HONOLOLO_ATTEMPT_INVALID');
  const name = safeSlug(slug);

  const verified = await verifyRun({ runDir, attempt });
  if (!verified.ok) {
    throw recipeError(
      'HONOLOLO_RECIPE_RUN_UNVERIFIED', JSON.stringify(verified.errors).slice(0, 400),
    );
  }
  const outcome = verified.history.find((entry) => entry.attempt === attempt)?.outcome;
  if (outcome !== 'pass') throw recipeError('HONOLOLO_RECIPE_ATTEMPT_NOT_PASS', String(outcome));

  const run = validateContract('run', JSON.parse(
    await readFile(jobRelative(runDir, 'run.json'), 'utf8'),
  ));
  const plan = validateContract('plan', JSON.parse(
    await readFile(jobRelative(runDir, 'plan/approved.json'), 'utf8'),
  ));
  const manifest = validateContract('evidence', JSON.parse(await readFile(
    jobRelative(runDir, `attempts/${String(attempt).padStart(3, '0')}/evidence.json`), 'utf8',
  )));

  const steps = [];
  for (const planStep of plan.steps) {
    const files = manifest.steps.find(({ id }) => id === planStep.id)?.files ?? [];
    const actions = files.find(
      ({ kind, path }) => kind === 'actions' && path.endsWith('/actions.json'),
    );
    if (!actions) throw recipeError('HONOLOLO_RECIPE_ACTIONS_MISSING', planStep.id);
    const ops = abstractOps(planStep.id, JSON.parse(
      await readFile(jobRelative(runDir, actions.path), 'utf8'),
    ));
    checkReplayable(planStep.id, ops);
    steps.push({ id: planStep.id, ops });
  }

  const host = new URL(run.target.url).hostname;
  const recipe = validateContract('recipe', {
    schema_version: '1',
    slug: name,
    host,
    goal: run.goal,
    request: run,
    plan,
    steps,
    source: {
      run: basename(resolve(runDir)),
      attempt,
      plan_sha256: verified.plan_sha256,
      extracted_at: now.toISOString(),
    },
  });
  const path = jobRelative(resolve(root), `${MEMORY_ROOT}/${host}/recipes/${name}.json`);
  if (force) await rm(path, { force: true });
  await writeExclusiveJson(path, recipe);
  return { path, recipe };
}

export async function emitOps({ recipePath, evidenceDir, stepId = null } = {}) {
  if (typeof recipePath !== 'string' || recipePath === '') {
    throw recipeError('HONOLOLO_RECIPE_PATH_REQUIRED');
  }
  if (typeof evidenceDir !== 'string' || evidenceDir === '') {
    throw recipeError('HONOLOLO_RECIPE_EVIDENCE_DIR_REQUIRED');
  }
  const recipe = validateContract('recipe', JSON.parse(await readFile(recipePath, 'utf8')));
  // The stored request and plan are what a replay will run under; a recipe whose copies no longer
  // validate is not a recipe, however intact its op lists look.
  validateContract('run', recipe.request);
  validateContract('plan', recipe.plan);
  const steps = stepId === null ? recipe.steps : recipe.steps.filter(({ id }) => id === stepId);
  if (steps.length === 0) throw recipeError('HONOLOLO_RECIPE_STEP_UNKNOWN', String(stepId));
  return steps.flatMap(({ ops }) => ops.map((op) => {
    const resolved = { ...op };
    for (const field of PATH_FIELDS) {
      if (typeof resolved[field] === 'string' && resolved[field].startsWith(EVIDENCE_TOKEN)) {
        resolved[field] = `${evidenceDir}/${resolved[field].slice(EVIDENCE_TOKEN.length)}`;
      }
    }
    return resolved;
  }));
}

const USAGE = '(--from-run <run-dir> --attempt <n> --slug <slug> [--root <dir>] [--force]) | ' +
  '(--emit <recipe-file> --evidence-dir <dir> [--step <id>])';

function parseArguments(argv) {
  const options = {
    fromRun: null, attempt: null, slug: null, root: '.', force: false,
    emit: null, evidenceDir: null, step: null,
  };
  let index = 0;
  while (index < argv.length) {
    const flag = argv[index];
    if (flag === '--force') {
      options.force = true;
      index += 1;
      continue;
    }
    const value = argv[index + 1];
    if (typeof value !== 'string' || value === '') throw recipeError('HONOLOLO_RECIPE_USAGE', USAGE);
    if (flag === '--from-run') options.fromRun = value;
    else if (flag === '--attempt') {
      if (!/^\d+$/u.test(value)) throw recipeError('HONOLOLO_RECIPE_USAGE', '--attempt');
      options.attempt = Number(value);
    } else if (flag === '--slug') options.slug = value;
    else if (flag === '--root') options.root = value;
    else if (flag === '--emit') options.emit = value;
    else if (flag === '--evidence-dir') options.evidenceDir = value;
    else if (flag === '--step') options.step = value;
    else throw recipeError('HONOLOLO_RECIPE_USAGE', String(flag));
    index += 2;
  }
  const extracting = options.fromRun !== null;
  const emitting = options.emit !== null;
  if (extracting === emitting) throw recipeError('HONOLOLO_RECIPE_USAGE', USAGE);
  if (extracting && (options.attempt === null || options.slug === null)) {
    throw recipeError('HONOLOLO_RECIPE_USAGE', USAGE);
  }
  if (emitting && options.evidenceDir === null) throw recipeError('HONOLOLO_RECIPE_USAGE', USAGE);
  return options;
}

async function main(argv) {
  const options = parseArguments(argv);
  if (options.fromRun !== null) {
    const { path, recipe } = await extractRecipe({
      runDir: options.fromRun, attempt: options.attempt, slug: options.slug,
      root: options.root, force: options.force,
    });
    process.stdout.write(`${JSON.stringify({
      recipe: path, host: recipe.host, steps: recipe.steps.length,
    })}\n`);
    return;
  }
  const ops = await emitOps({
    recipePath: options.emit, evidenceDir: options.evidenceDir, stepId: options.step,
  });
  process.stdout.write(`${JSON.stringify(ops)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
