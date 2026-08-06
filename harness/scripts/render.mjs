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
const TEMPLATE_NAMES = { qa: 'qa-result', manual: 'manual' };

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

// Escapes only what can change how a line renders or smuggle markup: link and emphasis syntax,
// code spans, table cells, and raw HTML. Brackets stay escaped, so `[text](url)` from page content
// can never become a live link — which means parentheses, `#`, and `!` need no backslash and prose
// (notably non-English prose full of parentheses) stays readable.
function markdownText(value) {
  return String(value)
    .replace(/\r\n?|\n/gu, ' ')
    .replace(/\\/gu, '\\\\')
    .replace(/([`*_[\]<>|])/gu, '\\$1');
}

// Manual prose is written by the operator into the approved plan, and a reader needs the product's
// own control names to stand out — pressing "＋" is not the same instruction as pressing plus. Bold
// is the one exception to the escaping above, and only in its narrowest form: the span may not
// contain a newline or any other markup character, so it can never become a link, an image, a
// table, raw HTML, or a code span. Everything outside the span is escaped exactly as before.
const BOLD_SPAN = /\*\*([^*\n`[\]<>|\\]{1,80})\*\*/gu;

export function manualText(value) {
  const source = String(value);
  let out = '';
  let index = 0;
  for (const match of source.matchAll(BOLD_SPAN)) {
    out += markdownText(source.slice(index, match.index));
    out += `**${markdownText(match[1])}**`;
    index = match.index + match[0].length;
  }
  return out + markdownText(source.slice(index));
}

// A template line whose every placeholder came back empty is dropped whole, label and all. A manual
// that prints "Caution: None." under each step is noise a reader learns to skip; the sections a step
// does not have should simply not be there.
function fillTemplate(template, values) {
  const resolve = (key) => values[key] ?? '';
  return template.split('\n').filter((line) => {
    const keys = [...line.matchAll(/\{\{([a-z_]+)\}\}/gu)].map(([, key]) => key);
    return keys.length === 0 || keys.some((key) => resolve(key) !== '');
  }).join('\n')
    .replace(/\{\{([a-z_]+)\}\}/gu, (_, key) => resolve(key))
    // The template spaces its sections for the case where every one of them is present. Dropping a
    // section leaves the blank lines that framed it behind, and a reader sees the gap, not the rule.
    .replace(/\n{3,}/gu, '\n\n');
}

// A run may ship its own presentation under `<run-dir>/templates/`: section order, labels, and
// output language belong to the deliverable, not to the harness. Falls back to the packaged default.
async function loadTemplate(runDir, name) {
  try {
    return (await readRegular(jobRelative(runDir, `templates/${name}.md`), name)).toString('utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    return readFile(new URL(`../templates/${name}.md`, import.meta.url), 'utf8');
  }
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

// A step publishes its screenshot when its own criteria all passed and its own history is
// uncontested. A `fail` anywhere still withholds everything: a run with a failing step is not a
// document to hand to a reader, whichever step failed.
function stepPublishGate(criteria, aggregate, contestedSteps) {
  const blockedSteps = new Set(contestedSteps);
  for (const criterion of criteria) {
    if (criterion.verdict !== 'pass') blockedSteps.add(criterion.step.id);
  }
  return (step) => aggregate.outcome !== 'fail' && !blockedSteps.has(step.id);
}

function numbered(items) {
  return items.map((item, index) => `${index + 1}. ${item}`).join('\n');
}

function calloutBlock(items, marker) {
  return items.map((item) => `> ${marker} ${manualText(item)}`).join('\n>\n');
}

// A step's ordered actions, or — when the step is a single move — the one sentence that says it.
// A numbered list of one reads like a form; a paragraph of six reads like a wall.
function actionBlock(manual) {
  return Array.isArray(manual.actions) && manual.actions.length > 0
    ? numbered(manual.actions.map(manualText))
    : manualText(manual.instruction ?? '');
}

// Carries its own leading break so the template can keep the section's label on the placeholder's
// line. A label that outlives its content is exactly the empty scaffolding the drop rule exists to
// remove, and a list cannot share a line with the words introducing it.
function checkpointBlock(manual) {
  const checkpoints = manual.checkpoints ?? [];
  if (checkpoints.length === 0) return '';
  return `\n\n${numbered(checkpoints.map(
    ({ label, detail }) => `**${markdownText(label)}** — ${manualText(detail)}`,
  ))}`;
}

function exampleBlock(manual) {
  if (!manual.example) return '';
  return `> ${manualText(manual.example.ask)}\n\n${manualText(manual.example.result)}`;
}

async function manualSteps(runDir, plan, files, publishStep, templates) {
  const screenshots = new Map(files
    .filter((file) => file.kind === 'screenshot')
    .map((file) => [file.step_id, file]));
  const blocks = [];
  const assets = [];
  let published = 0;
  let total = 0;
  let section = null;

  for (const step of plan.steps.filter(({ manual }) => manual)) {
    const manual = step.manual;
    // Consecutive steps sharing a section name become one chapter of the document, so a reader
    // meets a task rather than a numbered run of unrelated screens.
    if (manual.section !== undefined && manual.section !== section) {
      section = manual.section;
      blocks.push(fillTemplate(templates.section, {
        section: markdownText(section),
      }).trim());
    }
    total += 1;
    let image = '';
    let withheld = '';
    if (publishStep(step)) {
      const asset = await screenshotAsset(runDir, step, screenshots.get(step.id), total);
      assets.push(asset);
      image = `![${markdownText(imageAlt(step))}](assets/${asset.name})`;
      published += 1;
    } else withheld = 'Unpublished pending review.';

    blocks.push(fillTemplate(templates.step, {
      index: String(total),
      title: markdownText(manual.title),
      intro: manual.intro === undefined ? '' : manualText(manual.intro),
      actions: actionBlock(manual),
      // Kept so a run-local template written against the single-sentence shape still renders.
      instruction: manualText(manual.instruction ?? ''),
      image,
      image_withheld: withheld,
      checkpoints: checkpointBlock(manual),
      example: exampleBlock(manual),
      expected: manualText(manual.expected),
      tips: calloutBlock(manual.tips ?? [], '💡'),
      cautions: calloutBlock(manual.cautions, '🔒'),
    }).trimEnd());
  }
  if (total === 0) throw renderError('MANUAL_STEPS_MISSING');
  return { markdown: blocks.join('\n\n'), assets, published, total };
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

async function publishOutput(runDir, outputRoot, name, markdown, assets = []) {
  const relative = `${outputRoot}/${name}`;
  const document = Buffer.from(markdown, 'utf8');
  const destination = jobRelative(runDir, relative);
  await preflightDirectory(jobRelative(runDir, outputRoot), outputRoot);
  if (assets.length > 0) {
    await preflightDirectory(jobRelative(runDir, `${outputRoot}/assets`), `${outputRoot}/assets`);
  }
  await preflightFile(destination, document, 'OUTPUT_CONFLICT', relative);
  const prepared = assets.map((asset) => ({
    ...asset,
    destination: jobRelative(runDir, `${outputRoot}/assets/${asset.name}`),
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
  const template = await loadTemplate(runDir, TEMPLATE_NAMES[type]);
  const scope = [
    `Goal: ${markdownText(run.goal)}`,
    `Steps: ${plan.steps.map((step) => markdownText(step.goal)).join('; ')}`,
  ].join('\n');
  // Attempt 1 owns `output/`; a later attempt publishes beside it under `output/attempt-<NNN>/`.
  // Retries therefore deliver a document instead of dead-ending on immutable prior output.
  const outputRoot = verified.attempt === 1
    ? 'output'
    : `output/attempt-${String(verified.attempt).padStart(3, '0')}`;

  if (type === 'qa') {
    return publishOutput(runDir, outputRoot, 'result.md', fillTemplate(template, {
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
    stepPublishGate(criteria, aggregate, verified.contested_steps),
    {
      step: await loadTemplate(runDir, 'manual.step'),
      section: await loadTemplate(runDir, 'manual.section'),
    },
  );
  const document = plan.document;
  return publishOutput(runDir, outputRoot, 'manual.md', fillTemplate(template, {
    run_id: markdownText(verified.run_id),
    // Exactly one of these carries the title: a plan that wrote a document names it, and one that
    // did not falls back to the run. Both lines are placeholder-only, so the unused one is dropped.
    document_title: document ? markdownText(document.title) : '',
    fallback_title: document ? '' : markdownText(verified.run_id),
    overview: document ? manualText(document.overview) : '',
    prerequisites: document?.prerequisites?.length
      ? `\n\n${document.prerequisites.map((item) => `- ${manualText(item)}`).join('\n')}`
      : '',
    scope,
    environment: environment(run, verified.attempt),
    review_status: manualReviewStatus(
      aggregate, criteria, verified.requires_human_review, manual,
    ),
    steps: manual.markdown,
  }), manual.assets);
}
