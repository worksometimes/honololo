import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { executePlan, loadPlan } from '../src/runner.js';
import { AgentBrowserProvider } from '../src/providers/agent-browser.js';
import { JsonlBridgeProvider } from '../src/providers/jsonl.js';
import { HttpProvider } from '../src/providers/http.js';

async function tempRoot() {
  return mkdtemp(join(tmpdir(), 'venti-test-'));
}

function plan() {
  return {
    schema_version: '1.0',
    id: 'mock-smoke',
    goal: 'Verify the deterministic mock browser contract.',
    kind: 'smoke',
    channel: 'browser',
    provider: 'mock',
    target: { url: 'https://fixture.test', allowed_domains: ['fixture.test'], restore: false, session: 'fixture' },
    provider_config: { pages: { 'https://fixture.test': { title: 'Fixture', text: 'Fixture Domain\nReady' } } },
    items: [{
      id: 'home',
      goal: 'The fixture is ready.',
      setup: [{ open: 'https://fixture.test' }],
      actions: [],
      expect: [{ contains: 'Ready' }, { visible: { by: { role: 'heading', name: 'Fixture Domain' } } }, { url_matches: 'fixture\\.test' }],
      evidence: ['screenshot', 'page_text', 'url', 'action_ledger'],
    }],
    limits: { max_items: 1, max_attempts_per_item: 1, max_heals_per_item: 0, stop_after_consecutive_failures: 2, timeout_ms_per_item: 1000, max_tool_calls: 20, max_llm_calls: 0 },
    forbidden: ['delete'],
  };
}

test('runner executes a frozen plan and writes evidence', async () => {
  const root = await tempRoot();
  const planFile = join(root, 'plan.json');
  await (await import('node:fs/promises')).writeFile(planFile, JSON.stringify(plan()), 'utf8');
  const result = await executePlan({ planFile, root, providerName: 'mock', runId: 'mock-pass' });
  assert.equal(result.counts.pass, 1);
  assert.equal(result.results[0].status, 'pass');
  const report = await readFile(join(root, 'runs/mock-pass/report.md'), 'utf8');
  assert.match(report, /1 pass/);
  const observation = await readFile(join(root, 'runs/mock-pass/evidence/home/attempt-1/observation.json'), 'utf8');
  assert.match(observation, /Fixture Domain/);
  const resumed = await executePlan({ planFile, root, providerName: 'mock', runId: 'mock-pass' });
  assert.equal(resumed.results[0].status, 'pass');
  assert.equal((await readFile(join(root, 'runs/mock-pass/events.jsonl'), 'utf8')).includes('skipped_completed'), true);
});

test('agent-browser provider refuses unsafe allowlist/restore combination', () => {
  const provider = new AgentBrowserProvider({ allowed_domains: ['fixture.test'], restore: true });
  assert.throws(() => provider.commonArgs(), (error) => error.code === 'PROVIDER_CONFIG_CONFLICT');
});

test('jsonl bridge keeps the core independent of the browser SDK', async () => {
  const root = await tempRoot();
  const bridge = new JsonlBridgeProvider({ command: process.execPath, args: [join(process.cwd(), 'test/bridge-fixture.mjs')] });
  await bridge.open('https://bridge.test');
  const observation = await bridge.observe();
  assert.equal(observation.url, 'https://bridge.test');
  assert.equal(await bridge.currentUrl(), 'https://bridge.test');
  assert.match(observation.text, /Bridge page/);
  const screenshot = join(root, 'bridge.png');
  await bridge.screenshot(screenshot);
  assert.match(await readFile(screenshot, 'utf8'), /bridge screenshot/);
  await bridge.close();
});

test('http provider refuses mutation without an approval runner', async () => {
  const provider = new HttpProvider({ api_base: 'https://fixture.test' });
  await assert.rejects(
    provider.request({ method: 'POST', path: '/danger' }),
    (error) => error.code === 'SAFETY_GATE_REQUIRED',
  );
});

test('missing requested evidence is never reported as a pass', async () => {
  const root = await tempRoot();
  const source = plan();
  source.items[0].evidence = ['trace'];
  const planFile = join(root, 'plan.json');
  await writeFile(planFile, JSON.stringify(source), 'utf8');
  const result = await executePlan({ planFile, root, providerName: 'mock', runId: 'missing-trace' });
  assert.equal(result.results[0].status, 'needs_human');
  assert.equal(result.results[0].failure_class, 'ambiguous');
  assert.match(await readFile(join(root, 'runs/missing-trace/evidence/home/attempt-1/execution.json'), 'utf8'), /trace_error/);
});

test('target boundary is checked before an open action executes', async () => {
  const root = await tempRoot();
  const source = plan();
  source.items[0].setup = [{ open: 'https://outside.example.test' }];
  const planFile = join(root, 'plan.json');
  await writeFile(planFile, JSON.stringify(source), 'utf8');
  const result = await executePlan({ planFile, root, providerName: 'mock', runId: 'boundary-stop' });
  assert.equal(result.results[0].status, 'needs_human');
  assert.equal(result.results[0].failure_class, 'safety');
  assert.match(await readFile(join(root, 'runs/boundary-stop/evidence/home/attempt-1/execution.error.json'), 'utf8'), /DOMAIN_BOUNDARY_VIOLATION/);
});

test('http provider blocks an absolute URL outside the target boundary', async () => {
  const provider = new HttpProvider({ api_base: 'https://fixture.test', allowed_domains: ['fixture.test'] });
  await assert.rejects(
    provider.request({ method: 'GET', path: 'https://outside.example.test/' }),
    (error) => error.code === 'DOMAIN_BOUNDARY_VIOLATION',
  );
});

test('plan loader rejects documents that violate the public schema', async () => {
  const root = await tempRoot();
  const source = plan();
  delete source.items[0].evidence;
  const planFile = join(root, 'invalid.json');
  await writeFile(planFile, JSON.stringify(source), 'utf8');
  await assert.rejects(loadPlan(planFile), (error) => error.code === 'INVALID_PLAN');
});

test('providers expose a cheap current-url probe for per-action boundary checks', async () => {
  const { MockProvider } = await import('../src/providers/mock.js');
  const provider = new MockProvider();
  await provider.open('https://fixture.test/path');
  assert.equal(await provider.currentUrl(), 'https://fixture.test/path');
});

test('rubric-pending items are marked and do not trip the consecutive-failure stop gate', async () => {
  const root = await tempRoot();
  const source = plan();
  source.items = ['a', 'b', 'c', 'd'].map((suffix) => ({
    id: `rubric-${suffix}`,
    goal: 'Needs a model judgment after the run.',
    setup: [{ open: 'https://fixture.test' }],
    actions: [],
    expect: [
      { contains: 'Ready' },
      { rubric: { dimensions: [{ id: 'clarity', criterion: 'copy is clear', anchors: ['unclear', 'clear'] }], unknown_if: 'evidence lacks the copy' } },
    ],
    evidence: ['page_text', 'url', 'action_ledger'],
  }));
  source.limits.max_items = 4;
  source.limits.stop_after_consecutive_failures = 2;
  const planFile = join(root, 'plan.json');
  await writeFile(planFile, JSON.stringify(source), 'utf8');
  const result = await executePlan({ planFile, root, providerName: 'mock', runId: 'rubric-pending' });
  assert.equal(result.results.length, 4);
  for (const item of result.results) {
    assert.equal(item.status, 'needs_human');
    assert.equal(item.rubric_pending, true);
  }
});

test('screenshots are captured only when requested or when the item does not pass', async () => {
  const root = await tempRoot();
  const source = plan();
  source.items = [
    { id: 'pass-no-shot', goal: 'Passing item without a screenshot request.', setup: [{ open: 'https://fixture.test' }], actions: [], expect: [{ contains: 'Ready' }], evidence: ['page_text', 'url'] },
    { id: 'fail-gets-shot', goal: 'Failing item still gets a diagnostic screenshot.', setup: [{ open: 'https://fixture.test' }], actions: [], expect: [{ contains: 'Absent-Text' }], evidence: ['page_text', 'url'] },
  ];
  source.limits.max_items = 2;
  const planFile = join(root, 'plan.json');
  await writeFile(planFile, JSON.stringify(source), 'utf8');
  const result = await executePlan({ planFile, root, providerName: 'mock', runId: 'shot-policy' });
  assert.equal(result.results[0].status, 'pass');
  await assert.rejects(readFile(join(root, 'runs/shot-policy/evidence/pass-no-shot/attempt-1/screenshot.png')));
  assert.equal(result.results[1].status, 'fail');
  assert.match(await readFile(join(root, 'runs/shot-policy/evidence/fail-gets-shot/attempt-1/screenshot.png'), 'utf8'), /mock screenshot/);
  assert.ok(result.results[1].evidence.some((path) => path.endsWith('screenshot.png')));
});
