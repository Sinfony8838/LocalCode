import { deflateSync } from 'node:zlib';

// Synthetic geometry only. Keep acceptance independent of private character art
// and of the skill's PNG encoder so Electron also checks a separate PNG producer.
export function syntheticPetAtlas() {
  const width = 1536, height = 2288, stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);
  for (let row = 0; row < 11; row++) for (let col = 0; col < 8; col++) {
    for (let y = 60; y < 140; y++) for (let x = 50; x < 110; x++) {
      const offset = (row * 208 + y) * stride + 1 + (col * 192 + x) * 4;
      raw[offset] = 50 + row * 15; raw[offset + 1] = 80 + col * 20;
      raw[offset + 2] = 180; raw[offset + 3] = 255;
    }
  }
  const crc32 = bytes => {
    let crc = 0xffffffff;
    for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0); }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const size = Buffer.alloc(4), crc = Buffer.alloc(4);
    size.writeUInt32BE(data.length); crc.writeUInt32BE(crc32(body));
    return Buffer.concat([size, body, crc]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
