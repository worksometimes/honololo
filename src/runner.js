import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { createProvider } from './providers/index.js';
import { VentiError, PROTOCOL_VERSION, RESULT_STATUSES } from './types.js';
import {
  appendJsonl,
  atomicWrite,
  deepGet,
  ensureDir,
  fileExists,
  globToRegExp,
  json,
  nowIso,
  parseMaybeJson,
  readJsonl,
  redactText,
  redactDeep,
  sha256,
  sha256File,
  toAbsolute,
} from './util.js';

function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'run';
}

let planValidatorPromise;

async function validatePlanDocument(plan, planFile) {
  if (!planValidatorPromise) {
    planValidatorPromise = (async () => {
      const schema = JSON.parse(await readFile(new URL('../schemas/plan.schema.json', import.meta.url), 'utf8'));
      const ajv = new Ajv({ allErrors: true, strict: false });
      addFormats(ajv);
      return ajv.compile(schema);
    })();
  }
  const validate = await planValidatorPromise;
  if (!validate(plan)) {
    throw new VentiError(`Plan schema validation failed: ${planFile}`, {
      code: 'INVALID_PLAN',
      details: { errors: validate.errors ?? [] },
    });
  }
}

function runId(planId) {
  const date = new Date().toISOString().replace(/[-:]/g, '').replace('T', '_').replace(/\.\d+Z$/, '');
  return `${date}_${slug(planId)}`;
}

async function writeState(runDir, state) {
  let previous = {};
  try { previous = JSON.parse(await readFile(join(runDir, 'state.json'), 'utf8')); } catch { /* first checkpoint */ }
  await atomicWrite(join(runDir, 'state.json'), json({ ...previous, ...state, updated_at: nowIso() }));
}

function normalizePlan(plan, planFile) {
  if (!plan || typeof plan !== 'object') throw new VentiError(`Plan is not an object: ${planFile}`, { code: 'INVALID_PLAN' });
  const required = ['id', 'goal', 'target', 'items', 'limits', 'forbidden'];
  const missing = required.filter((key) => plan[key] === undefined);
  if (missing.length) throw new VentiError(`Plan is missing required fields: ${missing.join(', ')}`, { code: 'INVALID_PLAN' });
  if (!Array.isArray(plan.items) || plan.items.length === 0) throw new VentiError('Plan must contain at least one item', { code: 'INVALID_PLAN' });
  if (!plan.target.url || !Array.isArray(plan.target.allowed_domains) || plan.target.allowed_domains.length === 0) {
    throw new VentiError('Plan target must include url and allowed_domains', { code: 'INVALID_PLAN' });
  }
  const ids = new Set();
  for (const item of plan.items) {
    if (!item.id || ids.has(item.id)) throw new VentiError(`Duplicate or missing item id: ${item.id ?? '(missing)'}`, { code: 'INVALID_PLAN' });
    ids.add(item.id);
    if (!Array.isArray(item.expect) || item.expect.length === 0) throw new VentiError(`Item ${item.id} has no expectations`, { code: 'INVALID_PLAN' });
  }
  assertNoInlineSecrets(plan);
  return {
    schema_version: '1.0',
    kind: 'smoke',
    channel: 'browser',
    ...plan,
    limits: {
      max_items: plan.items.length,
      max_attempts_per_item: 1,
      max_heals_per_item: 0,
      stop_after_consecutive_failures: 3,
      timeout_ms_per_item: 120000,
      max_tool_calls: 1000,
      max_llm_calls: 0,
      max_parallel_agents: 1,
      ...plan.limits,
    },
    forbidden: [...new Set(plan.forbidden ?? [])],
  };
}

function assertNoInlineSecrets(value, path = 'plan') {
  const sensitive = /^(authorization|cookie|set-cookie|password|secret|api[_-]?key|access[_-]?token|refresh[_-]?token)$/i;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoInlineSecrets(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (sensitive.test(key)) throw new VentiError(`Inline secret-like field is not allowed at ${path}.${key}; use an *_env reference`, { code: 'INLINE_SECRET_REJECTED' });
    assertNoInlineSecrets(child, `${path}.${key}`);
  }
}

function providerConfig(plan, options, root, redact = []) {
  const config = {
    ...(plan.provider_config ?? {}),
    session: plan.target.session,
    restore: plan.target.restore ?? false,
    allowed_domains: plan.target.allowed_domains,
    api_base: plan.target.api_base,
    root,
    redact,
    headless: options.headless ?? plan.headless,
    timeout_ms: plan.limits.timeout_ms_per_item,
    namespace: options.namespace ?? plan.target.key ?? plan.target.session ?? 'venti-default',
  };
  if (config.cdp_url_env) {
    config.cdp_url = process.env[config.cdp_url_env];
    delete config.cdp_url_env;
  }
  if (config.cdp_ws_env) {
    config.cdp_ws = process.env[config.cdp_ws_env];
    delete config.cdp_ws_env;
  }
  return config;
}

function actionLabel(action) {
  return Object.keys(action)[0] ?? 'unknown';
}

function assertActionAllowed(action, plan, item, allowRisk) {
  const serialized = JSON.stringify(action).toLowerCase();
  const forbidden = (plan.forbidden ?? []).find((phrase) => serialized.includes(String(phrase).toLowerCase()));
  if (forbidden) throw new VentiError(`Action matches forbidden operation: ${forbidden}`, { code: 'SAFETY_GATE_REQUIRED', retryable: false, details: { item_id: item.id, action } });
  if (['high', 'critical'].includes(item.risk) && !allowRisk) {
    throw new VentiError(`Item ${item.id} has ${item.risk} risk and requires --approve-risk`, { code: 'SAFETY_GATE_REQUIRED', retryable: false, details: { item_id: item.id, risk: item.risk } });
  }
}

function locatorFrom(target) {
  if (!target) return undefined;
  if (!target.by) return target;
  return target.nth === undefined ? target.by : { ...target.by, nth: target.nth };
}

async function executeAction(provider, action, context) {
  const [kind, value] = Object.entries(action)[0] ?? [];
  switch (kind) {
    case 'open': return provider.open(String(value).replaceAll('${target.url}', context.plan.target.url));
    case 'reload': return provider.reload();
    case 'click': return provider.click(locatorFrom(value));
    case 'fill': return provider.fill(value.by ?? value, value.text ?? '');
    case 'type': return provider.type(value.by ?? value, value.text ?? '');
    case 'press': return provider.press(value.key, value.by ?? undefined);
    case 'select': return provider.select(value.by ?? value, value.value);
    case 'upload': return provider.upload(value.by ?? value, toAbsolute(context.root, value.path));
    case 'scroll': return provider.scroll(value.direction ?? 'down', value.amount);
    case 'wait_for': return provider.waitFor(value);
    case 'screenshot': return provider.screenshot(join(context.evidenceDir, value.name ?? 'action.png'));
    case 'api_request':
      if (typeof provider.request !== 'function') throw new VentiError('Current provider cannot execute api_request', { code: 'UNSUPPORTED_CHANNEL' });
      return provider.request(value);
    default: throw new VentiError(`Unsupported action: ${kind}`, { code: 'INVALID_ACTION' });
  }
}

function locatorDescription(locator) {
  if (!locator) return 'element';
  return Object.entries(locator).map(([key, value]) => `${key}=${value}`).join(', ');
}

function domainAllowed(url, allowedDomains) {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return allowedDomains.some((pattern) => {
      const normalized = String(pattern).toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/\/.*$/, '');
      return normalized.startsWith('*.')
        ? hostname === normalized.slice(2) || hostname.endsWith(`.${normalized.slice(2)}`)
        : hostname === normalized;
    });
  } catch {
    return false;
  }
}

function assertTargetBoundary(url, plan) {
  if (!url || !domainAllowed(url, plan.target.allowed_domains)) {
    throw new VentiError(`Browser left the allowed target boundary: ${url || '(unknown URL)'}`, {
      code: 'DOMAIN_BOUNDARY_VIOLATION',
      retryable: false,
      details: { allowed_domains: plan.target.allowed_domains },
    });
  }
}

function assertActionBoundary(action, plan) {
  const [kind, value] = Object.entries(action)[0] ?? [];
  if (kind === 'open') {
    const raw = String(value).replaceAll('${target.url}', plan.target.url);
    let url;
    try { url = new URL(raw, plan.target.url).toString(); } catch { url = raw; }
    assertTargetBoundary(url, plan);
  }
  if (kind === 'api_request') {
    let url;
    try { url = new URL(value.path, plan.target.api_base ?? plan.target.url).toString(); } catch { url = value.path; }
    assertTargetBoundary(url, plan);
  }
}

async function visible(provider, locator, observation) {
  if (typeof provider.isVisible === 'function') return provider.isVisible(locator);
  const needle = locator?.name ?? locator?.text ?? locator?.label ?? locator?.placeholder ?? locator?.test_id;
  return needle ? String(observation.snapshot ?? observation.text ?? '').includes(needle) : false;
}

async function countAtLeast(provider, locator, expected, observation) {
  if (typeof provider.count === 'function') return (await provider.count(locator)) >= expected;
  const needle = locator?.name ?? locator?.text ?? locator?.label ?? locator?.placeholder;
  if (!needle) return false;
  const text = String(observation.snapshot ?? observation.text ?? '');
  return text.split(needle).length - 1 >= expected;
}

async function checkExpectation(expectation, observation, provider) {
  const [kind, expected] = Object.entries(expectation)[0] ?? [];
  const text = String(observation.text ?? '');
  const evidence = ['evidence/page.txt', 'evidence/observation.json'];
  switch (kind) {
    case 'contains': return { expectation: `${kind}: ${expected}`, ok: text.includes(String(expected)), observed: text.includes(String(expected)) ? String(expected) : text.slice(0, 500), evidence };
    case 'not_contains': return { expectation: `${kind}: ${expected}`, ok: !text.includes(String(expected)), observed: text.includes(String(expected)) ? String(expected) : 'not present', evidence };
    case 'url_matches': {
      const pattern = String(expected);
      let ok = false;
      try { ok = new RegExp(pattern).test(observation.url); } catch { ok = globToRegExp(pattern).test(observation.url); }
      return { expectation: `${kind}: ${expected}`, ok, observed: observation.url, evidence: ['evidence/url.txt'] };
    }
    case 'visible': {
      const locator = locatorFrom(expected);
      const ok = await visible(provider, locator, observation);
      return { expectation: `${kind}: ${locatorDescription(locator)}`, ok, observed: ok ? 'visible' : 'not visible', evidence };
    }
    case 'not_visible': {
      const locator = locatorFrom(expected);
      const ok = !(await visible(provider, locator, observation));
      return { expectation: `${kind}: ${locatorDescription(locator)}`, ok, observed: ok ? 'not visible' : 'visible', evidence };
    }
    case 'count_at_least': {
      const locator = locatorFrom(expected.target);
      const ok = await countAtLeast(provider, locator, expected.count, observation);
      return { expectation: `${kind}: ${locatorDescription(locator)} >= ${expected.count}`, ok, observed: ok ? `>= ${expected.count}` : 'below threshold', evidence };
    }
    case 'value_equals': {
      if (typeof provider.value !== 'function') return { expectation: `${kind}: ${locatorDescription(locatorFrom(expected.target))}`, ok: false, observed: 'provider does not expose values', evidence, reason: 'needs_human: provider capability missing' };
      const observed = await provider.value(locatorFrom(expected.target));
      return { expectation: `${kind}: ${locatorDescription(locatorFrom(expected.target))}`, ok: observed === expected.value, observed, evidence };
    }
    case 'status_equals': {
      const observed = observation.metadata?.status;
      return { expectation: `${kind}: ${expected}`, ok: observed === expected, observed, evidence: ['evidence/observation.json'] };
    }
    case 'json_path_exists': {
      const observed = deepGet(observation.metadata?.body, expected);
      return { expectation: `${kind}: ${expected}`, ok: observed !== undefined, observed, evidence: ['evidence/observation.json'] };
    }
    case 'json_path_equals': {
      const observed = deepGet(observation.metadata?.body, expected.path);
      return { expectation: `${kind}: ${expected.path}`, ok: JSON.stringify(observed) === JSON.stringify(expected.value), observed, evidence: ['evidence/observation.json'] };
    }
    case 'json_contains': {
      const observed = JSON.stringify(observation.metadata?.body ?? '');
      return { expectation: `${kind}: ${expected}`, ok: observed.includes(String(expected)), observed: observed.slice(0, 500), evidence: ['evidence/observation.json'] };
    }
    case 'rubric': return { expectation: 'rubric', ok: false, observed: 'deterministic runner does not judge rubrics', evidence, reason: 'needs_human: use verifier agent' };
    default: return { expectation: `${kind}`, ok: false, observed: 'unsupported expectation', evidence, reason: 'needs_human: unsupported expectation' };
  }
}

function classifyError(error) {
  if (error?.code === 'INVALID_LOCATOR') return 'locator';
  if (['SAFETY_GATE_REQUIRED', 'DOMAIN_BOUNDARY_VIOLATION', 'INLINE_SECRET_REJECTED'].includes(error?.code)) return 'safety';
  if (error?.code === 'PROVIDER_TIMEOUT' || error?.retryable) return 'timing';
  if (error?.code === 'UNSUPPORTED_CHANNEL' || error?.code === 'MISSING_PROVIDER') return 'environment';
  if (error?.code === 'INVALID_ACTION' || error?.code === 'INVALID_PLAN') return 'environment';
  return 'environment';
}

function retryableError(error) {
  return Boolean(error?.retryable) && error.code !== 'INVALID_LOCATOR';
}

function missingEvidence(requested = [], files = {}) {
  return requested.filter((kind) => !files[kind]);
}

function safeActionForLedger(action, redact = []) {
  const safe = redactDeep(action, redact);
  const [kind, value] = Object.entries(safe)[0] ?? [];
  if (['fill', 'type'].includes(kind) && value && typeof value === 'object') {
    const locator = value.by ?? value;
    if (/(password|passcode|secret|token|api[ _-]?key|authorization|otp|one[- ]time)/i.test(JSON.stringify(locator))) value.text = '[REDACTED]';
  }
  return safe;
}

async function capture(provider, runDir, itemId, attempt, redact = [], { tracePath = null, apiResponse = false, wantScreenshot = true } = {}) {
  const evidenceDir = join(runDir, 'evidence', itemId, `attempt-${attempt}`);
  await ensureDir(evidenceDir);
  const observation = await provider.observe();
  await atomicWrite(join(evidenceDir, 'page.txt'), redactText(observation.text ?? '', redact));
  await atomicWrite(join(evidenceDir, 'url.txt'), `${observation.url ?? ''}\n`);
  await atomicWrite(join(evidenceDir, 'snapshot.txt'), redactText(observation.snapshot ?? '', redact));
  await atomicWrite(join(evidenceDir, 'observation.json'), json(redactDeep({ ...observation, text: redactText(observation.text ?? '', redact) }, redact)));
  const files = {
    screenshot: false,
    page_text: true,
    url: true,
    action_ledger: await fileExists(join(evidenceDir, 'actions.jsonl')),
    trace: Boolean(tracePath && await fileExists(toAbsolute(runDir, tracePath))),
    api_response: apiResponse,
    console: false,
    network: false,
  };
  if (wantScreenshot) {
    try { await provider.screenshot(join(evidenceDir, 'screenshot.png')); } catch (error) {
      await atomicWrite(join(evidenceDir, 'screenshot.error.txt'), `${redactText(error.message, redact)}\n`);
    }
    files.screenshot = await fileExists(join(evidenceDir, 'screenshot.png'));
  }
  const relativeDir = `evidence/${itemId}/attempt-${attempt}`;
  const evidence = [relativeDir];
  const names = {
    screenshot: 'screenshot.png', page_text: 'page.txt', url: 'url.txt', action_ledger: 'actions.jsonl',
    trace: 'trace.zip', api_response: 'observation.json', console: 'console.jsonl', network: 'network.jsonl',
  };
  for (const [kind, present] of Object.entries(files)) if (present && names[kind]) evidence.push(`${relativeDir}/${names[kind]}`);
  return { observation, evidenceDir: relativeDir, files, evidence };
}

async function runItem(provider, plan, item, context) {
  const maxAttempts = plan.limits.max_attempts_per_item;
  let lastResult;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const started = Date.now();
    const evidenceDir = join(context.runDir, 'evidence', item.id, `attempt-${attempt}`);
    await ensureDir(evidenceDir);
    const actionsPath = join(evidenceDir, 'actions.jsonl');
    await atomicWrite(actionsPath, '');
    const traceRequested = item.evidence?.includes('trace') || plan.provider_config?.trace === true;
    let traceActive = false;
    let tracePath = null;
    let traceError = null;
    const finishTrace = async () => {
      if (!traceActive) return;
      try {
        tracePath = await provider.stopTrace(join(evidenceDir, 'trace.zip'));
      } catch (error) {
        traceError = redactText(error.message, context.redact);
      } finally {
        traceActive = false;
      }
    };
    await appendJsonl(join(context.runDir, 'events.jsonl'), { ts: nowIso(), node: 'ITEM_SETUP', status: 'running', item_id: item.id, attempt });
    try {
      if (traceRequested) {
        try {
          traceActive = Boolean(await provider.startTrace());
          if (!traceActive) traceError = 'Provider does not expose trace capture';
        } catch (error) {
          traceError = redactText(error.message, context.redact);
        }
      }
      for (const action of [...(plan.setup ?? []), ...(item.setup ?? []), ...(item.actions ?? [])]) {
        assertActionAllowed(action, plan, item, context.allowRisk);
        assertActionBoundary(action, plan);
        const actionStarted = Date.now();
        const safeAction = safeActionForLedger(action, context.redact);
        await appendJsonl(actionsPath, { ts: nowIso(), node: 'ACT', status: 'started', action: safeAction });
        await appendJsonl(join(context.runDir, 'events.jsonl'), { ts: nowIso(), node: 'ACT', status: 'running', item_id: item.id, attempt, action: actionLabel(action) });
        try {
          await executeAction(provider, action, { ...context, plan, item, evidenceDir });
          const afterUrl = await provider.currentUrl();
          assertTargetBoundary(afterUrl, plan);
          await appendJsonl(actionsPath, { ts: nowIso(), node: 'ACT', status: 'complete', action: safeAction, url: afterUrl, elapsed_ms: Date.now() - actionStarted });
        } catch (error) {
          await appendJsonl(actionsPath, { ts: nowIso(), node: 'ACT', status: 'error', action: safeAction, error: { code: error.code, message: redactText(error.message, context.redact) }, elapsed_ms: Date.now() - actionStarted });
          throw error;
        }
      }
      await finishTrace();
      const captured = await capture(provider, context.runDir, item.id, attempt, context.redact, {
        tracePath,
        apiResponse: item.channel === 'api' || plan.channel === 'api' || provider.info().capabilities.includes('api'),
        wantScreenshot: Boolean(item.evidence?.includes('screenshot')),
      });
      assertTargetBoundary(captured.observation.url, plan);
      const checks = [];
      for (const expectation of item.expect) checks.push(await checkExpectation(expectation, captured.observation, provider));
      const missing = missingEvidence(item.evidence, captured.files);
      const hasUnknown = missing.length > 0 || Boolean(traceError) || checks.some((check) => check.reason?.startsWith('needs_human'));
      const passed = checks.every((check) => check.ok);
      const status = hasUnknown ? 'needs_human' : passed ? 'pass' : 'fail';
      const rubricPending = status === 'needs_human'
        && missing.length === 0 && !traceError
        && checks.some((check) => check.reason === 'needs_human: use verifier agent')
        && checks.filter((check) => check.reason !== 'needs_human: use verifier agent').every((check) => check.ok);
      if (status !== 'pass' && !captured.files.screenshot) {
        try {
          await provider.screenshot(join(evidenceDir, 'screenshot.png'));
          captured.files.screenshot = await fileExists(join(evidenceDir, 'screenshot.png'));
          if (captured.files.screenshot) captured.evidence.push(`${captured.evidenceDir}/screenshot.png`);
        } catch { /* diagnostic screenshot only; the verdict already stands */ }
      }
      lastResult = {
        run_id: context.runId,
        plan_id: plan.id,
        plan_hash: context.planHash,
        item_id: item.id,
        attempt,
        status,
        failure_class: status === 'pass' ? null : hasUnknown ? 'ambiguous' : 'product',
        checks,
        evidence: captured.evidence,
        healed: false,
        audited: false,
        rubric_pending: rubricPending,
        confidence: status === 'pass' ? 'high' : hasUnknown ? 'low' : 'medium',
        reason: status === 'pass' ? 'All deterministic expectations passed.' : missing.length ? `Required evidence is missing: ${missing.join(', ')}` : traceError ? `Trace evidence unavailable: ${traceError}` : hasUnknown ? 'At least one expectation needs a verifier or provider capability.' : 'One or more deterministic expectations failed.',
        elapsed_ms: Date.now() - started,
        timestamp: nowIso(),
      };
      await atomicWrite(join(evidenceDir, 'execution.json'), json({ item_id: item.id, attempt, status, action_ledger: 'actions.jsonl', evidence: captured.files, trace_error: traceError, elapsed_ms: lastResult.elapsed_ms }));
      await appendJsonl(join(context.runDir, 'results.jsonl'), lastResult);
      await appendJsonl(join(context.runDir, 'events.jsonl'), { ts: nowIso(), node: 'VERIFY', status, item_id: item.id, attempt });
      return lastResult;
    } catch (error) {
      await finishTrace();
      const failureClass = classifyError(error);
      const retry = retryableError(error) && attempt < maxAttempts;
      const fallbackEvidence = `evidence/${item.id}/attempt-${attempt}`;
      const safeMessage = redactText(error.message, context.redact);
      await atomicWrite(join(evidenceDir, 'execution.error.json'), json({ code: error.code, message: safeMessage, failure_class: failureClass, retry }));
      lastResult = {
        run_id: context.runId,
        plan_id: plan.id,
        plan_hash: context.planHash,
        item_id: item.id,
        attempt,
        status: retry ? 'blocked' : ['locator', 'safety'].includes(failureClass) ? 'needs_human' : 'error',
        failure_class: failureClass,
        checks: [],
        evidence: [fallbackEvidence, `${fallbackEvidence}/execution.error.json`],
        healed: false,
        audited: false,
        confidence: 'low',
        reason: safeMessage,
        elapsed_ms: Date.now() - started,
        timestamp: nowIso(),
      };
      await atomicWrite(join(evidenceDir, 'execution.json'), json({ item_id: item.id, attempt, status: lastResult.status, action_ledger: 'actions.jsonl', trace_path: tracePath, trace_error: traceError, elapsed_ms: lastResult.elapsed_ms, error: { code: error.code, message: safeMessage, failure_class: failureClass, retry } }));
      if (!retry) await appendJsonl(join(context.runDir, 'results.jsonl'), lastResult);
      await appendJsonl(join(context.runDir, 'events.jsonl'), { ts: nowIso(), node: 'CLASSIFY', status: retry ? 'retry' : lastResult.status, item_id: item.id, attempt, failure_class: failureClass, error: safeMessage });
      if (!retry) return lastResult;
    }
  }
  return lastResult;
}

function reportFor(plan, results, context, providerInfo) {
  const counts = Object.fromEntries(RESULT_STATUSES.map((status) => [status, results.filter((result) => result.status === status).length]));
  const lines = [
    `# ${plan.id} — ${context.runId}`,
    '',
    `Result: ${results.length} items — ${counts.pass} pass, ${counts.pass_needs_review} pass-needs-review, ${counts.fail} fail, ${counts.flaky} flaky, ${counts.needs_human} needs human, ${counts.error} error, ${counts.blocked} blocked, ${counts.skipped} skipped.`,
    `Provider: ${providerInfo.name}. Plan hash: ${context.planHash}.`,
    '',
    '## Findings',
  ];
  for (const result of results.filter((item) => !['pass'].includes(item.status))) {
    lines.push('', `### ${result.item_id} — ${result.status}`, `- Reason: ${result.reason}`, `- Evidence: ${result.evidence.join(', ')}`);
    for (const check of result.checks ?? []) if (!check.ok) lines.push(`- Expected: ${check.expectation}`, `- Observed: ${String(check.observed ?? '').slice(0, 500)}`);
  }
  if (results.every((result) => result.status === 'pass')) lines.push('', 'No deterministic failures observed.');
  return { counts, markdown: `${lines.join('\n')}\n` };
}

export async function loadPlan(planFile) {
  const source = await readFile(planFile, 'utf8');
  const parsed = planFile.endsWith('.json') ? JSON.parse(source) : parse(source);
  await validatePlanDocument(parsed, planFile);
  return { plan: normalizePlan(parsed, planFile), source, planHash: sha256(source) };
}

export async function executePlan({ planFile, root, providerName, providerOptions = {}, runId: requestedRunId, dryRun = false, redact = [], resume = true, allowRisk = false }) {
  const absolutePlan = toAbsolute(root, planFile);
  const { plan, source, planHash } = await loadPlan(absolutePlan);
  const run = requestedRunId ?? runId(plan.id);
  const runDir = join(root, 'runs', run);
  const existingManifestPath = join(runDir, 'manifest.json');
  const existingResultsPath = join(runDir, 'results.jsonl');
  let existingManifest = null;
  if (await fileExists(existingManifestPath)) {
    try { existingManifest = JSON.parse(await readFile(existingManifestPath, 'utf8')); } catch { existingManifest = null; }
  }
  if (existingManifest?.plan_hash && existingManifest.plan_hash !== planHash) {
    throw new VentiError(`Run ${run} belongs to a different plan hash`, { code: 'RESUME_PLAN_MISMATCH', details: { existing: existingManifest.plan_hash, requested: planHash } });
  }
  const previousResults = resume ? await readJsonl(existingResultsPath) : [];
  const previousByItem = new Map();
  for (const result of previousResults) if (result.item_id) previousByItem.set(result.item_id, result);
  await ensureDir(runDir);
  await ensureDir(join(runDir, 'evidence'));
  await atomicWrite(join(runDir, 'plan.snapshot.yaml'), source);
  const provider = createProvider(providerName ?? plan.provider ?? 'agent-browser', { ...providerConfig(plan, providerOptions, root, redact), ...providerOptions });
  const manifest = {
    schema_version: plan.schema_version,
    run_id: run,
    plan_id: plan.id,
    plan_hash: planHash,
    target: plan.target,
    channel: plan.channel,
    provider: provider.info(),
    execution_mode: 'standalone_deterministic',
    started_at: existingManifest?.started_at ?? nowIso(),
    ...(previousByItem.size ? { resumed_at: nowIso() } : {}),
    versions: {
      node: process.version,
      protocol: PROTOCOL_VERSION,
      provider: provider.info().provider_version ?? null,
      prompt_revision: plan.prompt_revision ?? null,
    },
    budgets: plan.limits,
    redactions: redact.length,
    baseline_run_id: plan.baseline?.run_id ?? null,
    dry_run: dryRun,
    resumed: previousByItem.size > 0,
  };
  await atomicWrite(join(runDir, 'manifest.json'), json(manifest));
  await writeState(runDir, { node: 'INTAKE', status: 'ready', run_id: run, plan_id: plan.id, plan_hash: planHash });
  const context = { root, runId: run, runDir, planHash, redact, allowRisk };
  const results = [];
  let consecutiveFailures = 0;
  try {
    await appendJsonl(join(runDir, 'events.jsonl'), { ts: nowIso(), node: 'INTAKE', status: 'started', run_id: run, plan_id: plan.id, plan_hash: planHash });
    await writeState(runDir, { node: 'INTAKE', status: 'running' });
    if (dryRun) {
      for (const item of plan.items.slice(0, plan.limits.max_items)) {
        const skipped = { item_id: item.id, status: 'skipped', reason: 'dry-run', checks: [], evidence: [], attempt: 0 };
        results.push(skipped);
        await writeState(runDir, { node: 'ITEM_COMPLETE', status: 'skipped', item_id: item.id, attempt: 0 });
      }
    } else {
      for (const item of plan.items.slice(0, plan.limits.max_items)) {
        const previous = previousByItem.get(item.id);
        if (previous && ['pass', 'pass_needs_review', 'fail', 'flaky', 'needs_human', 'error', 'skipped'].includes(previous.status)) {
          results.push(previous);
          await appendJsonl(join(runDir, 'events.jsonl'), { ts: nowIso(), node: 'RESUME', status: 'skipped_completed', item_id: item.id, previous_status: previous.status });
          await writeState(runDir, { node: 'ITEM_COMPLETE', status: previous.status, item_id: item.id, attempt: previous.attempt ?? 0, resumed: true });
          continue;
        }
        const result = await runItem(provider, plan, item, context);
        results.push(result);
        await writeState(runDir, { node: 'ITEM_COMPLETE', status: result.status, item_id: item.id, attempt: result.attempt ?? 0 });
        const failureLike = ['fail', 'error', 'blocked'].includes(result.status)
          || (result.status === 'needs_human' && !result.rubric_pending);
        if (failureLike) consecutiveFailures += 1;
        else consecutiveFailures = 0;
        if (consecutiveFailures >= plan.limits.stop_after_consecutive_failures) {
          await appendJsonl(join(runDir, 'events.jsonl'), { ts: nowIso(), node: 'STOP_GATE', status: 'blocked', reason: 'consecutive failure threshold', count: consecutiveFailures });
          break;
        }
      }
    }
  } finally {
    try { await provider.close(); } catch (error) { await appendJsonl(join(runDir, 'events.jsonl'), { ts: nowIso(), node: 'CLOSE', status: 'error', error: error.message }); }
  }
  const report = reportFor(plan, results, context, provider.info());
  const complete = results.length === Math.min(plan.items.length, plan.limits.max_items);
  await writeState(runDir, { node: complete ? 'COMPLETE' : 'BLOCKED', status: complete ? 'complete' : 'blocked', counts: report.counts });
  await atomicWrite(join(runDir, 'summary.json'), json({ run_id: run, plan_id: plan.id, plan_hash: planHash, provider: provider.info(), counts: report.counts, ...report.counts, complete }));
  await atomicWrite(join(runDir, 'report.md'), report.markdown);
  await appendJsonl(join(runDir, 'events.jsonl'), { ts: nowIso(), node: 'REPORT', status: 'complete', counts: report.counts });
  return { runId: run, runDir, plan, planHash, results, counts: report.counts, provider: provider.info() };
}
