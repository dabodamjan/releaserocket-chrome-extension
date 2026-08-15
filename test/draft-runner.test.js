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

// Hand-driven timers: the watchdog must be testable without waiting 45s, and
// no test may leave a live timer behind that keeps the run alive.
function makeTimers() {
  const armed = new Map();
  let nextId = 0;
  return {
    delays: [],
    setTimer(fn, ms) {
      nextId += 1;
      armed.set(nextId, fn);
      this.delays.push(ms);
      return nextId;
    },
    clearTimer(id) {
      armed.delete(id);
    },
    armedCount() {
      return armed.size;
    },
    // Fires armed timers oldest first, exactly once each. `count` limits it to
    // the oldest N, so a test can fire one draft's watchdog and not another's.
    fire(count) {
      const ids = [...armed.keys()];
      for (const id of count === undefined ? ids : ids.slice(0, count)) {
        const fn = armed.get(id);
        armed.delete(id);
        fn();
      }
    },
  };
}

// Records the callback sequence and hands back one deferred per started draft,
// so a test can land responses in whatever order it wants.
function makeHarness({ contextKey, timeoutMs } = {}) {
  const events = [];
  const pending = [];
  const timers = makeTimers();
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
    timeoutMs, // undefined falls through to the runner's own default
    setTimer: (fn, ms) => timers.setTimer(fn, ms),
    clearTimer: (id) => timers.clearTimer(id),
  });
  return { runner, events, pending, timers };
}

// Lets the microtask queue drain: the watchdog rejects from a timer callback,
// so start()'s continuation runs a tick later.
function flush() {
  return new Promise((resolve) => setImmediate(resolve));
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

/*
 * The watchdog. Without it, a draft whose response never arrives at all (a
 * message port that dies between content script and background script) leaves
 * busy stuck on: every control disabled and the button's isBusy() guard
 * refusing a retry, with no way out short of reloading the tab.
 */

test('a draft that never settles is failed by the watchdog and clears the busy state', async () => {
  const h = makeHarness({ timeoutMs: 1000 });
  const started = h.runner.start({ baseline: null });
  assert.deepEqual(h.events, ['busy']);
  assert.equal(h.runner.isBusy(), true);

  h.timers.fire();
  await started;
  assert.deepEqual(h.events, ['busy', 'error:Timed out talking to GitHub. Try again.', 'idle']);
  assert.equal(h.runner.isBusy(), false);
});

test('the watchdog uses the injected timeout, and 45s by default', async () => {
  const h = makeHarness({ timeoutMs: 1000 });
  h.runner.start({ baseline: null });
  assert.deepEqual(h.timers.delays, [1000]);

  const d = makeHarness();
  d.runner.start({ baseline: null });
  assert.deepEqual(d.timers.delays, [core.DRAFT_TIMEOUT_MS]);
  assert.equal(core.DRAFT_TIMEOUT_MS, 45000);
});

test('a response that arrives after the watchdog fired renders nothing', async () => {
  const h = makeHarness({ timeoutMs: 1000 });
  const started = h.runner.start({ baseline: null });
  h.timers.fire();
  await started;

  h.pending[0].resolve('the wedged response, at last');
  await flush();
  assert.deepEqual(
    h.events,
    ['busy', 'error:Timed out talking to GitHub. Try again.', 'idle'],
    'the timed-out draft is over; its late response must not render'
  );
  assert.equal(h.runner.isBusy(), false);
});

test('a draft that settles in time disarms its watchdog', async () => {
  const h = makeHarness({ timeoutMs: 1000 });
  const started = h.runner.start({ baseline: null });
  assert.equal(h.timers.armedCount(), 1);

  h.pending[0].resolve('draft-1');
  await started;
  assert.equal(h.timers.armedCount(), 0, 'a settled draft must leave no timer behind');
  assert.deepEqual(h.events, ['busy', 'result:draft-1', 'idle']);
});

// The superseded draft keeps its own watchdog armed; firing it must not report
// a timeout for, or unbusy, the draft that replaced it.
test("a superseded draft's watchdog leaves the newer draft alone", async () => {
  const h = makeHarness({ timeoutMs: 1000 });
  const first = h.runner.start({ baseline: 'v1.2.0' });
  const second = h.runner.start({ baseline: 'v1.1.0' });

  h.timers.fire(1); // the superseded draft's watchdog only
  await first;
  assert.deepEqual(h.events, ['busy', 'busy'], 'no error and no idle from the superseded draft');
  assert.equal(h.runner.isBusy(), true, 'the spinner stays up for the newer draft');

  h.pending[1].resolve('newer');
  await second;
  assert.deepEqual(h.events, ['busy', 'busy', 'result:newer', 'idle']);
  assert.equal(h.runner.isBusy(), false);
});

/*
 * preloadedFor is the refresh fix: the refresh button flags the request instead
 * of clearing the panel's session, so a refresh that fails leaves the picker
 * backed by the baselines still on screen rather than enabled and inert.
 */

const SESSION = { repoInfo: { default_branch: 'main' }, baselines: [{ tag: 'v1.2.0' }], lastResult: {} };

test('a draft with no session yet fetches everything', () => {
  assert.deepEqual(core.preloadedFor(null, { refresh: false }), {});
});

test('a baseline switch reuses the cached repo info and baselines', () => {
  assert.deepEqual(core.preloadedFor(SESSION, { baseline: null, refresh: false }), {
    repoInfo: SESSION.repoInfo,
    baselines: SESSION.baselines,
  });
  assert.deepEqual(core.preloadedFor(SESSION, {}), {
    repoInfo: SESSION.repoInfo,
    baselines: SESSION.baselines,
  });
});

test('a refresh refetches everything without discarding the session', () => {
  assert.deepEqual(core.preloadedFor(SESSION, { refresh: true }), {}, 'a refresh must not reuse the cache');
  // The session object is untouched, so after a refresh that fails the panel
  // still has the baselines behind its re-enabled "Since" picker.
  assert.deepEqual(core.preloadedFor(SESSION, { refresh: false }), {
    repoInfo: SESSION.repoInfo,
    baselines: SESSION.baselines,
  });
});

// A bug in rendering used to be caught by the same catch as the fetch, so the
// panel reported a broken renderer as a GitHub failure.
test('a throw from the render callback is not reported as a fetch failure', async () => {
  const events = [];
  const box = deferred();
  const timers = makeTimers();
  const runner = core.makeDraftRunner({
    contextKey: () => 'acme/widget',
    run: () => box.promise,
    onBusy: (busy) => events.push(busy ? 'busy' : 'idle'),
    onResult: () => {
      throw new Error('render bug');
    },
    onError: () => events.push('error'),
    setTimer: (fn, ms) => timers.setTimer(fn, ms),
    clearTimer: (id) => timers.clearTimer(id),
  });

  const started = runner.start({ baseline: null });
  box.resolve('ok');
  await assert.rejects(() => started, /render bug/);
  assert.deepEqual(events, ['busy', 'idle'], 'the spinner comes down and onError stays out of it');
  assert.equal(runner.isBusy(), false);
});
