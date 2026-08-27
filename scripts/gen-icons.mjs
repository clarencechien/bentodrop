// Render public/icons/icon-192.png and icon-512.png from simple shapes.
// Zero-dependency PNG writer (RGBA → deflate → chunks).
import { deflateSync } from "node:zlib";
import { writeFileSync, mkdirSync } from "node:fs";

function crc32(buf) {
  let c, table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (const b of buf) crc = table[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}
function png(width, height, rgba) {
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const COLORS = {
  box: [0xe6, 0xed, 0xea], rice: [0xfc, 0xfb, 0xf7], nori: [0x17, 0x2a, 0x26],
  gogo: [0x00, 0xc2, 0xa8], cell: [0xef, 0xf3, 0xf1], tama: [0xf0, 0xb2, 0x3c], ume: [0xe0, 0x48, 0x3a],
};

function render(size) {
  const px = Buffer.alloc(size * size * 4);
  const put = (x, y, [r, g, b]) => {
    const i = (y * size + x) * 4;
    px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = 255;
  };
  const S = size / 512;
  const inRect = (x, y, rx, ry, rw, rh) => x >= rx * S && x < (rx + rw) * S && y >= ry * S && y < (ry + rh) * S;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let c = COLORS.box;
      if (inRect(x, y, 86, 146, 340, 220)) c = COLORS.nori;          // border
      if (inRect(x, y, 108, 168, 296, 176)) c = COLORS.rice;         // face
      if (inRect(x, y, 108, 168, 110, 176)) c = COLORS.gogo;         // green cell
      if (inRect(x, y, 238, 168, 166, 84)) c = COLORS.cell;
      if (inRect(x, y, 238, 262, 166, 82)) c = COLORS.tama;
      if (inRect(x, y, 248, 88, 16, 336)) c = COLORS.ume;            // rubber band
      put(x, y, c);
    }
  }
  return png(size, size, px);
}

mkdirSync("public/icons", { recursive: true });
writeFileSync("public/icons/icon-192.png", render(192));
writeFileSync("public/icons/icon-512.png", render(512));
console.log("icons written");
