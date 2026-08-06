import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

// What a batch cost is recorded beside the run, not remembered by the operator. One line per
// transport invocation: which ops ran, how long each took, how the batch ended. Telemetry is
// observability, never evidence — sealing and verification do not read it — so the record carries
// timings and op names, and nothing captured from the page.
function telemetryError(code) {
  return new TypeError(code);
}

export function buildTelemetryRecord({ stage = null, target, results, startedAt, wallMs }) {
  if (typeof target !== 'string' || target === '') {
    throw telemetryError('HONOLOLO_TELEMETRY_TARGET_INVALID');
  }
  if (!Array.isArray(results)) throw telemetryError('HONOLOLO_TELEMETRY_RESULTS_INVALID');
  if (typeof startedAt !== 'string' || Number.isNaN(Date.parse(startedAt))) {
    throw telemetryError('HONOLOLO_TELEMETRY_TIME_INVALID');
  }
  if (!Number.isSafeInteger(wallMs) || wallMs < 0) {
    throw telemetryError('HONOLOLO_TELEMETRY_WALL_INVALID');
  }
  const ops = results
    .filter((result) => Number.isSafeInteger(result.ms))
    .map(({ op, ms, error, refused }) => ({
      op,
      ms,
      ...(error !== undefined ? { error: true } : {}),
      ...(refused === true ? { refused: true } : {}),
    }));
  const outcome = results.some(({ op }) => op === 'safety_stop')
    ? 'safety_stop'
    : (results.some(({ error }) => error !== undefined)
      ? 'error'
      : (results.some(({ refused }) => refused === true) ? 'refused' : 'ok'));
  return {
    at: startedAt, stage, target, op_count: ops.length, wall_ms: wallMs, outcome, ops,
  };
}

export async function appendTelemetry(path, record) {
  if (typeof path !== 'string' || path === '') throw telemetryError('HONOLOLO_TELEMETRY_PATH_INVALID');
  await mkdir(dirname(resolve(path)), { recursive: true, mode: 0o700 });
  await appendFile(path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}
