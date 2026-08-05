import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { createRun } from '../../harness/scripts/new-run.mjs';
import { renderRun } from '../../harness/scripts/render.mjs';
import { sealAttempt } from '../../harness/scripts/seal.mjs';

const CAPTURED_AT = '2026-08-05T04:05:06Z';
const FIXTURE_ORIGIN = 'http://127.0.0.1';
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const digest = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

function requestFor(type) {
  return {
    schema_version: '1',
    id: `fixture-${type}`,
    type,
    target: { url: `${FIXTURE_ORIGIN}/`, allowed_domains: ['127.0.0.1'] },
    goal: type === 'qa'
      ? 'Verify the deterministic fixture home state.'
      : 'Document the deterministic fixture settings state.',
    deliverables: [type === 'qa' ? 'output/result.md' : 'output/manual.md'],
    completion: ['Every declared criterion has reviewed evidence.'],
    forbidden: ['delete', 'purchase', 'publish', 'send', 'invite', 'change_permissions'],
    limits: { max_actions: 10 },
  };
}

function planFor(type, proposalSha256) {
  const approved = {
    by: 'user', at: CAPTURED_AT, proposal_sha256: proposalSha256,
  };
  if (type === 'qa') {
    return {
      schema_version: '1', run_id: 'fixture-qa', revision: 1, approved,
      steps: [{
        id: 'home', goal: 'Observe the settled fixture home page.', risk: 'low',
        evidence: ['url', 'snapshot', 'actions'],
        done_when: [
          { id: 'home-url', type: 'url_matches', value: `${FIXTURE_ORIGIN}/` },
          { id: 'home-heading', type: 'snapshot_contains', value: 'HONOLOLO Fixture' },
          { id: 'home-action-record', type: 'file_exists', value: 'actions.jsonl' },
        ],
      }],
      review: { fresh_evaluator: false, criteria: [] },
    };
  }
  return {
    schema_version: '1', run_id: 'fixture-manual', revision: 1, approved,
    steps: [{
      id: 'settings', goal: 'Open and describe the settled settings screen.', risk: 'low',
      evidence: ['url', 'snapshot', 'screenshot'],
      done_when: [
        { id: 'settings-url', type: 'url_matches', value: `${FIXTURE_ORIGIN}/settings` },
        { id: 'settings-heading', type: 'snapshot_contains', value: 'Settings' },
        { id: 'settings-image', type: 'image_exists', value: 'screen.png' },
        {
          id: 'settings-clarity', type: 'rubric',
          criterion: 'The screenshot and snapshot clearly show how to find the notification setting.',
        },
      ],
      manual: {
        title: 'Open settings',
        instruction: 'Choose Settings from the fixture navigation.',
        expected: 'The Settings heading and disabled Email notifications control are visible.',
        cautions: ['Do not change the notification setting.'],
      },
    }],
    review: {
      fresh_evaluator: true,
      criteria: [{
        id: 'settings-clarity',
        criterion: 'The screenshot and snapshot clearly show how to find the notification setting.',
      }],
    },
  };
}

async function writeEvidenceFile(runDir, path, bytes) {
  const content = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, 'utf8');
  await mkdir(dirname(join(runDir, path)), { recursive: true });
  await writeFile(join(runDir, path), content);
}

async function populateAttempt(runDir, type) {
  const stepId = type === 'qa' ? 'home' : 'settings';
  const evidenceRoot = `attempts/001/evidence/${stepId}`;
  const definitions = type === 'qa' ? [
    { kind: 'url', name: 'url.txt', bytes: `${FIXTURE_ORIGIN}/\n` },
    {
      kind: 'snapshot', name: 'snapshot.md',
      bytes: '# HONOLOLO Fixture\n\n- link "Settings"\n- link "Error state"\n',
    },
    {
      kind: 'actions', name: 'actions.jsonl',
      bytes: `${JSON.stringify({ action: 'open', path: '/', observed: 'settled home' })}\n`,
    },
  ] : [
    { kind: 'url', name: 'url.txt', bytes: `${FIXTURE_ORIGIN}/settings\n` },
    {
      kind: 'snapshot', name: 'snapshot.md',
      bytes: '# Settings\n\n- switch "Email notifications" unchecked\n- status "Disabled"\n',
    },
    { kind: 'screenshot', name: 'screen.png', bytes: PNG },
  ];

  const evidence = {};
  for (const definition of definitions) {
    const path = `${evidenceRoot}/${definition.name}`;
    await writeEvidenceFile(runDir, path, definition.bytes);
    evidence[definition.kind] = path;
  }
  // The manifest and the deterministic status are derived from these bytes, never hand-authored.
  await sealAttempt({ runDir, attempt: 1 });
  if (type === 'manual') {
    await writeFile(join(runDir, 'attempts/001/fresh.json'), json({
      schema_version: '1', run_id: 'fixture-manual', attempt: 1,
      source: 'fresh_evaluator', outcome: 'pass',
      criteria: [{
        id: 'settings-clarity', verdict: 'pass',
        reason: 'The evidence clearly identifies the setting and its visible disabled state.',
        evidence: [evidence.snapshot, evidence.screenshot],
      }],
    }));
  }
}

export async function runFixtureScenario(type) {
  if (type !== 'qa' && type !== 'manual') {
    throw new TypeError('HONOLOLO_SCENARIO_TYPE_INVALID');
  }
  const root = await mkdtemp(join(tmpdir(), 'honololo-scenario-'));
  const created = await createRun({
    root, request: requestFor(type), now: new Date(CAPTURED_AT),
  });
  const proposal = Buffer.from([
    `# ${type === 'qa' ? 'QA' : 'Manual'} fixture proposal`,
    '',
    'Scope: deterministic local fixture only.',
    'Risk: low; no consequential controls.',
    'Approval: fixture-only execution is approved.',
    '',
  ].join('\n'));
  await writeFile(join(created.runDir, 'plan/proposal.md'), proposal);
  const plan = planFor(type, digest(proposal));
  await writeFile(join(created.runDir, 'plan/approved.json'), Buffer.from(json(plan)), { flag: 'wx' });
  await mkdir(join(created.runDir, 'attempts/001'), { recursive: false });
  await populateAttempt(created.runDir, type);
  await renderRun({ runDir: created.runDir, attempt: 1, type });
  return created.runDir;
}

function unsafeDestination(destination) {
  return destination === '' || destination.includes('\\') || destination.includes('\0') ||
    destination.startsWith('/') || /^[a-z][a-z0-9+.-]*:/iu.test(destination) ||
    posix.normalize(destination) !== destination ||
    destination.split('/').some((part) => part === '.' || part === '..');
}

export async function brokenOutputLinks(runDir) {
  const output = resolve(runDir, 'output');
  const run = JSON.parse(await readFile(join(runDir, 'run.json'), 'utf8'));
  const markdown = join(output, run.type === 'qa' ? 'result.md' : 'manual.md');
  const broken = new Set();
  const source = await readFile(markdown, 'utf8');
  for (const match of source.matchAll(/\]\((assets\/[^)\n]+)\)/gu)) {
    const destination = match[1].trim();
    if (unsafeDestination(destination)) {
      broken.add(destination);
      continue;
    }
    const resolved = resolve(dirname(markdown), destination);
    const fromOutput = relative(output, resolved);
    if (fromOutput === '..' || fromOutput.startsWith(`..${sep}`)) {
      broken.add(destination);
      continue;
    }
    try {
      const stat = await lstat(resolved);
      if (stat.isSymbolicLink() || !stat.isFile()) broken.add(destination);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      broken.add(destination);
    }
  }
  return [...broken].sort();
}
