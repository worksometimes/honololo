import { appendFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { jobRelative } from '../lib/files.mjs';
import { rejectSensitive } from '../lib/sensitive.mjs';

// Target memory is personal and local. It names a real host, so it lives only under the gitignored
// `.honololo/` workspace on one operator's machine, is never packaged, shared, or promoted into the
// repository, and no other machine ever sees it. What generalises away from a target belongs in a
// playbook under `harness/playbooks/`, written by hand, with the target's identity left behind.
const MEMORY_ROOT = '.honololo/targets';
const HOSTNAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/u;
const KINDS = new Set([
  'navigation', 'auth', 'glossary', 'timing', 'hazard', 'forbidden', 'lesson',
]);
const OUTCOMES = new Set(['pass', 'fail', 'needs_human', 'blocked', 'interrupted']);
const MAX_NOTE = 500;

function noteError(code, detail) {
  const error = new Error(detail ? `${code}: ${detail}` : code);
  error.code = code;
  return error;
}

// One line per entry, appended and never rewritten. A journal an agent may only add to cannot be
// quietly reshaped into a tidier story about a target than the runs actually told.
function journalLine(kind, note, at) {
  return `- ${at} (${kind}) ${note.replace(/\s+/gu, ' ').trim()}\n`;
}

export async function appendNote({
  root = '.', host, kind, note, run = null, outcome = null, at,
} = {}) {
  if (typeof host !== 'string' || !HOSTNAME.test(host)) {
    throw noteError('HONOLOLO_TARGET_HOST_INVALID', String(host));
  }
  if (typeof note !== 'string' || note.trim() === '' || note.length > MAX_NOTE) {
    throw noteError('HONOLOLO_TARGET_NOTE_INVALID');
  }
  const sensitive = rejectSensitive(note);
  if (sensitive) throw noteError('HONOLOLO_TARGET_NOTE_SENSITIVE', sensitive);

  const stamp = at ?? new Date().toISOString().slice(0, 10);
  const directory = jobRelative(resolve(root), `${MEMORY_ROOT}/${host}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });

  if (run !== null) {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(run)) throw noteError('HONOLOLO_TARGET_RUN_INVALID', run);
    if (!OUTCOMES.has(outcome)) throw noteError('HONOLOLO_TARGET_OUTCOME_INVALID', String(outcome));
    const path = jobRelative(directory, 'runs.md');
    await appendFile(path, journalLine(`${run} ${outcome}`, note, stamp), { mode: 0o600 });
    return { path: `${MEMORY_ROOT}/${host}/runs.md`, at: stamp };
  }

  if (!KINDS.has(kind)) throw noteError('HONOLOLO_TARGET_KIND_INVALID', String(kind));
  const path = jobRelative(directory, 'profile.md');
  await appendFile(path, journalLine(kind, note, stamp), { mode: 0o600 });
  return { path: `${MEMORY_ROOT}/${host}/profile.md`, at: stamp };
}

const USAGE = '--host <hostname> (--kind <kind> | --run <run-id> --outcome <outcome>) ' +
  '--note "<text>" [--root <dir>]';

function parseArguments(argv) {
  const options = { root: '.', host: null, kind: null, note: null, run: null, outcome: null };
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (typeof value !== 'string' || value === '') throw noteError('HONOLOLO_TARGET_USAGE', USAGE);
    const name = flag.startsWith('--') ? flag.slice(2) : null;
    if (name === null || !Object.hasOwn(options, name)) {
      throw noteError('HONOLOLO_TARGET_USAGE', String(flag));
    }
    options[name] = value;
  }
  if (options.host === null || options.note === null) {
    throw noteError('HONOLOLO_TARGET_USAGE', USAGE);
  }
  return options;
}

async function main(argv) {
  const written = await appendNote(parseArguments(argv));
  process.stdout.write(`${JSON.stringify(written)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
