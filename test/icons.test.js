'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const { SIZES, render } = require('../tools/gen-icons.js');

const ICONS_DIR = path.join(__dirname, '..', 'icons');

/*
 * Minimal decoder for the PNGs tools/gen-icons.js emits (8-bit RGBA, filter 0
 * on every row). Comparing decoded pixels instead of file bytes keeps the test
 * stable across zlib versions, whose compressed output may differ for the same
 * image. A committed icon the decoder can't read is by definition not this
 * generator's output, so any decode assertion failing also means "stale".
 */
function decodePng(buf, label) {
  assert.deepStrictEqual(
    [...buf.subarray(0, 8)],
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    `${label}: PNG signature`
  );
  let width = 0;
  let height = 0;
  const idat = [];
  let pos = 8;
  while (pos + 12 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      assert.strictEqual(data[8], 8, `${label}: bit depth`);
      assert.strictEqual(data[9], 6, `${label}: color type RGBA`);
      assert.strictEqual(data[12], 0, `${label}: no interlace`);
    }
    if (type === 'IDAT') idat.push(data);
    pos += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = 1 + width * 4;
  assert.strictEqual(raw.length, height * stride, `${label}: raw scanline length`);
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    assert.strictEqual(raw[y * stride], 0, `${label}: row ${y} filter type`);
    raw.copy(pixels, y * width * 4, y * stride + 1, (y + 1) * stride);
  }
  return { width, height, pixels };
}

// The store zips package icons/*.png as committed, so a palette or scene edit
// in tools/gen-icons.js without `npm run icons` would ship stale artwork.
test('committed icon PNGs match the current generator output', () => {
  for (const size of SIZES) {
    const file = `icons/icon${size}.png`;
    const committed = decodePng(fs.readFileSync(path.join(ICONS_DIR, `icon${size}.png`)), file);
    const fresh = decodePng(render(size), `render(${size})`);
    assert.strictEqual(committed.width, size, `${file}: width`);
    assert.strictEqual(committed.height, size, `${file}: height`);
    assert.ok(
      committed.pixels.equals(fresh.pixels),
      `${file} is stale: run \`npm run icons\` and commit the regenerated PNGs`
    );
  }
});
