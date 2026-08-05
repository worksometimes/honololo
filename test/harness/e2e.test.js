import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { renderRun } from '../../harness/scripts/render.mjs';
import { verifyRun } from '../../harness/scripts/verify-run.mjs';
import { fixtureWithInterruptedFirstAttemptAndSuccessfulSecond } from './helpers.mjs';
import { startFixtureSite } from './fixture-site.mjs';
import { brokenOutputLinks, runFixtureScenario } from './scenarios.mjs';

const fixtureScript = fileURLToPath(new URL('./fixture-site.mjs', import.meta.url));

function firstLine(stream) {
  return new Promise((resolve, reject) => {
    let source = '';
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      source += chunk;
      const newline = source.indexOf('\n');
      if (newline !== -1) resolve(source.slice(0, newline));
    });
    stream.on('error', reject);
    stream.on('end', () => reject(new Error('fixture exited before printing its URL')));
  });
}

test('fixture serves deterministic home, settings, and recovery states', async (t) => {
  const fixture = await startFixtureSite();
  t.after(() => fixture.close());

  assert.equal(fixture.url, `${fixture.origin}/`);
  for (const [path, expected] of [
    ['/', ['HONOLOLO Fixture', 'Settings', 'Error state']],
    ['/settings', ['Loading settings…', 'Email notifications', 'Disabled', 'Settings']],
    ['/error', ['Something went wrong', 'Home']],
  ]) {
    const response = await fetch(`${fixture.origin}${path}`);
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get('content-type'), /^text\/html/u, path);
    const body = await response.text();
    for (const text of expected) assert.equal(body.includes(text), true, `${path}: ${text}`);
    assert.doesNotMatch(body, /https?:\/\/(?!127\.0\.0\.1)/u, path);
  }
});

test('direct fixture process prints one URL record and shuts down cleanly', async () => {
  const child = spawn(process.execPath, [fixtureScript], { stdio: ['ignore', 'pipe', 'pipe'] });
  const line = await firstLine(child.stdout);
  const record = JSON.parse(line);
  assert.match(record.url, /^http:\/\/127\.0\.0\.1:\d+\/$/u);
  assert.equal((await fetch(record.url)).status, 200);

  child.kill('SIGTERM');
  const [code, signal] = await new Promise((resolve) => child.once('exit', (...args) => resolve(args)));
  assert.equal(code, 0);
  assert.equal(signal, null);
});

test('QA and manual scenarios produce verified portable outputs', async () => {
  const qa = await runFixtureScenario('qa');
  const qaVerification = await verifyRun({ runDir: qa });
  assert.equal(qaVerification.ok, true);
  assert.deepEqual(qaVerification.history, [{ attempt: 1, outcome: 'pass' }]);
  assert.match(
    await readFile(join(qa, 'output/result.md'), 'utf8'),
    /## Outcome\n\nOverall: pass/u,
  );

  const manual = await runFixtureScenario('manual');
  const manualVerification = await verifyRun({ runDir: manual });
  assert.equal(manualVerification.ok, true);
  assert.deepEqual(await brokenOutputLinks(manual), []);

  const screenshot = manualVerification.files.find(({ kind }) => kind === 'screenshot');
  assert.ok(screenshot);
  assert.deepEqual(
    await readFile(join(manual, 'output/assets/001-settings.png')),
    await readFile(join(manual, screenshot.path)),
  );
});

test('scenario type is an explicit QA or manual choice', async () => {
  await assert.rejects(() => runFixtureScenario('audit'), /HONOLOLO_SCENARIO_TYPE_INVALID/u);
});

test('output link oracle checks only renderer-shaped assets in the known output document', async () => {
  const runDir = await runFixtureScenario('manual');
  await appendFile(join(runDir, 'output/manual.md'), [
    '',
    '![Escaped \\[label\\]](assets/missing.png)',
    '[Asset traversal](assets/../run.json)',
    '[External](https://example.invalid/image.png)',
    '[Absolute](/tmp/image.png)',
    '[Traversal](../run.json)',
    '',
  ].join('\n'));
  await mkdir(join(runDir, 'output/notes'), { recursive: true });
  await writeFile(
    join(runDir, 'output/notes/ignored.md'),
    '[Not renderer output](assets/nested-missing.png)\n',
  );
  assert.deepEqual(await brokenOutputLinks(runDir), [
    'assets/../run.json',
    'assets/missing.png',
  ]);
});

test('an interrupted attempt qualifies a later passing retry', async () => {
  const runDir = await fixtureWithInterruptedFirstAttemptAndSuccessfulSecond();
  const verified = await verifyRun({ runDir });
  assert.equal(verified.ok, true);
  assert.deepEqual(verified.history, [
    { attempt: 1, outcome: 'interrupted' },
    { attempt: 2, outcome: 'pass' },
  ]);
  assert.equal(verified.requires_human_review, true);

  const output = await renderRun({ runDir, attempt: 2, type: 'qa' });
  assert.match(await readFile(output, 'utf8'), /## Outcome\n\nOverall: needs_human/u);
});
