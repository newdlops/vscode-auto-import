#!/usr/bin/env node
// Generate resources/icon.png (128x128 RGBA) using only Node stdlib.
// Design: dark card → a blue symbol "chip" flies into a lighter document on the right.

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const W = 128;
const H = 128;

// Palette (GitHub-dark inspired, reads well on both light and dark themes)
const C_OUTER = [0x0d, 0x11, 0x17];
const C_CARD = [0x16, 0x1b, 0x22];
const C_CARD_EDGE = [0x2a, 0x31, 0x3c];
const C_DOC = [0xe6, 0xed, 0xf3];
const C_DOC_EDGE = [0xb3, 0xbc, 0xc9];
const C_DOC_LINE_STRONG = [0x58, 0xa6, 0xff];
const C_DOC_LINE = [0x8b, 0x94, 0x9e];
const C_ARROW = [0x58, 0xa6, 0xff];
const C_CHIP = [0x1f, 0x6f, 0xeb];
const C_CHIP_HL = [0x79, 0xc0, 0xff];

const px = Buffer.alloc(W * H * 4);

function setPx(x, y, rgb, a = 255) {
  if (x < 0 || x >= W || y < 0 || y >= H) return;
  const i = (y * W + x) * 4;
  if (a === 255) {
    px[i] = rgb[0]; px[i + 1] = rgb[1]; px[i + 2] = rgb[2]; px[i + 3] = 255;
    return;
  }
  const alpha = a / 255;
  px[i] = Math.round(px[i] * (1 - alpha) + rgb[0] * alpha);
  px[i + 1] = Math.round(px[i + 1] * (1 - alpha) + rgb[1] * alpha);
  px[i + 2] = Math.round(px[i + 2] * (1 - alpha) + rgb[2] * alpha);
  px[i + 3] = 255;
}

function fillRect(x0, y0, x1, y1, c) {
  for (let y = Math.max(0, y0); y < Math.min(H, y1); y++) {
    for (let x = Math.max(0, x0); x < Math.min(W, x1); x++) setPx(x, y, c);
  }
}

function fillRoundRect(x, y, w, h, r, c) {
  for (let py = y; py < y + h; py++) {
    for (let px_ = x; px_ < x + w; px_++) {
      let dx = 0, dy = 0;
      if (px_ < x + r) dx = x + r - px_;
      else if (px_ >= x + w - r) dx = px_ - (x + w - r - 1);
      if (py < y + r) dy = y + r - py;
      else if (py >= y + h - r) dy = py - (y + h - r - 1);
      // Sub-pixel AA: antialias only on the arc corners
      const dist2 = dx * dx + dy * dy;
      if (dist2 <= (r - 1) * (r - 1)) {
        setPx(px_, py, c);
      } else if (dist2 <= r * r) {
        const d = Math.sqrt(dist2);
        const alpha = Math.max(0, Math.min(1, r - d));
        setPx(px_, py, c, Math.round(alpha * 255));
      }
    }
  }
}

function triangle(points, c) {
  const minY = Math.max(0, Math.floor(Math.min(...points.map((p) => p[1]))));
  const maxY = Math.min(H - 1, Math.ceil(Math.max(...points.map((p) => p[1]))));
  for (let y = minY; y <= maxY; y++) {
    let minX = Infinity, maxX = -Infinity;
    for (let i = 0; i < 3; i++) {
      const [x1, y1] = points[i];
      const [x2, y2] = points[(i + 1) % 3];
      if ((y1 <= y && y2 > y) || (y2 <= y && y1 > y)) {
        const t = (y - y1) / (y2 - y1);
        const x = x1 + t * (x2 - x1);
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
      }
    }
    if (minX === Infinity) continue;
    for (let x = Math.max(0, Math.ceil(minX)); x <= Math.min(W - 1, Math.floor(maxX)); x++) {
      setPx(x, y, c);
    }
  }
}

// --- Compose ---

// Outer dark background
fillRect(0, 0, W, H, C_OUTER);

// Inner card with rounded corners
fillRoundRect(4, 4, W - 8, H - 8, 22, C_CARD_EDGE);
fillRoundRect(6, 6, W - 12, H - 12, 20, C_CARD);

// Document on the right (light, angled feel via offset of top-right "fold")
const docX = 58;
const docY = 24;
const docW = 52;
const docH = 80;
// Subtle drop shadow to separate from card
fillRoundRect(docX + 2, docY + 4, docW, docH, 8, [0x00, 0x00, 0x00]);
fillRoundRect(docX, docY, docW, docH, 8, C_DOC_EDGE);
fillRoundRect(docX + 1, docY + 1, docW - 2, docH - 2, 7, C_DOC);

// Code lines inside the document
const lineX = docX + 8;
const lineW = docW - 16;
const lineWidths = [lineW - 8, lineW - 2, lineW - 14, lineW - 6, lineW - 20];
const lineColors = [
  C_DOC_LINE,
  C_DOC_LINE_STRONG,  // highlighted "just imported" line
  C_DOC_LINE,
  C_DOC_LINE,
  C_DOC_LINE,
];
for (let i = 0; i < lineWidths.length; i++) {
  const ly = docY + 12 + i * 13;
  fillRoundRect(lineX, ly, lineWidths[i], 4, 2, lineColors[i]);
}

// "Chip" (symbol) flying in from top-left toward the highlighted line
const chipX = 18;
const chipY = 26;
fillRoundRect(chipX + 2, chipY + 3, 26, 18, 5, [0x00, 0x00, 0x00]); // shadow
fillRoundRect(chipX, chipY, 26, 18, 5, C_CHIP_HL);
fillRoundRect(chipX + 1, chipY + 1, 24, 16, 4, C_CHIP);
// Tiny bars inside chip (2 short lines) to hint it's a code symbol
fillRoundRect(chipX + 5, chipY + 5, 10, 2, 1, C_CHIP_HL);
fillRoundRect(chipX + 5, chipY + 10, 14, 2, 1, C_CHIP_HL);

// Curved arrow shaft from chip to highlighted doc line
// Implemented as a thick polyline with AA-free edges (acceptable at 128px)
const shaft = [
  [44, 34],
  [48, 40],
  [52, 46],
  [55, 50],
];
// Draw shaft as stacked thick line segments
function thickLine(x0, y0, x1, y1, thickness, c) {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.hypot(dx, dy);
  if (len < 0.5) return;
  const nx = -dy / len;
  const ny = dx / len;
  for (let t = 0; t <= len; t += 0.5) {
    const cx = x0 + (dx * t) / len;
    const cy = y0 + (dy * t) / len;
    for (let s = -thickness / 2; s <= thickness / 2; s += 0.5) {
      const px_ = Math.round(cx + nx * s);
      const py = Math.round(cy + ny * s);
      setPx(px_, py, c);
    }
  }
}
for (let i = 0; i < shaft.length - 1; i++) {
  thickLine(shaft[i][0], shaft[i][1], shaft[i + 1][0], shaft[i + 1][1], 5, C_ARROW);
}

// Arrowhead triangle pointing into the highlighted line
triangle(
  [
    [55, 44],
    [55, 56],
    [67, 50],
  ],
  C_ARROW,
);

// --- Encode PNG ---

function crc32(buf) {
  let table = crc32._t;
  if (!table) {
    table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c;
    }
    crc32._t = table;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0);
ihdr.writeUInt32BE(H, 4);
ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

const stride = W * 4;
const raw = Buffer.alloc(H * (1 + stride));
for (let y = 0; y < H; y++) {
  raw[y * (1 + stride)] = 0;
  px.copy(raw, y * (1 + stride) + 1, y * stride, (y + 1) * stride);
}
const idat = zlib.deflateSync(raw, { level: 9 });

const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const png = Buffer.concat([
  signature,
  chunk('IHDR', ihdr),
  chunk('IDAT', idat),
  chunk('IEND', Buffer.alloc(0)),
]);

const outDir = path.join(__dirname, '..', 'resources');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'icon.png'), png);
console.log(`wrote resources/icon.png (${png.length} bytes, ${W}x${H})`);
