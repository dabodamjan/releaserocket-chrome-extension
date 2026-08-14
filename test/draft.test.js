'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../src/core.js');
const { makeFetch, jsonResponse, loadFixture } = require('./helpers.js');

const REPO = { owner: 'acme', repo: 'widget' };

function tagCommit(date) {
  return { sha: 'f00d' + date, commit: { committer: { name: 'GitHub', date }, message: `tag commit ${date}` } };
}

function standardRoutes() {
  return [
    ['/repos/acme/widget/releases', loadFixture('releases')],
    ['/repos/acme/widget/tags', loadFixture('tags')],
    // Tag commits behind the release baselines (created_at in releases.json),
    // looked up through the qualified `tags/NAME` ref.
    ['/commits/tags/v1.2.0', tagCommit('2026-06-30T22:00:00Z')],
    ['/commits/tags/v1.1.0', tagCommit('2026-05-31T22:00:00Z')],
    ['/repos/acme/widget/commits/', loadFixture('commit')],
    ['/repos/acme/widget/pulls', loadFixture('pulls-page1')],
    [(url) => url.endsWith('/repos/acme/widget'), loadFixture('repo')],
  ];
}

test('listBaselines uses published releases and drops drafts', async () => {
  const fetchImpl = makeFetch(standardRoutes());
  const baselines = await core.listBaselines(REPO, fetchImpl);
  assert.deepEqual(baselines.map((b) => b.tag), ['v1.2.0', 'v1.1.0', 'v1.0.0']);
  assert.equal(baselines[0].type, 'release');
  // Releases resolve their cutoff lazily through the tag commit; published_at
  // is kept only as a fallback.
  assert.equal(baselines[0].date, null);
  assert.equal(baselines[0].commitRef, 'tags/v1.2.0');
  assert.equal(baselines[0].fallbackDate, '2026-07-01T00:00:00Z');
  assert.equal(baselines[1].name, 'Spring release');
  assert.equal(fetchImpl.calls.length, 1);
});

test('listBaselines requests up to 100 releases so drafts cannot hide published ones', async () => {
  const fetchImpl = makeFetch(standardRoutes());
  await core.listBaselines(REPO, fetchImpl);
  assert.match(fetchImpl.calls[0], /\/releases\?per_page=100$/);
});

test('listBaselines falls back to tags when there are no releases', async () => {
  const fetchImpl = makeFetch([
    ['/releases', []],
    ['/tags', loadFixture('tags')],
  ]);
  const baselines = await core.listBaselines(REPO, fetchImpl);
  assert.deepEqual(baselines.map((b) => b.tag), ['v0.9.0', 'v0.8.0']);
  assert.equal(baselines[0].type, 'tag');
  assert.equal(baselines[0].date, null);
  assert.equal(baselines[0].commitRef, 'abc123def4567890abc123def4567890abc123de');
});

test('resolveCutoff: an already-resolved date is reused without a call', async () => {
  const fetchImpl = makeFetch([]);
  const cutoff = await core.resolveCutoff({ type: 'release', tag: 'v1.2.0', date: '2026-06-30T22:00:00Z' }, REPO, fetchImpl);
  assert.equal(cutoff, '2026-06-30T22:00:00Z');
  assert.equal(fetchImpl.calls.length, 0);
});

// Regression: releases used to cut off at published_at, so PRs merged between
// tag creation and publish vanished from the next draft.
test('resolveCutoff: releases resolve through the tag commit date, not published_at', async () => {
  const fetchImpl = makeFetch(standardRoutes());
  const baseline = { type: 'release', tag: 'v1.2.0', date: null, commitRef: 'tags/v1.2.0', fallbackDate: '2026-07-01T00:00:00Z' };
  const cutoff = await core.resolveCutoff(baseline, REPO, fetchImpl);
  assert.equal(cutoff, '2026-06-30T22:00:00Z');
  assert.equal(fetchImpl.calls.length, 1);
  assert.match(fetchImpl.calls[0], /\/commits\/tags\/v1\.2\.0$/);
  const again = await core.resolveCutoff(baseline, REPO, fetchImpl);
  assert.equal(again, cutoff);
  assert.equal(fetchImpl.calls.length, 1);
});

// A tag named like a branch, or like a SHA prefix, resolves to the wrong commit
// on the unqualified form; the docs for GET /commits/{ref} take `tags/NAME`.
test('release baselines look the tag up as a qualified tags/ ref', async () => {
  const fetchImpl = makeFetch([
    ['/releases', [{ name: 'Weird tag', tag_name: 'main', draft: false, published_at: '2026-07-01T00:00:00Z' }]],
  ]);
  const [baseline] = await core.listBaselines(REPO, fetchImpl);
  assert.equal(baseline.commitRef, 'tags/main');
});

test('resolveCutoff keeps the slashes in a slash-containing tag name', async () => {
  const fetchImpl = makeFetch([['/commits/', tagCommit('2026-06-30T22:00:00Z')]]);
  const baseline = { type: 'release', tag: 'release/1.0', date: null, commitRef: 'tags/release/1.0', fallbackDate: null };
  await core.resolveCutoff(baseline, REPO, fetchImpl);
  assert.match(fetchImpl.calls[0], /\/commits\/tags\/release\/1\.0$/);
});

test('resolveCutoff: falls back to published_at when the commit carries no date', async () => {
  const fetchImpl = makeFetch([['/commits/tags/v1.2.0', { sha: 'x', commit: {} }]]);
  const baseline = { type: 'release', tag: 'v1.2.0', date: null, commitRef: 'tags/v1.2.0', fallbackDate: '2026-07-01T00:00:00Z' };
  assert.equal(await core.resolveCutoff(baseline, REPO, fetchImpl), '2026-07-01T00:00:00Z');
});

// Regression: a release whose tag was deleted or renamed 404s on the commit
// lookup, which used to abort the whole draft instead of using published_at.
test('resolveCutoff: a dead tag ref falls back to the publish date', async () => {
  const fetchImpl = makeFetch([
    ['/commits/', jsonResponse({ message: 'No commit found for SHA: tags/v1.2.0' }, { status: 404 })],
  ]);
  const baseline = { type: 'release', tag: 'v1.2.0', date: null, commitRef: 'tags/v1.2.0', fallbackDate: '2026-07-01T00:00:00Z' };
  assert.equal(await core.resolveCutoff(baseline, REPO, fetchImpl), '2026-07-01T00:00:00Z');
});

test('resolveCutoff: a dead ref with no fallback date means no cutoff', async () => {
  const fetchImpl = makeFetch([['/commits/', jsonResponse({ message: 'Not Found' }, { status: 404 })]]);
  const baseline = { type: 'tag', tag: 'v0.9.0', date: null, commitRef: 'deadbeef' };
  assert.equal(await core.resolveCutoff(baseline, REPO, fetchImpl), null);
});

// Rate limits, auth and permission failures hit every later call too, so they
// must not be swallowed into a silently wrong cutoff. The permission 403 case
// is a regression: it used to be mistaken for a dead tag and hidden behind the
// publish-date fallback, so a repo the token cannot read produced a draft
// instead of an access error.
test('resolveCutoff: rate limits, auth and permission failures still propagate', async () => {
  for (const [status, headers, kind] of [
    [403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1786709000' }, 'rate-limit'],
    [429, { 'x-ratelimit-remaining': '9', 'retry-after': '30' }, 'rate-limit-secondary'],
    [403, { 'x-ratelimit-remaining': '42' }, 'forbidden'],
    [401, {}, 'bad-token'],
  ]) {
    const fetchImpl = makeFetch([['/commits/', jsonResponse({ message: 'nope' }, { status, headers })]]);
    const baseline = { type: 'release', tag: 'v1.2.0', date: null, commitRef: 'tags/v1.2.0', fallbackDate: '2026-07-01T00:00:00Z' };
    await assert.rejects(() => core.resolveCutoff(baseline, REPO, fetchImpl), (err) => err.kind === kind);
  }
});

test('resolveCutoff: a network failure propagates', async () => {
  const fetchImpl = async () => {
    throw new Error('offline');
  };
  fetchImpl.calls = [];
  const baseline = { type: 'release', tag: 'v1.2.0', date: null, commitRef: 'tags/v1.2.0', fallbackDate: '2026-07-01T00:00:00Z' };
  await assert.rejects(() => core.resolveCutoff(baseline, REPO, fetchImpl), (err) => err.kind === 'network');
});

test('resolveCutoff: tags resolve through the tagged commit and cache the date', async () => {
  const fetchImpl = makeFetch(standardRoutes());
  const baseline = { type: 'tag', tag: 'v0.9.0', date: null, commitRef: 'abc123def4567890abc123def4567890abc123de' };
  const cutoff = await core.resolveCutoff(baseline, REPO, fetchImpl);
  assert.equal(cutoff, '2026-06-15T12:00:00Z');
  assert.equal(fetchImpl.calls.length, 1);
  const again = await core.resolveCutoff(baseline, REPO, fetchImpl);
  assert.equal(again, cutoff);
  assert.equal(fetchImpl.calls.length, 1);
});

test('resolveCutoff: null baseline means no cutoff', async () => {
  const fetchImpl = makeFetch([]);
  assert.equal(await core.resolveCutoff(null, REPO, fetchImpl), null);
});

test('listMergedPrsSince filters to PRs merged after the cutoff', async () => {
  const fetchImpl = makeFetch(standardRoutes());
  const { prs, truncated } = await core.listMergedPrsSince(
    { ...REPO, base: 'main', cutoff: '2026-07-01T00:00:00Z' },
    fetchImpl
  );
  assert.deepEqual(prs.map((p) => p.number), [50, 49, 48, 47, 46]);
  assert.equal(truncated, false);
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(
    fetchImpl.calls[0],
    'https://api.github.com/repos/acme/widget/pulls?state=closed&base=main&sort=updated&direction=desc&per_page=100&page=1'
  );
});

test('listMergedPrsSince with an older cutoff includes the extra PR', async () => {
  const fetchImpl = makeFetch(standardRoutes());
  const { prs } = await core.listMergedPrsSince({ ...REPO, base: 'main', cutoff: '2026-06-01T00:00:00Z' }, fetchImpl);
  assert.deepEqual(prs.map((p) => p.number), [50, 49, 48, 47, 46, 44]);
});

function syntheticPr(number, mergedAt) {
  return {
    number,
    title: `Change ${number}`,
    labels: [],
    merged_at: mergedAt,
    updated_at: mergedAt,
  };
}

test('listMergedPrsSince pages until it passes the cutoff, then stops', async () => {
  // Page 1: 100 PRs merged after the cutoff. Page 2: older ones.
  const page1 = Array.from({ length: 100 }, (_, i) => syntheticPr(300 - i, '2026-07-10T00:00:00Z'));
  const page2 = [syntheticPr(200, '2026-07-05T00:00:00Z'), syntheticPr(199, '2026-05-01T00:00:00Z')];
  const fetchImpl = makeFetch([
    ['&page=1', page1],
    ['&page=2', page2],
    ['&page=3', []],
  ]);
  const { prs, truncated } = await core.listMergedPrsSince(
    { ...REPO, base: 'main', cutoff: '2026-06-01T00:00:00Z' },
    fetchImpl
  );
  assert.equal(prs.length, 101);
  assert.equal(truncated, false);
  assert.equal(fetchImpl.calls.length, 2);
});

// Regression: an empty page used to fall through to `truncated: true`, so a
// repo whose closed-PR count is an exact multiple of 100 got a false
// "stopped after 300 PRs" warning on a complete draft.
test('listMergedPrsSince treats an empty page as exhausted, not truncated', async () => {
  const fullPage = Array.from({ length: 100 }, (_, i) => syntheticPr(300 - i, '2026-07-10T00:00:00Z'));
  const fetchImpl = makeFetch([
    ['&page=1', fullPage],
    ['&page=2', []],
  ]);
  const { prs, truncated } = await core.listMergedPrsSince(
    { ...REPO, base: 'main', cutoff: '2026-06-01T00:00:00Z' },
    fetchImpl
  );
  assert.equal(prs.length, 100);
  assert.equal(truncated, false);
  assert.equal(fetchImpl.calls.length, 2);
});

test('listMergedPrsSince excludes a PR merged exactly at the cutoff', async () => {
  const cutoff = '2026-07-01T00:00:00Z';
  const fetchImpl = makeFetch([
    ['&page=1', [syntheticPr(2, '2026-07-01T00:00:01Z'), syntheticPr(1, cutoff)]],
  ]);
  const { prs } = await core.listMergedPrsSince({ ...REPO, base: 'main', cutoff }, fetchImpl);
  assert.deepEqual(prs.map((p) => p.number), [2]);
});

test('listMergedPrsSince stops at maxPages and reports truncation', async () => {
  const fullPage = (page) => Array.from({ length: 100 }, (_, i) => syntheticPr(page * 1000 + i, '2026-07-10T00:00:00Z'));
  const fetchImpl = makeFetch([
    ['&page=1', fullPage(1)],
    ['&page=2', fullPage(2)],
    ['&page=3', fullPage(3)],
    ['&page=4', fullPage(4)],
  ]);
  const { prs, truncated } = await core.listMergedPrsSince(
    { ...REPO, base: 'main', cutoff: '2026-06-01T00:00:00Z', maxPages: 3 },
    fetchImpl
  );
  assert.equal(prs.length, 300);
  assert.equal(truncated, true);
  assert.equal(fetchImpl.calls.length, 3);
});

test('rate-limited responses raise a clear error with the reset time', async () => {
  const resetEpoch = 1786709000;
  const fetchImpl = makeFetch([
    [
      '/repos/',
      jsonResponse(
        { message: 'API rate limit exceeded' },
        { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(resetEpoch) } }
      ),
    ],
  ]);
  await assert.rejects(
    () => core.draftReleaseNotes(REPO, fetchImpl),
    (err) => {
      assert.equal(err.name, 'ApiError');
      assert.equal(err.kind, 'rate-limit');
      assert.equal(err.resetAt.getTime(), resetEpoch * 1000);
      assert.match(err.message, /rate limit/);
      assert.match(err.message, /60 requests per hour/);
      assert.match(err.message, /5,000/);
      return true;
    }
  );
});

test('a 403 naming the secondary limit tells the user to wait', async () => {
  const fetchImpl = makeFetch([
    [
      '/repos/',
      jsonResponse(
        { message: 'You have exceeded a secondary rate limit. Please wait a few minutes before you try again.' },
        { status: 403, headers: { 'x-ratelimit-remaining': '42' } }
      ),
    ],
  ]);
  await assert.rejects(
    () => core.draftReleaseNotes(REPO, fetchImpl),
    (err) => {
      assert.equal(err.kind, 'rate-limit-secondary');
      assert.equal(err.retryAfterSeconds, null);
      assert.match(err.message, /403/);
      assert.match(err.message, /[Ww]ait/);
      return true;
    }
  );
});

test('a 403 carrying Retry-After tells the user to wait even without a telling message', async () => {
  const fetchImpl = makeFetch([
    ['/repos/', jsonResponse({ message: 'Forbidden' }, { status: 403, headers: { 'x-ratelimit-remaining': '42', 'retry-after': '45' } })],
  ]);
  await assert.rejects(
    () => core.draftReleaseNotes(REPO, fetchImpl),
    (err) => err.kind === 'rate-limit-secondary' && err.retryAfterSeconds === 45 && /45 seconds/.test(err.message)
  );
});

// Regression: SSO and permission 403s used to be reported as a rate limit, so
// the user was told to wait for something waiting could never fix.
test('a permission 403 reports an access problem, not a rate limit', async () => {
  const fetchImpl = makeFetch([
    [
      '/repos/',
      jsonResponse(
        { message: 'Resource not accessible by personal access token' },
        { status: 403, headers: { 'x-ratelimit-remaining': '42' } }
      ),
    ],
  ]);
  await assert.rejects(
    () => core.draftReleaseNotes(REPO, fetchImpl),
    (err) => {
      assert.equal(err.kind, 'forbidden');
      assert.match(err.message, /403/);
      assert.match(err.message, /token/);
      assert.doesNotMatch(err.message, /[Ww]ait/);
      return true;
    }
  );
});

test('a 403 with an unreadable body is classified as an access problem', async () => {
  const fetchImpl = makeFetch([
    [
      '/repos/',
      {
        status: 403,
        headers: { get: (name) => (name.toLowerCase() === 'x-ratelimit-remaining' ? '42' : null) },
        json: async () => {
          throw new SyntaxError('Unexpected token < in JSON at position 0');
        },
      },
    ],
  ]);
  await assert.rejects(() => core.draftReleaseNotes(REPO, fetchImpl), (err) => err.kind === 'forbidden');
});

test('secondary 429s surface the Retry-After wait time', async () => {
  const fetchImpl = makeFetch([
    [
      '/repos/',
      jsonResponse(
        { message: 'You have exceeded a secondary rate limit' },
        { status: 429, headers: { 'x-ratelimit-remaining': '42', 'retry-after': '30' } }
      ),
    ],
  ]);
  await assert.rejects(
    () => core.draftReleaseNotes(REPO, fetchImpl),
    (err) => {
      assert.equal(err.kind, 'rate-limit-secondary');
      assert.equal(err.retryAfterSeconds, 30);
      assert.match(err.message, /30 seconds/);
      return true;
    }
  );
});

test('401 responses report a rejected token', async () => {
  const fetchImpl = makeFetch([['/repos/', jsonResponse({ message: 'Bad credentials' }, { status: 401 })]]);
  await assert.rejects(
    () => core.draftReleaseNotes(REPO, fetchImpl),
    (err) => err.kind === 'bad-token' && /token/.test(err.message)
  );
});

test('404 suggests adding a token for private repositories', async () => {
  const fetchImpl = makeFetch([['/repos/', jsonResponse({ message: 'Not Found' }, { status: 404 })]]);
  await assert.rejects(
    () => core.draftReleaseNotes(REPO, fetchImpl),
    (err) => err.kind === 'not-found' && /personal access token/.test(err.message)
  );
});

test('draftReleaseNotes end to end: latest release baseline, grouped markdown, 4 calls', async () => {
  const fetchImpl = makeFetch(standardRoutes());
  const result = await core.draftReleaseNotes(REPO, fetchImpl);
  assert.equal(result.baseline.tag, 'v1.2.0');
  // Cutoff is the v1.2.0 tag commit date, not the later published_at.
  assert.equal(result.cutoff, '2026-06-30T22:00:00Z');
  assert.equal(result.truncated, false);
  assert.deepEqual(result.prs.map((p) => p.number), [50, 49, 48, 47, 46]);
  assert.ok(result.markdown.startsWith('## Features'));
  assert.ok(result.markdown.includes('- Add dark mode (#50)'));
  assert.ok(result.markdown.includes('**Full Changelog**: https://github.com/acme/widget/compare/v1.2.0...main'));
  // Budget: repo + releases + tag commit + one pulls page.
  assert.equal(fetchImpl.calls.length, 4);
});

// Regression: a PR merged after the release tag's commit but before the
// release was published used to vanish from the next draft.
test('draftReleaseNotes includes a PR merged between tag creation and publish', async () => {
  const betweenPr = syntheticPr(51, '2026-06-30T23:30:00Z'); // tag at 22:00, published at 00:00 next day
  const fetchImpl = makeFetch([
    ['/repos/acme/widget/releases', loadFixture('releases')],
    ['/commits/tags/v1.2.0', tagCommit('2026-06-30T22:00:00Z')],
    ['/repos/acme/widget/pulls', [betweenPr, ...loadFixture('pulls-page1')]],
    [(url) => url.endsWith('/repos/acme/widget'), loadFixture('repo')],
  ]);
  const result = await core.draftReleaseNotes(REPO, fetchImpl);
  assert.ok(result.prs.some((p) => p.number === 51));
});

// Regression: a release whose tag no longer exists used to abort the draft.
test('draftReleaseNotes still drafts when the baseline tag ref is gone', async () => {
  const fetchImpl = makeFetch([
    ['/repos/acme/widget/releases', loadFixture('releases')],
    ['/commits/', jsonResponse({ message: 'Not Found' }, { status: 404 })],
    ['/repos/acme/widget/pulls', loadFixture('pulls-page1')],
    [(url) => url.endsWith('/repos/acme/widget'), loadFixture('repo')],
  ]);
  const result = await core.draftReleaseNotes(REPO, fetchImpl);
  // Falls back to the release's published_at.
  assert.equal(result.cutoff, '2026-07-01T00:00:00Z');
  assert.deepEqual(result.prs.map((p) => p.number), [50, 49, 48, 47, 46]);
  assert.ok(result.markdown.startsWith('## Features'));
});

// Regression: a permission/SSO 403 on the commit lookup used to be treated like
// a dead tag, so the user got a draft built from the publish date instead of
// being told the token cannot read the repository.
test('draftReleaseNotes surfaces a permission 403 during the cutoff lookup', async () => {
  const fetchImpl = makeFetch([
    ['/repos/acme/widget/releases', loadFixture('releases')],
    [
      '/commits/',
      jsonResponse({ message: 'Resource not accessible by personal access token' }, { status: 403, headers: { 'x-ratelimit-remaining': '42' } }),
    ],
    ['/repos/acme/widget/pulls', loadFixture('pulls-page1')],
    [(url) => url.endsWith('/repos/acme/widget'), loadFixture('repo')],
  ]);
  await assert.rejects(
    () => core.draftReleaseNotes(REPO, fetchImpl),
    (err) => {
      assert.equal(err.kind, 'forbidden');
      assert.match(err.message, /403/);
      return true;
    }
  );
});

test('draftReleaseNotes reuses preloaded data when switching baselines', async () => {
  const fetchImpl = makeFetch(standardRoutes());
  const first = await core.draftReleaseNotes(REPO, fetchImpl);
  const older = first.baselines[1];
  const second = await core.draftReleaseNotes(
    { ...REPO, baseline: older, preloaded: { repoInfo: first.repoInfo, baselines: first.baselines } },
    fetchImpl
  );
  assert.equal(second.baseline.tag, 'v1.1.0');
  assert.deepEqual(second.prs.map((p) => p.number), [50, 49, 48, 47, 46, 44]);
  assert.ok(second.markdown.includes('- Handle unicode titles (#44)'));
  // Redraft costs the older baseline's tag commit plus one pulls call.
  assert.equal(fetchImpl.calls.length, 6);
});

test('draftReleaseNotes with no releases or tags drafts from all merged PRs', async () => {
  const fetchImpl = makeFetch([
    ['/releases', []],
    ['/tags', []],
    ['/pulls', loadFixture('pulls-page1')],
    [(url) => url.endsWith('/repos/acme/widget'), loadFixture('repo')],
  ]);
  const result = await core.draftReleaseNotes(REPO, fetchImpl);
  assert.equal(result.baseline, null);
  assert.equal(result.cutoff, null);
  assert.deepEqual(result.prs.map((p) => p.number), [50, 49, 48, 47, 46, 44, 43]);
  assert.ok(!result.markdown.includes('Full Changelog'));
});

// The content script uses this guard to drop draft responses that resolve
// after a Turbo navigation changed the repo (or unmounted the panel).
test('makeRequestGuard accepts only the newest request for the unchanged repo', () => {
  const guard = core.makeRequestGuard();
  const ticket = guard.begin('acme/widget');
  assert.equal(guard.accept(ticket, 'acme/widget'), true);
  // Navigated to another repo before the response arrived.
  assert.equal(guard.accept(ticket, 'acme/gadget'), false);
  assert.equal(guard.accept(ticket, null), false);
});

test('makeRequestGuard: a newer request supersedes an older in-flight one', () => {
  const guard = core.makeRequestGuard();
  const first = guard.begin('acme/widget');
  const second = guard.begin('acme/widget');
  assert.equal(guard.accept(first, 'acme/widget'), false);
  assert.equal(guard.isCurrent(first), false);
  assert.equal(guard.accept(second, 'acme/widget'), true);
  assert.equal(guard.isCurrent(second), true);
});

test('makeRequestGuard.invalidate drops everything in flight', () => {
  const guard = core.makeRequestGuard();
  const ticket = guard.begin('acme/widget');
  guard.invalidate();
  assert.equal(guard.accept(ticket, 'acme/widget'), false);
  assert.equal(guard.isCurrent(ticket), false);
});
