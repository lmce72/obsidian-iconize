import { inflateSync, strFromU8 } from 'fflate';

interface ZipEntry {
  offset: number;
  size: number;
  originalSize: number;
  method: number;
  flags: number;
}

/** 一次读取 ZIP/ZIP64 目录，之后按偏移读取单项。 / Index ZIP/ZIP64 once, then inflate only the requested entry. */
export class ZipDirectory {
  readonly entries = new Map<string, ZipEntry>();
  private view: DataView;
  private constructor(private bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  private u32(offset: number): number {
    return this.view.getUint32(offset, true);
  }
  private u16(offset: number): number {
    return this.view.getUint16(offset, true);
  }
  private u64(offset: number): number {
    const value = this.u32(offset) + this.u32(offset + 4) * 4294967296;
    if (!Number.isSafeInteger(value))
      throw new Error('ZIP64 value exceeds safe integer range');
    return value;
  }

  static async open(bytes: Uint8Array): Promise<ZipDirectory> {
    const directory = new ZipDirectory(bytes);
    let end = bytes.length - 22;
    const earliest = Math.max(0, end - 65535);
    for (; end >= earliest; end--) {
      if (
        directory.u32(end) === 0x06054b50 &&
        end + 22 + directory.u16(end + 20) === bytes.length
      )
        break;
    }
    if (end < earliest) throw new Error('ZIP end directory is missing');
    if (directory.u16(end + 4) || directory.u16(end + 6))
      throw new Error('Multi-disk ZIP is unsupported');
    let count = directory.u16(end + 10);
    let offset = directory.u32(end + 16);
    if (count === 65535 || offset === 0xffffffff) {
      if (end < 20 || directory.u32(end - 20) !== 0x07064b50)
        throw new Error('ZIP64 locator is missing');
      const zip64 = directory.u64(end - 12);
      if (
        directory.u32(zip64) !== 0x06064b50 ||
        directory.u32(zip64 + 16) ||
        directory.u32(zip64 + 20)
      )
        throw new Error('Invalid ZIP64 directory');
      count = directory.u64(zip64 + 32);
      offset = directory.u64(zip64 + 48);
    }
    let slice = performance.now();
    for (let i = 0; i < count; i++) {
      if (directory.u32(offset) !== 0x02014b50)
        throw new Error('Invalid ZIP central directory');
      const nameLength = directory.u16(offset + 28);
      const extraLength = directory.u16(offset + 30);
      const commentLength = directory.u16(offset + 32);
      const next = offset + 46 + nameLength + extraLength + commentLength;
      if (next > bytes.length)
        throw new Error('Truncated ZIP central directory');
      const flags = directory.u16(offset + 8);
      const name = strFromU8(
        bytes.subarray(offset + 46, offset + 46 + nameLength),
        !(flags & 2048),
      );
      let size = directory.u32(offset + 20);
      let originalSize = directory.u32(offset + 24);
      let localOffset = directory.u32(offset + 42);
      if ([size, originalSize, localOffset].includes(0xffffffff)) {
        let extra = offset + 46 + nameLength;
        const extraEnd = extra + extraLength;
        let found = false;
        while (extra + 4 <= extraEnd) {
          const kind = directory.u16(extra);
          const length = directory.u16(extra + 2);
          const fieldEnd = extra + 4 + length;
          if (fieldEnd > extraEnd) throw new Error('Truncated ZIP extra field');
          if (kind === 1) {
            let position = extra + 4;
            const read = () => {
              if (position + 8 > fieldEnd)
                throw new Error('Truncated ZIP64 extra field');
              const value = directory.u64(position);
              position += 8;
              return value;
            };
            if (originalSize === 0xffffffff) originalSize = read();
            if (size === 0xffffffff) size = read();
            if (localOffset === 0xffffffff) localOffset = read();
            found = true;
            break;
          }
          extra = fieldEnd;
        }
        if (!found) throw new Error('ZIP64 entry metadata is missing');
      }
      if (!name.endsWith('/'))
        directory.entries.set(name, {
          offset: localOffset,
          size,
          originalSize,
          method: directory.u16(offset + 10),
          flags,
        });
      offset = next;
      if (i % 256 === 0 && performance.now() - slice >= 8) {
        await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
        slice = performance.now();
      }
    }
    return directory;
  }

  read(path: string): string | null {
    const entry = this.entries.get(path);
    if (!entry) return null;
    if (entry.flags & 1) throw new Error('Encrypted ZIP icons are unsupported');
    if (entry.originalSize > 8 * 1024 * 1024)
      throw new Error('SVG exceeds the 8 MB per-icon limit');
    if (this.u32(entry.offset) !== 0x04034b50)
      throw new Error('Invalid ZIP local header');
    const start =
      entry.offset +
      30 +
      this.u16(entry.offset + 26) +
      this.u16(entry.offset + 28);
    if (start + entry.size > this.bytes.length)
      throw new Error('Truncated ZIP icon');
    const data = this.bytes.subarray(start, start + entry.size);
    if (entry.method !== 0 && entry.method !== 8)
      throw new Error('Unsupported ZIP compression method');
    const decoded =
      entry.method === 0
        ? data
        : inflateSync(data, { out: new Uint8Array(entry.originalSize) });
    if (decoded.length !== entry.originalSize)
      throw new Error('Invalid ZIP icon size');
    return strFromU8(decoded);
  }
}
