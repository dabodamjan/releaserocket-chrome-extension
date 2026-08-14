/*
 * Core logic for the release notes drafter.
 *
 * Everything here is UI-free and takes an injectable `fetchImpl` so the same
 * code runs in the content script (backed by the extension service worker)
 * and in Node tests (backed by fixture responses).
 *
 * `fetchImpl(url)` must resolve to a Response-like object:
 *   { status: number, headers: { get(name) -> string|null }, json() -> Promise }
 */
'use strict';

const API_ROOT = 'https://api.github.com';

class ApiError extends Error {
  constructor(kind, message, extra = {}) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;
    Object.assign(this, extra);
  }
}

function apiUrl(path, params) {
  const url = new URL(API_ROOT + path);
  if (params) {
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
  }
  return url.toString();
}

function rateLimitMessage(resetAt) {
  let msg = 'GitHub API rate limit reached.';
  if (resetAt) {
    msg += ` It resets at ${resetAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`;
  }
  msg += ' GitHub allows 60 requests per hour without a token and 5,000 with one.';
  return msg;
}

async function fetchJson(url, fetchImpl) {
  let res;
  try {
    res = await fetchImpl(url);
  } catch (err) {
    throw new ApiError('network', 'Could not reach the GitHub API. Check your connection and try again.', { cause: err });
  }
  if (res.status === 403 || res.status === 429) {
    if (res.headers.get('x-ratelimit-remaining') === '0') {
      const reset = Number(res.headers.get('x-ratelimit-reset'));
      const resetAt = Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000) : null;
      throw new ApiError('rate-limit', rateLimitMessage(resetAt), { resetAt });
    }
    // Secondary rate limit: quota not exhausted, GitHub is throttling bursts.
    const retryAfter = Number(res.headers.get('retry-after'));
    const retryAfterSeconds = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null;
    const wait = retryAfterSeconds ? `about ${retryAfterSeconds} seconds` : 'a minute or two';
    throw new ApiError(
      'rate-limit-secondary',
      `GitHub is temporarily limiting requests from this connection (HTTP ${res.status}). Wait ${wait}, then try again.`,
      { status: res.status, retryAfterSeconds }
    );
  }
  if (res.status === 404) {
    throw new ApiError('not-found', 'GitHub returned 404 for this repository. If it is private, add a personal access token in the extension popup.');
  }
  if (res.status === 401) {
    throw new ApiError('bad-token', 'GitHub rejected the saved token. Update or clear it in the extension popup.');
  }
  if (res.status < 200 || res.status >= 300) {
    throw new ApiError('http', `GitHub API error (HTTP ${res.status}).`, { status: res.status });
  }
  return res.json();
}

/*
 * A "baseline" is the point the notes start from: a published release when the
 * repo has releases, otherwise a tag. Both kinds resolve their cutoff lazily
 * from the commit the tag points at (one extra API call, only for the chosen
 * baseline). Releases deliberately do NOT cut off at `published_at`: a release
 * can be published hours or days after its tag was created, and PRs merged in
 * between belong to the NEXT set of notes, so the tag's commit date is the
 * honest boundary. `published_at` is kept only as a fallback.
 */
async function listBaselines({ owner, repo }, fetchImpl) {
  const releases = await fetchJson(apiUrl(`/repos/${owner}/${repo}/releases`, { per_page: 100 }), fetchImpl);
  const published = (Array.isArray(releases) ? releases : []).filter((r) => !r.draft);
  if (published.length) {
    return published.map((r) => ({
      type: 'release',
      name: r.name || r.tag_name,
      tag: r.tag_name,
      date: null,
      commitRef: r.tag_name,
      fallbackDate: r.published_at || r.created_at || null,
    }));
  }
  const tags = await fetchJson(apiUrl(`/repos/${owner}/${repo}/tags`, { per_page: 20 }), fetchImpl);
  return (Array.isArray(tags) ? tags : []).map((t) => ({
    type: 'tag',
    name: t.name,
    tag: t.name,
    date: null,
    commitRef: t.commit ? t.commit.sha : null,
  }));
}

async function resolveCutoff(baseline, { owner, repo }, fetchImpl) {
  if (!baseline) return null;
  if (baseline.date) return baseline.date;
  if (baseline.commitRef) {
    const data = await fetchJson(apiUrl(`/repos/${owner}/${repo}/commits/${encodeURIComponent(baseline.commitRef)}`), fetchImpl);
    const commit = data && data.commit;
    const date = (commit && ((commit.committer && commit.committer.date) || (commit.author && commit.author.date))) || null;
    baseline.date = date || baseline.fallbackDate || null;
    return baseline.date;
  }
  return baseline.fallbackDate || null;
}

/*
 * Lists PRs merged into `base` after `cutoff` (ISO string) or all merged PRs
 * when cutoff is null. Uses the closed-PR list sorted by update time, newest
 * first: any PR merged after the cutoff was necessarily also updated after it,
 * so paging can stop as soon as a page ends below the cutoff. Capped at
 * `maxPages` calls to respect the 60/hour anonymous budget.
 */
async function listMergedPrsSince({ owner, repo, base, cutoff, maxPages = 3 }, fetchImpl) {
  const prs = [];
  const seen = new Set();
  const cutoffTime = cutoff ? Date.parse(cutoff) : null;
  for (let page = 1; page <= maxPages; page++) {
    const batch = await fetchJson(
      apiUrl(`/repos/${owner}/${repo}/pulls`, {
        state: 'closed',
        base,
        sort: 'updated',
        direction: 'desc',
        per_page: 100,
        page,
      }),
      fetchImpl
    );
    // An empty page means the closed-PR list is exhausted, not truncated.
    if (!Array.isArray(batch) || batch.length === 0) return { prs, truncated: false };
    for (const pr of batch) {
      if (!pr.merged_at || seen.has(pr.number)) continue;
      if (cutoffTime !== null && Date.parse(pr.merged_at) <= cutoffTime) continue;
      seen.add(pr.number);
      prs.push(pr);
    }
    const last = batch[batch.length - 1];
    const exhausted = batch.length < 100;
    const pastCutoff = cutoffTime !== null && Date.parse(last.updated_at) < cutoffTime;
    if (exhausted || pastCutoff) return { prs, truncated: false };
  }
  return { prs, truncated: true };
}

/*
 * Guards async responses against navigation races. begin(key) stamps a new
 * request with the context (repo) it was made for and supersedes all earlier
 * ones; accept(ticket, currentKey) is true only for the newest request AND
 * only when the context it was made for is still the current one. invalidate()
 * supersedes everything in flight (call on unmount).
 */
function makeRequestGuard() {
  let seq = 0;
  return {
    begin(key) {
      seq += 1;
      return { seq, key };
    },
    accept(ticket, currentKey) {
      return Boolean(ticket) && ticket.seq === seq && ticket.key === currentKey;
    },
    isCurrent(ticket) {
      return Boolean(ticket) && ticket.seq === seq;
    },
    invalidate() {
      seq += 1;
    },
  };
}

const FIX_LABELS = ['bug', 'fix', 'fixes', 'bugfix', 'hotfix', 'regression'];
const FEATURE_LABELS = ['feature', 'features', 'feat', 'enhancement', 'new feature'];

function classifyPr(pr) {
  const labels = (pr.labels || []).map((l) => String(l && l.name ? l.name : '').toLowerCase());
  if (labels.some((l) => FIX_LABELS.includes(l))) return 'fixes';
  if (labels.some((l) => FEATURE_LABELS.includes(l))) return 'features';
  const title = String(pr.title || '').trim();
  if (/^(fix|fixes|fixed|bugfix|hotfix)\b/i.test(title) || /^fix(\([^)]*\))?!?:/i.test(title)) return 'fixes';
  if (/^(feat|feature)(\([^)]*\))?!?:/i.test(title) || /^(add|adds|added|introduce|implement|support)\b/i.test(title)) return 'features';
  return 'other';
}

function cleanTitle(title) {
  let t = String(title || '').trim();
  const prefix = t.match(/^(feat|feature|fix|bugfix|hotfix|docs|doc|chore|refactor|perf|test|tests|build|ci|style|revert|deps)(\([^)]*\))?!?:\s*/i);
  if (prefix) t = t.slice(prefix[0].length).trim();
  if (t) t = t.charAt(0).toUpperCase() + t.slice(1);
  return t;
}

function groupPrs(prs) {
  const groups = { features: [], fixes: [], other: [] };
  for (const pr of prs) groups[classifyPr(pr)].push(pr);
  const byMergedAt = (a, b) => Date.parse(a.merged_at) - Date.parse(b.merged_at);
  for (const key of Object.keys(groups)) groups[key].sort(byMergedAt);
  return groups;
}

function renderMarkdown({ groups, owner, repo, baseTag, headRef }) {
  const sections = [
    ['Features', 'features'],
    ['Fixes', 'fixes'],
    ['Other changes', 'other'],
  ];
  const out = [];
  for (const [heading, key] of sections) {
    const list = groups[key];
    if (!list || !list.length) continue;
    out.push(`## ${heading}`, '');
    for (const pr of list) out.push(`- ${cleanTitle(pr.title)} (#${pr.number})`);
    out.push('');
  }
  if (!out.length) return '';
  if (baseTag && headRef) {
    out.push(`**Full Changelog**: https://github.com/${owner}/${repo}/compare/${encodeURIComponent(baseTag)}...${encodeURIComponent(headRef)}`);
  }
  return out.join('\n').trim() + '\n';
}

/*
 * End-to-end draft. `baseline` semantics:
 *   undefined -> newest baseline (default), null -> no cutoff (all merged PRs),
 *   otherwise a baseline object from listBaselines().
 * `preloaded` lets the caller reuse repoInfo/baselines across redrafts so a
 * baseline switch costs only the PR-list calls.
 */
async function draftReleaseNotes({ owner, repo, baseline, preloaded = {} }, fetchImpl) {
  const repoInfo = preloaded.repoInfo || (await fetchJson(apiUrl(`/repos/${owner}/${repo}`), fetchImpl));
  const baselines = preloaded.baselines || (await listBaselines({ owner, repo }, fetchImpl));
  const chosen = baseline === undefined ? baselines[0] || null : baseline;
  const cutoff = await resolveCutoff(chosen, { owner, repo }, fetchImpl);
  const head = repoInfo.default_branch || 'main';
  const { prs, truncated } = await listMergedPrsSince({ owner, repo, base: head, cutoff }, fetchImpl);
  const groups = groupPrs(prs);
  const markdown = renderMarkdown({ groups, owner, repo, baseTag: chosen ? chosen.tag : null, headRef: head });
  return { markdown, prs, groups, baselines, baseline: chosen, repoInfo, truncated, cutoff };
}

const RRNotesCore = {
  API_ROOT,
  ApiError,
  apiUrl,
  fetchJson,
  listBaselines,
  resolveCutoff,
  listMergedPrsSince,
  makeRequestGuard,
  classifyPr,
  cleanTitle,
  groupPrs,
  renderMarkdown,
  draftReleaseNotes,
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = RRNotesCore;
}
if (typeof self !== 'undefined') {
  self.RRNotes = RRNotesCore;
}
