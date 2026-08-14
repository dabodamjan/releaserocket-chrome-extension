'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const core = require('../src/core.js');
const { makeFetch, jsonResponse, loadFixture } = require('./helpers.js');

const REPO = { owner: 'acme', repo: 'widget' };

function standardRoutes() {
  return [
    ['/repos/acme/widget/releases', loadFixture('releases')],
    ['/repos/acme/widget/tags', loadFixture('tags')],
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
  assert.equal(baselines[0].date, '2026-07-01T00:00:00Z');
  assert.equal(baselines[1].name, 'Spring release');
  assert.equal(fetchImpl.calls.length, 1);
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
  assert.equal(baselines[0].commitSha, 'abc123def4567890abc123def4567890abc123de');
});

test('resolveCutoff: releases already carry their date, no extra call', async () => {
  const fetchImpl = makeFetch(standardRoutes());
  const cutoff = await core.resolveCutoff({ type: 'release', tag: 'v1.2.0', date: '2026-07-01T00:00:00Z' }, REPO, fetchImpl);
  assert.equal(cutoff, '2026-07-01T00:00:00Z');
  assert.equal(fetchImpl.calls.length, 0);
});

test('resolveCutoff: tags resolve through the tagged commit and cache the date', async () => {
  const fetchImpl = makeFetch(standardRoutes());
  const baseline = { type: 'tag', tag: 'v0.9.0', date: null, commitSha: 'abc123def4567890abc123def4567890abc123de' };
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

test('secondary 403s without an exhausted quota are not reported as rate limits', async () => {
  const fetchImpl = makeFetch([
    ['/repos/', jsonResponse({ message: 'Forbidden' }, { status: 403, headers: { 'x-ratelimit-remaining': '42' } })],
  ]);
  await assert.rejects(
    () => core.draftReleaseNotes(REPO, fetchImpl),
    (err) => err.kind === 'http' && /403/.test(err.message)
  );
});

test('404 suggests adding a token for private repositories', async () => {
  const fetchImpl = makeFetch([['/repos/', jsonResponse({ message: 'Not Found' }, { status: 404 })]]);
  await assert.rejects(
    () => core.draftReleaseNotes(REPO, fetchImpl),
    (err) => err.kind === 'not-found' && /personal access token/.test(err.message)
  );
});

test('draftReleaseNotes end to end: latest release baseline, grouped markdown, 3 calls', async () => {
  const fetchImpl = makeFetch(standardRoutes());
  const result = await core.draftReleaseNotes(REPO, fetchImpl);
  assert.equal(result.baseline.tag, 'v1.2.0');
  assert.equal(result.cutoff, '2026-07-01T00:00:00Z');
  assert.equal(result.truncated, false);
  assert.deepEqual(result.prs.map((p) => p.number), [50, 49, 48, 47, 46]);
  assert.ok(result.markdown.startsWith('## Features'));
  assert.ok(result.markdown.includes('- Add dark mode (#50)'));
  assert.ok(result.markdown.includes('**Full Changelog**: https://github.com/acme/widget/compare/v1.2.0...main'));
  // Budget: repo + releases + one pulls page.
  assert.equal(fetchImpl.calls.length, 3);
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
  // Only one extra pulls call for the redraft.
  assert.equal(fetchImpl.calls.length, 4);
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
