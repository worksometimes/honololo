import { BrowserProvider } from './base.js';
import { VentiError, PROTOCOL_VERSION } from '../types.js';
import { nowIso } from '../util.js';

function moduleName(config) {
  if (config.browser === 'firefox') return 'firefox';
  if (config.browser === 'webkit') return 'webkit';
  return 'chromium';
}

export class PlaywrightProvider extends BrowserProvider {
  constructor(config = {}) {
    super({ ...config, name: 'playwright' });
    this.config = config;
    this.playwright = null;
    this.browser = null;
    this.context = null;
    this.page = null;
    this.tracePath = null;
    this.traceStarted = false;
  }

  info() {
    return {
      name: this.name,
      capabilities: ['browser', 'snapshot', 'screenshot', 'trace', 'console', 'network'],
      protocol_version: PROTOCOL_VERSION,
      browser: moduleName(this.config),
    };
  }

  async ensurePage() {
    if (this.page) return this.page;
    try {
      this.playwright = await import('playwright');
    } catch (error) {
      throw new VentiError('Playwright provider requires the optional "playwright" package', {
        code: 'MISSING_PROVIDER', details: { install: 'npm install -D playwright', cause: error.message },
      });
    }
    if (this.config.cdp_url) {
      this.browser = await this.playwright.chromium.connectOverCDP(this.config.cdp_url);
      this.context = this.browser.contexts()[0] ?? await this.browser.newContext();
    } else {
      this.browser = await this.playwright[moduleName(this.config)].launch({ headless: this.config.headless !== false });
      this.context = await this.browser.newContext({
        storageState: this.config.storage_state,
        viewport: this.config.viewport,
      });
    }
    this.page = this.context.pages()[0] ?? await this.context.newPage();
    if (this.config.trace) await this.startTrace();
    return this.page;
  }

  locator(locator = {}) {
    const page = this.page;
    let result;
    if (locator.role) result = page.getByRole(locator.role, locator.name === undefined ? undefined : { name: locator.name, exact: locator.exact });
    else if (locator.label) result = page.getByLabel(locator.label, { exact: locator.exact });
    else if (locator.placeholder) result = page.getByPlaceholder(locator.placeholder, { exact: locator.exact });
    else if (locator.text) result = page.getByText(locator.text, { exact: locator.exact });
    else if (locator.test_id) result = page.getByTestId(locator.test_id);
    else if (locator.alt) result = page.getByAltText(locator.alt, { exact: locator.exact });
    else if (locator.title) result = page.getByTitle(locator.title, { exact: locator.exact });
    else if (locator.css) result = page.locator(locator.css);
    else if (locator.xpath) result = page.locator(`xpath=${locator.xpath}`);
    else if (locator.index !== undefined) result = page.locator('*').nth(locator.index);
    else throw new VentiError('Locator has no supported strategy', { code: 'INVALID_LOCATOR' });
    return locator.nth === undefined ? result : result.nth(locator.nth);
  }

  async open(url) { await (await this.ensurePage()).goto(url, { waitUntil: this.config.wait_until ?? 'domcontentloaded' }); }
  async reload() { await (await this.ensurePage()).reload({ waitUntil: this.config.wait_until ?? 'domcontentloaded' }); }
  async snapshot() {
    const page = await this.ensurePage();
    return page.locator('body').innerText();
  }
  async observe() {
    const page = await this.ensurePage();
    return {
      provider: this.name,
      observed_at: nowIso(),
      url: page.url(),
      title: await page.title(),
      text: await page.locator('body').innerText(),
      snapshot: await page.locator('body').innerText(),
    };
  }
  async currentUrl() { return (await this.ensurePage()).url(); }
  async click(locator) { await this.locator(locator).click(); }
  async fill(locator, value) { await this.locator(locator).fill(value); }
  async type(locator, value) { await this.locator(locator).pressSequentially(value); }
  async press(key, locator) {
    if (locator) await this.locator(locator).press(key);
    else await this.page.keyboard.press(key);
  }
  async select(locator, value) { await this.locator(locator).selectOption(value); }
  async upload(locator, path) { await this.locator(locator).setInputFiles(path); }
  async scroll(direction = 'down', amount = 600) {
    const delta = direction === 'up' ? -amount : direction === 'left' ? -amount : amount;
    const axis = direction === 'left' || direction === 'right' ? 'x' : 'y';
    await this.page.evaluate(({ axis: key, delta: value }) => window.scrollBy(key === 'x' ? value : 0, key === 'y' ? value : 0), { axis, delta });
  }
  async waitFor(condition) {
    const page = await this.ensurePage();
    const timeout = condition.timeout_ms;
    if (condition.text !== undefined) return this.locator({ text: condition.text, exact: condition.exact }).waitFor({ state: 'visible', timeout });
    if (condition.url_matches !== undefined) return page.waitForURL(condition.url_matches, { timeout });
    if (condition.load !== undefined) return page.waitForLoadState(condition.load, { timeout });
    if (condition.visible) return this.locator(condition.visible.by ?? condition.visible).waitFor({ state: 'visible', timeout });
    throw new VentiError('Unsupported Playwright wait condition', { code: 'INVALID_WAIT' });
  }
  async screenshot(path) { await (await this.ensurePage()).screenshot({ path, fullPage: true }); }
  async startTrace() {
    await this.ensurePage();
    if (this.traceStarted) return true;
    await this.context.tracing.start({ screenshots: true, snapshots: true, sources: true });
    this.traceStarted = true;
    return true;
  }
  async stopTrace(path) {
    if (!this.context || !this.traceStarted) return null;
    await this.context.tracing.stop({ path });
    this.tracePath = path;
    this.traceStarted = false;
    return path;
  }
  async close() {
    if (this.traceStarted && this.config.trace_path) await this.stopTrace(this.config.trace_path);
    if (this.context && !this.config.cdp_url) await this.context.close();
    if (this.browser && !this.config.cdp_url) await this.browser.close();
    this.page = null;
    this.traceStarted = false;
  }
  async isVisible(locator) { return this.locator(locator).isVisible(); }
  async count(locator) { return this.locator(locator).count(); }
  async value(locator) { return this.locator(locator).inputValue(); }
}
