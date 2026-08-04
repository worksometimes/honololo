import { readFile } from 'node:fs/promises';
import { BrowserProvider } from './base.js';
import { VentiError, PROTOCOL_VERSION } from '../types.js';
import { nowIso, parseMaybeJson, redactText, toAbsolute } from '../util.js';

function allowedUrl(url, allowedDomains = []) {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return allowedDomains.some((pattern) => {
      const normalized = String(pattern).toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/\/.*$/, '');
      return normalized.startsWith('*.')
        ? hostname === normalized.slice(2) || hostname.endsWith(`.${normalized.slice(2)}`)
        : hostname === normalized;
    });
  } catch {
    return false;
  }
}

export class HttpProvider extends BrowserProvider {
  constructor(config = {}) {
    super({ ...config, name: 'http' });
    this.baseUrl = config.api_base ?? config.base_url ?? '';
    this.root = config.root ?? process.cwd();
    this.redact = config.redact ?? [];
    this.allowedDomains = config.allowed_domains ?? [];
    this.last = null;
  }

  info() { return { name: this.name, capabilities: ['api', 'redacted_response', 'status', 'json'], protocol_version: PROTOCOL_VERSION, allowed_domains: this.allowedDomains }; }

  async request(spec = {}) {
    const method = String(spec.method ?? 'GET').toUpperCase();
    if (!['GET', 'HEAD'].includes(method)) {
      throw new VentiError(`HTTP ${method} is mutation-capable and requires an interactive approval runner`, {
        code: 'SAFETY_GATE_REQUIRED', retryable: false, details: { method, path: spec.path },
      });
    }
    const path = spec.path ?? '';
    const url = new URL(path, this.baseUrl || undefined).toString();
    if (this.allowedDomains.length && !allowedUrl(url, this.allowedDomains)) {
      throw new VentiError(`HTTP target is outside the allowed domain boundary: ${url}`, {
        code: 'DOMAIN_BOUNDARY_VIOLATION', retryable: false, details: { allowed_domains: this.allowedDomains },
      });
    }
    const headers = { accept: 'application/json, text/plain;q=0.9, */*;q=0.8', ...(spec.headers ?? {}) };
    if (spec.auth_env) {
      const token = process.env[spec.auth_env];
      if (!token) throw new VentiError(`Missing API credential environment variable: ${spec.auth_env}`, { code: 'MISSING_CREDENTIAL', retryable: false });
      headers.authorization = token.startsWith('Bearer ') ? token : `Bearer ${token}`;
    }
    let body;
    if (spec.body_file) body = await readFile(toAbsolute(this.root, spec.body_file), 'utf8');
    else if (spec.body !== undefined) body = JSON.stringify(spec.body);
    const started = Date.now();
    const response = await fetch(url, { method, headers, body });
    const raw = method === 'HEAD' ? '' : await response.text();
    const redacted = redactText(raw, this.redact);
    const parsed = parseMaybeJson(redacted);
    this.last = {
      provider: this.name,
      observed_at: nowIso(),
      url,
      title: '',
      text: redacted,
      snapshot: redacted,
      metadata: {
        status: response.status,
        status_text: response.statusText,
        body: parsed,
        headers: { 'content-type': response.headers.get('content-type') },
        elapsed_ms: Date.now() - started,
      },
    };
    return this.last;
  }

  async open(url) { return this.request({ method: 'GET', path: url }); }
  async observe() {
    if (!this.last) throw new VentiError('No API response has been observed yet', { code: 'NO_OBSERVATION' });
    return this.last;
  }
  async snapshot() { return (await this.observe()).text; }
  async screenshot() { throw new VentiError('HTTP provider cannot capture a browser screenshot', { code: 'UNSUPPORTED_CAPABILITY' }); }
  async close() {}
}
