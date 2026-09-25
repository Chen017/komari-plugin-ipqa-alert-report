import test from 'node:test';
import assert from 'node:assert/strict';
import { isAdminPrincipal } from '../src/index.ts';

test('mutating HTTP routes reject anonymous and non-admin principals', () => {
  assert.equal(isAdminPrincipal(undefined), false);
  assert.equal(isAdminPrincipal({ type: 'anonymous', roles: ['guest'] }), false);
  assert.equal(isAdminPrincipal({ type: 'agent', roles: ['client'] }), false);
  assert.equal(isAdminPrincipal({ type: 'user', roles: [] }), false);
});

test('mutating HTTP routes accept admin users and API keys', () => {
  assert.equal(isAdminPrincipal({ type: 'user', roles: ['admin'] }), true);
  assert.equal(isAdminPrincipal({ type: 'api_key', roles: ['admin'], is_api_key: true }), true);
});
