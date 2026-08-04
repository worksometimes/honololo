import { spawn } from 'node:child_process';
import { BrowserProvider } from './base.js';
import { VentiError, PROTOCOL_VERSION } from '../types.js';
import { nowIso, sleep } from '../util.js';

function locatorArgs(locator = {}, action, value) {
  const add = (kind, selector, extra = []) => [
    'find', kind, selector, action,
    ...(value === undefined ? [] : [String(value)]),
    ...extra,
  ];
  if (locator.nth !== undefined && !locator.css && !locator.xpath) {
    throw new VentiError('agent-browser cannot combine nth with a semantic locator; use a CSS locator or a provider with locator indexing', { code: 'INVALID_LOCATOR' });
  }
  if (locator.role) return add('role', locator.role, locator.name === undefined ? [] : ['--name', locator.name]);
  if (locator.label) return add('label', locator.label);
  if (locator.placeholder) return add('placeholder', locator.placeholder);
  if (locator.text) return add('text', locator.text, locator.exact ? ['--exact'] : []);
  if (locator.test_id) return add('testid', locator.test_id);
  if (locator.alt) return add('alt', locator.alt);
  if (locator.title) return add('title', locator.title);
  if (locator.css && locator.nth !== undefined) return ['find', 'nth', String(locator.nth), locator.css, action, ...(value === undefined ? [] : [value])];
  if (locator.xpath && locator.nth !== undefined) return ['find', 'nth', String(locator.nth), `xpath=${locator.xpath}`, action, ...(value === undefined ? [] : [value])];
  if (locator.css) return [action, locator.css, ...(value === undefined ? [] : [value])];
  if (locator.xpath) return [action, `xpath=${locator.xpath}`, ...(value === undefined ? [] : [value])];
  throw new VentiError('Locator has no supported strategy', { code: 'INVALID_LOCATOR' });
}

export class AgentBrowserProvider extends BrowserProvider {
  constructor(config = {}) {
    super({ ...config, name: 'agent-browser' });
    this.command = config.command ?? 'agent-browser';
    this.session = config.session ?? `venti-${process.pid}`;
    this.restore = config.restore !== false;
    this.restoreSave = config.restore_save ?? 'auto';
    this.namespace = config.namespace;
    this.allowedDomains = config.allowed_domains ?? [];
    this.timeoutMs = config.timeout_ms ?? 60000;
  }

  info() {
    return {
      name: this.name,
      capabilities: ['browser', 'snapshot', 'screenshot', 'session', 'trace', 'a11y'],
      protocol_version: PROTOCOL_VERSION,
      command: this.command,
      restore: this.restore,
      allowed_domains: this.allowedDomains,
    };
  }

  commonArgs() {
    if (this.allowedDomains.length && this.restore) {
      throw new VentiError('agent-browser cannot combine --allowed-domains with --restore. Set target.restore: false for a strict public run, or use a provider with explicit storage-state support.', {
        code: 'PROVIDER_CONFIG_CONFLICT',
        retryable: false,
        details: { allowed_domains: this.allowedDomains, restore: true },
      });
    }
    const args = [];
    if (this.session) args.push('--session', this.session);
    if (this.restore) args.push('--restore', '--restore-save', this.restoreSave);
    if (this.namespace) args.push('--namespace', this.namespace);
    if (this.allowedDomains.length) args.push('--allowed-domains', this.allowedDomains.join(','));
    return args;
  }

  async exec(args, { timeoutMs = this.timeoutMs, allowFailure = false } = {}) {
    const fullArgs = [...this.commonArgs(), ...args];
    const started = Date.now();
    const child = spawn(this.command, fullArgs, { shell: false, env: process.env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const result = await new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new VentiError(`agent-browser timed out: ${args.join(' ')}`, {
          code: 'PROVIDER_TIMEOUT', retryable: true, details: { timeoutMs },
        }));
      }, timeoutMs);
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(new VentiError(`Cannot start ${this.command}: ${error.message}`, {
          code: 'PROVIDER_START_ERROR', retryable: true,
        }));
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        resolvePromise({ code: code ?? 1, signal, stdout, stderr, elapsedMs: Date.now() - started });
      });
    });
    if (result.code !== 0 && !allowFailure) {
      throw new VentiError(result.stderr.trim() || result.stdout.trim() || `agent-browser exited ${result.code}`, {
        code: 'PROVIDER_COMMAND_FAILED', retryable: true,
        details: { args: fullArgs, exitCode: result.code, elapsedMs: result.elapsedMs },
      });
    }
    return result;
  }

  async open(url) { return this.exec(['open', url]); }
  async reload() { return this.exec(['reload']); }
  async snapshot() {
    const result = await this.exec(['snapshot', '-i', '-c']);
    return result.stdout;
  }
  async observe() {
    const [url, title, text, snapshot] = await Promise.all([
      this.exec(['get', 'url']),
      this.exec(['get', 'title']),
      this.exec(['get', 'text', 'body']),
      this.snapshot(),
    ]);
    return {
      provider: this.name,
      observed_at: nowIso(),
      url: url.stdout.trim(),
      title: title.stdout.trim(),
      text: text.stdout,
      snapshot,
    };
  }
  async currentUrl() { return (await this.exec(['get', 'url'])).stdout.trim(); }
  async click(locator) { return this.exec(locatorArgs(locator, 'click')); }
  async fill(locator, value) { return this.exec(locatorArgs(locator, 'fill', value)); }
  async type(locator, value) { return this.exec(locatorArgs(locator, 'type', value)); }
  async press(key, locator) {
    if (locator) {
      await this.exec(locatorArgs(locator, 'focus'));
    }
    return this.exec(['press', key]);
  }
  async select(locator, value) { return this.exec(locatorArgs(locator, 'select', value)); }
  async upload(locator, path) { return this.exec(locatorArgs(locator, 'upload', path)); }
  async scroll(direction = 'down', amount) {
    return this.exec(['scroll', direction, ...(amount === undefined ? [] : [String(amount)])]);
  }
  async waitFor(condition) {
    const timeoutMs = condition.timeout_ms ?? this.timeoutMs;
    if (condition.text !== undefined) return this.exec(['wait', '--text', condition.text], { timeoutMs });
    if (condition.url_matches !== undefined) return this.exec(['wait', '--url', condition.url_matches], { timeoutMs });
    if (condition.load !== undefined) return this.exec(['wait', '--load', condition.load], { timeoutMs });
    if (condition.ms !== undefined) return this.exec(['wait', String(condition.ms)], { timeoutMs });
    if (condition.visible) return this.exec(locatorArgs(condition.visible.by ?? condition.visible, 'text'), { timeoutMs });
    throw new VentiError('Unsupported agent-browser wait condition', { code: 'INVALID_WAIT' });
  }
  async screenshot(path) { return this.exec(['screenshot', path]); }
  async startTrace() { await this.exec(['trace', 'start']); return true; }
  async stopTrace(path) { await this.exec(['trace', 'stop', path]); return path; }
  async close() { return this.exec(['close'], { allowFailure: true }); }
}
