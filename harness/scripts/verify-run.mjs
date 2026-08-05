import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateContract, validateReviewForPlan } from '../lib/contracts.mjs';
import { jobRelative } from '../lib/files.mjs';

const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_EVIDENCE_BYTES = 64 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');
const ATTEMPT_NAME = /^\d{3}$/u;
const UNSAFE_HISTORY = new Set(['fail', 'needs_human', 'blocked', 'interrupted']);
const VERDICT_ORDER = { pass: 0, needs_human: 1, fail: 2 };

function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function verifierError(code, detail) {
  const error = new Error(detail ? `${code}: ${detail}` : code);
  error.code = code;
  return error;
}

function canonicalRelative(value) {
  if (typeof value !== 'string' || value === '' || value.includes('\\') || value.includes('\0') ||
      posix.isAbsolute(value) || posix.normalize(value) !== value ||
      value.split('/').some((part) => part === '.' || part === '..')) {
    throw verifierError('HONOLOLO_PATH_INVALID', String(value));
  }
  return value;
}

async function checkedDirectory(root, relative = null) {
  const rootPath = resolve(root);
  const parts = relative === null ? [] : canonicalRelative(relative).split('/');
  let current = rootPath;
  for (let index = 0; index <= parts.length; index += 1) {
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw verifierError('HONOLOLO_DIRECTORY_INVALID', relative ?? 'run');
    }
    if (index < parts.length) current = jobRelative(rootPath, parts.slice(0, index + 1).join('/'));
  }
  return current;
}

async function readChecked(root, relative, maxBytes = MAX_JSON_BYTES) {
  canonicalRelative(relative);
  const parts = relative.split('/');
  let current = resolve(root);
  await checkedDirectory(current);
  for (let index = 0; index < parts.length; index += 1) {
    current = jobRelative(root, parts.slice(0, index + 1).join('/'));
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) throw verifierError('HONOLOLO_SYMLINK_REJECTED', relative);
    if (index < parts.length - 1 && !stat.isDirectory()) {
      throw verifierError('HONOLOLO_DIRECTORY_INVALID', relative);
    }
    if (index === parts.length - 1) {
      if (!stat.isFile()) throw verifierError('HONOLOLO_FILE_NOT_REGULAR', relative);
      if (!Number.isSafeInteger(stat.size) || stat.size > maxBytes) {
        throw verifierError('HONOLOLO_FILE_SIZE_INVALID', relative);
      }
    }
  }
  const bytes = await readFile(current);
  if (bytes.length > maxBytes) throw verifierError('HONOLOLO_FILE_SIZE_INVALID', relative);
  return bytes;
}

async function readJson(root, relative, contract) {
  const bytes = await readChecked(root, relative);
  let value;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) throw verifierError('HONOLOLO_JSON_INVALID', relative);
    throw error;
  }
  return { bytes, value: validateContract(contract, value) };
}

function planIndex(plan) {
  const steps = new Map();
  const criteria = new Map();
  for (const step of plan.steps) {
    if (steps.has(step.id)) throw verifierError('HONOLOLO_PLAN_STEP_DUPLICATE', step.id);
    steps.set(step.id, step);
    for (const criterion of step.done_when) {
      if (criteria.has(criterion.id)) {
        throw verifierError('HONOLOLO_PLAN_CRITERION_DUPLICATE', criterion.id);
      }
      criteria.set(criterion.id, step.id);
    }
  }
  return { steps, criteria };
}

async function listAttempts(runDir) {
  const attemptsDir = await checkedDirectory(runDir, 'attempts');
  const entries = await readdir(attemptsDir, { withFileTypes: true });
  const attempts = [];
  for (const entry of entries) {
    if (!ATTEMPT_NAME.test(entry.name) || entry.isSymbolicLink() || !entry.isDirectory()) {
      throw verifierError('HONOLOLO_ATTEMPT_ENTRY_INVALID', entry.name);
    }
    await checkedDirectory(runDir, `attempts/${entry.name}`);
    const attempt = Number(entry.name);
    if (attempt < 1 || String(attempt).padStart(3, '0') !== entry.name) {
      throw verifierError('HONOLOLO_ATTEMPT_ENTRY_INVALID', entry.name);
    }
    attempts.push(attempt);
  }
  attempts.sort((left, right) => left - right);
  if (attempts.length === 0) throw verifierError('HONOLOLO_ATTEMPTS_EMPTY');
  for (let index = 0; index < attempts.length; index += 1) {
    if (attempts[index] !== index + 1) throw verifierError('HONOLOLO_ATTEMPT_GAP');
  }
  return attempts;
}

async function verifyEvidence(runDir, attempt, plan, planSha256, indexed) {
  const name = String(attempt).padStart(3, '0');
  const attemptDir = `attempts/${name}`;
  const { value: manifest } = await readJson(runDir, `${attemptDir}/evidence.json`, 'evidence');
  if (manifest.run_id !== plan.run_id || manifest.attempt !== attempt ||
      manifest.plan_sha256 !== planSha256) {
    throw verifierError('HONOLOLO_EVIDENCE_IDENTITY_INVALID');
  }

  const seenSteps = new Set();
  const verified = [];
  for (const claimedStep of manifest.steps) {
    const approvedStep = indexed.steps.get(claimedStep.id);
    if (!approvedStep || seenSteps.has(claimedStep.id)) {
      throw verifierError('HONOLOLO_EVIDENCE_STEP_INVALID', claimedStep.id);
    }
    seenSteps.add(claimedStep.id);
    const expectedKinds = new Set(approvedStep.evidence);
    const seenKinds = new Set();
    const seenPaths = new Set();
    const scope = `${attemptDir}/evidence/${claimedStep.id}/`;

    for (const file of claimedStep.files) {
      canonicalRelative(file.path);
      if (!file.path.startsWith(scope)) {
        throw verifierError('HONOLOLO_EVIDENCE_SCOPE_INVALID', file.path);
      }
      if (seenPaths.has(file.path)) {
        throw verifierError('HONOLOLO_EVIDENCE_PATH_DUPLICATE', file.path);
      }
      if (!expectedKinds.has(file.kind) || seenKinds.has(file.kind)) {
        throw verifierError('HONOLOLO_EVIDENCE_KIND_INVALID', `${claimedStep.id}:${file.kind}`);
      }
      seenPaths.add(file.path);
      seenKinds.add(file.kind);

      const bytes = await readChecked(runDir, file.path, MAX_EVIDENCE_BYTES);
      if (bytes.length === 0 || bytes.length !== file.bytes || sha256(bytes) !== file.sha256) {
        throw verifierError('HONOLOLO_EVIDENCE_DIGEST_INVALID', file.path);
      }
      if (file.kind === 'screenshot' &&
          !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
        throw verifierError('HONOLOLO_PNG_SIGNATURE_INVALID', file.path);
      }
      verified.push({ step_id: claimedStep.id, ...file });
    }
    if (seenKinds.size !== expectedKinds.size ||
        [...expectedKinds].some((kind) => !seenKinds.has(kind))) {
      throw verifierError('HONOLOLO_EVIDENCE_KIND_SET_INVALID', claimedStep.id);
    }
  }
  if (seenSteps.size !== indexed.steps.size) {
    throw verifierError('HONOLOLO_EVIDENCE_STEP_MISSING');
  }
  return verified;
}

function verifyReviewEvidence(review, files, criterionOwners, errorCode) {
  const verified = new Map(files.map((file) => [file.path, file]));
  for (const criterion of review.criteria) {
    const owner = criterionOwners.get(criterion.id);
    for (const path of criterion.evidence) {
      canonicalRelative(path);
      const file = verified.get(path);
      if (!file || file.step_id !== owner) {
        throw verifierError(errorCode, path);
      }
    }
  }
}

function validateAttemptReview(plan, review, source, attempt, files, indexed) {
  validateReviewForPlan(plan, review);
  if (review.source !== source || review.run_id !== plan.run_id || review.attempt !== attempt) {
    throw verifierError('HONOLOLO_REVIEW_IDENTITY_INVALID', `${attempt}:${source}`);
  }
  verifyReviewEvidence(
    review, files, indexed.criteria,
    source === 'deterministic'
      ? 'HONOLOLO_STATUS_EVIDENCE_INVALID'
      : 'HONOLOLO_REVIEW_EVIDENCE_INVALID',
  );
}

function terminalVerdict(outcome) {
  if (outcome === 'fail') return 'fail';
  return outcome === 'pass' ? 'pass' : 'needs_human';
}

function effectiveOutcome(plan, deterministic, fresh) {
  let outcome = 'pass';
  const promote = (verdict) => {
    if (VERDICT_ORDER[verdict] > VERDICT_ORDER[outcome]) outcome = verdict;
  };
  promote(terminalVerdict(deterministic.outcome));
  if (fresh) promote(terminalVerdict(fresh.outcome));

  const deterministicById = new Map(
    deterministic.criteria.map((criterion) => [criterion.id, criterion]),
  );
  const freshById = new Map((fresh?.criteria ?? []).map((criterion) => [criterion.id, criterion]));
  for (const step of plan.steps) {
    for (const criterion of step.done_when) {
      const review = (criterion.type === 'rubric' ? freshById : deterministicById).get(criterion.id);
      promote(review?.verdict ?? 'needs_human');
    }
  }
  return outcome;
}

async function attemptHistory(runDir, plan, planSha256, selected, indexed) {
  const history = [];
  let selectedFiles = [];
  let selectedHasStatus = false;
  for (let attempt = 1; attempt <= selected; attempt += 1) {
    const name = String(attempt).padStart(3, '0');
    const statusPath = `attempts/${name}/status.json`;
    let status;
    try {
      status = (await readJson(runDir, statusPath, 'review')).value;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      history.push({ attempt, outcome: 'interrupted' });
      continue;
    }
    const files = await verifyEvidence(runDir, attempt, plan, planSha256, indexed);
    validateAttemptReview(plan, status, 'deterministic', attempt, files, indexed);

    let fresh = null;
    try {
      fresh = (await readJson(runDir, `attempts/${name}/fresh.json`, 'review')).value;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (fresh) {
      validateAttemptReview(plan, fresh, 'fresh_evaluator', attempt, files, indexed);
    }
    history.push({ attempt, outcome: effectiveOutcome(plan, status, fresh) });
    if (attempt === selected) {
      selectedHasStatus = true;
      selectedFiles = files;
    }
  }
  return { history, selectedFiles, selectedHasStatus };
}

function needsHistoryReview(history) {
  return history.at(-1)?.outcome === 'pass' &&
    history.slice(0, -1).some(({ outcome }) => UNSAFE_HISTORY.has(outcome));
}

export async function verifyRun({ runDir, attempt } = {}) {
  const result = {
    ok: false,
    run_id: null,
    attempt: null,
    plan_sha256: null,
    history: [],
    files: [],
    errors: [],
    requires_human_review: false,
  };
  try {
    if (typeof runDir !== 'string' || runDir === '') {
      throw verifierError('HONOLOLO_RUN_DIR_INVALID');
    }
    if (attempt !== undefined && (!Number.isSafeInteger(attempt) || attempt < 1)) {
      throw verifierError('HONOLOLO_ATTEMPT_INVALID');
    }
    await checkedDirectory(runDir);

    const { value: run } = await readJson(runDir, 'run.json', 'run');
    const planRecord = await readJson(runDir, 'plan/approved.json', 'plan');
    const plan = planRecord.value;
    if (plan.run_id !== run.id) throw verifierError('HONOLOLO_RUN_PLAN_ID_INVALID');
    const indexed = planIndex(plan);
    result.run_id = run.id;
    result.plan_sha256 = sha256(planRecord.bytes);

    const attempts = await listAttempts(runDir);
    const selected = attempt ?? attempts.at(-1);
    if (!attempts.includes(selected)) throw verifierError('HONOLOLO_ATTEMPT_NOT_FOUND');
    result.attempt = selected;
    const verified = await attemptHistory(
      runDir, plan, result.plan_sha256, selected, indexed,
    );
    result.history = verified.history;
    result.requires_human_review = needsHistoryReview(result.history);
    if (!verified.selectedHasStatus) throw verifierError('HONOLOLO_ATTEMPT_INTERRUPTED');
    result.files = verified.selectedFiles;
    result.ok = true;
  } catch (error) {
    result.errors.push(error?.message ?? String(error));
  }
  return result;
}

function parseArguments(argv) {
  if (argv.length === 1) return { runDir: argv[0] };
  if (argv.length === 3 && argv[1] === '--attempt' && /^\d+$/u.test(argv[2])) {
    return { runDir: argv[0], attempt: Number(argv[2]) };
  }
  throw verifierError('HONOLOLO_VERIFY_USAGE', '<run-dir> [--attempt <positive-integer>]');
}

async function main(argv) {
  let result;
  try {
    result = await verifyRun(parseArguments(argv));
  } catch (error) {
    result = {
      ok: false,
      run_id: null,
      attempt: null,
      plan_sha256: null,
      history: [],
      files: [],
      errors: [error?.message ?? String(error)],
      requires_human_review: false,
    };
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
