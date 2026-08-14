/*
 * Generates the extension icons (16, 32, 48, 128) with no dependencies:
 * a supersampled vector scene (rocket on an indigo tile) encoded to PNG by
 * hand via zlib. Run with: npm run icons
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ---------- PNG encoding ----------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(8 + data.length + 4);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const raw = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 4)] = 0; // filter: none
    rgba.copy(raw, y * (1 + width * 4) + 1, y * width * 4, (y + 1) * width * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------- Scene ----------

function hex(c) {
  return [parseInt(c.slice(1, 3), 16) / 255, parseInt(c.slice(3, 5), 16) / 255, parseInt(c.slice(5, 7), 16) / 255];
}

const BG_TOP = hex('#4F46E5');
const BG_BOTTOM = hex('#7C3AED');
const BODY = hex('#FAFAFF');
const TRIM = hex('#C7D2FE');
const GLASS = hex('#312E81');
const FLAME_IN = hex('#FDE68A');
const FLAME_A = hex('#F59E0B');
const FLAME_B = hex('#EF4444');

function lerp3(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function inTriangle(px, py, a, b, c) {
  const s1 = (b[0] - a[0]) * (py - a[1]) - (b[1] - a[1]) * (px - a[0]);
  const s2 = (c[0] - b[0]) * (py - b[1]) - (c[1] - b[1]) * (px - b[0]);
  const s3 = (a[0] - c[0]) * (py - c[1]) - (a[1] - c[1]) * (px - c[0]);
  return (s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0);
}

const STARS = [
  [0.2, 0.16, 0.014],
  [0.82, 0.2, 0.011],
  [0.15, 0.55, 0.009],
  [0.75, 0.82, 0.012],
];

const ROT = Math.SQRT1_2; // cos 45 == sin 45
const SCALE = 1.12;

// Returns [r, g, b] or null for transparent; u, v in [0, 1], v down.
function sample(u, v) {
  // Rounded-square tile.
  const r = 0.21;
  const qx = Math.max(Math.abs(u - 0.5) - (0.5 - r), 0);
  const qy = Math.max(Math.abs(v - 0.5) - (0.5 - r), 0);
  if (Math.hypot(qx, qy) > r) return null;

  let color = lerp3(BG_TOP, BG_BOTTOM, (u + v) / 2);

  for (const [sx, sy, sr] of STARS) {
    if (Math.hypot(u - sx, v - sy) <= sr) color = lerp3(color, [1, 1, 1], 0.85);
  }

  // Rocket frame: tilted 45 degrees, nose to the upper right.
  const dx = u - 0.5;
  const dy = v - 0.5;
  const lx = ((ROT * dx + ROT * dy) * SCALE);
  const ly = ((-ROT * dx + ROT * dy) * SCALE);

  // Flame (drawn first, sits behind the nozzle).
  if (ly > 0.165 && ly < 0.33) {
    const t = (ly - 0.165) / 0.165;
    const hw = 0.058 * Math.pow(1 - t, 0.6);
    if (Math.abs(lx) <= hw) color = lerp3(FLAME_A, FLAME_B, t);
    const hwIn = hw * 0.5;
    if (t < 0.6 && Math.abs(lx) <= hwIn) color = FLAME_IN;
  }

  // Fins.
  if (
    inTriangle(lx, ly, [0.1, 0.0], [0.245, 0.175], [0.1, 0.155]) ||
    inTriangle(lx, ly, [-0.1, 0.0], [-0.245, 0.175], [-0.1, 0.155])
  ) {
    color = TRIM;
  }

  // Nozzle.
  if (ly >= 0.13 && ly <= 0.168) {
    const t = (ly - 0.13) / 0.038;
    if (Math.abs(lx) <= 0.052 + 0.022 * t) color = TRIM;
  }

  // Body: pointed nose easing into straight sides, flat base.
  if (ly >= -0.27 && ly <= 0.13) {
    const t = (ly + 0.27) / 0.4;
    const hw = 0.13 * Math.min(1, Math.pow(t / 0.62, 0.55));
    if (Math.abs(lx) <= hw) color = BODY;
  }

  // Window.
  const wr = Math.hypot(lx, ly + 0.075);
  if (wr <= 0.064) color = TRIM;
  if (wr <= 0.048) color = GLASS;

  return color;
}

function render(size) {
  const SS = 4;
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (x + (sx + 0.5) / SS) / size;
          const v = (y + (sy + 0.5) / SS) / size;
          const c = sample(u, v);
          if (c) {
            r += c[0];
            g += c[1];
            b += c[2];
            a += 1;
          }
        }
      }
      const n = SS * SS;
      const i = (y * size + x) * 4;
      if (a > 0) {
        rgba[i] = Math.round((r / a) * 255);
        rgba[i + 1] = Math.round((g / a) * 255);
        rgba[i + 2] = Math.round((b / a) * 255);
        rgba[i + 3] = Math.round((a / n) * 255);
      }
    }
  }
  return encodePng(size, size, rgba);
}

const outDir = path.join(__dirname, '..', 'icons');
fs.mkdirSync(outDir, { recursive: true });
for (const size of [16, 32, 48, 128]) {
  const file = path.join(outDir, `icon${size}.png`);
  fs.writeFileSync(file, render(size));
  console.log(`wrote ${file}`);
}
