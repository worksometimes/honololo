import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { SETTLE_BUDGETS, settle, settleBudget } from '../../harness/lib/settle.mjs';
import { inspectNewTabs, runOp, timedOp } from '../../harness/scripts/browser.mjs';

// A page stub records what the driver asked for. Nothing here needs a real browser: the properties
// under test are which wait each op chooses and what it reports, not how Chrome renders.
function fakePage({ url = 'https://app.example.com/', evaluate, overrides = {} } = {}) {
  const calls = [];
  const record = (name) => (...args) => {
    calls.push({ name, args });
    return Promise.resolve();
  };
  const element = {
    click: record('element.click'),
    hover: record('element.hover'),
    type: record('element.type'),
    selectOption: (...args) => {
      calls.push({ name: 'element.selectOption', args });
      return Promise.resolve(['chosen']);
    },
  };
  return {
    calls,
    url: () => url,
    locator: () => ({ first: () => element }),
    goto: record('goto'),
    waitForTimeout: record('waitForTimeout'),
    waitForSelector: record('waitForSelector'),
    waitForFunction: record('waitForFunction'),
    keyboard: { press: record('keyboard.press') },
    mouse: { move: record('mouse.move'), wheel: record('mouse.wheel') },
    screenshot: () => Promise.resolve(Buffer.from('89504e470d0a1a0a', 'hex')),
    evaluate: evaluate ?? ((source) => {
      calls.push({ name: 'evaluate', args: [source] });
      return Promise.resolve({ waited_ms: 12, reason: 'quiet' });
    }),
    ...overrides,
  };
}

const names = (page) => page.calls.map(({ name }) => name);

// A settled page must always beat the fixed delay it replaced, and an unsettled one must stay
// bounded. The cap may exceed the old delay — a capture taken mid-render was the failure the fixed
// 400ms produced — but only for a document still changing.
test('a settled page beats the fixed delay it replaced, and an unsettled one stays bounded', () => {
  const replaced = {
    goto: 2500, click: 1500, press: 1500, type: 500, scroll: 600, snapshot: 400, capture: 400,
  };
  for (const [op, budget] of Object.entries(SETTLE_BUDGETS)) {
    assert.equal(budget.quiet < budget.cap, true, op);
    assert.equal(budget.cap <= 2500, true, op);
    if (replaced[op] !== undefined) {
      assert.equal(budget.quiet <= replaced[op], true, op);
    }
  }
});

test('an explicit ms becomes the settle ceiling, never a guaranteed sleep', () => {
  assert.deepEqual(settleBudget('click', 4000), { quiet: 150, cap: 4000 });
  // A short ceiling pulls the quiet window down with it rather than exceeding the whole budget.
  assert.deepEqual(settleBudget('goto', 200), { quiet: 50, cap: 200 });
  assert.deepEqual(settleBudget('click', 0), SETTLE_BUDGETS.click);
  assert.deepEqual(settleBudget('unknown-op'), { quiet: 120, cap: 800 });
});

test('a navigation that destroys the settle context is reported, not thrown', async () => {
  let attempts = 0;
  const page = fakePage({
    evaluate: () => {
      attempts += 1;
      return Promise.reject(new Error('Execution context was destroyed'));
    },
  });
  assert.deepEqual(await settle(page, 'click'), { waited_ms: 0, reason: 'context_lost' });
  assert.equal(attempts, 2);
});

test('ops wait on the document settling instead of a fixed timer', async (t) => {
  for (const command of [
    { op: 'goto', url: 'https://app.example.com/' },
    { op: 'click', ref: 'e1' },
    { op: 'press', key: 'Enter' },
    { op: 'scroll', dy: 400 },
  ]) {
    await t.test(command.op, async () => {
      const page = fakePage();
      const result = await runOp(page, command, { allow: ['app.example.com'], scope: [] });
      assert.equal(result.settled_ms, 12);
      assert.equal(names(page).includes('waitForTimeout'), false);
      assert.equal(names(page).includes('evaluate'), true);
    });
  }
});

test('the wait op stays a guaranteed pause', async () => {
  const page = fakePage();
  await runOp(page, { op: 'wait', ms: 250 }, { allow: [], scope: [] });
  assert.deepEqual(page.calls, [{ name: 'waitForTimeout', args: [250] }]);
});

test('wait_for resolves a named condition and reports how long it took', async () => {
  const page = fakePage();
  const result = await runOp(
    page, { op: 'wait_for', selector: '#panel' }, { allow: [], scope: [] },
  );
  assert.equal(result.matched, true);
  assert.equal(Number.isInteger(result.waited_ms), true);
  assert.deepEqual(page.calls[0], {
    name: 'waitForSelector', args: ['#panel', { state: 'visible', timeout: 10000 }],
  });
});

test('wait_for gone waits for the element to leave instead of to arrive', async () => {
  const page = fakePage();
  await runOp(page, { op: 'wait_for', selector: '.spinner', gone: true }, { allow: [], scope: [] });
  assert.deepEqual(page.calls[0].args[1], { state: 'hidden', timeout: 10000 });
});

test('an unmet wait_for stops the batch unless the caller marked it optional', async (t) => {
  const timingOut = () => ({
    overrides: { waitForSelector: () => Promise.reject(new Error('Timeout 500ms exceeded')) },
  });

  await t.test('required', async () => {
    const page = fakePage(timingOut());
    await assert.rejects(
      runOp(page, { op: 'wait_for', selector: '#never', timeout: 500 }, { allow: [], scope: [] }),
      /HONOLOLO_BROWSER_WAIT_TIMEOUT: #never after 500ms/u,
    );
  });

  await t.test('optional', async () => {
    const page = fakePage(timingOut());
    const result = await runOp(
      page, { op: 'wait_for', selector: '#never', optional: true }, { allow: [], scope: [] },
    );
    assert.equal(result.matched, false);
  });
});

test('wait_for refuses a condition it cannot name', async () => {
  await assert.rejects(
    runOp(fakePage(), { op: 'wait_for' }, { allow: [], scope: [] }),
    /HONOLOLO_BROWSER_USAGE: wait_for needs a selector or text/u,
  );
});

test('select and hover drive the control and report the resulting choice', async () => {
  const page = fakePage();
  const selected = await runOp(
    page, { op: 'select', ref: 'e4', label: 'Weekly' }, { allow: [], scope: [] },
  );
  assert.equal(selected.selected, 'chosen');
  assert.deepEqual(page.calls[0].args[0], { label: 'Weekly' });

  const hovered = await runOp(fakePage(), { op: 'hover', ref: 'e5' }, { allow: [], scope: [] });
  assert.equal(hovered.ref, 'e5');
});

// A step whose criteria are all textual should not pay for a PNG encode, nor hand the operator
// pixels to inspect before the capture may be persisted.
test('snapshot persists on its own, with no screenshot and no pairing claim', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'honololo-snapshot-'));
  const page = fakePage({
    evaluate: (source) => Promise.resolve(source.includes('MutationObserver')
      ? { waited_ms: 8, reason: 'quiet' }
      : { url: 'https://app.example.com/', title: 'Home', elements: [], text: 'Ready' }),
  });
  const result = await runOp(
    page, { op: 'snapshot', path_prefix: join(directory, 'home') }, { allow: [], scope: [] },
  );

  assert.equal(result.snapshot, join(directory, 'home.snapshot.json'));
  const persisted = JSON.parse(await readFile(result.snapshot, 'utf8'));
  assert.equal(persisted.text, 'Ready');
  assert.equal(persisted.paired_sha256, undefined);
  assert.equal(persisted.paired_screenshot, undefined);
});

test('timedOp stamps how long the op took and preserves its result', async () => {
  const page = fakePage();
  const { result, failed } = await timedOp(
    page, { op: 'click', ref: 'e1' }, { allow: [], scope: [] },
  );
  assert.equal(failed, false);
  assert.equal(result.op, 'click');
  assert.equal(result.ref, 'e1');
  assert.equal(Number.isSafeInteger(result.ms), true);
});

test('a failed op becomes a timed error record that ends the batch', async () => {
  const page = fakePage({
    overrides: { waitForSelector: () => Promise.reject(new Error('Timeout 500ms exceeded')) },
  });
  const { result, failed } = await timedOp(
    page, { op: 'wait_for', selector: '#never', timeout: 500 }, { allow: [], scope: [] },
  );
  assert.equal(failed, true);
  assert.match(result.error, /HONOLOLO_BROWSER_WAIT_TIMEOUT/u);
  assert.equal(result.url, 'https://app.example.com/');
  assert.equal(Number.isSafeInteger(result.ms), true);
});

test('a tab opened outside the guard stops the batch', async () => {
  const known = new Set();
  const opened = {
    url: () => 'https://elsewhere.example.net/oauth',
    waitForLoadState: () => Promise.resolve(),
  };
  const context = { pages: () => [opened] };

  const blocked = await inspectNewTabs(context, known, { allow: ['app.example.com'], scope: [] });
  assert.deepEqual(blocked.opened, ['https://elsewhere.example.net/oauth']);
  assert.equal(blocked.violation.code, 'DOMAIN_BLOCKED');

  // A tab already seen is not reported twice, so a long batch reports each new tab once.
  const repeated = await inspectNewTabs(context, known, { allow: [], scope: [] });
  assert.deepEqual(repeated, { opened: [], violation: null });
});
