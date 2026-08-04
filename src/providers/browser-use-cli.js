import { AgentBrowserProvider } from './agent-browser.js';

/**
 * Browser Use CLI compatibility profile.
 *
 * browser-use has shipped both a high-level autonomous Agent API and a persistent CLI. The latter
 * exposes open/state/click/type/screenshot primitives. Venti keeps the same provider protocol and
 * lets users point this profile at the installed CLI; semantic locator actions can be delegated to
 * the CLI when it supports them, or to a JSONL bridge for richer Browser Use versions.
 */
export class BrowserUseCliProvider extends AgentBrowserProvider {
  constructor(config = {}) {
    super({ ...config, name: 'browser-use-cli', command: config.command ?? 'browser-use' });
    this.name = 'browser-use-cli';
  }

  info() {
    return {
      name: this.name,
      capabilities: ['browser', 'persistent_session', 'state', 'screenshot'],
      protocol_version: 'venti.browser.v1',
      command: this.command,
      note: 'For Browser Use Agent/Cloud, prefer the JSONL bridge profile so session identity is preserved.',
    };
  }

  commonArgs() {
    return [
      ...(this.config.prefix_args ?? []),
      ...(this.session ? ['--session', this.session] : []),
    ];
  }

  async open(url) {
    this.currentUrl = url;
    return this.exec(['open', url]);
  }

  async snapshot() {
    const result = await this.exec(['state']);
    return result.stdout;
  }

  async observe() {
    const [url, snapshot] = await Promise.all([
      this.exec(['get', 'url'], { allowFailure: true }),
      this.snapshot(),
    ]);
    const observedUrl = url.stdout.trim() || this.currentUrl || '';
    return {
      provider: this.name,
      observed_at: new Date().toISOString(),
      url: observedUrl,
      title: '',
      text: snapshot,
      snapshot,
    };
  }

  async click(locator) {
    if (locator.index !== undefined) return this.exec(['click', String(locator.index)]);
    return super.click(locator);
  }

  async fill(locator, value) {
    if (locator.index !== undefined) return this.exec(['type', String(value)]);
    return super.fill(locator, value);
  }
}
