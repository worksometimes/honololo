import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { BrowserProvider } from './base.js';
import { VentiError, PROTOCOL_VERSION } from '../types.js';

const RESULT_MARKER = '__VENTI_BROWSER_USE_RESULT__';

export class BrowserUseHarnessProvider extends BrowserProvider {
  constructor(config = {}) {
    super({ ...config, name: 'browser-use' });
    this.command = config.command ?? 'browser-use';
    this.args = config.args ?? [];
    this.scriptUrl = new URL('./browser-use-harness.py', import.meta.url);
    this.timeoutMs = config.timeout_ms ?? 120000;
    this.cdpWs = config.cdp_ws ?? process.env.BU_CDP_WS;
    this.cdpUrl = config.cdp_url ?? process.env.BU_CDP_URL;
    this.buName = config.bu_name;
  }

  info() {
    return {
      name: this.name,
      capabilities: ['browser', 'cdp', 'accessibility', 'real_input', 'screenshot', 'browser-use-harness'],
      protocol_version: PROTOCOL_VERSION,
      command: this.command,
      cdp_configured: Boolean(this.cdpWs || this.cdpUrl),
    };
  }

  async call(operation, params = {}) {
    const script = await readFile(this.scriptUrl, 'utf8');
    const env = {
      ...process.env,
      VENTI_BU_OP: operation,
      VENTI_BU_PARAMS: JSON.stringify(params),
    };
    if (this.cdpWs) env.BU_CDP_WS = this.cdpWs;
    if (this.cdpUrl) env.BU_CDP_URL = this.cdpUrl;
    if (this.buName) env.BU_NAME = this.buName;
    const child = spawn(this.command, this.args, { shell: false, stdio: ['pipe', 'pipe', 'pipe'], env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdin.end(script);
    const result = await new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGTERM');
        reject(new VentiError(`browser-use harness timed out: ${operation}`, { code: 'PROVIDER_TIMEOUT', retryable: true }));
      }, this.timeoutMs);
      child.on('error', (error) => {
        clearTimeout(timer);
        reject(new VentiError(`Cannot start ${this.command}: ${error.message}`, { code: 'PROVIDER_START_ERROR', retryable: true }));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolvePromise({ code: code ?? 1, stdout, stderr });
      });
    });
    const line = result.stdout.split('\n').filter((entry) => entry.startsWith(RESULT_MARKER)).at(-1);
    if (!line) throw new VentiError(result.stderr.trim() || result.stdout.trim() || `browser-use exited ${result.code}`, { code: 'BRIDGE_PROTOCOL_ERROR', retryable: false, details: { operation, exit_code: result.code } });
    let response;
    try { response = JSON.parse(line.slice(RESULT_MARKER.length)); } catch (error) { throw new VentiError(`Invalid Browser Use bridge JSON: ${error.message}`, { code: 'BRIDGE_PROTOCOL_ERROR' }); }
    if (!response.ok) throw new VentiError(response.error?.message ?? 'Browser Use operation failed', { code: response.error?.code ?? 'BROWSER_USE_OPERATION_FAILED', retryable: response.error?.retryable ?? false, details: response.error });
    return response.result;
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
  async isVisible(locator) { return this.call('isVisible', { locator }); }
  async count(locator) { return this.call('count', { locator }); }
  async value(locator) { return this.call('value', { locator }); }
  async close() {}
}
