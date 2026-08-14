'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const { FILES, GECKO_ID, firefoxManifest, retag, buildEntries, zip, crc32 } = require('../scripts/build-zips.js');

const ROOT = path.join(__dirname, '..');

test('every packaged file exists in the repository', () => {
  for (const rel of FILES) {
    assert.ok(fs.existsSync(path.join(ROOT, rel)), `${rel} missing`);
  }
});

test('firefox manifest gains an event page and gecko settings, and keeps the rest', () => {
  const base = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
  const ff = firefoxManifest(base);
  assert.deepStrictEqual(ff.background.scripts, ['src/background.js']);
  assert.strictEqual(ff.background.service_worker, 'src/background.js');
  assert.strictEqual(ff.browser_specific_settings.gecko.id, GECKO_ID);
  assert.strictEqual(ff.browser_specific_settings.gecko.strict_min_version, '127.0');
  assert.deepStrictEqual(ff.browser_specific_settings.gecko.data_collection_permissions, { required: ['none'] });
  assert.deepStrictEqual(ff.host_permissions, base.host_permissions);
  assert.deepStrictEqual(ff.content_scripts, base.content_scripts);
  assert.strictEqual(base.background.scripts, undefined, 'source manifest must not be mutated');
  assert.strictEqual(base.browser_specific_settings, undefined, 'source manifest must not be mutated');
});

test('the referral tag is rewritten per browser', () => {
  assert.strictEqual(retag('a?ref=chrome-extension"', 'firefox'), 'a?ref=firefox-extension"');
  const get = (browser, name) => String(buildEntries(browser).find((e) => e.name === name).data);
  assert.ok(get('chrome', 'src/content.js').includes('ref=chrome-extension'));
  for (const browser of ['edge', 'firefox']) {
    for (const name of ['src/content.js', 'src/popup.html']) {
      assert.ok(get(browser, name).includes(`ref=${browser}-extension`), `${browser} ${name}`);
      assert.ok(!get(browser, name).includes('ref=chrome-extension'), `${browser} ${name} still has chrome tag`);
    }
  }
});

test('chrome and edge packages carry the repository manifest unchanged', () => {
  const disk = fs.readFileSync(path.join(ROOT, 'manifest.json'));
  for (const browser of ['chrome', 'edge']) {
    const entry = buildEntries(browser).find((e) => e.name === 'manifest.json');
    assert.ok(entry.data.equals(disk), `${browser} manifest differs from manifest.json`);
  }
});

test('crc32 matches known vectors', () => {
  assert.strictEqual(crc32(Buffer.alloc(0)), 0);
  assert.strictEqual(crc32(Buffer.from('The quick brown fox jumps over the lazy dog')), 0x414fa339);
});

test('zip output is a well-formed archive containing every file', () => {
  const entries = buildEntries('firefox');
  const buf = zip(entries);
  assert.strictEqual(buf.readUInt32LE(0), 0x04034b50, 'local file header signature');
  assert.strictEqual(buf.readUInt32LE(buf.length - 22), 0x06054b50, 'end of central directory signature');
  assert.strictEqual(buf.readUInt16LE(buf.length - 22 + 10), FILES.length, 'central directory entry count');

  // Walk the central directory and re-inflate each member against its CRC.
  const byName = new Map(entries.map((e) => [e.name, e.data]));
  let pos = buf.readUInt32LE(buf.length - 22 + 16);
  for (let i = 0; i < FILES.length; i++) {
    assert.strictEqual(buf.readUInt32LE(pos), 0x02014b50, `central header ${i}`);
    const method = buf.readUInt16LE(pos + 10);
    const csize = buf.readUInt32LE(pos + 20);
    const nameLen = buf.readUInt16LE(pos + 28);
    const name = buf.toString('utf8', pos + 46, pos + 46 + nameLen);
    const localOff = buf.readUInt32LE(pos + 42);
    const localNameLen = buf.readUInt16LE(localOff + 26);
    const localExtraLen = buf.readUInt16LE(localOff + 28);
    const bodyStart = localOff + 30 + localNameLen + localExtraLen;
    const body = buf.subarray(bodyStart, bodyStart + csize);
    const restored = method === 8 ? zlib.inflateRawSync(body) : body;
    assert.ok(restored.equals(byName.get(name)), `${name} round-trips`);
    pos += 46 + nameLen;
  }
});
