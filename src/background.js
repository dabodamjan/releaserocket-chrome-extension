/*
 * Service worker: performs all GitHub API requests on behalf of the content
 * script. Keeps the personal access token out of the github.com page context
 * and makes requests independent of the page's CSP and CORS behavior.
 */
'use strict';

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.type !== 'rr-fetch') return;
  (async () => {
    const url = String(msg.url || '');
    if (!url.startsWith('https://api.github.com/')) {
      sendResponse({ error: 'Blocked request to a non-GitHub URL.' });
      return;
    }
    const { token } = await chrome.storage.local.get('token');
    const headers = {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (token) headers.Authorization = 'Bearer ' + token;
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
