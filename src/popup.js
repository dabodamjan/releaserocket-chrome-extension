'use strict';

const ext = globalThis.browser || globalThis.chrome;
const core = self.RRNotes;

const tokenInput = document.getElementById('token');
const statusEl = document.getElementById('status');

function setStatus(text) {
  statusEl.textContent = text;
}

// Firefox 140+ data-collection consent, detected once at popup load so the
// Save click can call permissions.request() as its first await: the request
// must run inside the user-activated handler, and a getAll() await before it
// could end that activation. Chrome and Edge never prompt. If Save is somehow
// clicked before detection resolves, the token is stored ungranted and the
// background's per-request consent check keeps it off the wire.
let consentSupported = false;
ext.permissions.getAll().then((perms) => {
  consentSupported = core.supportsTokenConsent(perms);
});

ext.storage.local.get('token').then(({ token }) => {
  if (token) setStatus('A token is saved.');
});

document.getElementById('save').addEventListener('click', async () => {
  const token = tokenInput.value.trim();
  if (!token) {
    setStatus('Paste a token first.');
    return;
  }
  if (consentSupported) {
    // Requesting an already-granted permission resolves true without a
    // prompt, so no pre-check is needed here.
    const granted = await ext.permissions.request({ data_collection: [core.TOKEN_CONSENT_PERMISSION] });
    if (!granted) {
      setStatus('Token not saved: Firefox needs that permission to send the token to api.github.com. Click Save to try again.');
      return;
    }
  }
  await ext.storage.local.set({ token });
  tokenInput.value = '';
  setStatus('Token saved.');
});

document.getElementById('clear').addEventListener('click', async () => {
  await ext.storage.local.remove('token');
  tokenInput.value = '';
  setStatus('Token cleared.');
});
