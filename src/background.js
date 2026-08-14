/*
 * Background script: performs all GitHub API requests on behalf of the
 * content script. Keeps the personal access token out of the github.com page
 * context and makes requests independent of the page's CSP and CORS behavior.
 * Runs as a service worker in Chrome and Edge and as a non-persistent event
 * page in Firefox; it holds no state between messages (the token is read
 * from storage on every request), so either lifecycle works.
 */
'use strict';

// Chrome and Edge run this as a service worker, which pulls in core.js via
// importScripts; the Firefox package lists core.js before this file in
// background.scripts instead (event pages have no importScripts).
if (typeof importScripts === 'function') importScripts('core.js');

const ext = globalThis.browser || globalThis.chrome;
const core = self.RRNotes;

ext.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'rr-fetch') return;
  (async () => {
    const url = String(msg.url || '');
    if (!url.startsWith('https://api.github.com/')) {
      sendResponse({ error: 'Blocked request to a non-GitHub URL.' });
      return;
    }
    const { token } = await ext.storage.local.get('token');
    const headers = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    // Firefox's data-collection consent lets the user revoke the
    // authenticationInfo grant after a token was saved; a revoked grant sends
    // the request tokenless rather than transmitting auth data without
    // consent. Chrome and Edge have no data_collection key and always pass.
    if (token && core.hasTokenConsent(await ext.permissions.getAll())) {
      headers.Authorization = 'Bearer ' + token;
    }
    try {
      const res = await fetch(url, { headers });
      const bodyText = await res.text();
      const headerMap = {};
      for (const [name, value] of res.headers) headerMap[name.toLowerCase()] = value;
      sendResponse({ status: res.status, headers: headerMap, bodyText });
    } catch (err) {
      sendResponse({ error: String((err && err.message) || err) });
    }
  })();
  return true;
});
