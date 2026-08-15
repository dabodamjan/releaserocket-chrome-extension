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

/*
 * Path-encodes a git ref for /commits/{ref}. Segments are encoded
 * individually so qualified refs ("tags/v1.0", "tags/release/1.0") keep their
 * slashes instead of collapsing into a single %2F-escaped segment.
 */
function encodeRefPath(ref) {
  return String(ref).split('/').map(encodeURIComponent).join('/');
}

function rateLimitMessage(resetAt) {
  let msg = 'GitHub API rate limit reached.';
  if (resetAt) {
    msg += ` It resets at ${resetAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`;
  }
  msg += ' GitHub allows 60 requests per hour without a token and 5,000 with one.';
  return msg;
}

/*
 * Best-effort read of GitHub's `message` field from an error response. Error
 * bodies can be empty or non-JSON (proxies, HTML error pages), and the content
 * script's json() is a JSON.parse over the raw body text, so this never throws.
 */
async function readBodyMessage(res) {
  try {
    const body = await res.json();
    if (typeof body === 'string') return body;
    if (body && typeof body.message === 'string') return body.message;
  } catch (err) {
    /* non-JSON or unreadable body: classify on headers alone */
  }
  return '';
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
    const retryAfter = Number(res.headers.get('retry-after'));
    const retryAfterSeconds = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null;
    // A 403 with quota left is only a secondary rate limit when GitHub says so:
    // Retry-After, or a body message naming the secondary/abuse limit. Plain
    // 403s are permission problems (private repo, missing scope, SSO not
    // authorized) and must not tell the user to wait. 429 always means limiting.
    const message = await readBodyMessage(res);
    const saysSecondary = /secondary rate limit|abuse detection|rate limit/i.test(message);
    if (res.status === 429 || retryAfterSeconds !== null || saysSecondary) {
      const wait = retryAfterSeconds ? `about ${retryAfterSeconds} seconds` : 'a minute or two';
      throw new ApiError(
        'rate-limit-secondary',
        `GitHub is temporarily limiting requests from this connection (HTTP ${res.status}). Wait ${wait}, then try again.`,
        { status: res.status, retryAfterSeconds }
      );
    }
    throw new ApiError(
      'forbidden',
      'GitHub refused this request (HTTP 403). The repository may need a personal access token with access to it; for organizations with SSO the token also has to be authorized for that organization. Add or update it in the extension popup.',
      { status: res.status }
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
      // Qualified ref: GitHub's /commits/{ref} documents "tags/TAG_NAME", so a
      // tag named like a branch (or like a SHA prefix) cannot resolve elsewhere.
      commitRef: r.tag_name ? `tags/${r.tag_name}` : null,
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

// Failures that affect every request in the draft, not just this one lookup.
const FATAL_KINDS = new Set(['rate-limit', 'rate-limit-secondary', 'bad-token', 'forbidden', 'network']);

async function resolveCutoff(baseline, { owner, repo }, fetchImpl) {
  if (!baseline) return null;
  if (baseline.date) return baseline.date;
  if (baseline.commitRef) {
    let data;
    try {
      data = await fetchJson(apiUrl(`/repos/${owner}/${repo}/commits/${encodeRefPath(baseline.commitRef)}`), fetchImpl);
    } catch (err) {
      // A release whose tag was deleted or renamed 404s here. That is a reason
      // to fall back to the release's publish date, not to abort the draft.
      // Rate limits, auth, permission and connectivity failures hit every later
      // call too, so those still propagate.
      if (err instanceof ApiError && FATAL_KINDS.has(err.kind)) throw err;
      baseline.date = baseline.fallbackDate || null;
      return baseline.date;
    }
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

/*
 * A draft that has not settled after this long is treated as wedged. The
 * message port between content script and background script can die without
 * ever rejecting (worker evicted mid-request, extension reloaded under the
 * page), and with no terminal path the panel would stay busy forever: every
 * control off, and the button's isBusy() guard refusing a retry. Generous
 * enough that a slow but live draft (up to 7 GitHub calls) is never cut off.
 */
const DRAFT_TIMEOUT_MS = 45000;
const DRAFT_TIMEOUT_MESSAGE = 'Timed out talking to GitHub. Try again.';

/*
 * Drives one panel's draft lifecycle so the loading state cannot lie.
 *
 *   run(request)      -> Promise of the draft result (injectable for tests)
 *   contextKey()      -> the context the panel is showing (the repo key)
 *   onBusy(busy, req) -> flip the spinner and the disabled controls
 *   onResult / onError(x, req) -> render, exactly one of them, at most once
 *   timeoutMs / setTimer / clearTimer -> watchdog, injectable for tests
 *
 * A newer start() supersedes whatever is in flight: the older response is
 * dropped instead of overwriting the fresher one, and it also leaves the busy
 * state alone so the spinner keeps running for the request that replaced it.
 * The newest request always clears busy, on success and on failure alike, so a
 * failed fetch resolves into the error path rather than a stuck spinner, and a
 * draft that never settles at all is failed by the watchdog after timeoutMs. A
 * response whose context changed under it (Turbo navigated to another repo) is
 * dropped the same way. Render callbacks run outside the fetch's try/catch, so
 * a throw in onResult can never be mistaken for a fetch failure.
 */
function makeDraftRunner({
  run,
  contextKey,
  onBusy,
  onResult,
  onError,
  timeoutMs = DRAFT_TIMEOUT_MS,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (id) => clearTimeout(id),
}) {
  const guard = makeRequestGuard();
  let busy = false;

  /*
   * Fails `work` with the timeout error if it has not settled in time. Once the
   * watchdog has fired, a response that lands later settles a promise nobody
   * awaits any more, so it renders nothing; and if that request had meanwhile
   * been superseded, the guard below drops it for the usual reason instead.
   */
  function withWatchdog(work) {
    if (!(timeoutMs > 0)) return work;
    return new Promise((resolve, reject) => {
      const timer = setTimer(() => reject(new ApiError('timeout', DRAFT_TIMEOUT_MESSAGE)), timeoutMs);
      work.then(
        (value) => {
          clearTimer(timer);
          resolve(value);
        },
        (err) => {
          clearTimer(timer);
          reject(err);
        }
      );
    });
  }

  return {
    isBusy() {
      return busy;
    },
    // Supersedes everything in flight without touching the UI: the caller is
    // tearing that UI down (unmount).
    invalidate() {
      guard.invalidate();
      busy = false;
    },
    async start(request) {
      const ticket = guard.begin(contextKey());
      busy = true;
      onBusy(true, request);
      let outcome;
      try {
        outcome = { ok: true, value: await withWatchdog(Promise.resolve(run(request))) };
      } catch (err) {
        outcome = { ok: false, value: err };
      }
      const accepted = guard.accept(ticket, contextKey());
      const current = guard.isCurrent(ticket);
      if (current) busy = false;
      try {
        if (accepted) {
          if (outcome.ok) onResult(outcome.value, request);
          else onError(outcome.value, request);
        }
      } finally {
        // Unconditional: a bug thrown by a render callback must still take the
        // spinner down rather than leave the panel looking like it is loading.
        if (current) onBusy(false, request);
      }
    },
  };
}

/*
 * Decides what a draft may reuse from the panel's session cache.
 *
 * A refresh has to go back to GitHub for the repo info and the baseline list,
 * so it returns {} ("fetch everything"). It deliberately does NOT clear the
 * session itself: if the refresh fails, the panel still holds the baselines
 * behind the picker it just re-enabled, so changing "Since" keeps working
 * against the data the user can actually see. The session is replaced only
 * when fresh data lands. Every other draft (a baseline switch) reuses the
 * cached repo info and baselines, which keeps a switch down to the PR calls.
 */
function preloadedFor(session, request) {
  if (!session || (request && request.refresh)) return {};
  return { repoInfo: session.repoInfo, baselines: session.baselines };
}

/*
 * Firefox 140+ ships a built-in data-collection consent experience: the
 * manifest declares `authenticationInfo` as an optional category, and the
 * extension must obtain the user's grant (permissions.request, from inside a
 * user-activated handler) before a token is stored, and honor revocation
 * before every later use. Feature detection is the `data_collection` key in
 * permissions.getAll(): Chrome and Edge have no such key, so its absence
 * means "no consent experience — proceed with zero prompts". Both helpers
 * take the getAll() result as a plain object so they run in Node tests.
 */
const TOKEN_CONSENT_PERMISSION = 'authenticationInfo';

function supportsTokenConsent(perms) {
  return Boolean(perms) && typeof perms === 'object' && 'data_collection' in perms;
}

function hasTokenConsent(perms) {
  if (!supportsTokenConsent(perms)) return true;
  return Array.isArray(perms.data_collection) && perms.data_collection.includes(TOKEN_CONSENT_PERMISSION);
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
  makeDraftRunner,
  preloadedFor,
  DRAFT_TIMEOUT_MS,
  DRAFT_TIMEOUT_MESSAGE,
  TOKEN_CONSENT_PERMISSION,
  supportsTokenConsent,
  hasTokenConsent,
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
