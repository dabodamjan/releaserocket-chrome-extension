'use strict';

const test = require('node:test');
const assert = require('node:assert');

const core = require('../src/core.js');
const { initPopup } = require('../src/popup.js');

const CHROME_PERMS = { permissions: ['storage'], origins: ['https://api.github.com/*'] };
const FIREFOX_PERMS = { permissions: ['storage'], origins: ['https://api.github.com/*'], data_collection: [] };

function makeDoc() {
  const makeEl = () => {
    const el = {
      value: '',
      textContent: '',
      disabled: false,
      handlers: {},
      addEventListener(event, fn) {
        el.handlers[event] = fn;
      },
    };
    return el;
  };
  const els = { token: makeEl(), status: makeEl(), save: makeEl(), clear: makeEl() };
  return { doc: { getElementById: (id) => els[id] }, els };
}

// getAll resolves/rejects only when the test says so, to hold detection open.
function makeExt({ getAll } = {}) {
  const ext = {
    stored: {},
    requests: [],
    grantNext: true,
    permissions: {
      getAll: getAll || (() => Promise.resolve(CHROME_PERMS)),
      request: (arg) => {
        ext.requests.push(arg);
        return Promise.resolve(ext.grantNext);
      },
    },
    storage: {
      local: {
        get: () => Promise.resolve({ ...ext.stored }),
        set: (obj) => {
          Object.assign(ext.stored, obj);
          return Promise.resolve();
        },
        remove: (key) => {
          delete ext.stored[key];
          return Promise.resolve();
        },
      },
    },
  };
  return ext;
}

test('save is disabled and inert until consent detection resolves', async () => {
  let resolveGetAll;
  const ext = makeExt({ getAll: () => new Promise((resolve) => (resolveGetAll = resolve)) });
  const { doc, els } = makeDoc();
  const detection = initPopup({ ext, core, doc });

  assert.strictEqual(els.save.disabled, true, 'save must start disabled');
  els.token.value = 'ghp_racing';
  await els.save.handlers.click(); // programmatic click; a real one is blocked by disabled
  assert.deepStrictEqual(ext.stored, {}, 'a click during detection must not store the token');
  assert.deepStrictEqual(ext.requests, []);
  assert.strictEqual(els.status.textContent, '');

  resolveGetAll(FIREFOX_PERMS);
  await detection;
  assert.strictEqual(els.save.disabled, false, 'save enables once detection settles');
  await els.save.handlers.click();
  assert.deepStrictEqual(ext.requests, [{ data_collection: [core.TOKEN_CONSENT_PERMISSION] }]);
  assert.deepStrictEqual(ext.stored, { token: 'ghp_racing' });
});

test('a getAll failure fails closed: save stays disabled with an explanation', async () => {
  const ext = makeExt({ getAll: () => Promise.reject(new Error('boom')) });
  const { doc, els } = makeDoc();
  await initPopup({ ext, core, doc });

  assert.strictEqual(els.save.disabled, true);
  assert.match(els.status.textContent, /unavailable/);
  els.token.value = 'ghp_secret';
  await els.save.handlers.click();
  assert.deepStrictEqual(ext.stored, {}, 'no token may be stored when consent state is unknown');
  assert.deepStrictEqual(ext.requests, [], 'nothing to request without user-visible consent support');
});

test('firefox path: permissions.request is the first await, and a decline blocks the save', async () => {
  const ext = makeExt({ getAll: () => Promise.resolve(FIREFOX_PERMS) });
  const { doc, els } = makeDoc();
  await initPopup({ ext, core, doc });

  els.token.value = 'ghp_token';
  ext.grantNext = false;
  const clicked = els.save.handlers.click();
  // Code before an async function's first await runs synchronously, so the
  // user-activation constraint holds iff the request was already issued here.
  assert.strictEqual(ext.requests.length, 1, 'request must be issued synchronously inside the click');
  await clicked;
  assert.deepStrictEqual(ext.stored, {});
  assert.match(els.status.textContent, /not saved/);

  ext.grantNext = true;
  await els.save.handlers.click();
  assert.deepStrictEqual(ext.stored, { token: 'ghp_token' });
  assert.strictEqual(els.token.value, '');
  assert.strictEqual(els.status.textContent, 'Token saved.');
});

test('chrome path: no consent request, save and clear round-trip', async () => {
  const ext = makeExt();
  const { doc, els } = makeDoc();
  await initPopup({ ext, core, doc });

  assert.strictEqual(els.save.disabled, false);
  await els.save.handlers.click();
  assert.strictEqual(els.status.textContent, 'Paste a token first.');

  els.token.value = '  ghp_abc  ';
  await els.save.handlers.click();
  assert.deepStrictEqual(ext.requests, []);
  assert.deepStrictEqual(ext.stored, { token: 'ghp_abc' });

  await els.clear.handlers.click();
  assert.deepStrictEqual(ext.stored, {});
  assert.strictEqual(els.status.textContent, 'Token cleared.');
});

test('a saved token is reported on load', async () => {
  const ext = makeExt();
  ext.stored.token = 'ghp_existing';
  const { doc, els } = makeDoc();
  await initPopup({ ext, core, doc });
  await Promise.resolve(); // let the storage.get continuation run
  assert.strictEqual(els.status.textContent, 'A token is saved.');
});
