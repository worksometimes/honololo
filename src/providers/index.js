import { AgentBrowserProvider } from './agent-browser.js';
import { BrowserUseCliProvider } from './browser-use-cli.js';
import { JsonlBridgeProvider } from './jsonl.js';
import { PlaywrightProvider } from './playwright.js';
import { MockProvider } from './mock.js';
import { HttpProvider } from './http.js';
import { BrowserUseHarnessProvider } from './browser-use-harness.js';
import { VentiError } from '../types.js';

export function createProvider(name, config = {}) {
  switch (name) {
    case 'agent-browser': return new AgentBrowserProvider(config);
    case 'browser-use': return new BrowserUseHarnessProvider(config);
    case 'browser-use-cli': return new BrowserUseCliProvider(config);
    case 'playwright': return new PlaywrightProvider(config);
    case 'jsonl':
    case 'stagehand':
    case 'browsergym':
    case 'mcp': return new JsonlBridgeProvider({ ...config, name });
    case 'mock': return new MockProvider(config);
    case 'http':
    case 'api': return new HttpProvider(config);
    default: throw new VentiError(`Unknown provider: ${name}`, { code: 'UNKNOWN_PROVIDER', details: { available: providerNames() } });
  }
}

export function providerNames() {
  return ['agent-browser', 'playwright', 'browser-use', 'browser-use-cli', 'jsonl', 'stagehand', 'browsergym', 'mcp', 'http', 'api', 'mock'];
}
