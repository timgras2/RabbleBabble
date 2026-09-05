import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";

const palette = {
  background: [23, 33, 43, 255],
  accent: [239, 118, 93, 255],
  foreground: [255, 250, 241, 255],
};

function pngFor(size, maskable = false) {
  const pixels = Buffer.alloc((size * 4 + 1) * size);
  const scale = size / 512;
  for (let y = 0; y < size; y += 1) {
    pixels[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x += 1) {
      const sourceX = x / scale;
      const sourceY = y / scale;
      const px = maskable ? 256 + (sourceX - 256) / 0.78 : sourceX;
      const py = maskable ? 256 + (sourceY - 256) / 0.78 : sourceY;
      let color = palette.background;
      const corner = 116;
      const insideRound = maskable || px >= corner && px <= 512 - corner && py >= 0 && py <= 512 ||
        px >= 0 && px <= 512 && py >= corner && py <= 512 - corner ||
        ((px - corner) ** 2 + (py - corner) ** 2 <= corner ** 2) ||
        ((px - (512 - corner)) ** 2 + (py - corner) ** 2 <= corner ** 2) ||
        ((px - corner) ** 2 + (py - (512 - corner)) ** 2 <= corner ** 2) ||
        ((px - (512 - corner)) ** 2 + (py - (512 - corner)) ** 2 <= corner ** 2);
      if (!insideRound) color = [0, 0, 0, 0];
      if ((px - 256) ** 2 + (py - 256) ** 2 <= 154 ** 2) color = palette.accent;
      if (px >= 211 && px <= 301 && py >= 135 && py <= 337 && (px - 256) ** 2 + (Math.max(135 - py, py - 337, 0)) ** 2 <= 45 ** 2) color = palette.foreground;
      const inArc = Math.abs(Math.hypot(px - 256, py - 267) - 92) < 13 && py >= 267 && py <= 366 && px >= 164 && px <= 348;
      const stem = Math.abs(px - 256) < 12.5 && py >= 354 && py <= 420;
      const base = px >= 206 && px <= 306 && py >= 395 && py <= 421;
      if (inArc || stem || base) color = palette.foreground;
      const offset = y * (size * 4 + 1) + 1 + x * 4;
      pixels.set(color, offset);
    }
  }
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const chunk = (type, data) => {
    const typeBuffer = Buffer.from(type);
    const crc = crc32(Buffer.concat([typeBuffer, data]));
    const result = Buffer.alloc(12 + data.length);
    result.writeUInt32BE(data.length, 0);
    typeBuffer.copy(result, 4);
    data.copy(result, 8);
    result.writeUInt32BE(crc, data.length + 8);
    return result;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([signature, chunk("IHDR", header), chunk("IDAT", deflateSync(pixels)), chunk("IEND", Buffer.alloc(0))]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

mkdirSync("src/public/icons", { recursive: true });
writeFileSync("src/public/icons/icon-192.png", pngFor(192));
writeFileSync("src/public/icons/icon-512.png", pngFor(512));
writeFileSync("src/public/icons/icon-192-maskable.png", pngFor(192, true));
writeFileSync("src/public/icons/icon-512-maskable.png", pngFor(512, true));
