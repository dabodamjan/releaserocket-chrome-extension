/*
 * Content script: shows a "Draft release notes" button on GitHub releases
 * pages (the releases list, single release pages, and the new release form)
 * and renders the draft panel. All API traffic goes through the service
 * worker; all UI lives in a shadow root so GitHub styles cannot leak in.
 */
'use strict';

(function () {
  const core = self.RRNotes;
  if (!core) return;

  const ext = globalThis.browser || globalThis.chrome;

  // First path segments that can never be a repository owner.
  const RESERVED_OWNERS = new Set([
    'orgs', 'settings', 'marketplace', 'apps', 'notifications', 'sponsors',
    'topics', 'collections', 'enterprises', 'features', 'codespaces',
    'search', 'pulls', 'issues', 'explore', 'new', 'login', 'about',
  ]);

  function repoFromPath() {
    const parts = location.pathname.split('/').filter(Boolean);
    if (parts.length < 3 || parts[2] !== 'releases') return null;
    if (RESERVED_OWNERS.has(parts[0].toLowerCase())) return null;
    return { owner: parts[0], repo: parts[1] };
  }

  function bgFetch(url) {
    return ext.runtime.sendMessage({ type: 'rr-fetch', url }).then((res) => {
      if (!res) throw new Error('The extension service worker did not respond. Reload the page and try again.');
      if (res.error) throw new Error(res.error);
      return {
        status: res.status,
        headers: { get: (name) => (name.toLowerCase() in res.headers ? res.headers[name.toLowerCase()] : null) },
        json: async () => JSON.parse(res.bodyText),
      };
    });
  }

  const CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; }
    .root { position: fixed; right: 20px; bottom: 20px; z-index: 2147483000; display: flex; flex-direction: column; align-items: flex-end; gap: 10px; }
    .fab { display: inline-flex; align-items: center; gap: 7px; border: none; cursor: pointer; border-radius: 999px; padding: 10px 16px; font-size: 13px; font-weight: 600; color: var(--on-accent); background: linear-gradient(135deg, var(--fab-from), var(--fab-to)); box-shadow: 0 4px 14px var(--accent-glow); }
    .fab:hover { filter: brightness(1.08); }
    .fab svg { width: 15px; height: 15px; display: block; }
    .panel { width: 440px; max-width: calc(100vw - 40px); max-height: calc(100vh - 110px); display: flex; flex-direction: column; background: var(--bg); color: var(--fg); border: 1px solid var(--border); border-radius: 12px; box-shadow: 0 12px 34px rgba(0, 0, 0, 0.25); overflow: hidden; }
    .head { display: flex; align-items: center; gap: 8px; padding: 12px 14px; border-bottom: 1px solid var(--border); }
    .head .title { font-size: 14px; font-weight: 600; }
    .head .repo { font-size: 12px; color: var(--muted); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .iconbtn { border: none; background: none; cursor: pointer; color: var(--muted); font-size: 16px; line-height: 1; padding: 4px; border-radius: 6px; }
    .iconbtn:hover { background: var(--hover); color: var(--fg); }
    .controls { display: flex; align-items: center; gap: 8px; padding: 10px 14px; }
    .controls label { font-size: 12px; color: var(--muted); }
    .controls select { flex: 1; min-width: 0; font-size: 12px; padding: 5px 6px; border-radius: 6px; border: 1px solid var(--border); background: var(--bg); color: var(--fg); }
    .status { padding: 0 14px 8px; font-size: 12px; color: var(--muted); min-height: 16px; }
    .status.error { color: #d1242f; }
    .output { margin: 0 14px; height: 240px; resize: vertical; font-family: ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace; font-size: 12px; line-height: 1.5; padding: 10px; border-radius: 8px; border: 1px solid var(--border); background: var(--codebg); color: var(--fg); white-space: pre; overflow: auto; }
    .actions { display: flex; gap: 8px; padding: 10px 14px; }
    .btn { border: 1px solid var(--border); background: var(--bg); color: var(--fg); cursor: pointer; border-radius: 6px; padding: 6px 12px; font-size: 12px; font-weight: 600; }
    .btn:hover { background: var(--hover); }
    .btn.primary { background: var(--accent); border-color: var(--accent); color: var(--on-accent); }
    .btn.primary:hover { filter: brightness(1.08); background: var(--accent); }
    .btn.linkish { margin-left: auto; border: none; background: none; color: var(--muted); font-weight: 400; }
    .settings { padding: 0 14px 10px; display: flex; flex-direction: column; gap: 6px; }
    .settings .hint { font-size: 11px; color: var(--muted); line-height: 1.4; }
    .foot { padding: 10px 14px; border-top: 1px solid var(--border); font-size: 11.5px; color: var(--muted); line-height: 1.45; }
    .foot .cta { display: inline-block; margin-top: 7px; padding: 6px 12px; border-radius: 6px; background: var(--accent); color: var(--on-accent); text-decoration: none; font-weight: 600; font-size: 12px; }
    .foot .cta:hover { text-decoration: none; filter: brightness(1.08); }
    /* Surfaces stay GitHub-neutral so the panel sits on either GitHub theme;
       the accent is the ReleaseRocket burnt orange (#bc3f15 light / #e66233 dark). */
    .root { --bg: #ffffff; --fg: #1f2328; --muted: #59636e; --border: #d1d9e0; --hover: #f3f4f6; --codebg: #f6f8fa; --accent: #bc3f15; --on-accent: #fff7ee; --fab-from: #bc3f15; --fab-to: #9e340f; --accent-glow: rgba(188, 63, 21, 0.4); }
    .root.dark { --bg: #151b23; --fg: #f0f6fc; --muted: #9198a1; --border: #3d444d; --hover: #1f2733; --codebg: #0d1117; --accent: #e66233; --on-accent: #1c0d04; --fab-from: #ef7a4d; --fab-to: #e66233; --accent-glow: rgba(230, 98, 51, 0.35); }
    .root.dark .status.error { color: #ff7b72; }
    [hidden] { display: none !important; }
  `;

  const ROCKET_SVG = '<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M14.6 1.4c-.3-.3-2.9-.7-5.4 1.8L6.9 5.5l-3 .6a.5.5 0 0 0-.26.85l1.7 1.7-.9 1.8a.5.5 0 0 0 .1.57l.4.4a.5.5 0 0 0 .57.1l1.8-.9 1.7 1.7a.5.5 0 0 0 .85-.26l.6-3 2.3-2.3c2.5-2.5 2.1-5.1 1.8-5.4ZM11.3 5.8a1.1 1.1 0 1 1-1.56-1.56A1.1 1.1 0 0 1 11.3 5.8ZM2.4 11.2c-.9.9-1.2 3-1.3 3.5-.05.2.1.35.3.3.5-.1 2.6-.4 3.5-1.3.5-.5.5-1.3 0-1.8l-.7-.7c-.5-.5-1.3-.5-1.8 0Z"/></svg>';

  let ui = null; // { host, refs, repoKey }
  let session = null; // per-repo cache: { repoInfo, baselines, lastResult }
  let drafting = false;
  // Drops draft responses that resolve after a Turbo navigation changed the
  // repo (or unmounted the panel), so repo A's draft never lands in repo B.
  const draftGuard = core.makeRequestGuard();

  function currentRepoKey() {
    const ref = repoFromPath();
    return ref ? `${ref.owner}/${ref.repo}` : null;
  }

  function el(root, selector) {
    return root.querySelector(selector);
  }

  function isDarkTheme() {
    const mode = document.documentElement.getAttribute('data-color-mode');
    if (mode === 'dark') return true;
    if (mode === 'light') return false;
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  }

  function findReleaseBodyField() {
    return (
      document.querySelector('textarea[name="release[body]"]') ||
      document.getElementById('release_body') ||
      document.querySelector('markdown-toolbar + text-expander textarea')
    );
  }

  function mount(repoRef) {
    if (ui) return;
    const host = document.createElement('div');
    host.setAttribute('data-rr-notes', '');
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>${CSS}</style>
      <div class="root${isDarkTheme() ? ' dark' : ''}">
        <section class="panel" hidden>
          <div class="head">
            <span class="title">Release notes draft</span>
            <span class="repo"></span>
            <button class="iconbtn refresh" title="Refresh data from GitHub" aria-label="Refresh">&#8635;</button>
            <button class="iconbtn close" title="Close" aria-label="Close">&#10005;</button>
          </div>
          <div class="controls">
            <label for="rr-since">Since</label>
            <select id="rr-since"></select>
          </div>
          <div class="status"></div>
          <textarea class="output" spellcheck="false" aria-label="Release notes markdown"></textarea>
          <div class="actions">
            <button class="btn primary copy">Copy markdown</button>
            <button class="btn insert" hidden>Insert into description</button>
            <button class="btn linkish token-toggle">Token</button>
          </div>
          <div class="settings" hidden>
            <div class="hint">The optional GitHub token is managed in the extension popup: click the Release Notes Drafter icon in your browser's toolbar (behind the puzzle or Extensions icon if unpinned). It unlocks private repositories and raises the API limit from 60 to 5,000 requests per hour. The token is entered only in the popup, so it never enters this page.</div>
          </div>
          <div class="foot">Want release notes like these written and published for you automatically? <a class="cta" href="https://releaserocket.io?ref=chrome-extension" target="_blank" rel="noopener">Try ReleaseRocket</a></div>
        </section>
        <button class="fab">${ROCKET_SVG}<span>Draft release notes</span></button>
      </div>
    `;
    document.documentElement.appendChild(host);

    const root = shadow.querySelector('.root');
    const refs = {
      root,
      panel: el(root, '.panel'),
      fab: el(root, '.fab'),
      repoLabel: el(root, '.repo'),
      select: el(root, '#rr-since'),
      status: el(root, '.status'),
      output: el(root, '.output'),
      copyBtn: el(root, '.copy'),
      insertBtn: el(root, '.insert'),
      refreshBtn: el(root, '.refresh'),
      closeBtn: el(root, '.close'),
      tokenToggle: el(root, '.token-toggle'),
      settings: el(root, '.settings'),
    };
    ui = { host, refs, repoKey: `${repoRef.owner}/${repoRef.repo}` };

    refs.repoLabel.textContent = `${repoRef.owner}/${repoRef.repo}`;
    refs.fab.addEventListener('click', () => {
      const open = refs.panel.hidden;
      refs.panel.hidden = !open;
      if (open && !session) draft(undefined);
    });
    refs.closeBtn.addEventListener('click', () => {
      refs.panel.hidden = true;
    });
    refs.refreshBtn.addEventListener('click', () => {
      session = null;
      draft(undefined);
    });
    refs.select.addEventListener('change', () => {
      if (!session) return;
      const value = refs.select.value;
      const baseline = value === 'all' ? null : session.baselines[Number(value)];
      draft(baseline);
    });
    refs.copyBtn.addEventListener('click', copyOutput);
    refs.insertBtn.addEventListener('click', insertOutput);
    refs.tokenToggle.addEventListener('click', () => {
      refs.settings.hidden = !refs.settings.hidden;
    });
  }

  function unmount() {
    if (!ui) return;
    ui.host.remove();
    ui = null;
    session = null;
    draftGuard.invalidate();
    drafting = false;
  }

  function setStatus(text, isError) {
    if (!ui) return;
    ui.refs.status.textContent = text || '';
    ui.refs.status.classList.toggle('error', Boolean(isError));
  }

  function baselineLabel(b) {
    if (!b) return 'All merged pull requests';
    return b.type === 'release' ? `Release ${b.name}` : `Tag ${b.name}`;
  }

  function populateSelect(baselines, chosen) {
    const { select } = ui.refs;
    select.innerHTML = '';
    baselines.forEach((b, i) => {
      const opt = document.createElement('option');
      opt.value = String(i);
      opt.textContent = baselineLabel(b);
      select.appendChild(opt);
    });
    const all = document.createElement('option');
    all.value = 'all';
    all.textContent = baselines.length ? 'All merged pull requests' : 'All merged pull requests (no releases or tags found)';
    select.appendChild(all);
    const idx = chosen ? baselines.indexOf(chosen) : -1;
    select.value = idx >= 0 ? String(idx) : 'all';
  }

  async function draft(baseline) {
    if (!ui || drafting) return;
    const repoRef = repoFromPath();
    if (!repoRef) return;
    const ticket = draftGuard.begin(`${repoRef.owner}/${repoRef.repo}`);
    drafting = true;
    setStatus('Fetching merged pull requests from GitHub...');
    ui.refs.output.value = '';
    try {
      const preloaded = session ? { repoInfo: session.repoInfo, baselines: session.baselines } : {};
      const result = await core.draftReleaseNotes({ owner: repoRef.owner, repo: repoRef.repo, baseline, preloaded }, bgFetch);
      if (!ui || !draftGuard.accept(ticket, currentRepoKey())) return;
      session = { repoInfo: result.repoInfo, baselines: result.baselines, lastResult: result };
      populateSelect(result.baselines, result.baseline);
      ui.refs.output.value = result.markdown;
      const count = result.prs.length;
      if (count === 0) {
        setStatus(`No merged pull requests found since ${result.baseline ? result.baseline.name : 'the beginning'}.`);
      } else {
        let note = `Drafted from ${count} merged pull request${count === 1 ? '' : 's'}`;
        note += result.baseline ? ` since ${baselineLabel(result.baseline).toLowerCase()}.` : '.';
        if (result.truncated) note += ' Stopped after 300 pull requests; the oldest changes may be missing.';
        setStatus(note);
      }
      refreshInsertVisibility();
    } catch (err) {
      if (!ui || !draftGuard.accept(ticket, currentRepoKey())) return;
      setStatus(err && err.message ? err.message : 'Something went wrong. Try again.', true);
    } finally {
      if (draftGuard.isCurrent(ticket)) drafting = false;
    }
  }

  async function copyOutput() {
    const text = ui.refs.output.value;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      flashButton(ui.refs.copyBtn, 'Copied');
    } catch (err) {
      ui.refs.output.focus();
      ui.refs.output.select();
      document.execCommand('copy');
      flashButton(ui.refs.copyBtn, 'Copied');
    }
  }

  // The insert button is useful only when there is a draft AND the page has a
  // release description field; navigation between /releases and /releases/new
  // changes the latter, so sync() re-checks this on every navigation event.
  function refreshInsertVisibility() {
    if (!ui) return;
    ui.refs.insertBtn.hidden = !ui.refs.output.value || !findReleaseBodyField();
  }

  function insertOutput() {
    const text = ui.refs.output.value;
    if (!text) return;
    const field = findReleaseBodyField();
    if (!field) {
      setStatus('No release description field on this page. Open the new release form and try again.', true);
      refreshInsertVisibility();
      return;
    }
    field.value = field.value ? field.value.replace(/\s*$/, '\n\n') + text : text;
    field.dispatchEvent(new Event('input', { bubbles: true }));
    flashButton(ui.refs.insertBtn, 'Inserted');
  }

  function flashButton(btn, label) {
    const original = btn.textContent;
    btn.textContent = label;
    setTimeout(() => {
      btn.textContent = original;
    }, 1500);
  }

  function sync() {
    const repoRef = repoFromPath();
    if (!repoRef) {
      unmount();
      return;
    }
    if (ui && ui.repoKey !== `${repoRef.owner}/${repoRef.repo}`) {
      unmount();
    }
    if (!ui) mount(repoRef);
    refreshInsertVisibility();
  }

  // GitHub navigates with Turbo; also poll the URL as a fallback for
  // navigations that fire no turbo events.
  let lastHref = location.href;
  document.addEventListener('turbo:load', sync);
  window.addEventListener('popstate', sync);
  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      sync();
    }
  }, 1000);
  sync();
})();
