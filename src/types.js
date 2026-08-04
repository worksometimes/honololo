export const PROTOCOL_VERSION = 'venti.browser.v1';

export const RESULT_STATUSES = Object.freeze([
  'pass',
  'pass_needs_review',
  'fail',
  'flaky',
  'blocked',
  'needs_human',
  'skipped',
  'error',
]);

export class VentiError extends Error {
  constructor(message, { code = 'VENTI_ERROR', retryable = false, details = {} } = {}) {
    super(message);
    this.name = 'VentiError';
    this.code = code;
    this.retryable = retryable;
    this.details = details;
  }
}

/**
 * @typedef {{role?: string, name?: string, text?: string, label?: string,
 * placeholder?: string, test_id?: string, alt?: string, title?: string,
 * css?: string, xpath?: string, index?: number}} Locator
 */

/**
 * @typedef {{url: string, title?: string, text?: string, snapshot?: string,
 * provider: string, observed_at: string, metadata?: object}} Observation
 */

/**
 * @typedef {{name: string, capabilities: string[], provider_version?: string,
 * protocol_version: string}} ProviderInfo
 */
