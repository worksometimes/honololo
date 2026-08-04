import { spawn } from 'node:child_process';
import { BrowserProvider } from './base.js';
import { VentiError, PROTOCOL_VERSION } from '../types.js';

/**
 * JSONL bridge for Python browser-use, Stagehand, BrowserGym, Playwright MCP, or a custom browser.
 * One request and one response per line:
 *   {"id":"1","method":"open","params":{"url":"..."}}
 *   {"id":"1","ok":true,"result":{...}}
 *
 * The bridge is intentionally tiny. It lets the core remain provider-neutral without importing
 * Python or a particular vendor SDK into this package.
 */
export class JsonlBridgeProvider extends BrowserProvider {
  constructor(config = {}) {
    super({ ...config, name: config.name ?? 'jsonl-bridge' });
    this.command = config.command;
    this.args = config.args ?? [];
    this.timeoutMs = config.timeout_ms ?? 120000;
    this.child = null;
    this.pending = new Map();
    this.buffer = '';
    this.sequence = 0;
  }

  info() {
    return {
      name: this.name,
      capabilities: ['browser', 'bridge', 'custom'],
      protocol_version: PROTOCOL_VERSION,
      command: this.command,
    };
  }

  async start() {
    if (this.child) return;
    if (!this.command) throw new VentiError('JSONL bridge requires command', { code: 'MISSING_PROVIDER_CONFIG' });
    this.child = spawn(this.command, this.args, { shell: false, stdio: ['pipe', 'pipe', 'pipe'], env: process.env });
    this.child.stdout.on('data', (chunk) => this.onData(chunk));
    this.child.stderr.on('data', (chunk) => { this.lastStderr = `${this.lastStderr ?? ''}${chunk}`.slice(-10000); });
    this.child.on('close', (code) => {
      for (const { reject } of this.pending.values()) reject(new VentiError(`Bridge exited with code ${code}`, { code: 'BRIDGE_EXITED', retryable: true }));
      this.pending.clear();
      this.child = null;
    });
  }

  onData(chunk) {
    this.buffer += chunk.toString();
    let newline;
    while ((newline = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      if (message.ok === false || message.error) pending.reject(new VentiError(message.error?.message ?? 'Bridge request failed', { code: message.error?.code ?? 'BRIDGE_ERROR', retryable: message.error?.retryable ?? false, details: message.error }));
      else pending.resolve(message.result ?? message);
    }
  }

  async call(method, params = {}) {
    await this.start();
    const id = String(++this.sequence);
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new VentiError(`Bridge timed out: ${method}`, { code: 'PROVIDER_TIMEOUT', retryable: true }));
      }, this.timeoutMs);
      this.pending.set(id, { resolve: (value) => { clearTimeout(timer); resolvePromise(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
      this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  async open(url) { return this.call('open', { url }); }
  async reload() { return this.call('reload'); }
  async observe() { return this.call('observe'); }
  async snapshot() { return this.call('snapshot'); }
  async click(locator) { return this.call('click', { locator }); }
  async fill(locator, value) { return this.call('fill', { locator, value }); }
  async type(locator, value) { return this.call('type', { locator, value }); }
  async press(key, locator) { return this.call('press', { key, locator }); }
  async select(locator, value) { return this.call('select', { locator, value }); }
  async upload(locator, path) { return this.call('upload', { locator, path }); }
  async scroll(direction, amount) { return this.call('scroll', { direction, amount }); }
  async waitFor(condition) { return this.call('waitFor', { condition }); }
  async screenshot(path) { return this.call('screenshot', { path }); }
  async startTrace() { return this.call('startTrace'); }
  async stopTrace(path) { return this.call('stopTrace', { path }); }
  async close() {
    if (!this.child) return;
    try { await this.call('close'); } catch { /* bridge may close itself */ }
    this.child.kill('SIGTERM');
    this.child = null;
  }
}
