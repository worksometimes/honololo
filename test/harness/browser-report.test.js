import assert from 'node:assert/strict';
import { test } from 'node:test';
import { elementLines, formatResults } from '../../harness/lib/browser-report.mjs';

const element = (ref, role, name, box = [0, 0, 10, 10], disabled = false) =>
  ({ ref, role, name, box, disabled });

test('lists distinct controls with their geometry', () => {
  assert.deepEqual(elementLines([
    element('e1', 'button', 'Save', [4, 8, 60, 20]),
    element('e2', 'a', 'Help', [70, 8, 40, 20]),
  ]), [
    '  e1 button "Save" 4,8,60,20',
    '  e2 a "Help" 70,8,40,20',
  ]);
});

test('collapses repeated identical controls to one line naming their refs', () => {
  const rows = [];
  for (let index = 1; index <= 5; index += 1) {
    rows.push(element(`e${index * 2 - 1}`, 'button', 'Run'));
    rows.push(element(`e${index * 2}`, 'button', 'More'));
  }
  const lines = elementLines(rows);
  assert.deepEqual(lines, [
    '  button "Run" ×5 (e1,e3,e5,e7,…)',
    '  button "More" ×5 (e2,e4,e6,e8,…)',
  ]);
});

test('keeps disabled state and separates it from the enabled group', () => {
  const lines = elementLines([
    element('e1', 'button', 'Send', [0, 0, 10, 10], true),
    element('e2', 'button', 'Send'),
  ]);
  assert.deepEqual(lines, [
    '  e1 button "Send" disabled 0,0,10,10',
    '  e2 button "Send" 0,0,10,10',
  ]);
});

test('truncates a long accessible name without dropping the line', () => {
  const [line] = elementLines([element('e1', 'button', 'x'.repeat(200))]);
  assert.equal(line.length < 120, true);
  assert.match(line, /…"/u);
});

test('reports a snapshot far more compactly than its JSON form', () => {
  const results = [{
    op: 'snapshot', url: 'https://app.example.com/', title: 'Home',
    elements: Array.from({ length: 40 }, (_, index) => element(`e${index + 1}`, 'button', 'Run')),
    text: 'Ready',
  }];
  const digestOutput = formatResults(results);
  assert.match(digestOutput, /^snapshot https:\/\/app\.example\.com\/ "Home" 40 elements\n/u);
  assert.match(digestOutput, /button "Run" ×40 \(e1,e2,e3,e4,…\)/u);
  assert.match(digestOutput, /--- visible text ---\n  Ready/u);
  assert.equal(digestOutput.length * 4 < JSON.stringify(results, null, 1).length, true);
});

test('renders capture, screenshot, refusal, stop, and error results distinctly', () => {
  const output = formatResults([
    {
      op: 'capture', screenshot: 'e/s.png', snapshot: 'e/s.snapshot.json', bytes: 2048,
      sha256: `sha256:${'ab'.repeat(32)}`, url: 'https://app.example.com/', title: 'Home',
      elements: [element('e1', 'button', 'Save')], text: 'Ready',
    },
    { op: 'screenshot', path: 'e/full.png', bytes: 99, sha256: `sha256:${'cd'.repeat(32)}` },
    { op: 'goto', refused: true, code: 'DOMAIN_BLOCKED', url: 'https://other.example/' },
    { op: 'safety_stop', code: 'SCOPE_BLOCKED', url: 'https://app.example.com/admin' },
    { op: 'click', error: 'locator timeout', url: 'https://app.example.com/' },
    { op: 'type', ref: 'e5', chars: 12, text: '[REDACTED_INPUT]' },
    { op: 'final', url: 'https://app.example.com/' },
  ]);

  assert.match(output, /capture e\/s\.png 2048B ababababab/u);
  assert.match(output, /\+ e\/s\.snapshot\.json 1 elements https:\/\/app\.example\.com\//u);
  assert.match(output, /screenshot e\/full\.png 99B cdcdcdcdcd/u);
  assert.match(output, /goto REFUSED DOMAIN_BLOCKED https:\/\/other\.example\//u);
  assert.match(output, /safety_stop SCOPE_BLOCKED https:\/\/app\.example\.com\/admin/u);
  assert.match(output, /click ERROR locator timeout/u);
  assert.match(output, /type e5 12 chars/u);
  assert.doesNotMatch(output, /REDACTED_INPUT/u);
  assert.match(output, /final url=https:\/\/app\.example\.com\//u);
});
