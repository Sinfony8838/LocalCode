import { deflateSync } from 'node:zlib';

// A deterministic geometric fixture, independent of the private character atlases.
// Keep a real decodable RGBA PNG so the same bytes can be exercised by nativeImage.
export function petAtlasFixture(variant = 0): Buffer {
  const width = 1536, height = 2288, stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  const frames = [6, 8, 8, 4, 5, 8, 6, 6, 6, 8, 8];
  for (let row = 0; row < frames.length; row++) {
    for (let column = 0; column < frames[row]; column++) {
      const startX = column * 192 + 70 + column % 3, startY = row * 208 + 80;
      for (let y = startY; y < startY + 48; y++) for (let x = startX; x < startX + 48; x++) {
        const offset = y * (stride + 1) + 1 + x * 4;
        raw[offset] = (70 + row * 15 + variant * 33) % 256;
        raw[offset + 1] = (60 + column * 25 + variant * 29) % 256;
        raw[offset + 2] = 180; raw[offset + 3] = 255;
      }
    }
  }
  const checksum = (bytes: Buffer) => {
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (name: string, bytes: Buffer) => {
    const output = Buffer.alloc(bytes.length + 12);
    output.writeUInt32BE(bytes.length); output.write(name, 4, 'ascii'); bytes.copy(output, 8);
    output.writeUInt32BE(checksum(output.subarray(4, output.length - 4)), output.length - 4);
    return output;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
