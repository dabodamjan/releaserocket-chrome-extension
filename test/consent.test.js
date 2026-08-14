'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { supportsTokenConsent, hasTokenConsent, TOKEN_CONSENT_PERMISSION } = require('../src/core.js');

test('chrome/edge permissions (no data_collection key) mean no consent experience', () => {
  const perms = { permissions: ['storage'], origins: ['https://api.github.com/*'] };
  assert.strictEqual(supportsTokenConsent(perms), false);
  assert.strictEqual(hasTokenConsent(perms), true);
});

test('a granted authenticationInfo data permission allows token use', () => {
  assert.strictEqual(TOKEN_CONSENT_PERMISSION, 'authenticationInfo');
  const perms = { permissions: [], origins: [], data_collection: [TOKEN_CONSENT_PERMISSION] };
  assert.strictEqual(supportsTokenConsent(perms), true);
  assert.strictEqual(hasTokenConsent(perms), true);
  // Other granted categories alongside it change nothing.
  assert.strictEqual(hasTokenConsent({ data_collection: ['none', TOKEN_CONSENT_PERMISSION] }), true);
});

test('an absent or revoked grant blocks token use on firefox', () => {
  for (const data_collection of [[], ['none'], ['technicalAndInteraction']]) {
    const perms = { permissions: [], origins: [], data_collection };
    assert.strictEqual(supportsTokenConsent(perms), true, JSON.stringify(data_collection));
    assert.strictEqual(hasTokenConsent(perms), false, JSON.stringify(data_collection));
  }
});

test('degenerate getAll results fail open only when the key is missing', () => {
  assert.strictEqual(hasTokenConsent(undefined), true);
  assert.strictEqual(hasTokenConsent(null), true);
  assert.strictEqual(hasTokenConsent({}), true);
  // A present but malformed key reads as unconsented, never as unsupported.
  assert.strictEqual(hasTokenConsent({ data_collection: 'authenticationInfo' }), false);
});
