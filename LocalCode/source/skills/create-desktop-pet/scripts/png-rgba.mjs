import { inflateSync, deflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';

export const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
export const FRAME_COUNTS = [6, 8, 8, 4, 5, 8, 6, 6, 6, 8, 8];
const signature = Buffer.from('89504e470d0a1a0a', 'hex');
const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(bytes) {
  let crc = 0xffffffff;
  for (const value of bytes) crc = crcTable[(crc ^ value) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function paeth(a, b, c) {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Bounded decoder for the non-interlaced 8-bit RGBA format accepted by LocalCode. */
export function decodePng(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length < 45 || bytes.length > MAX_IMAGE_BYTES || !bytes.subarray(0, 8).equals(signature)) throw new Error('图片必须为不超过 16 MiB 的 PNG。');
  let width, height, ended = false, seenData = false, dataEnded = false;
  const chunks = [];
  for (let offset = 8; offset < bytes.length;) {
    if (offset + 12 > bytes.length) throw new Error('PNG 数据被截断。');
    const size = bytes.readUInt32BE(offset), end = offset + size + 12;
    if (end > bytes.length) throw new Error('PNG 区块长度无效。');
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const data = bytes.subarray(offset + 8, end - 4);
    if (crc32(bytes.subarray(offset + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) throw new Error('PNG 校验和不匹配。');
    if (offset === 8 && type !== 'IHDR') throw new Error('PNG 缺少首个 IHDR。');
    if (type === 'IHDR') {
      if (width !== undefined || size !== 13) throw new Error('PNG IHDR 无效。');
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      if (!width || !height || width > 8192 || height > 8192 || width * height > 20_000_000) throw new Error('图片尺寸超出支持范围。');
      if (data[8] !== 8 || data[9] !== 6 || data[10] !== 0 || data[11] !== 0 || data[12] !== 0) throw new Error('需要非交错、8 位 RGBA PNG；请先转换颜色格式，保留透明通道。');
    } else if (type === 'IDAT') {
      if (dataEnded) throw new Error('PNG 图像区块顺序无效。');
      seenData = true; chunks.push(data);
    } else if (type === 'IEND') {
      if (size !== 0 || !seenData || end !== bytes.length) throw new Error('PNG 结束区块无效。');
      ended = true; break;
    } else {
      if (seenData) dataEnded = true;
      if (type === 'acTL' || type === 'fcTL' || type === 'fdAT') throw new Error('请使用静态 PNG 图集，不要使用 APNG。');
      if ((bytes[offset + 4] & 32) === 0 && type !== 'PLTE') throw new Error('PNG 包含不支持的关键区块。');
    }
    offset = end;
  }
  if (!ended || width === undefined) throw new Error('PNG 不完整。');
  const stride = width * 4, expected = (stride + 1) * height;
  let raw;
  try { raw = inflateSync(Buffer.concat(chunks), { maxOutputLength: expected }); }
  catch { throw new Error('PNG 像素数据无法解压或超过声明尺寸。'); }
  if (raw.length !== expected) throw new Error('PNG 像素数据长度不匹配。');
  const rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const source = y * (stride + 1), target = y * stride, filter = raw[source];
    if (filter > 4) throw new Error('PNG 行过滤器无效。');
    for (let x = 0; x < stride; x++) {
      const left = x >= 4 ? rgba[target + x - 4] : 0;
      const above = y ? rgba[target + x - stride] : 0;
      const upperLeft = x >= 4 && y ? rgba[target + x - stride - 4] : 0;
      const predictor = filter === 1 ? left : filter === 2 ? above : filter === 3 ? Math.floor((left + above) / 2) : filter === 4 ? paeth(left, above, upperLeft) : 0;
      rgba[target + x] = (raw[source + 1 + x] + predictor) & 255;
    }
  }
  return { width, height, rgba };
}

function chunk(type, data) {
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length, 0); result.write(type, 4, 4, 'ascii'); data.copy(result, 8);
  result.writeUInt32BE(crc32(result.subarray(4, result.length - 4)), result.length - 4);
  return result;
}
export function encodePng({ width, height, rgba }) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width * height > 20_000_000 || rgba.length !== width * height * 4) throw new Error('RGBA 图像参数无效。');
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  const stride = width * 4, raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  return Buffer.concat([signature, chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** Nearest-neighbor resampling preserves transparent pixels and crisp sprite edges. */
export function normalizeAtlas(input) {
  if (input.width === 1536 && input.height === 2288) return input;
  const width = 1536, height = 2288, rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const sy = Math.min(input.height - 1, Math.floor((y + 0.5) * input.height / height));
    for (let x = 0; x < width; x++) {
      const sx = Math.min(input.width - 1, Math.floor((x + 0.5) * input.width / width));
      const source = (sy * input.width + sx) * 4, target = (y * width + x) * 4;
      rgba[target] = input.rgba[source]; rgba[target + 1] = input.rgba[source + 1]; rgba[target + 2] = input.rgba[source + 2]; rgba[target + 3] = input.rgba[source + 3];
    }
  }
  return { width, height, rgba };
}

export function inspectAtlas(image) {
  if (image.width !== 1536 || image.height !== 2288) throw new Error('最终图集必须是 1536×2288。');
  let transparent = 0;
  for (let i = 3; i < image.rgba.length; i += 4) if (image.rgba[i] === 0) transparent++;
  if (transparent < image.width * image.height * 0.01) throw new Error('图集缺少透明背景；棋盘格或纯色背景不能直接作为透明图集。');
  const warnings = [], empty = [], rows = [];
  for (let row = 0; row < 11; row++) {
    const hashes = [], edgeFrames = [];
    for (let col = 0; col < FRAME_COUNTS[row]; col++) {
      const tile = Buffer.alloc(192 * 208 * 4); let visible = 0, transparentInTile = 0, touchesEdge = false;
      for (let y = 0; y < 208; y++) {
        const source = ((row * 208 + y) * image.width + col * 192) * 4;
        image.rgba.copy(tile, y * 192 * 4, source, source + 192 * 4);
        for (let x = 0; x < 192; x++) {
          const alpha = image.rgba[source + x * 4 + 3];
          if (alpha > 16) { visible++; if (x === 0 || x === 191 || y === 0 || y === 207) touchesEdge = true; }
          if (alpha === 0) transparentInTile++;
        }
      }
      if (visible < 8) empty.push(`${row + 1}:${col + 1}`);
      if (!transparentInTile) warnings.push(`第 ${row + 1} 行第 ${col + 1} 格没有完全透明像素，请检查背景。`);
      if (touchesEdge) edgeFrames.push(col + 1);
      hashes.push(createHash('sha256').update(tile).digest('hex'));
    }
    const uniqueFrames = new Set(hashes).size;
    if (row < 9 && uniqueFrames === 1) warnings.push(`第 ${row + 1} 行所有帧相同，尚无可见动画变化。`);
    if (edgeFrames.length) warnings.push(`第 ${row + 1} 行的 ${edgeFrames.join('、')} 格像素触及边缘，请检查裁切和串帧。`);
    rows.push({ row, frames: FRAME_COUNTS[row], uniqueFrames });
  }
  if (empty.length) throw new Error(`图集有空的必需帧（行:列，从 1 开始）：${empty.join(', ')}。请补齐真实动作，不能仅复制立绘冒充动画。`);
  return { formatValid: true, width: image.width, height: image.height, requiredFrames: 73, transparentPixels: transparent, visualReview: 'required', warnings, rows };
}
