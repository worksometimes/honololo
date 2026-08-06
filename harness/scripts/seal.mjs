import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateContract } from '../lib/contracts.mjs';
import {
  DETERMINISTIC_TYPES, evaluateAttempt, pairedScreenshotDigest, worstVerdict,
} from '../lib/criteria.mjs';
import { jobRelative, writeExclusiveJson } from '../lib/files.mjs';

const MAX_EVIDENCE_BYTES = 64 * 1024 * 1024;

function sealError(code, detail) {
  const error = new Error(detail ? `${code}: ${detail}` : code);
  error.code = code;
  return error;
}

// Evidence kind is inferred from the file name so the transport's own output names seal without
// renaming: `capture` writes `<step>.png` plus `<step>.snapshot.json`.
function inferKind(name) {
  if (name === 'url.txt') return 'url';
  if (name === 'actions.json' || name === 'actions.jsonl') return 'actions';
  if (name.endsWith('.png')) return 'screenshot';
  if (name.endsWith('snapshot.json') || name === 'snapshot.md') return 'snapshot';
  return null;
}

async function readStepFiles(runDir, attemptDir, stepId) {
  const directory = jobRelative(runDir, `${attemptDir}/evidence/${stepId}`);
  const entries = await readdir(directory, { withFileTypes: true });
  const files = new Map();
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile()) throw sealError('HONOLOLO_SEAL_ENTRY_INVALID', `${stepId}/${entry.name}`);
    const kind = inferKind(entry.name);
    if (kind === null) throw sealError('HONOLOLO_SEAL_FILE_UNKNOWN', `${stepId}/${entry.name}`);
    if (files.has(kind)) {
      throw sealError('HONOLOLO_SEAL_KIND_DUPLICATE', `${stepId}:${kind}`);
    }
    const path = `${attemptDir}/evidence/${stepId}/${entry.name}`;
    const absolute = jobRelative(runDir, path);
    const info = await stat(absolute);
    if (info.size === 0 || info.size > MAX_EVIDENCE_BYTES) {
      throw sealError('HONOLOLO_SEAL_FILE_SIZE_INVALID', path);
    }
    const bytes = await readFile(absolute);
    files.set(kind, {
      kind,
      path,
      size: bytes.length,
      sha256: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
      captured_at: info.mtime.toISOString(),
      bytes: kind === 'screenshot' ? bytes.subarray(0, 8) : bytes,
    });
  }
  return files;
}

// The `capture` op records the screenshot digest inside the snapshot it was taken with. Checking it
// here makes the atomic-pair rule mechanical instead of a prose instruction the executor may skip.
function checkPairing(stepId, files) {
  const paired = pairedScreenshotDigest(files.get('snapshot'));
  if (paired === null) return;
  const screenshot = files.get('screenshot');
  if (!screenshot || screenshot.sha256 !== paired) {
    throw sealError('HONOLOLO_SEAL_CAPTURE_PAIR_INVALID', stepId);
  }
}

async function readContract(runDir, relative, contract) {
  return validateContract(contract, JSON.parse(
    await readFile(jobRelative(runDir, relative), 'utf8'),
  ));
}

// Re-capturing an entire plan because one step drifted is the retry cost that makes an agent reach
// for a copied capture or abandon the run. An attempt may instead inherit an earlier attempt's
// evidence for the steps that already passed there, and re-capture only what actually needs
// re-observing. The bytes are the originals, still at their original paths, re-hashed here against
// the digest the source manifest recorded — so inheritance moves nothing and forges nothing.
async function loadInheritance(runDir, attempt, source, planSha256, plan) {
  if (source === null) return null;
  if (!Number.isSafeInteger(source) || source < 1 || source >= attempt) {
    throw sealError('HONOLOLO_SEAL_INHERIT_ATTEMPT_INVALID', String(source));
  }
  const dir = `attempts/${String(source).padStart(3, '0')}`;
  let manifest;
  let status;
  try {
    manifest = await readContract(runDir, `${dir}/evidence.json`, 'evidence');
    status = await readContract(runDir, `${dir}/status.json`, 'review');
  } catch (error) {
    if (error?.code === 'ENOENT') throw sealError('HONOLOLO_SEAL_INHERIT_SOURCE_MISSING', dir);
    throw error;
  }
  // Inheriting across a plan change would attach one plan's evidence to another's criteria.
  if (manifest.plan_sha256 !== planSha256) {
    throw sealError('HONOLOLO_SEAL_INHERIT_PLAN_MISMATCH', dir);
  }
  const verdicts = new Map(status.criteria.map(({ id, verdict }) => [id, verdict]));
  try {
    const fresh = await readContract(runDir, `${dir}/fresh.json`, 'review');
    for (const { id, verdict } of fresh.criteria) verdicts.set(id, verdict);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  // Only a step every one of whose criteria passed at the source is inheritable. A step that failed,
  // was withheld, or was never reviewed there has to be observed again — inheritance carries settled
  // evidence forward, never an unresolved verdict.
  const passed = new Set();
  for (const step of plan.steps) {
    if (step.done_when.every(({ id }) => verdicts.get(id) === 'pass')) passed.add(step.id);
  }
  return { attempt: source, manifest, passed };
}

// The recorded paths are followed rather than a directory guessed from the source attempt number, so
// a step inherited twice still points at the attempt whose bytes it actually is. Every file of one
// step must live in that single directory, which keeps `inherited_from` an exact claim.
async function inheritStepFiles(runDir, sourceStep, stepId) {
  const files = new Map();
  let origin = null;
  for (const entry of sourceStep.files) {
    const located = /^attempts\/(\d{3})\/evidence\/([a-z0-9][a-z0-9-]{0,63})\//u.exec(entry.path);
    if (!located || located[2] !== stepId || (origin !== null && Number(located[1]) !== origin)) {
      throw sealError('HONOLOLO_SEAL_INHERIT_PATH_INVALID', entry.path);
    }
    origin = Number(located[1]);
    if (files.has(entry.kind)) throw sealError('HONOLOLO_SEAL_KIND_DUPLICATE', `${stepId}:${entry.kind}`);
    const absolute = jobRelative(runDir, entry.path);
    const info = await stat(absolute);
    if (info.size === 0 || info.size > MAX_EVIDENCE_BYTES) {
      throw sealError('HONOLOLO_SEAL_FILE_SIZE_INVALID', entry.path);
    }
    const bytes = await readFile(absolute);
    const sha256 = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
    if (bytes.length !== entry.bytes || sha256 !== entry.sha256) {
      throw sealError('HONOLOLO_SEAL_INHERIT_DIGEST_INVALID', entry.path);
    }
    files.set(entry.kind, {
      kind: entry.kind,
      path: entry.path,
      size: bytes.length,
      sha256,
      captured_at: entry.captured_at,
      bytes: entry.kind === 'screenshot' ? bytes.subarray(0, 8) : bytes,
    });
  }
  return { files, origin };
}

function checkDeclaredKinds(stepId, planStep, files) {
  const declared = new Set(planStep.evidence);
  for (const kind of files.keys()) {
    if (!declared.has(kind)) throw sealError('HONOLOLO_SEAL_KIND_UNAPPROVED', `${stepId}:${kind}`);
  }
  for (const kind of declared) {
    if (!files.has(kind)) throw sealError('HONOLOLO_SEAL_KIND_MISSING', `${stepId}:${kind}`);
  }
}

async function collectSteps(runDir, attemptDir, plan, inheritance) {
  const stepsById = new Map();
  const inherited = new Map();
  const missing = [];
  let captured = 0;
  for (const planStep of plan.steps) {
    let files;
    try {
      files = await readStepFiles(runDir, attemptDir, planStep.id);
      captured += 1;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      const source = inheritance?.manifest.steps.find(({ id }) => id === planStep.id);
      if (!inheritance || !source || !inheritance.passed.has(planStep.id)) {
        missing.push(planStep.id);
        continue;
      }
      const carried = await inheritStepFiles(runDir, source, planStep.id);
      files = carried.files;
      inherited.set(planStep.id, carried.origin);
    }
    checkDeclaredKinds(planStep.id, planStep, files);
    checkPairing(planStep.id, files);
    stepsById.set(planStep.id, { id: planStep.id, files });
  }
  if (missing.length > 0) throw sealError('HONOLOLO_SEAL_STEP_MISSING', missing.join(', '));
  // An attempt that observed nothing is a copy of its predecessor, not a retry.
  if (captured === 0) throw sealError('HONOLOLO_SEAL_INHERIT_ALL');
  return { stepsById, inherited };
}

function applyWithheld(records, withheld, plan) {
  const deterministic = new Set();
  for (const step of plan.steps) {
    for (const criterion of step.done_when) {
      if (DETERMINISTIC_TYPES.has(criterion.type)) deterministic.add(criterion.id);
    }
  }
  for (const id of withheld.keys()) {
    if (!deterministic.has(id)) throw sealError('HONOLOLO_SEAL_WITHHELD_UNKNOWN', id);
  }
  // Withholding never softens a verdict: a criterion the bytes deterministically fail stays `fail`,
  // with the operator's reason recorded beside it.
  return records.map((record) => withheld.has(record.id)
    ? {
      ...record,
      verdict: worstVerdict([record.verdict, 'needs_human']),
      reason: `withheld by operator: ${withheld.get(record.id)} (evidence: ${record.reason})`,
    }
    : record);
}

export async function sealAttempt({
  runDir, attempt, withheld = new Map(), inheritFrom = null,
} = {}) {
  if (typeof runDir !== 'string' || runDir === '') throw sealError('HONOLOLO_RUN_DIR_INVALID');
  if (!Number.isSafeInteger(attempt) || attempt < 1) throw sealError('HONOLOLO_ATTEMPT_INVALID');
  const attemptDir = `attempts/${String(attempt).padStart(3, '0')}`;

  const run = validateContract('run', JSON.parse(
    await readFile(jobRelative(runDir, 'run.json'), 'utf8'),
  ));
  const planBytes = await readFile(jobRelative(runDir, 'plan/approved.json'));
  const plan = validateContract('plan', JSON.parse(planBytes.toString('utf8')));
  if (plan.run_id !== run.id) throw sealError('HONOLOLO_RUN_PLAN_ID_INVALID');

  const planSha256 = `sha256:${createHash('sha256').update(planBytes).digest('hex')}`;
  const inheritance = await loadInheritance(runDir, attempt, inheritFrom, planSha256, plan);
  const { stepsById, inherited } = await collectSteps(runDir, attemptDir, plan, inheritance);
  const evidence = validateContract('evidence', {
    schema_version: '1',
    run_id: run.id,
    attempt,
    plan_sha256: planSha256,
    steps: plan.steps.map((planStep) => ({
      id: planStep.id,
      ...(inherited.has(planStep.id) ? { inherited_from: inherited.get(planStep.id) } : {}),
      files: [...stepsById.get(planStep.id).files.values()].map(
        ({ kind, path, size, sha256, captured_at: capturedAt }) => ({
          kind, path, bytes: size, sha256, captured_at: capturedAt,
        }),
      ),
    })),
  });

  const criteria = applyWithheld(evaluateAttempt(plan, stepsById), withheld, plan);
  const status = validateContract('review', {
    schema_version: '1',
    run_id: run.id,
    attempt,
    source: 'deterministic',
    outcome: worstVerdict(criteria.map(({ verdict }) => verdict)),
    criteria,
  });

  await writeExclusiveJson(jobRelative(runDir, `${attemptDir}/evidence.json`), evidence);
  await writeExclusiveJson(jobRelative(runDir, `${attemptDir}/status.json`), status);
  return { evidence, status };
}

const SEAL_USAGE =
  '<run-dir> --attempt <n> [--inherit-from <n>] [--needs-human <id>=<reason>]...';

function parseArguments(argv) {
  const options = { runDir: argv[0], attempt: null, withheld: new Map(), inheritFrom: null };
  if (typeof options.runDir !== 'string' || options.runDir === '' || options.runDir.startsWith('--')) {
    throw sealError('HONOLOLO_SEAL_USAGE', SEAL_USAGE);
  }
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (typeof value !== 'string' || value === '') throw sealError('HONOLOLO_SEAL_USAGE', flag);
    if (flag === '--attempt') {
      if (!/^\d+$/u.test(value)) throw sealError('HONOLOLO_SEAL_USAGE', '--attempt');
      options.attempt = Number(value);
    } else if (flag === '--inherit-from') {
      if (!/^\d+$/u.test(value)) throw sealError('HONOLOLO_SEAL_USAGE', '--inherit-from');
      options.inheritFrom = Number(value);
    } else if (flag === '--needs-human') {
      const split = value.indexOf('=');
      if (split < 1 || split === value.length - 1) {
        throw sealError('HONOLOLO_SEAL_USAGE', '--needs-human <id>=<reason>');
      }
      options.withheld.set(value.slice(0, split), value.slice(split + 1));
    } else throw sealError('HONOLOLO_SEAL_USAGE', String(flag));
  }
  if (options.attempt === null) throw sealError('HONOLOLO_SEAL_USAGE', '--attempt');
  return options;
}

async function main(argv) {
  const { evidence, status } = await sealAttempt(parseArguments(argv));
  const counts = {};
  for (const { verdict } of status.criteria) counts[verdict] = (counts[verdict] ?? 0) + 1;
  process.stdout.write(`${JSON.stringify({
    sealed: `attempts/${String(status.attempt).padStart(3, '0')}`,
    steps: evidence.steps.length,
    inherited: evidence.steps.filter((step) => step.inherited_from !== undefined).length,
    files: evidence.steps.reduce((total, step) => total + step.files.length, 0),
    outcome: status.outcome,
    verdicts: counts,
  })}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
