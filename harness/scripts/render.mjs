import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { validateContract, validateReviewForPlan } from '../lib/contracts.mjs';
import { jobRelative } from '../lib/files.mjs';
import { verifyRun } from './verify-run.mjs';

const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_EVIDENCE_BYTES = 64 * 1024 * 1024;
const VERDICT_ORDER = { pass: 0, needs_human: 1, fail: 2 };
const TEMPLATE_URLS = {
  qa: new URL('../templates/qa-result.md', import.meta.url),
  manual: new URL('../templates/manual.md', import.meta.url),
};

function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function renderError(code, detail) {
  const error = new Error(detail ? `${code}: ${detail}` : code);
  error.code = code;
  return error;
}

function attemptPath(attempt, file) {
  return `attempts/${String(attempt).padStart(3, '0')}/${file}`;
}

async function readRegular(path, label, maxBytes = MAX_JSON_BYTES) {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > maxBytes) {
    throw renderError('HONOLOLO_RENDER_FILE_INVALID', label);
  }
  return readFile(path);
}

async function readJson(runDir, path, contract) {
  const bytes = await readRegular(jobRelative(runDir, path), path);
  let value;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    if (error instanceof SyntaxError) throw renderError('HONOLOLO_JSON_INVALID', path);
    throw error;
  }
  return validateContract(contract, value);
}

async function optionalReview(runDir, path) {
  try {
    return await readJson(runDir, path, 'review');
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

function markdownText(value) {
  return String(value)
    .replace(/\r\n?|\n/gu, ' ')
    .replace(/\\/gu, '\\\\')
    .replace(/([`*_{}\[\]()<>#+!|])/gu, '\\$1');
}

function fillTemplate(template, values) {
  return template.replace(/\{\{([a-z_]+)\}\}/gu, (_, key) => values[key] ?? '');
}

function criterionIndex(plan) {
  const criteria = new Map();
  for (const step of plan.steps) {
    for (const criterion of step.done_when) {
      if (criteria.has(criterion.id)) {
        throw renderError('HONOLOLO_PLAN_CRITERION_DUPLICATE', criterion.id);
      }
      criteria.set(criterion.id, { criterion, step });
    }
  }
  return criteria;
}

function validateReviewEvidence(plan, review, source, attempt, indexed, files) {
  validateReviewForPlan(plan, review);
  if (review.source !== source) throw renderError('HONOLOLO_REVIEW_SOURCE_INVALID', source);
  if (review.attempt !== attempt) {
    throw renderError('HONOLOLO_REVIEW_ATTEMPT_INVALID', String(review.attempt));
  }
  const verified = new Map(files.map((file) => [file.path, file]));
  for (const record of review.criteria) {
    const owner = indexed.get(record.id);
    for (const path of record.evidence) {
      const file = verified.get(path);
      if (!file || file.step_id !== owner.step.id) {
        throw renderError('HONOLOLO_REVIEW_EVIDENCE_INVALID', path);
      }
    }
  }
}

function aggregateCriteria(plan, deterministic, fresh, verified) {
  const indexed = criterionIndex(plan);
  validateReviewEvidence(
    plan, deterministic, 'deterministic', verified.attempt, indexed, verified.files,
  );
  if (fresh) {
    validateReviewEvidence(
      plan, fresh, 'fresh_evaluator', verified.attempt, indexed, verified.files,
    );
  }
  const deterministicById = new Map(
    deterministic.criteria.map((criterion) => [criterion.id, criterion]),
  );
  const freshById = new Map((fresh?.criteria ?? []).map((criterion) => [criterion.id, criterion]));
  return [...indexed].map(([id, { criterion, step }]) => {
    const review = (criterion.type === 'rubric' ? freshById : deterministicById).get(id);
    return {
      id,
      criterion,
      step,
      verdict: review?.verdict ?? 'needs_human',
      evidence: review?.evidence ?? [],
    };
  });
}

function terminalVerdict(outcome) {
  if (outcome === 'fail') return 'fail';
  return outcome === 'pass' ? 'pass' : 'needs_human';
}

function aggregateOutcome(criteria, requiresHumanReview, reviews) {
  let outcome = requiresHumanReview ? 'needs_human' : 'pass';
  for (const criterion of criteria) {
    if (VERDICT_ORDER[criterion.verdict] > VERDICT_ORDER[outcome]) {
      outcome = criterion.verdict;
    }
  }
  const terminals = reviews.map((review) => ({
    source: review.source,
    outcome: review.outcome,
    verdict: terminalVerdict(review.outcome),
  }));
  for (const terminal of terminals) {
    if (VERDICT_ORDER[terminal.verdict] > VERDICT_ORDER[outcome]) {
      outcome = terminal.verdict;
    }
  }
  return { outcome, terminals };
}

function expectedText(criterion) {
  return criterion.type === 'rubric' ? criterion.criterion : criterion.value;
}

function criterionBlock(criteria, verdict) {
  const selected = criteria.filter((criterion) => criterion.verdict === verdict);
  if (selected.length === 0) return 'None.';
  return selected.map((entry) => [
    `- ${markdownText(entry.id)} — Expected: ${markdownText(expectedText(entry.criterion))}`,
    `  Evidence: ${entry.evidence.length === 0
      ? 'None.'
      : entry.evidence.map(markdownText).join(', ')}`,
  ].join('\n')).join('\n');
}

function terminalBlock(terminals, verdict) {
  const selected = terminals.filter((terminal) => terminal.verdict === verdict);
  return selected.map((terminal) =>
    `- ${markdownText(terminal.source)} review outcome: ${markdownText(terminal.outcome)}.`,
  ).join('\n');
}

function appendBlocks(...blocks) {
  return blocks.filter((block) => block && block !== 'None.').join('\n') || 'None.';
}

function stepEvidence(plan, files) {
  const byStep = new Map();
  for (const file of files) {
    const paths = byStep.get(file.step_id) ?? [];
    paths.push(file.path);
    byStep.set(file.step_id, paths);
  }
  return plan.steps.map((step) => {
    const paths = byStep.get(step.id) ?? [];
    return `- ${markdownText(step.id)}: ${paths.map(markdownText).join(', ')}`;
  }).join('\n');
}

function historyBlock(history) {
  return history.map(({ attempt, outcome }) =>
    `- Attempt ${attempt}: ${markdownText(outcome)}`,
  ).join('\n');
}

function environment(run, attempt) {
  const target = new URL(run.target.url);
  return [
    `Target: ${markdownText(`${target.origin}${target.pathname}`)}`,
    `Allowed domains: ${run.target.allowed_domains.map(markdownText).join(', ')}`,
    `Attempt: ${attempt}`,
  ].join('\n');
}

function manualReviewStatus(aggregate, criteria, requiresHumanReview, manual) {
  let qualification = 'All declared review criteria passed.';
  if (aggregate.outcome !== 'pass') {
    qualification = manual.published === 0
      ? 'This is a qualified draft. Screenshots are unpublished pending review.'
      : 'This is a qualified draft. Screenshots are published only for steps whose ' +
        `criteria all passed (${manual.published} of ${manual.total}).`;
  }
  return [
    `Overall: ${aggregate.outcome}`,
    `Qualification: ${qualification}`,
    terminalBlock(aggregate.terminals, 'fail'),
    terminalBlock(aggregate.terminals, 'needs_human'),
    criterionBlock(criteria, 'fail') === 'None.'
      ? ''
      : `Failed criteria:\n${criterionBlock(criteria, 'fail')}`,
    criterionBlock(criteria, 'needs_human') === 'None.'
      ? ''
      : `Needs human:\n${criterionBlock(criteria, 'needs_human')}`,
    requiresHumanReview ? '- Attempt history requires human review.' : '',
  ].filter(Boolean).join('\n');
}

function imageAlt(step) {
  return step.manual.title;
}

async function screenshotAsset(runDir, step, file, index) {
  if (!file) throw renderError('MANUAL_SCREENSHOT_MISSING', step.id);
  const bytes = await readRegular(
    jobRelative(runDir, file.path), file.path, MAX_EVIDENCE_BYTES,
  );
  if (bytes.length !== file.bytes || sha256(bytes) !== file.sha256 ||
      !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw renderError('HONOLOLO_OUTPUT_SOURCE_INVALID', file.path);
  }
  return { name: `${String(index).padStart(3, '0')}-${step.id}.png`, bytes };
}

function stepPublishGate(criteria, aggregate, requiresHumanReview) {
  const globalBlocked = requiresHumanReview || aggregate.outcome === 'fail';
  const blockedSteps = new Set();
  for (const criterion of criteria) {
    if (criterion.verdict !== 'pass') blockedSteps.add(criterion.step.id);
  }
  return (step) => !globalBlocked && !blockedSteps.has(step.id);
}

async function manualSteps(runDir, plan, files, publishStep) {
  const screenshots = new Map(files
    .filter((file) => file.kind === 'screenshot')
    .map((file) => [file.step_id, file]));
  const rendered = [];
  const assets = [];
  let published = 0;
  for (const step of plan.steps.filter(({ manual }) => manual)) {
    const index = rendered.length + 1;
    let image = 'Image: Unpublished pending review.';
    if (publishStep(step)) {
      const asset = await screenshotAsset(runDir, step, screenshots.get(step.id), index);
      assets.push(asset);
      image = `Image: ![${markdownText(imageAlt(step))}](assets/${asset.name})`;
      published += 1;
    }
    const cautions = step.manual.cautions.length === 0
      ? 'None.'
      : step.manual.cautions.map(markdownText).join('; ');
    rendered.push([
      `### ${index}. ${markdownText(step.manual.title)}`,
      '',
      `Title: ${markdownText(step.manual.title)}`,
      `Action: ${markdownText(step.manual.instruction)}`,
      `Expected: ${markdownText(step.manual.expected)}`,
      image,
      `Caution: ${cautions}`,
    ].join('\n'));
  }
  if (rendered.length === 0) throw renderError('MANUAL_STEPS_MISSING');
  return { markdown: rendered.join('\n\n'), assets, published, total: rendered.length };
}

async function preflightDirectory(path, label) {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw renderError('OUTPUT_DIRECTORY_CONFLICT', label);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function preflightFile(path, bytes, conflictCode, label) {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size !== bytes.length) {
      throw renderError(conflictCode, label);
    }
    const existing = await readRegular(path, label, bytes.length);
    if (!existing.equals(bytes)) throw renderError(conflictCode, label);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

async function createExclusive(path, bytes, conflictCode, label) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try {
    await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
    await preflightFile(path, bytes, conflictCode, label);
  }
}

async function publishOutput(runDir, relative, markdown, assets = []) {
  const document = Buffer.from(markdown, 'utf8');
  const destination = jobRelative(runDir, relative);
  const outputDir = jobRelative(runDir, 'output');
  await preflightDirectory(outputDir, 'output');
  if (assets.length > 0) {
    await preflightDirectory(jobRelative(runDir, 'output/assets'), 'output/assets');
  }
  await preflightFile(destination, document, 'OUTPUT_CONFLICT', relative);
  const prepared = assets.map((asset) => ({
    ...asset,
    destination: jobRelative(runDir, `output/assets/${asset.name}`),
  }));
  for (const asset of prepared) {
    await preflightFile(
      asset.destination, asset.bytes, 'OUTPUT_ASSET_CONFLICT', asset.name,
    );
  }
  for (const asset of prepared) {
    await createExclusive(
      asset.destination, asset.bytes, 'OUTPUT_ASSET_CONFLICT', asset.name,
    );
  }
  await createExclusive(destination, document, 'OUTPUT_CONFLICT', relative);
  return destination;
}

export async function renderRun({ runDir, attempt, type } = {}) {
  const verified = await verifyRun({ runDir, attempt });
  if (!verified.ok) throw renderError('RUN_NOT_VERIFIED', verified.errors.join('; '));
  if (type !== 'qa' && type !== 'manual') {
    throw renderError('HONOLOLO_RENDER_TYPE_INVALID');
  }

  const run = await readJson(runDir, 'run.json', 'run');
  if (run.type !== type) throw renderError('HONOLOLO_RENDER_TYPE_MISMATCH');
  const plan = await readJson(runDir, 'plan/approved.json', 'plan');
  const deterministic = await readJson(
    runDir, attemptPath(verified.attempt, 'status.json'), 'review',
  );
  const fresh = await optionalReview(runDir, attemptPath(verified.attempt, 'fresh.json'));
  const criteria = aggregateCriteria(plan, deterministic, fresh, verified);
  const aggregate = aggregateOutcome(criteria, verified.requires_human_review, [
    deterministic,
    ...(fresh ? [fresh] : []),
  ]);
  const template = await readFile(TEMPLATE_URLS[type], 'utf8');
  const scope = [
    `Goal: ${markdownText(run.goal)}`,
    `Steps: ${plan.steps.map((step) => markdownText(step.goal)).join('; ')}`,
  ].join('\n');

  if (type === 'qa') {
    return publishOutput(runDir, 'output/result.md', fillTemplate(template, {
      run_id: markdownText(verified.run_id),
      scope,
      environment: environment(run, verified.attempt),
      outcome: `Overall: ${aggregate.outcome}`,
      failed_criteria: appendBlocks(
        criterionBlock(criteria, 'fail'), terminalBlock(aggregate.terminals, 'fail'),
      ),
      needs_human: appendBlocks(
        criterionBlock(criteria, 'needs_human'),
        terminalBlock(aggregate.terminals, 'needs_human'),
        verified.requires_human_review ? '- Attempt history requires human review.' : '',
      ),
      step_evidence: stepEvidence(plan, verified.files),
      attempt_history: historyBlock(verified.history),
    }));
  }

  const manual = await manualSteps(
    runDir, plan, verified.files,
    stepPublishGate(criteria, aggregate, verified.requires_human_review),
  );
  return publishOutput(runDir, 'output/manual.md', fillTemplate(template, {
    run_id: markdownText(verified.run_id),
    scope,
    environment: environment(run, verified.attempt),
    review_status: manualReviewStatus(
      aggregate, criteria, verified.requires_human_review, manual,
    ),
    steps: manual.markdown,
  }), manual.assets);
}
