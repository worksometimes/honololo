const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex');
const VERDICT_ORDER = { pass: 0, needs_human: 1, fail: 2 };

export const DETERMINISTIC_TYPES = new Set([
  'url_matches', 'snapshot_contains', 'snapshot_not_contains', 'file_exists', 'image_exists',
]);

export function worstVerdict(verdicts) {
  let worst = 'pass';
  for (const verdict of verdicts) {
    if (VERDICT_ORDER[verdict] > VERDICT_ORDER[worst]) worst = verdict;
  }
  return worst;
}

// An executor may record a verdict more conservative than the evidence requires — withholding is
// always allowed. It may not record a weaker one: not a `pass` the bytes do not satisfy, and not a
// `needs_human` over a criterion the bytes deterministically fail. Masking a failure as unresolved
// is not caution; it publishes screenshots a failed run withholds and reads as pending, not failed.
export function weakerThanEvidence(claimed, evaluated) {
  return VERDICT_ORDER[claimed] < VERDICT_ORDER[evaluated];
}

function parsedSnapshot(file) {
  if (!file) return null;
  try {
    const value = JSON.parse(file.bytes.toString('utf8'));
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

// Searchable text of a snapshot: the rendered strings only. Structural JSON keys are excluded, so
// `snapshot_contains "button"` cannot pass on a role name the page never displayed. The URL is
// excluded too — the executor chooses it, and a crafted query string would otherwise let any phrase
// satisfy a content criterion from a page that never showed it. `url_matches` is for URLs.
export function snapshotHaystack(file) {
  const parsed = parsedSnapshot(file);
  if (!parsed) return file.bytes.toString('utf8');
  const parts = [parsed.title, parsed.text];
  for (const element of Array.isArray(parsed.elements) ? parsed.elements : []) {
    parts.push(element?.name);
  }
  return parts.filter((part) => typeof part === 'string').join('\n');
}

export function pairedScreenshotDigest(file) {
  const parsed = parsedSnapshot(file);
  return typeof parsed?.paired_sha256 === 'string' ? parsed.paired_sha256 : null;
}

function observedUrl(step) {
  const url = step.files.get('url');
  if (url) return { text: url.bytes.toString('utf8').trim(), file: url };
  const snapshot = step.files.get('snapshot');
  const parsed = parsedSnapshot(snapshot);
  if (typeof parsed?.url === 'string') return { text: parsed.url, file: snapshot };
  return null;
}

function declaredFile(step, value) {
  for (const file of step.files.values()) {
    if (file.path === value || file.path.endsWith(`/${value}`)) return file;
  }
  return null;
}

function record(criterion, verdict, reason, file, step) {
  const cited = file ?? step.files.values().next().value;
  return { id: criterion.id, verdict, reason, evidence: [cited.path] };
}

// Evaluates one deterministic criterion against captured evidence bytes. Reasons never quote page
// content, so a criterion record cannot become a channel for secrets the capture gate missed.
export function evaluateCriterion(criterion, step) {
  const { type, value } = criterion;
  if (type === 'url_matches') {
    const observed = observedUrl(step);
    if (!observed) {
      return record(criterion, 'needs_human', 'url_matches: no url or snapshot evidence', null, step);
    }
    const hit = observed.text.includes(value);
    return record(
      criterion, hit ? 'pass' : 'fail',
      `url_matches: observed url contains ${JSON.stringify(value)} = ${hit}`,
      observed.file, step,
    );
  }

  if (type === 'snapshot_contains' || type === 'snapshot_not_contains') {
    const snapshot = step.files.get('snapshot');
    if (!snapshot) {
      return record(criterion, 'needs_human', `${type}: no snapshot evidence`, null, step);
    }
    const present = snapshotHaystack(snapshot).includes(value);
    const wanted = type === 'snapshot_contains';
    return record(
      criterion, present === wanted ? 'pass' : 'fail',
      `${type}: visible snapshot text contains ${JSON.stringify(value)} = ${present}`,
      snapshot, step,
    );
  }

  if (type === 'file_exists' || type === 'image_exists') {
    const file = declaredFile(step, value);
    if (!file || file.size === 0) {
      return record(criterion, 'fail', `${type}: ${JSON.stringify(value)} is not declared evidence`, null, step);
    }
    if (type === 'image_exists') {
      const png = file.kind === 'screenshot' &&
        file.bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);
      return record(
        criterion, png ? 'pass' : 'fail',
        `image_exists: ${JSON.stringify(value)} is a ${file.size}-byte PNG screenshot = ${png}`,
        file, step,
      );
    }
    return record(criterion, 'pass', `file_exists: ${JSON.stringify(value)} is ${file.size} bytes`, file, step);
  }

  return record(criterion, 'needs_human', `unsupported deterministic type: ${type}`, null, step);
}

// Evaluates every deterministic criterion of the plan, so coverage of the plan is always complete.
// Callers must supply captured evidence for every plan step; a step with none is a caller error
// rather than a verdict, because a criterion record has to cite at least one evidence path.
export function evaluateAttempt(plan, stepsById) {
  const records = [];
  for (const planStep of plan.steps) {
    const step = stepsById.get(planStep.id);
    const deterministic = planStep.done_when.filter(({ type }) => DETERMINISTIC_TYPES.has(type));
    if (deterministic.length > 0 && (!step || step.files.size === 0)) {
      const error = new Error(`HONOLOLO_CRITERIA_STEP_EVIDENCE_MISSING: ${planStep.id}`);
      error.code = 'HONOLOLO_CRITERIA_STEP_EVIDENCE_MISSING';
      throw error;
    }
    for (const criterion of deterministic) records.push(evaluateCriterion(criterion, step));
  }
  return records;
}
