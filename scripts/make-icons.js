'use strict';
// Piirtää tray-kuvakkeet (assets/tray.png 16 px ja assets/tray@2x.png 32 px) sovelluksen turkoosista pylväslogosta (src/renderer/index.html, 32x32). Lisäksi asennuspaketin ikoni: build/icon.ico (16–256 px, PNG-pakattu ICO) ja build/icon.png (256 px).
// Ei riippuvuuksia: PNG kirjoitetaan käsin (zlib). Ajo: node scripts/make-icons.js
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const OUT = path.join(__dirname, '..', 'assets');
// Logon muodot 32x32-koordinaatistossa: [x, y, w, h, säde, väri]
const SHAPES = [
  [0, 0, 32, 32, 8, [0x0f, 0x2f, 0x2c]],
  [6, 17, 5, 9, 1.5, [0x14, 0xb8, 0xa6]],
  [13.5, 11, 5, 15, 1.5, [0x14, 0xb8, 0xa6]],
  [21, 5, 5, 21, 1.5, [0x5e, 0xea, 0xd4]],
];
function inside(px, py, [x, y, w, h, r]) {
  if (px < x || py < y || px >= x + w || py >= y + h) return false;
  const cx = px < x + r ? x + r : px > x + w - r ? x + w - r : px;
  const cy = py < y + r ? y + r : py > y + h - r ? y + h - r : py;
  return (px - cx) ** 2 + (py - cy) ** 2 <= r * r;
}
function render(size) {
  const SS = 8; // alinäytteitä per akseli (reunojen pehmennys)
  const k = 32 / size;
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // suodatin: ei mitään
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) for (let sx = 0; sx < SS; sx++) {
        const px = (x + (sx + 0.5) / SS) * k, py = (y + (sy + 0.5) / SS) * k;
        let hit = null;
        for (const s of SHAPES) if (inside(px, py, s)) hit = s[5];
        if (hit) { r += hit[0]; g += hit[1]; b += hit[2]; a += 1; }
      }
      const n = SS * SS, o = y * (size * 4 + 1) + 1 + x * 4;
      raw[o] = a ? Math.round(r / a) : 0; raw[o + 1] = a ? Math.round(g / a) : 0; raw[o + 2] = a ? Math.round(b / a) : 0; raw[o + 3] = Math.round((a / n) * 255);
    }
  }
  return raw;
}
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (buf) => { let c = 0xffffffff; for (const v of buf) c = CRC[(c ^ v) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6; // 8 bit, RGBA
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(render(size), { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

fs.mkdirSync(OUT, { recursive: true });
for (const [name, size] of [['tray.png', 16], ['tray@2x.png', 32]]) {
  fs.writeFileSync(path.join(OUT, name), png(size));
  console.log(`kirjoitettu assets/${name} (${size}x${size})`);
}

// Asennuspaketin ikoni (electron-builder: build/icon.ico). ICO-tiedosto sisältää PNG-kuvat (Windows Vista+).
const BUILD = path.join(__dirname, '..', 'build');
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
function ico(sizes) {
  const images = sizes.map((s) => png(s));
  const head = Buffer.alloc(6 + 16 * sizes.length);
  head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(sizes.length, 4);
  let offset = head.length;
  sizes.forEach((s, i) => {
    const o = 6 + 16 * i;
    head[o] = s >= 256 ? 0 : s; head[o + 1] = s >= 256 ? 0 : s; // 0 = 256
    head.writeUInt16LE(1, o + 4); head.writeUInt16LE(32, o + 6); // tasoja, bittiä/pikseli
    head.writeUInt32LE(images[i].length, o + 8); head.writeUInt32LE(offset, o + 12);
    offset += images[i].length;
  });
  return Buffer.concat([head, ...images]);
}
fs.mkdirSync(BUILD, { recursive: true });
fs.writeFileSync(path.join(BUILD, 'icon.png'), png(256));
fs.writeFileSync(path.join(BUILD, 'icon.ico'), ico(ICO_SIZES));
console.log('kirjoitettu build/icon.png (256x256) ja build/icon.ico (' + ICO_SIZES.join(', ') + ' px)');
