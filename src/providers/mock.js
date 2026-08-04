import { writeFile } from 'node:fs/promises';
import { BrowserProvider } from './base.js';
import { PROTOCOL_VERSION } from '../types.js';
import { nowIso } from '../util.js';

/** Deterministic provider used for contract tests and adapter development. */
export class MockProvider extends BrowserProvider {
  constructor(config = {}) {
    super({ ...config, name: 'mock' });
    this.pages = config.pages ?? {};
    this.url = '';
    this.text = '';
    this.title = '';
    this.actions = [];
  }

  info() { return { name: this.name, capabilities: ['browser', 'snapshot', 'screenshot', 'deterministic'], protocol_version: PROTOCOL_VERSION }; }
  async open(url) {
    this.url = url;
    const page = this.pages[url] ?? { title: 'Mock page', text: `Mock page: ${url}` };
    this.title = page.title ?? 'Mock page';
    this.text = page.text ?? '';
    this.actions.push({ action: 'open', url });
  }
  async reload() { this.actions.push({ action: 'reload' }); }
  async observe() { return { provider: this.name, observed_at: nowIso(), url: this.url, title: this.title, text: this.text, snapshot: this.text }; }
  async currentUrl() { return this.url; }
  async snapshot() { return this.text; }
  async click(locator) { this.actions.push({ action: 'click', locator }); }
  async fill(locator, value) { this.actions.push({ action: 'fill', locator, value }); }
  async type(locator, value) { this.actions.push({ action: 'type', locator, value }); }
  async press(key, locator) { this.actions.push({ action: 'press', key, locator }); }
  async select(locator, value) { this.actions.push({ action: 'select', locator, value }); }
  async upload(locator, path) { this.actions.push({ action: 'upload', locator, path }); }
  async scroll(direction, amount) { this.actions.push({ action: 'scroll', direction, amount }); }
  async waitFor(condition) { this.actions.push({ action: 'waitFor', condition }); }
  async screenshot(path) { await writeFile(path, 'mock screenshot\n', 'utf8'); }
  async isVisible(locator) {
    const needle = locator?.name ?? locator?.text ?? locator?.label ?? locator?.placeholder ?? locator?.test_id;
    return needle ? this.text.includes(needle) : false;
  }
  async count(locator) {
    const needle = locator?.name ?? locator?.text ?? locator?.label ?? locator?.placeholder;
    return needle ? this.text.split(needle).length - 1 : 0;
  }
  async close() {}
}
