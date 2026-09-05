import { deflateSync } from "node:zlib";
import { mkdirSync, writeFileSync } from "node:fs";

// The icon is drawn in a 512x512 design space with signed distance fields, so every
// size gets analytic anti-aliasing instead of the stair-stepped edges a per-pixel
// hit test produces. Colours follow the app palette: warm coral ground, cream mark.
const CORNER_RADIUS = 112;
const MASKABLE_SAFE_SCALE = 0.8;
const GLYPH_SCALE = 0.92;

const gradientStart = [246, 143, 116];
const gradientEnd = [214, 74, 55];
const mark = [255, 250, 241];

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function distanceToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  const t = lengthSquared === 0 ? 0 : clamp(((px - ax) * dx + (py - ay) * dy) / lengthSquared, 0, 1);
  return Math.hypot(px - (ax + dx * t), py - (ay + dy * t));
}

function roundedSquareDistance(px, py, half, radius) {
  const qx = Math.abs(px - 256) - half + radius;
  const qy = Math.abs(py - 256) - half + radius;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
}

// Microphone: a capsule head over a U-shaped cradle, a stem and a base bar.
const arcPoints = [];
for (let step = 0; step <= 96; step += 1) {
  const angle = (Math.PI * step) / 96;
  arcPoints.push([256 - 104 * Math.cos(angle), 268 + 104 * Math.sin(angle)]);
}

function markDistance(px, py) {
  const x = 256 + (px - 256) / GLYPH_SCALE;
  const y = 256 + (py - 258) / GLYPH_SCALE;
  let distance = distanceToSegment(x, y, 256, 140, 256, 286) - 46;
  for (let index = 0; index < arcPoints.length - 1; index += 1) {
    const [ax, ay] = arcPoints[index];
    const [bx, by] = arcPoints[index + 1];
    distance = Math.min(distance, distanceToSegment(x, y, ax, ay, bx, by) - 13);
  }
  distance = Math.min(distance, distanceToSegment(x, y, 256, 372, 256, 410) - 13);
  distance = Math.min(distance, distanceToSegment(x, y, 206, 410, 306, 410) - 13);
  return distance * GLYPH_SCALE;
}

function pngFor(size, maskable = false) {
  const pixels = Buffer.alloc((size * 4 + 1) * size);
  const scale = size / 512;
  // Maskable icons bleed to the edge and keep their content inside the 80% safe zone;
  // "any" icons carry their own rounded corners because nothing masks them.
  const contentScale = maskable ? MASKABLE_SAFE_SCALE : 1;
  for (let y = 0; y < size; y += 1) {
    pixels[y * (size * 4 + 1)] = 0;
    for (let x = 0; x < size; x += 1) {
      const px = (x + 0.5) / scale;
      const py = (y + 0.5) / scale;
      const groundDistance = maskable
        ? -1
        : roundedSquareDistance(px, py, 256, CORNER_RADIUS);
      const groundAlpha = clamp(0.5 - groundDistance * scale, 0, 1);

      const gx = 256 + (px - 256) / contentScale;
      const gy = 256 + (py - 256) / contentScale;
      const t = clamp((gx + gy) / 1024, 0, 1);
      const ground = [
        Math.round(gradientStart[0] + (gradientEnd[0] - gradientStart[0]) * t),
        Math.round(gradientStart[1] + (gradientEnd[1] - gradientStart[1]) * t),
        Math.round(gradientStart[2] + (gradientEnd[2] - gradientStart[2]) * t),
      ];
      const markAlpha = clamp(0.5 - markDistance(gx, gy) * contentScale * scale, 0, 1);

      const alpha = groundAlpha;
      const color = [
        Math.round(ground[0] + (mark[0] - ground[0]) * markAlpha),
        Math.round(ground[1] + (mark[1] - ground[1]) * markAlpha),
        Math.round(ground[2] + (mark[2] - ground[2]) * markAlpha),
      ];

      const offset = y * (size * 4 + 1) + 1 + x * 4;
      pixels[offset] = color[0];
      pixels[offset + 1] = color[1];
      pixels[offset + 2] = color[2];
      pixels[offset + 3] = Math.round(alpha * 255);
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
writeFileSync("src/public/icons/apple-touch-icon.png", pngFor(180, true));
