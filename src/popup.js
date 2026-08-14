'use strict';

const ext = globalThis.browser || globalThis.chrome;

const tokenInput = document.getElementById('token');
const statusEl = document.getElementById('status');

function setStatus(text) {
  statusEl.textContent = text;
}

ext.storage.local.get('token').then(({ token }) => {
  if (token) setStatus('A token is saved.');
});

document.getElementById('save').addEventListener('click', async () => {
  const token = tokenInput.value.trim();
  if (!token) {
    setStatus('Paste a token first.');
    return;
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
