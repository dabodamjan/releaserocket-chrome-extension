# Release Notes Drafter by ReleaseRocket

Chrome extension that drafts release notes from merged pull requests, right on GitHub's releases pages. One click collects the PRs merged since your last release, groups them into features, fixes, and other changes, and gives you clean markdown to copy or insert into the release form.

Made by [ReleaseRocket](https://releaserocket.io), the service that writes and publishes release notes for you automatically.

## What it does

- Adds a "Draft release notes" button to every GitHub releases page (`/releases`, `/releases/new`, and single release pages).
- Finds the pull requests merged into the default branch since the latest release (or since any release or tag you pick, or all merged PRs).
- Groups them by labels and title conventions: `bug`/`fix` labels and `fix:` titles become Fixes, `feature`/`enhancement` labels and `feat:`/"Add ..." titles become Features, everything else lands in Other changes.
- Renders grouped markdown with a Full Changelog compare link, ready to copy. On the new release form it can also insert the draft straight into the description field.
- Works without any login or token on public repositories. An optional personal access token unlocks private repositories and a higher API limit.

## Install (load unpacked)

1. Clone or download this repository.
2. Open `chrome://extensions` in Chrome.
3. Turn on "Developer mode" (top right).
4. Click "Load unpacked" and select the repository folder (the one containing `manifest.json`).
5. Open any GitHub repository's Releases page. The "Draft release notes" button appears in the bottom right corner.

No build step. The extension runs as plain files from this folder.

## Optional: personal access token

Public repositories work without a token, limited by GitHub to 60 anonymous API requests per hour per IP address. A draft costs 4 to 7 requests, so heavy use or shared networks can hit the limit. Adding a token raises the limit to 5,000 requests per hour and makes private repositories work.

Add it in the extension popup (click the extension icon); the panel's "Token" button points there. The token is entered only in the popup, an extension-owned page, so it never enters the github.com page context — page scripts cannot see it, and the service worker attaches it to API requests outside the page. A fine-grained token with read access to contents and pull requests is enough. The token is stored in `chrome.storage.local` on your device and is sent only to `api.github.com`.

## How it works

All GitHub API calls go through the extension's service worker to `api.github.com`. A draft makes these requests:

1. Repository info, for the default branch.
2. The release list (falls back to the tag list when a repo has tags but no releases).
3. One commit lookup for the chosen baseline, to resolve its cutoff date. Releases cut off at their tag's commit date rather than the publish date, so PRs merged between tagging and publishing land in the next draft instead of vanishing.
4. One to three pages of closed pull requests on the default branch, newest first, stopping as soon as it has passed the chosen baseline date.

The extension itself makes network requests only to `api.github.com` and collects nothing. The panel and popup footer contain an ordinary link to releaserocket.io (tagged `?ref=chrome-extension`), which loads nothing unless you click it.

## Known limits

- Only PRs merged into the default branch are listed.
- Paging stops after 300 pull requests; the panel says so when that happens.
- The baseline picker shows the 100 most recent releases (drafts excluded) or, when a repo has no releases, the 20 most recent tags. When releases exist, tags are not offered as baselines — a design tradeoff to keep every draft within a fixed request budget.
- Cutoffs are timestamp-based, not ancestry-based. A lightweight tag whose commit carries a backdated timestamp can make the draft include more PRs than actually landed after that tag.
- Direct pushes to the default branch are invisible to it; the draft is built from merged PRs only.

## Project layout

```
manifest.json        Extension manifest (MV3)
src/core.js          All drafting logic: baselines, PR listing, grouping, markdown. UI-free and test-covered.
src/content.js       Releases-page button and panel (shadow DOM), talks to the service worker.
src/background.js    Service worker: performs the api.github.com requests, attaches the token.
src/popup.html/js    Toolbar popup: short instructions and token management.
icons/               Generated icons.
tools/gen-icons.js   Icon generator (no dependencies). Run: npm run icons
test/                Node test suite with fixture API responses. Run: npm test
STORE_LISTING.md     Draft Chrome Web Store listing copy.
```

## Development

- `npm test` runs the test suite (Node's built-in runner, no dependencies to install).
- `npm run check` syntax-checks every script and the manifest.
- `npm run icons` regenerates the icons.

After editing files, click the reload icon on the extension card in `chrome://extensions` and refresh the GitHub tab.
