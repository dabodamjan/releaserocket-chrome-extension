# Chrome Web Store listing draft

Ready to paste at submission. Screenshots still need to be taken from the live extension (suggested: the panel with a real draft on a releases page, the popup, the inserted result on the new release form).

## Title

Release Notes Drafter by ReleaseRocket

## Short description

Draft grouped release notes from merged pull requests, right on GitHub's releases pages.

## Category

Developer Tools

## Full description

Cutting a release and writing the notes by hand? This extension drafts them for you, right where you already are.

On any GitHub releases page you get a "Draft release notes" button. One click collects the pull requests merged since your last release and turns them into clean markdown, grouped into Features, Fixes, and Other changes, with a Full Changelog compare link at the end. Copy it, or insert it straight into the description field on the new release form.

What it does:

- Drafts from the pull requests merged into the default branch since the latest release
- Lets you pick a different starting point: any recent release or tag, or all merged PRs
- Groups entries using PR labels (bug, enhancement, and similar) and title conventions (fix:, feat:, "Add ...")
- Cleans up conventional-commit prefixes so the notes read well
- Copies the markdown, or inserts it into the release form
- Works on public repositories with no account and no setup

For private repositories, or if you draft often, you can add a GitHub personal access token. Without one, GitHub allows 60 anonymous API requests per hour per IP address; a draft costs 3 to 6. A token raises the limit to 5,000. The token stays in Chrome's local storage on your machine and is sent only to api.github.com.

The extension talks only to the GitHub API. No analytics, no tracking, no other requests.

Made by ReleaseRocket (https://releaserocket.io). If you want release notes written and published for you automatically, that is what ReleaseRocket does.

## Permission justifications

**Host permission, api.github.com:** the extension reads releases, tags, and merged pull requests from the GitHub API to build the draft. This is its single purpose. No other host is contacted.

**storage:** stores one optional value, the user's GitHub personal access token, in chrome.storage.local so private repositories work and the API limit is higher. Nothing else is stored.

**Content script on github.com:** shows the "Draft release notes" button and panel on releases pages. It does not read page content beyond the URL (to identify the repository), the page theme, and the release form's description field when the user clicks "Insert into description".

## Single purpose statement

Drafts release notes from a repository's merged pull requests on GitHub releases pages.

## Data usage disclosure

- No user data is collected or transmitted to the developer.
- No analytics or tracking of any kind.
- The optional personal access token is stored locally in Chrome and sent only to api.github.com with the user's API requests.
