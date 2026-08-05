const INTERNAL_PROTOCOLS = new Set(['about:', 'chrome:', 'devtools:']);

function guardError(code, detail) {
  const error = new Error(detail ? `${code}: ${detail}` : code);
  error.code = code;
  return error;
}

export function parseGuard({ allow = [], scope = [] } = {}) {
  if (!Array.isArray(allow) || !Array.isArray(scope)) {
    throw guardError('HONOLOLO_GUARD_INVALID');
  }
  for (const domain of allow) {
    if (typeof domain !== 'string' || domain === '' || domain.includes('/')) {
      throw guardError('HONOLOLO_GUARD_DOMAIN_INVALID', String(domain));
    }
  }
  for (const fragment of scope) {
    if (typeof fragment !== 'string' || fragment === '') {
      throw guardError('HONOLOLO_GUARD_SCOPE_INVALID', String(fragment));
    }
  }
  return { allow: [...allow], scope: [...scope] };
}

export function checkGuard(url, { allow = [], scope = [] } = {}) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return { code: 'URL_INVALID', url: String(url) };
  }
  if (INTERNAL_PROTOCOLS.has(parsed.protocol)) return null;
  if (allow.length > 0 && !allow.includes(parsed.hostname)) {
    return { code: 'DOMAIN_BLOCKED', url: parsed.href, hostname: parsed.hostname };
  }
  if (scope.length > 0 && !scope.some((fragment) => parsed.href.includes(fragment))) {
    return { code: 'SCOPE_BLOCKED', url: parsed.href };
  }
  return null;
}

export function parseDriverArguments(argv) {
  const options = { cdp: 'http://127.0.0.1:9222', target: null, allow: [], scope: [], json: false };
  let index = 0;
  while (index < argv.length) {
    const flag = argv[index];
    if (flag === '--json') {
      options.json = true;
      index += 1;
      continue;
    }
    const value = argv[index + 1];
    if (typeof value !== 'string' || value === '') {
      throw guardError('HONOLOLO_BROWSER_USAGE', String(flag));
    }
    if (flag === '--cdp') options.cdp = value;
    else if (flag === '--target') options.target = value;
    else if (flag === '--allow') options.allow.push(value);
    else if (flag === '--scope') options.scope.push(value);
    else throw guardError('HONOLOLO_BROWSER_USAGE', String(flag));
    index += 2;
  }
  if (options.target === null) {
    throw guardError(
      'HONOLOLO_BROWSER_USAGE',
      '--target <url-substring> [--cdp <url>] [--allow <domain>]... [--scope <url-substring>]... [--json]',
    );
  }
  parseGuard(options);
  return options;
}
