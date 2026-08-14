/*
 * Builds store-ready packages into dist/: one zip each for Chrome, Edge, and
 * Firefox, plus an unpacked dist/firefox/ directory for about:debugging.
 * No dependencies; the zip container is written by hand (deflate via zlib).
 *
 * The repository's manifest.json stays the Chrome manifest. Edge uses it
 * unchanged. Firefox gets a patched copy: a background event page (Firefox
 * has no MV3 service workers) and browser_specific_settings.gecko. The
 * releaserocket.io ?ref= tag is rewritten per browser so store installs are
 * attributable. Details and sources: PORTS.md.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');

const FILES = [
  'manifest.json',
  'src/background.js',
  'src/content.js',
  'src/core.js',
  'src/popup.html',
  'src/popup.js',
  'icons/icon16.png',
  'icons/icon32.png',
  'icons/icon48.png',
  'icons/icon128.png',
];

const GECKO_ID = 'release-notes-drafter@releaserocket.io';

function firefoxManifest(manifest) {
  const out = JSON.parse(JSON.stringify(manifest));
  // Firefox runs the same file as a non-persistent event page; Chrome 121+
  // ignores "scripts", Firefox 121+ ignores "service_worker", so declaring
  // both is the MDN-recommended cross-browser form.
  out.background = {
    scripts: [manifest.background.service_worker],
    service_worker: manifest.background.service_worker,
  };
  out.browser_specific_settings = {
    gecko: {
      // An explicit id is mandatory for MV3 signing on AMO.
      id: GECKO_ID,
      // Firefox 127 is the first release whose install prompt shows (and
      // grants) MV3 host permissions; on older versions the extension looks
      // broken until the user opts in through the extensions panel.
      strict_min_version: '127.0',
      // Mandatory for new AMO submissions since 2025-11-03. Nothing leaves
      // the device except the user's own API requests to api.github.com.
      data_collection_permissions: { required: ['none'] },
    },
  };
  return out;
}

function retag(text, browser) {
  return text.replace(/ref=chrome-extension/g, `ref=${browser}-extension`);
}

function buildEntries(browser) {
  return FILES.map((rel) => {
    let data = fs.readFileSync(path.join(ROOT, rel));
    if (rel === 'manifest.json' && browser === 'firefox') {
      data = Buffer.from(`${JSON.stringify(firefoxManifest(JSON.parse(String(data))), null, 2)}\n`);
    } else if (browser !== 'chrome' && (rel.endsWith('.js') || rel.endsWith('.html'))) {
      data = Buffer.from(retag(String(data), browser));
    }
    return { name: rel, data };
  });
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Fixed timestamp (2026-01-01 00:00) keeps the zips byte-identical across
// rebuilds of the same sources.
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (1 << 5) | 1;

function zip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const stored = deflated.length >= data.length;
    const body = stored ? data : deflated;
    const method = stored ? 0 : 8;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuf, body);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(DOS_TIME, 12);
    central.writeUInt16LE(DOS_DATE, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);

    offset += local.length + nameBuf.length + body.length;
  }
  const centralBuf = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, eocd]);
}

function main() {
  const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  const dist = path.join(ROOT, 'dist');
  fs.rmSync(dist, { recursive: true, force: true });
  fs.mkdirSync(dist);
  for (const browser of ['chrome', 'edge', 'firefox']) {
    const entries = buildEntries(browser);
    const zipName = `release-notes-drafter-${version}-${browser}.zip`;
    fs.writeFileSync(path.join(dist, zipName), zip(entries));
    console.log(`dist/${zipName}  (${entries.length} files)`);
  }
  for (const { name, data } of buildEntries('firefox')) {
    const dest = path.join(dist, 'firefox', name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, data);
  }
  console.log('dist/firefox/  (unpacked, for about:debugging temporary install)');
}

if (require.main === module) main();

module.exports = { FILES, GECKO_ID, firefoxManifest, retag, buildEntries, zip, crc32 };
