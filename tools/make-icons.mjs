/**
 * Rasterizes the BugPin toolbar icon to the PNG sizes Chrome MV3 requires.
 * Dependency-free: draws into an RGBA buffer and encodes PNG with node:zlib.
 *
 *   node tools/make-icons.mjs
 */
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'icons');
const SIZES = [16, 32, 48, 128];

const ACCENT = [239, 68, 68, 255]; // #ef4444 — same red as a saved pin
const INK = [255, 255, 255, 255];

/** Signed distance helpers, all in 0..1 unit space so every size shares one design. */
const circle = (x, y, cx, cy, r) => Math.hypot(x - cx, y - cy) - r;
const roundedSquare = (x, y, r) => {
  const dx = Math.abs(x - 0.5) - (0.5 - r);
  const dy = Math.abs(y - 0.5) - (0.5 - r);
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - r;
};

/** The pin: a head circle plus a tapering needle down to a point. */
function pinDistance(x, y) {
  const head = circle(x, y, 0.5, 0.38, 0.17);
  const t = Math.min(Math.max((y - 0.38) / 0.42, 0), 1);
  const halfWidth = 0.115 * (1 - t) + 0.008;
  const needle = Math.max(Math.abs(x - 0.5) - halfWidth, 0.38 - y, y - 0.82);
  return Math.min(head, needle);
}

const coverage = (d, feather) => Math.min(Math.max(0.5 - d / feather, 0), 1);

function blend(dst, offset, rgba, alpha) {
  for (let c = 0; c < 3; c++) {
    dst[offset + c] = Math.round(dst[offset + c] * (1 - alpha) + rgba[c] * alpha);
  }
  dst[offset + 3] = Math.round(dst[offset + 3] * (1 - alpha) + rgba[3] * alpha);
}

function renderIcon(size) {
  const px = new Uint8Array(size * size * 4);
  const feather = 1.6 / size;
  for (let py = 0; py < size; py++) {
    for (let pxi = 0; pxi < size; pxi++) {
      const x = (pxi + 0.5) / size;
      const y = (py + 0.5) / size;
      const offset = (py * size + pxi) * 4;
      blend(px, offset, ACCENT, coverage(roundedSquare(x, y, 0.22), feather));
      blend(px, offset, INK, coverage(pinDistance(x, y), feather));
      // Bite out of the pin head, so it reads as a bug's eye rather than a blob.
      blend(px, offset, ACCENT, coverage(circle(x, y, 0.5, 0.38, 0.062), feather));
    }
  }
  return px;
}

function encodePng(px, size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let row = 0; row < size; row++) {
    raw[row * (size * 4 + 1)] = 0; // filter: none
    Buffer.from(px.buffer, row * size * 4, size * 4).copy(raw, row * (size * 4 + 1) + 1);
  }
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

mkdirSync(OUT_DIR, { recursive: true });
for (const size of SIZES) {
  const file = join(OUT_DIR, `icon${size}.png`);
  writeFileSync(file, encodePng(renderIcon(size), size));
  console.log(`wrote ${file}`);
}
