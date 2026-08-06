import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { appendTelemetry, buildTelemetryRecord } from '../../harness/lib/telemetry.mjs';

const BASE = {
  target: 'app.example.com',
  startedAt: '2026-08-06T01:02:03.000Z',
  wallMs: 4210,
};

test('a record carries per-op timings and drops results that are not timed ops', () => {
  const record = buildTelemetryRecord({
    ...BASE,
    stage: 'execute',
    results: [
      { op: 'goto', url: 'https://app.example.com/', ms: 812 },
      { op: 'new_tab', urls: 'https://app.example.com/help' },
      { op: 'capture', screenshot: 'x.png', ms: 1400 },
      { op: 'final', url: 'https://app.example.com/' },
    ],
  });
  assert.deepEqual(record, {
    at: '2026-08-06T01:02:03.000Z', stage: 'execute', target: 'app.example.com',
    op_count: 2, wall_ms: 4210, outcome: 'ok',
    ops: [{ op: 'goto', ms: 812 }, { op: 'capture', ms: 1400 }],
  });
});

test('outcome reports a safety stop above an op error, and an op error above ok', () => {
  const stopped = buildTelemetryRecord({
    ...BASE,
    results: [
      { op: 'click', ms: 90, error: 'HONOLOLO_BROWSER_WAIT_TIMEOUT' },
      { op: 'safety_stop', code: 'DOMAIN_BLOCKED' },
    ],
  });
  assert.equal(stopped.outcome, 'safety_stop');
  assert.deepEqual(stopped.ops, [{ op: 'click', ms: 90, error: true }]);

  const errored = buildTelemetryRecord({
    ...BASE,
    results: [{ op: 'click', ms: 90, error: 'boom' }],
  });
  assert.equal(errored.outcome, 'error');
  assert.equal(errored.stage, null);
});

test('a refused op is marked without copying its detail, and colors the outcome', () => {
  const record = buildTelemetryRecord({
    ...BASE,
    results: [{ op: 'goto', refused: true, code: 'DOMAIN_BLOCKED', ms: 3 }],
  });
  assert.deepEqual(record.ops, [{ op: 'goto', ms: 3, refused: true }]);
  assert.equal(record.outcome, 'refused');
});

test('a record refuses inputs it cannot stand behind', () => {
  assert.throws(() => buildTelemetryRecord({ ...BASE, target: '', results: [] }),
    /HONOLOLO_TELEMETRY_TARGET_INVALID/u);
  assert.throws(() => buildTelemetryRecord({ ...BASE, results: null }),
    /HONOLOLO_TELEMETRY_RESULTS_INVALID/u);
  assert.throws(() => buildTelemetryRecord({ ...BASE, results: [], startedAt: 'yesterday' }),
    /HONOLOLO_TELEMETRY_TIME_INVALID/u);
  assert.throws(() => buildTelemetryRecord({ ...BASE, results: [], wallMs: -1 }),
    /HONOLOLO_TELEMETRY_WALL_INVALID/u);
});

test('appendTelemetry writes one JSON line per call and creates the parent directory', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'honololo-telemetry-'));
  const path = join(directory, 'run', 'telemetry.jsonl');
  const record = buildTelemetryRecord({ ...BASE, results: [] });
  await appendTelemetry(path, record);
  await appendTelemetry(path, { ...record, stage: 'scout' });
  const lines = (await readFile(path, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].stage, null);
  assert.equal(lines[1].stage, 'scout');
  await assert.rejects(appendTelemetry('', record), /HONOLOLO_TELEMETRY_PATH_INVALID/u);
});
