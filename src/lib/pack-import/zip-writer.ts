/**
 * ZIP 写入 / ZIP writing.
 *
 * fflate 的 `zipSync` 把条目数写成 16 位字段；超过 65,535 个图标时会回绕，产生
 * 无效的中央目录计数。这里在超出 16 位时改写成合法的 ZIP64 归档，运行时读取器
 * 已支持 ZIP64。普通规模仍交给 fflate，保持原有压缩与兼容性。
 *
 * fflate's `zipSync` writes the entry count as a 16-bit field; more than 65,535 icons
 * wraps it and produces an invalid central-directory count. Above that threshold this
 * module writes a valid ZIP64 archive, which the runtime reader already supports. Normal
 * packs still go through fflate to keep the existing compression and compatibility.
 */

import { deflateSync, strToU8, zipSync } from 'fflate';

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit++)
    crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let index = 0; index < data.length; index++)
    crc = CRC_TABLE[(crc ^ data[index]) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function writeU64(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value >>> 0, true);
  view.setUint32(offset + 4, Math.floor(value / 4294967296) >>> 0, true);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

/**
 * 写入 ZIP64 归档 / Writes a ZIP64 archive.
 *
 * 无数据描述符：压缩后大小在写本地头之前已知。每个条目使用 deflate；中央目录
 * 记录使用 32 位大小/偏移（调用方已限制在 4 GB 内），条目总数由 ZIP64 EOCD
 * 承载。
 *
 * No data descriptors: compressed sizes are known before the local header is written.
 * Each entry is deflated; central records use 32-bit sizes/offsets (the caller enforces
 * the 4 GB bound) while the true entry count lives in the ZIP64 EOCD.
 */
function writeZip64(files: Record<string, Uint8Array>): Uint8Array {
  const names = Object.keys(files).sort();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const name of names) {
    const data = files[name];
    const nameBytes = strToU8(name);
    const compressed = deflateSync(data, { level: 6 });
    if (
      data.length > 0xffffffff ||
      compressed.length > 0xffffffff ||
      offset > 0xffffffff
    )
      throw new Error('ZIP entry exceeds the 4 GB ZIP32 limit');
    const crc = crc32(data);

    const local = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 45, true);
    localView.setUint16(6, 0x0800, true); // UTF-8 names
    localView.setUint16(8, 8, true); // deflate
    localView.setUint16(10, 0, true);
    localView.setUint16(12, 0, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, compressed.length, true);
    localView.setUint32(22, data.length, true);
    localView.setUint16(26, nameBytes.length, true);
    localView.setUint16(28, 0, true);
    local.set(nameBytes, 30);
    parts.push(local, compressed);

    const entry = new Uint8Array(46 + nameBytes.length);
    const entryView = new DataView(entry.buffer);
    entryView.setUint32(0, 0x02014b50, true);
    entryView.setUint16(4, 45, true);
    entryView.setUint16(6, 45, true);
    entryView.setUint16(8, 0x0800, true);
    entryView.setUint16(10, 8, true);
    entryView.setUint16(12, 0, true);
    entryView.setUint16(14, 0, true);
    entryView.setUint32(16, crc, true);
    entryView.setUint32(20, compressed.length, true);
    entryView.setUint32(24, data.length, true);
    entryView.setUint16(28, nameBytes.length, true);
    entryView.setUint16(30, 0, true);
    entryView.setUint16(32, 0, true);
    entryView.setUint16(34, 0, true);
    entryView.setUint16(36, 0, true);
    entryView.setUint32(38, 0, true);
    entryView.setUint32(42, offset, true);
    entry.set(nameBytes, 46);
    central.push(entry);

    offset += local.length + compressed.length;
  }

  const centralOffset = offset;
  const centralSize = central.reduce((sum, entry) => sum + entry.length, 0);
  if (centralOffset > 0xffffffff || centralSize > 0xffffffff)
    throw new Error('ZIP64 directory exceeds the 4 GB limit');

  const zip64 = new Uint8Array(56);
  const zip64View = new DataView(zip64.buffer);
  zip64View.setUint32(0, 0x06064b50, true);
  writeU64(zip64View, 4, 44);
  zip64View.setUint16(12, 45, true);
  zip64View.setUint16(14, 45, true);
  zip64View.setUint32(16, 0, true);
  zip64View.setUint32(20, 0, true);
  writeU64(zip64View, 24, names.length);
  writeU64(zip64View, 32, names.length);
  writeU64(zip64View, 40, centralSize);
  writeU64(zip64View, 48, centralOffset);

  const locator = new Uint8Array(20);
  const locatorView = new DataView(locator.buffer);
  locatorView.setUint32(0, 0x07064b50, true);
  locatorView.setUint32(4, 0, true);
  writeU64(locatorView, 8, centralOffset + centralSize);
  locatorView.setUint32(16, 1, true);

  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true);
  eocdView.setUint16(4, 0, true);
  eocdView.setUint16(6, 0, true);
  eocdView.setUint16(8, 0xffff, true);
  eocdView.setUint16(10, 0xffff, true);
  eocdView.setUint32(12, centralSize, true);
  eocdView.setUint32(16, centralOffset, true);
  eocdView.setUint16(20, 0, true);

  return concat([...parts, ...central, zip64, locator, eocd]);
}

/**
 * 写图标包 ZIP / Writes an icon pack ZIP.
 *
 * 16 位条目数以内使用 fflate；超过时使用 ZIP64，避免计数回绕。
 * Uses fflate while the 16-bit count fits; switches to ZIP64 above it so the count
 * cannot wrap.
 */
export function writeZip(files: Record<string, Uint8Array>): Uint8Array {
  return Object.keys(files).length <= 0xffff
    ? zipSync(files, { level: 6 })
    : writeZip64(files);
}
