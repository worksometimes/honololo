import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkGuard, parseDriverArguments, parseGuard } from '../../harness/lib/browser-guard.mjs';

test('checkGuard passes allowed hostnames and scoped URLs', () => {
  const guard = { allow: ['admin.miso.example'], scope: ['personal-connectors'] };
  assert.equal(
    checkGuard('https://admin.miso.example/dashboard/personal-connectors/abc', guard),
    null,
  );
});

test('checkGuard blocks foreign domains before scope is consulted', () => {
  const guard = { allow: ['admin.miso.example'], scope: ['personal-connectors'] };
  const violation = checkGuard('https://evil.example/personal-connectors', guard);
  assert.equal(violation.code, 'DOMAIN_BLOCKED');
  assert.equal(violation.hostname, 'evil.example');
});

test('checkGuard blocks same-domain navigation outside scope', () => {
  const guard = { allow: ['admin.miso.example'], scope: ['personal-connectors'] };
  const violation = checkGuard('https://admin.miso.example/dashboard/users', guard);
  assert.equal(violation.code, 'SCOPE_BLOCKED');
});

test('checkGuard treats empty guard lists as unrestricted and rejects bad URLs', () => {
  assert.equal(checkGuard('https://anything.example/path', {}), null);
  assert.equal(checkGuard('about:blank', { allow: ['admin.miso.example'] }), null);
  assert.equal(checkGuard('not a url', {}).code, 'URL_INVALID');
});

test('checkGuard does not allow subdomain or substring hostname escapes', () => {
  const guard = { allow: ['miso.example'] };
  assert.equal(checkGuard('https://admin.miso.example/', guard).code, 'DOMAIN_BLOCKED');
  assert.equal(checkGuard('https://miso.example.evil.example/', guard).code, 'DOMAIN_BLOCKED');
});

test('parseGuard rejects malformed domain and scope entries', () => {
  assert.throws(() => parseGuard({ allow: ['host/path'] }), /HONOLOLO_GUARD_DOMAIN_INVALID/u);
  assert.throws(() => parseGuard({ scope: [''] }), /HONOLOLO_GUARD_SCOPE_INVALID/u);
  assert.throws(() => parseGuard({ allow: 'not-a-list' }), /HONOLOLO_GUARD_INVALID/u);
});

test('parseDriverArguments requires target and collects repeatable flags', () => {
  const options = parseDriverArguments([
    '--target', 'admin.miso.example',
    '--allow', 'admin.miso.example',
    '--scope', 'personal-connectors',
    '--scope', 'sign-in',
  ]);
  assert.equal(options.target, 'admin.miso.example');
  assert.equal(options.cdp, 'http://127.0.0.1:9222');
  assert.deepEqual(options.allow, ['admin.miso.example']);
  assert.deepEqual(options.scope, ['personal-connectors', 'sign-in']);

  assert.throws(() => parseDriverArguments([]), /HONOLOLO_BROWSER_USAGE/u);
  assert.throws(
    () => parseDriverArguments(['--target', 'x', '--bogus', 'y']),
    /HONOLOLO_BROWSER_USAGE/u,
  );
  assert.throws(() => parseDriverArguments(['--target']), /HONOLOLO_BROWSER_USAGE/u);
});

test('telemetry and stage are optional value flags', () => {
  const options = parseDriverArguments([
    '--target', 'app', '--telemetry', 'run/telemetry.jsonl', '--stage', 'execute',
  ]);
  assert.equal(options.telemetry, 'run/telemetry.jsonl');
  assert.equal(options.stage, 'execute');
  const bare = parseDriverArguments(['--target', 'app']);
  assert.equal(bare.telemetry, null);
  assert.equal(bare.stage, null);
});
