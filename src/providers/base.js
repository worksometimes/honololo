import { VentiError, PROTOCOL_VERSION } from '../types.js';

export class BrowserProvider {
  constructor(config = {}) {
    this.config = config;
    this.name = config.name ?? 'unknown';
  }

  info() {
    return {
      name: this.name,
      capabilities: [],
      protocol_version: PROTOCOL_VERSION,
    };
  }

  unsupported(method) {
    throw new VentiError(`${this.name} provider does not support ${method}`, {
      code: 'UNSUPPORTED_CAPABILITY',
    });
  }

  async open() { this.unsupported('open'); }
  async reload() { this.unsupported('reload'); }
  async observe() { this.unsupported('observe'); }
  /** Cheap URL probe for per-action boundary checks; override when the runtime has a direct call. */
  async currentUrl() { return (await this.observe()).url; }
  async snapshot() { this.unsupported('snapshot'); }
  async click() { this.unsupported('click'); }
  async fill() { this.unsupported('fill'); }
  async type() { this.unsupported('type'); }
  async press() { this.unsupported('press'); }
  async select() { this.unsupported('select'); }
  async upload() { this.unsupported('upload'); }
  async scroll() { this.unsupported('scroll'); }
  async waitFor() { this.unsupported('waitFor'); }
  async screenshot() { this.unsupported('screenshot'); }
  async startTrace() { return false; }
  async stopTrace() { return null; }
  async close() {}
}
