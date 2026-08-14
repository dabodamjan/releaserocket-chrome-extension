'use strict';

/*
 * Loaded as a plain script by popup.html; also require()d by test/popup.test.js,
 * which injects fake ext/core/doc — keep initPopup free of browser globals.
 */
function initPopup({ ext, core, doc }) {
  const tokenInput = doc.getElementById('token');
  const statusEl = doc.getElementById('status');
  const saveBtn = doc.getElementById('save');

  function setStatus(text) {
    statusEl.textContent = text;
  }

  // Firefox 140+ data-collection consent, detected once at popup load so the
  // Save click can call permissions.request() as its first await: the request
  // must run inside the user-activated handler, and a getAll() await before it
  // could end that activation. Chrome and Edge never prompt. Save stays
  // disabled (markup + here) until detection settles, so a token can never be
  // stored without the consent path having run; if getAll() fails, consent may
  // be required but can't be requested, so saving stays off (the background's
  // per-request check would keep such a token off the wire anyway).
  let consent = 'pending'; // 'pending' | 'prompt' | 'no-prompt' | 'unavailable'
  saveBtn.disabled = true;
  const detection = ext.permissions.getAll().then(
    (perms) => {
      consent = core.supportsTokenConsent(perms) ? 'prompt' : 'no-prompt';
      saveBtn.disabled = false;
    },
    () => {
      consent = 'unavailable';
      setStatus('Token saving is unavailable: the browser did not report its permission state. Close and reopen this popup to retry.');
    }
  );

  // Chained after detection so it can never race past the fail-closed
  // 'unavailable' status; the consent guard keeps that failure sticky.
  const ready = detection
    .then(() => ext.storage.local.get('token'))
    .then(({ token }) => {
      if (token && consent !== 'unavailable') setStatus('A token is saved.');
    });

  saveBtn.addEventListener('click', async () => {
    // The button is disabled in these states; this guards programmatic clicks.
    if (consent !== 'prompt' && consent !== 'no-prompt') return;
    const token = tokenInput.value.trim();
    if (!token) {
      setStatus('Paste a token first.');
      return;
    }
    if (consent === 'prompt') {
      // First await in the handler (user activation, see above). Requesting an
      // already-granted permission resolves true without a prompt, so no
      // pre-check is needed here.
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

  doc.getElementById('clear').addEventListener('click', async () => {
    await ext.storage.local.remove('token');
    tokenInput.value = '';
    setStatus('Token cleared.');
  });

  return ready;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { initPopup };
}
if (typeof document !== 'undefined') {
  initPopup({ ext: globalThis.browser || globalThis.chrome, core: self.RRNotes, doc: document });
}
