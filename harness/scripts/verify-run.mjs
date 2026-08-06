import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateContract, validateReviewForPlan } from '../lib/contracts.mjs';
import { evaluateAttempt, pairedScreenshotDigest, weakerThanEvidence } from '../lib/criteria.mjs';
import { jobRelative } from '../lib/files.mjs';

const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_EVIDENCE_BYTES = 64 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');
const ATTEMPT_NAME = /^\d{3}$/u;
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
  const inheritedSteps = [];
  const stepsById = new Map();
  for (const claimedStep of manifest.steps) {
    const approvedStep = indexed.steps.get(claimedStep.id);
    if (!approvedStep || seenSteps.has(claimedStep.id)) {
      throw verifierError('HONOLOLO_EVIDENCE_STEP_INVALID', claimedStep.id);
    }
    seenSteps.add(claimedStep.id);
    const expectedKinds = new Set(approvedStep.evidence);
    const seenKinds = new Set();
    const seenPaths = new Set();
    // A step may carry forward the evidence an earlier attempt already settled, in which case its
    // files stay at their original paths. The scope stays exactly one directory either way: the
    // named attempt's own directory for this step, never a sibling step's and never a later attempt.
    const carried = claimedStep.inherited_from;
    if (carried !== undefined && carried >= attempt) {
      throw verifierError('HONOLOLO_EVIDENCE_INHERIT_INVALID', `${claimedStep.id}:${carried}`);
    }
    const scope = carried === undefined
      ? `${attemptDir}/evidence/${claimedStep.id}/`
      : `attempts/${String(carried).padStart(3, '0')}/evidence/${claimedStep.id}/`;
    const evidenceFiles = new Map();

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
      evidenceFiles.set(file.kind, {
        kind: file.kind,
        path: file.path,
        size: bytes.length,
        sha256: file.sha256,
        bytes: file.kind === 'screenshot' ? bytes.subarray(0, PNG_SIGNATURE.length) : bytes,
      });
    }
    if (seenKinds.size !== expectedKinds.size ||
        [...expectedKinds].some((kind) => !seenKinds.has(kind))) {
      throw verifierError('HONOLOLO_EVIDENCE_KIND_SET_INVALID', claimedStep.id);
    }
    const paired = pairedScreenshotDigest(evidenceFiles.get('snapshot'));
    if (paired !== null && evidenceFiles.get('screenshot')?.sha256 !== paired) {
      throw verifierError('HONOLOLO_CAPTURE_PAIR_INVALID', claimedStep.id);
    }
    if (carried !== undefined) inheritedSteps.push({ step_id: claimedStep.id, from: carried });
    stepsById.set(claimedStep.id, { id: claimedStep.id, files: evidenceFiles });
  }
  if (seenSteps.size !== indexed.steps.size) {
    throw verifierError('HONOLOLO_EVIDENCE_STEP_MISSING');
  }
  return { verified, stepsById, inheritedSteps };
}

// A step that repeats another step's captured bytes observed nothing new, so a copied capture cannot
// stand in as independent evidence. Two steps are duplicates when their snapshots are byte-identical
// and their screenshots agree — identical for both, or absent from both. A shared snapshot beside
// differing screenshots is left alone: scrolling a page changes its pixels without changing its text,
// and that is an ordinary way for two steps to observe one document.
function duplicateCaptures(verified) {
  const byStep = new Map();
  for (const file of verified) {
    if (file.kind !== 'snapshot' && file.kind !== 'screenshot') continue;
    const digests = byStep.get(file.step_id) ?? {};
    digests[file.kind] = file.sha256;
    byStep.set(file.step_id, digests);
  }
  const seen = new Map();
  const duplicates = [];
  for (const [stepId, digests] of byStep) {
    if (!digests.snapshot) continue;
    const key = `${digests.snapshot}\0${digests.screenshot ?? ''}`;
    const earlier = seen.get(key);
    if (earlier === undefined) seen.set(key, stepId);
    else duplicates.push({ steps: [earlier, stepId], sha256: digests.snapshot });
  }
  return duplicates;
}

// Re-evaluates every deterministic criterion from the evidence bytes instead of trusting the
// executor's own account of them. A verdict weaker than the evidence supports is a structural
// failure, not a judgment call, and a criterion left unreported is not silently dropped.
function crossCheckDeterministic(plan, status, stepsById) {
  const evaluated = new Map(evaluateAttempt(plan, stepsById).map((record) => [record.id, record]));
  const claimed = new Map(status.criteria.map((criterion) => [criterion.id, criterion]));
  for (const [id, record] of evaluated) {
    const criterion = claimed.get(id);
    if (!criterion) throw verifierError('HONOLOLO_STATUS_CRITERION_MISSING', id);
    if (weakerThanEvidence(criterion.verdict, record.verdict)) {
      throw verifierError(
        'HONOLOLO_STATUS_VERDICT_UNSUPPORTED',
        `${id}: claimed ${criterion.verdict}, evidence supports ${record.verdict}`,
      );
    }
  }
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

function recordedVerdicts(plan, status, fresh) {
  const byId = new Map();
  for (const { id, verdict } of status.criteria) byId.set(id, verdict);
  for (const { id, verdict } of fresh?.criteria ?? []) byId.set(id, verdict);
  const verdicts = new Map();
  for (const step of plan.steps) {
    // An unreported criterion is unresolved, exactly as `effectiveOutcome` reads it. Treating its
    // absence as a pass would let a retry launder a criterion by simply not mentioning it.
    for (const { id } of step.done_when) verdicts.set(id, byId.get(id) ?? 'needs_human');
  }
  return verdicts;
}

async function attemptHistory(runDir, plan, planSha256, selected, indexed) {
  const history = [];
  const earlierNonPass = new Set();
  let interruptedEarlier = false;
  let selectedVerdicts = new Map();
  let selectedFiles = [];
  let selectedInherited = [];
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
      // An attempt that was never sealed says nothing about any step, so nothing about it can be
      // cleared per step later.
      if (attempt < selected) interruptedEarlier = true;
      continue;
    }
    const { verified: files, stepsById, inheritedSteps } = await verifyEvidence(
      runDir, attempt, plan, planSha256, indexed,
    );
    validateAttemptReview(plan, status, 'deterministic', attempt, files, indexed);
    crossCheckDeterministic(plan, status, stepsById);

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
    const verdicts = recordedVerdicts(plan, status, fresh);
    if (attempt === selected) {
      selectedHasStatus = true;
      selectedFiles = files;
      selectedInherited = inheritedSteps;
      selectedVerdicts = verdicts;
    } else {
      for (const [id, verdict] of verdicts) if (verdict !== 'pass') earlierNonPass.add(id);
    }
  }
  return {
    history, selectedFiles, selectedInherited, selectedHasStatus,
    earlierNonPass, interruptedEarlier, selectedVerdicts,
  };
}

// A contradictory history is a property of the step it contradicts, not of the whole run. When one
// step failed in an earlier attempt and passes now, that step is the one a human should look at;
// withholding every other step's evidence alongside it does not make the run safer, it makes a
// retry pointless and pushes the operator to assemble the deliverable by hand outside the harness.
// A step is contested when the selected attempt calls it passed and the run's history disagrees:
// an earlier attempt recorded a non-pass for one of its criteria, an earlier attempt was never
// sealed at all, or its capture repeats another step's bytes.
function contestedSteps(indexed, verified, duplicates) {
  const contested = new Set();
  const passesNow = (stepId) => indexed.steps.get(stepId)?.done_when
    .every(({ id }) => verified.selectedVerdicts.get(id) === 'pass') === true;

  for (const [id, stepId] of indexed.criteria) {
    if (verified.earlierNonPass.has(id) && passesNow(stepId)) contested.add(stepId);
  }
  if (verified.interruptedEarlier) {
    for (const stepId of indexed.steps.keys()) if (passesNow(stepId)) contested.add(stepId);
  }
  for (const duplicate of duplicates) for (const stepId of duplicate.steps) contested.add(stepId);
  return [...contested].sort();
}

async function verifyAmendments(runDir, runId) {
  let record;
  try {
    record = (await readJson(runDir, 'output/amendments.json', 'amendment')).value;
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  if (record.run_id !== runId) throw verifierError('HONOLOLO_AMENDMENT_RUN_ID_INVALID');
  const latest = new Map();
  for (const amendment of record.amendments) latest.set(amendment.asset, amendment);
  for (const [asset, amendment] of latest) {
    const bytes = await readChecked(runDir, `output/assets/${asset}`, MAX_EVIDENCE_BYTES);
    if (sha256(bytes) !== amendment.sha256) {
      throw verifierError('HONOLOLO_AMENDMENT_DIGEST_INVALID', asset);
    }
    if (!bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
      throw verifierError('HONOLOLO_PNG_SIGNATURE_INVALID', `output/assets/${asset}`);
    }
  }
  return record.amendments;
}

export async function verifyRun({ runDir, attempt } = {}) {
  const result = {
    ok: false,
    run_id: null,
    attempt: null,
    plan_sha256: null,
    approval_mode: null,
    history: [],
    files: [],
    amendments: [],
    duplicate_captures: [],
    inherited_steps: [],
    contested_steps: [],
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
    // The approved plan claims a proposal digest; without this check that claim is unverified and an
    // approval can be bound to a proposal that was never written or was rewritten afterwards.
    let proposal;
    try {
      proposal = await readChecked(runDir, 'plan/proposal.md');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      throw verifierError('HONOLOLO_PROPOSAL_MISSING', 'plan/proposal.md');
    }
    if (sha256(proposal) !== plan.approved.proposal_sha256) {
      throw verifierError('HONOLOLO_PROPOSAL_SHA256_INVALID');
    }
    const indexed = planIndex(plan);
    result.run_id = run.id;
    result.plan_sha256 = sha256(planRecord.bytes);
    // Recorded so the run's own verifier record says which approval authorised it. The schema
    // already refuses a standing grant over anything above a low-risk step; this makes the choice
    // visible in the artifact a reader inspects afterwards rather than only in the plan.
    result.approval_mode = plan.approved.mode ?? 'interactive';

    const attempts = await listAttempts(runDir);
    const selected = attempt ?? attempts.at(-1);
    if (!attempts.includes(selected)) throw verifierError('HONOLOLO_ATTEMPT_NOT_FOUND');
    result.attempt = selected;
    const verified = await attemptHistory(
      runDir, plan, result.plan_sha256, selected, indexed,
    );
    result.history = verified.history;
    result.inherited_steps = verified.selectedInherited;
    result.duplicate_captures = duplicateCaptures(verified.selectedFiles);
    result.contested_steps = contestedSteps(indexed, verified, result.duplicate_captures);
    result.requires_human_review = result.contested_steps.length > 0;
    if (!verified.selectedHasStatus) throw verifierError('HONOLOLO_ATTEMPT_INTERRUPTED');
    result.files = verified.selectedFiles;
    result.amendments = await verifyAmendments(runDir, run.id);
    result.ok = true;
  } catch (error) {
    result.errors.push(error?.message ?? String(error));
  }
  return result;
}

const USAGE = '<run-dir> [--attempt <positive-integer>] [--write initial|final]';

function parseArguments(argv) {
  const options = { runDir: argv[0], write: null };
  if (typeof options.runDir !== 'string' || options.runDir === '' ||
      options.runDir.startsWith('--')) {
    throw verifierError('HONOLOLO_VERIFY_USAGE', USAGE);
  }
  for (let index = 1; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (typeof value !== 'string' || value === '') throw verifierError('HONOLOLO_VERIFY_USAGE', USAGE);
    if (flag === '--attempt') {
      if (!/^\d+$/u.test(value)) throw verifierError('HONOLOLO_VERIFY_USAGE', USAGE);
      options.attempt = Number(value);
    } else if (flag === '--write') {
      if (value !== 'initial' && value !== 'final') {
        throw verifierError('HONOLOLO_VERIFY_USAGE', USAGE);
      }
      options.write = value;
    } else throw verifierError('HONOLOLO_VERIFY_USAGE', USAGE);
  }
  return options;
}

// Records the exact bytes it printed, so the run's verifier record cannot drift from the result the
// operator read. The file is created exclusively: an existing record is never replaced.
async function writeRecord(runDir, attempt, stage, bytes) {
  const relative = `attempts/${String(attempt).padStart(3, '0')}/verifier.${stage}.json`;
  const path = jobRelative(runDir, relative);
  await mkdir(resolve(path, '..'), { recursive: true, mode: 0o700 });
  try {
    await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error?.code === 'EEXIST') throw verifierError('HONOLOLO_VERIFIER_RECORD_EXISTS', relative);
    throw error;
  }
  return relative;
}

async function main(argv) {
  let options = null;
  let result;
  try {
    options = parseArguments(argv);
    result = await verifyRun(options);
  } catch (error) {
    result = {
      ok: false,
      run_id: null,
      attempt: null,
      plan_sha256: null,
      history: [],
      files: [],
      amendments: [],
      duplicate_captures: [],
      errors: [error?.message ?? String(error)],
      requires_human_review: false,
    };
  }
  const bytes = `${JSON.stringify(result)}\n`;
  process.stdout.write(bytes);
  // Only a successful verification is recorded. A rejected one is reported and the attempt is
  // abandoned, so freezing its result would spend the attempt's one record slot on a run nobody
  // continues — and would leave a later, valid verification of that attempt with nowhere to write.
  if (options?.write) {
    if (!result.ok || result.attempt === null) {
      process.stderr.write(
        `HONOLOLO_VERIFIER_RECORD_SKIPPED: ${options.write} not recorded for a rejected run\n`,
      );
    } else {
      try {
        await writeRecord(options.runDir, result.attempt, options.write, bytes);
      } catch (error) {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
      }
    }
  }
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
