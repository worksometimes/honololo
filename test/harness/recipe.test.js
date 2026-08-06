import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateContract } from '../../harness/lib/contracts.mjs';

const RECIPE = {
  schema_version: '1',
  slug: 'settings-check',
  host: 'app.example.com',
  goal: 'Verify the settings screen.',
  request: {},
  plan: {},
  steps: [{ id: 'home', ops: [{ op: 'goto', url: 'https://app.example.com/' }] }],
  source: {
    run: '20260806-010203-settings-check', attempt: 1,
    plan_sha256: `sha256:${'a'.repeat(64)}`, extracted_at: '2026-08-06T01:02:03.000Z',
  },
};

test('the recipe contract accepts the envelope and refuses a step without ops', () => {
  assert.deepEqual(validateContract('recipe', RECIPE), RECIPE);
  assert.throws(
    () => validateContract('recipe', { ...RECIPE, steps: [{ id: 'home', ops: [] }] }),
    /HONOLOLO_RECIPE_INVALID/u,
  );
  assert.throws(
    () => validateContract('recipe', { ...RECIPE, host: 'App.Example.com' }),
    /HONOLOLO_RECIPE_INVALID/u,
  );
});
