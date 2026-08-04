#!/usr/bin/env node
import { access, readdir, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, resolve } from 'node:path';
import { executePlan, loadPlan } from './runner.js';
import { providerNames } from './providers/index.js';
import { VentiError } from './types.js';
import { sha256File } from './util.js';

const execFileAsync = promisify(execFile);
const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..');

function usage() {
  return `Venti execution core

Usage:
  venti-run run <plan.yaml|plan.json> [options]
  venti-run hash <plan.yaml|plan.json>
  venti-run validate [path ...]
  venti-run providers
  venti-run doctor

Run options:
  --provider <name>      agent-browser (default), playwright, browser-use, browser-use-cli, jsonl, stagehand, browsergym, mcp, http, mock
  --run-id <id>          Resume-friendly explicit run directory id
  --root <path>          Repository root (default: current directory)
  --namespace <name>     Browser daemon namespace
  --headed               Show the browser when the provider supports it
  --headless             Force headless mode
  --redact <value>       Redact a value from captured text (repeatable)
  --dry-run              Validate and materialize a plan without opening a browser
  --no-resume             Re-run items even when the run id already has completed results
  --approve-risk          Allow explicitly high/critical browser items (never enables API mutation)
  --json                 Print machine-readable summary
  --allow-fail           Return exit code 0 even when QA items fail
`;
}

function parseArgs(argv) {
  const [command = 'help', ...rest] = argv;
  const options = { command, redactions: [] };
  const positional = [];
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === '--') { positional.push(...rest.slice(index + 1)); break; }
    if (!arg.startsWith('--')) { positional.push(arg); continue; }
    const [key, inline] = arg.slice(2).split('=', 2);
    if (key.startsWith('no-')) {
      options[key.slice(3).replaceAll('-', '_')] = false;
      continue;
    }
    const needsValue = ['provider', 'run-id', 'root', 'namespace', 'redact'].includes(key);
    const value = inline ?? (needsValue ? rest[++index] : true);
    if (key === 'redact') options.redactions.push(value);
    else options[key.replaceAll('-', '_')] = value;
  }
  options.positional = positional;
  return options;
}

async function commandDoctor() {
  const checks = [];
  const check = (name, ok, details = '') => checks.push({ name, ok, details });
  check('node', Number(process.versions.node.split('.')[0]) >= 20, process.version);
  try { await access(resolve(ROOT, 'schemas/plan.schema.json')); check('plan schema', true); } catch { check('plan schema', false); }
  try { await access(resolve(ROOT, 'agents/runner.md')); check('role contracts', true); } catch { check('role contracts', false); }
  try {
    const result = await execFileAsync('agent-browser', ['--version']);
    check('agent-browser', true, result.stdout.trim());
  } catch (error) { check('agent-browser', false, error.message); }
  try { await import('playwright'); check('playwright', true, 'installed'); } catch { check('playwright', true, 'optional/not installed'); }
  const failed = checks.filter((entry) => !entry.ok);
  console.log(JSON.stringify({ ok: failed.length === 0, checks }, null, 2));
  return failed.length ? 1 : 0;
}

async function commandValidate(root, requestedPaths = []) {
  const candidates = requestedPaths.length ? requestedPaths : ['plans'];
  const files = [];
  for (const candidate of candidates) {
    const absolute = resolve(root, candidate);
    const details = await stat(absolute);
    if (details.isDirectory()) {
      const entries = await readdir(absolute, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && /\.(ya?ml|json)$/i.test(entry.name)) files.push(resolve(absolute, entry.name));
      }
    } else if (/\.(ya?ml|json)$/i.test(absolute)) {
      files.push(absolute);
    }
  }
  if (!files.length) throw new VentiError('No YAML or JSON plans found to validate', { code: 'INVALID_PLAN' });
  const plans = [];
  for (const file of files.sort()) {
    const loaded = await loadPlan(file);
    plans.push({ file: file.replace(`${root}/`, ''), id: loaded.plan.id, hash: loaded.planHash });
  }
  console.log(JSON.stringify({ ok: true, count: plans.length, plans }, null, 2));
  return 0;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.command === 'help' || options.help || options.h) { console.log(usage()); return 0; }
  if (options.command === 'providers') { console.log(providerNames().join('\n')); return 0; }
  if (options.command === 'doctor') return commandDoctor();
  if (options.command === 'validate') return commandValidate(resolve(options.root ?? process.cwd()), options.positional);
  if (!['run', 'hash'].includes(options.command)) throw new VentiError(`Unknown command: ${options.command}`, { code: 'CLI_USAGE' });
  const planFile = options.positional[0];
  if (!planFile) throw new VentiError(`${options.command} requires a plan file`, { code: 'CLI_USAGE' });
  const root = resolve(options.root ?? process.cwd());
  const absolutePlan = resolve(root, planFile);
  if (options.command === 'hash') { console.log(await sha256File(absolutePlan)); return 0; }
  const result = await executePlan({
    planFile: absolutePlan,
    root,
    providerName: options.provider ?? process.env.VENTI_PROVIDER ?? undefined,
    providerOptions: {
      ...(options.headed ? { headless: false } : {}),
      ...(options.headless ? { headless: true } : {}),
      ...(options.namespace ? { namespace: options.namespace } : {}),
    },
    runId: options.run_id,
    dryRun: Boolean(options.dry_run),
    redact: options.redactions,
    resume: options.resume !== false,
    allowRisk: Boolean(options.approve_risk),
  });
  const summary = { run_id: result.runId, run_dir: result.runDir, plan_id: result.plan.id, plan_hash: result.planHash, provider: result.provider, counts: result.counts };
  if (options.json) console.log(JSON.stringify(summary, null, 2));
  else {
    console.log(`Venti run: ${result.runId}`);
    console.log(`Provider: ${result.provider.name}`);
    console.log(`Result: ${result.results.length} items — ${result.counts.pass ?? 0} pass, ${result.counts.fail ?? 0} fail, ${result.counts.needs_human ?? 0} needs human, ${result.counts.error ?? 0} error`);
    console.log(`Report: ${resolve(result.runDir, 'report.md')}`);
  }
  const bad = result.results.some((item) => !['pass', 'skipped'].includes(item.status));
  return bad && !options.allow_fail ? 1 : 0;
}

main().then((code) => process.exit(code)).catch((error) => {
  const payload = { ok: false, code: error.code ?? 'ERROR', message: error.message, details: error.details ?? {} };
  if (process.argv.includes('--json')) console.error(JSON.stringify(payload, null, 2));
  else { console.error(`venti-run: ${error.message}`); if (error.code === 'CLI_USAGE') console.error(`\n${usage()}`); }
  process.exit(error.code === 'CLI_USAGE' ? 2 : 1);
});
