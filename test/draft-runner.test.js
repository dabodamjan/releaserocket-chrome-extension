'use strict';

/*
 * makeDraftRunner is the panel's loading state: it decides when the spinner is
 * up, which response is allowed to render, and that a finished draft always
 * resolves into either a result or an error. The content script only maps
 * those callbacks onto DOM attributes, so the transitions are covered here.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../src/core.js');

function deferred() {
  const box = {};
  box.promise = new Promise((resolve, reject) => {
    box.resolve = resolve;
    box.reject = reject;
  });
  return box;
}

// Records the callback sequence and hands back one deferred per started draft,
// so a test can land responses in whatever order it wants.
function makeHarness({ contextKey } = {}) {
  const events = [];
  const pending = [];
  const runner = core.makeDraftRunner({
    contextKey: contextKey || (() => 'acme/widget'),
    run: (request) => {
      const box = deferred();
      pending.push({ request, resolve: box.resolve, reject: box.reject });
      return box.promise;
    },
    onBusy: (busy) => events.push(busy ? 'busy' : 'idle'),
    onResult: (result) => events.push(`result:${result}`),
    onError: (err) => events.push(`error:${err.message}`),
  });
  return { runner, events, pending };
}

test('a draft raises the busy state immediately and drops it once the result renders', async () => {
  const h = makeHarness();
  const started = h.runner.start({ baseline: null });
  // The panel must show the in-progress state before any await, not a frame later.
  assert.deepEqual(h.events, ['busy']);
  assert.equal(h.runner.isBusy(), true);
  assert.equal(h.pending.length, 1);

  h.pending[0].resolve('draft-1');
  await started;
  assert.deepEqual(h.events, ['busy', 'result:draft-1', 'idle']);
  assert.equal(h.runner.isBusy(), false);
});

test('the request reaches run() and the busy state is raised again for a redraft', async () => {
  const h = makeHarness();
  const first = h.runner.start({ baseline: 'v1.2.0' });
  h.pending[0].resolve('draft-1');
  await first;

  const second = h.runner.start({ baseline: 'v1.1.0' });
  assert.deepEqual(h.pending.map((p) => p.request.baseline), ['v1.2.0', 'v1.1.0']);
  assert.equal(h.runner.isBusy(), true);
  h.pending[1].resolve('draft-2');
  await second;
  assert.deepEqual(h.events, ['busy', 'result:draft-1', 'idle', 'busy', 'result:draft-2', 'idle']);
});

// A stuck spinner is the failure mode this guards: a fetch that throws has to
// end in the error path with the busy state cleared.
test('a failed fetch resolves the busy state into the error path', async () => {
  const h = makeHarness();
  const started = h.runner.start({ baseline: null });
  h.pending[0].reject(new Error('GitHub API rate limit reached.'));
  await started;
  assert.deepEqual(h.events, ['busy', 'error:GitHub API rate limit reached.', 'idle']);
  assert.equal(h.runner.isBusy(), false);
});

// The brief's race: two quick "Since" changes, first response lands last.
test('a late response from a superseded draft never overwrites the newer one', async () => {
  const h = makeHarness();
  const first = h.runner.start({ baseline: 'v1.2.0' });
  const second = h.runner.start({ baseline: 'v1.1.0' });
  assert.equal(h.pending.length, 2);

  h.pending[1].resolve('newer');
  await second;
  assert.equal(h.runner.isBusy(), false);

  h.pending[0].resolve('stale');
  await first;
  assert.deepEqual(h.events, ['busy', 'busy', 'result:newer', 'idle'], 'the stale draft must render nothing');
});

test('a superseded draft leaves the busy state up for the draft that replaced it', async () => {
  const h = makeHarness();
  const first = h.runner.start({ baseline: 'v1.2.0' });
  const second = h.runner.start({ baseline: 'v1.1.0' });

  h.pending[0].resolve('stale');
  await first;
  assert.equal(h.runner.isBusy(), true, 'the spinner must stay up for the newer draft');
  assert.deepEqual(h.events, ['busy', 'busy']);

  h.pending[1].resolve('newer');
  await second;
  assert.deepEqual(h.events, ['busy', 'busy', 'result:newer', 'idle']);
  assert.equal(h.runner.isBusy(), false);
});

// Turbo navigation to another repository while a draft is in flight.
test('a response whose context changed under it is dropped, and the busy state still clears', async () => {
  let key = 'acme/widget';
  const h = makeHarness({ contextKey: () => key });
  const started = h.runner.start({ baseline: null });
  key = 'acme/gadget';

  h.pending[0].resolve('widget draft');
  await started;
  assert.deepEqual(h.events, ['busy', 'idle'], "repo A's draft must not land in repo B");
  assert.equal(h.runner.isBusy(), false);
});

test('invalidate drops the in-flight response without touching the UI', async () => {
  const h = makeHarness();
  const started = h.runner.start({ baseline: null });
  h.runner.invalidate();
  assert.equal(h.runner.isBusy(), false);

  h.pending[0].resolve('gone');
  await started;
  assert.deepEqual(h.events, ['busy'], 'an unmounted panel gets no further callbacks');
});

// A bug in rendering used to be caught by the same catch as the fetch, so the
// panel reported a broken renderer as a GitHub failure.
test('a throw from the render callback is not reported as a fetch failure', async () => {
  const events = [];
  const box = deferred();
  const runner = core.makeDraftRunner({
    contextKey: () => 'acme/widget',
    run: () => box.promise,
    onBusy: (busy) => events.push(busy ? 'busy' : 'idle'),
    onResult: () => {
      throw new Error('render bug');
    },
    onError: () => events.push('error'),
  });

  const started = runner.start({ baseline: null });
  box.resolve('ok');
  await assert.rejects(() => started, /render bug/);
  assert.deepEqual(events, ['busy', 'idle'], 'the spinner comes down and onError stays out of it');
  assert.equal(runner.isBusy(), false);
});
