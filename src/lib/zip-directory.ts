import { inflateSync, strFromU8 } from 'fflate';
import { yieldToMain } from './task-scheduler';

/** 可按范围读取的 ZIP，不要求归档常驻内存。 / A ZIP readable by range without retaining the archive. */
export interface ZipReader {
  readonly size: number;
  readonly residentBytes?: number;
  readonly cancelled?: () => boolean;
  read(offset: number, length: number): Promise<Uint8Array>;
}

const MAX_ICON_BYTES = 8 * 1024 * 1024;
const DIRECTORY_WINDOW = 512 * 1024;
const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++)
    value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0);
  return value >>> 0;
});

function u64(view: DataView, offset: number): number {
  const value =
    view.getUint32(offset, true) +
    view.getUint32(offset + 4, true) * 4294967296;
  if (!Number.isSafeInteger(value))
    throw new Error('ZIP64 value exceeds safe integer range');
  return value;
}

function hashName(name: string): number {
  let hash = 2166136261;
  for (let i = 0; i < name.length; i++)
    hash = Math.imul(hash ^ name.charCodeAt(i), 16777619);
  return hash >>> 0;
}

/**
 * 紧凑 ZIP/ZIP64 目录：百万条目约 35 MiB，不保留名称字符串或每项对象。
 * Compact ZIP/ZIP64 directory: about 35 MiB per million entries, without retained
 * name strings or per-entry objects. Hash collisions are verified against local names.
 */
export class ZipDirectory {
  private offsets: Float64Array;
  private sizes: Uint32Array;
  private originalSizes: Uint32Array;
  private methodsAndFlags: Uint32Array;
  private hashes: Uint32Array;
  private checksums: Uint32Array;
  private buckets: Uint32Array;
  private collectedNames: string[] | null = null;
  private used = 0;

  private constructor(
    private readonly reader: ZipReader,
    private readonly centralOffset: number,
    private readonly centralSize: number,
    private readonly count: number,
  ) {
    this.offsets = new Float64Array(count);
    this.sizes = new Uint32Array(count);
    this.originalSizes = new Uint32Array(count);
    this.methodsAndFlags = new Uint32Array(count);
    this.hashes = new Uint32Array(count);
    this.checksums = new Uint32Array(count);
    let capacity = 1;
    while (capacity < count * 1.5) capacity *= 2;
    this.buckets = new Uint32Array(capacity);
  }

  get entryCount(): number {
    return this.used;
  }

  /** 计入原归档回退，不能漏算整个 ArrayBuffer。 / Include full-buffer fallbacks in the budget. */
  get residentBytes(): number {
    return (
      (this.reader.residentBytes ?? 0) +
      this.offsets.byteLength +
      this.sizes.byteLength +
      this.originalSizes.byteLength +
      this.methodsAndFlags.byteLength +
      this.hashes.byteLength +
      this.checksums.byteLength +
      this.buckets.byteLength
    );
  }

  static open(
    bytes: Uint8Array,
    collectNames = true,
    cancelled?: () => boolean,
  ): Promise<ZipDirectory> {
    return ZipDirectory.openReader(
      {
        size: bytes.length,
        residentBytes: bytes.buffer.byteLength,
        cancelled,
        read: (offset, length) =>
          Promise.resolve(bytes.subarray(offset, offset + length)),
      },
      collectNames,
    );
  }

  static async openReader(
    reader: ZipReader,
    collectNames = false,
  ): Promise<ZipDirectory> {
    if (!Number.isSafeInteger(reader.size) || reader.size < 22)
      throw new Error('ZIP end directory is missing');
    const tailOffset = Math.max(0, reader.size - 22 - 65535 - 20);
    const tail = await ZipDirectory.range(
      reader,
      tailOffset,
      reader.size - tailOffset,
    );
    const view = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
    let end = tail.length - 22;
    for (; end >= 0; end--) {
      if (
        view.getUint32(end, true) === 0x06054b50 &&
        end + 22 + view.getUint16(end + 20, true) === tail.length
      )
        break;
    }
    if (end < 0) throw new Error('ZIP end directory is missing');
    if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true))
      throw new Error('Multi-disk ZIP is unsupported');
    let count = view.getUint16(end + 10, true);
    let centralSize = view.getUint32(end + 12, true);
    let offset = view.getUint32(end + 16, true);
    if (
      count === 65535 ||
      offset === 0xffffffff ||
      centralSize === 0xffffffff
    ) {
      if (end < 20 || view.getUint32(end - 20, true) !== 0x07064b50)
        throw new Error('ZIP64 locator is missing');
      if (view.getUint32(end - 16, true) || view.getUint32(end - 4, true) !== 1)
        throw new Error('Multi-disk ZIP64 is unsupported');
      const zip64Offset = u64(view, end - 12);
      const zip64Bytes = await ZipDirectory.range(reader, zip64Offset, 56);
      const zip64 = new DataView(
        zip64Bytes.buffer,
        zip64Bytes.byteOffset,
        zip64Bytes.byteLength,
      );
      if (
        zip64.getUint32(0, true) !== 0x06064b50 ||
        zip64.getUint32(16, true) ||
        zip64.getUint32(20, true)
      )
        throw new Error('Invalid ZIP64 directory');
      count = u64(zip64, 32);
      centralSize = u64(zip64, 40);
      offset = u64(zip64, 48);
    }
    if (
      count > centralSize / 46 ||
      offset + centralSize > tailOffset + end ||
      !Number.isSafeInteger(offset + centralSize)
    )
      throw new Error('Invalid ZIP central directory bounds');
    const directory = new ZipDirectory(reader, offset, centralSize, count);
    directory.collectedNames = collectNames ? [] : null;
    await directory.scan((record, name, recordView) => {
      if (name.endsWith('/')) return;
      const flags = recordView.getUint16(record + 8, true);
      let size = recordView.getUint32(record + 20, true);
      let originalSize = recordView.getUint32(record + 24, true);
      let localOffset = recordView.getUint32(record + 42, true);
      if ([size, originalSize, localOffset].includes(0xffffffff)) {
        const nameLength = recordView.getUint16(record + 28, true);
        const extraLength = recordView.getUint16(record + 30, true);
        let extra = record + 46 + nameLength;
        const extraEnd = extra + extraLength;
        let found = false;
        while (extra + 4 <= extraEnd) {
          const kind = recordView.getUint16(extra, true);
          const length = recordView.getUint16(extra + 2, true);
          const fieldEnd = extra + 4 + length;
          if (fieldEnd > extraEnd) throw new Error('Truncated ZIP extra field');
          if (kind === 1) {
            let position = extra + 4;
            const read = () => {
              if (position + 8 > fieldEnd)
                throw new Error('Truncated ZIP64 extra field');
              const value = u64(recordView, position);
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
      const index = directory.used++;
      const hash = hashName(name);
      let bucket = hash & (directory.buckets.length - 1);
      while (directory.buckets[bucket])
        bucket = (bucket + 1) & (directory.buckets.length - 1);
      directory.buckets[bucket] = index + 1;
      directory.hashes[index] = hash;
      directory.checksums[index] = recordView.getUint32(record + 16, true);
      directory.offsets[index] = localOffset;
      // 超大 ZIP64 单项以标记拒绝，避免每个尺寸都使用 64 位数组。 / Mark oversized entries instead of storing 64-bit sizes.
      directory.sizes[index] = Math.min(size, 0xffffffff);
      directory.originalSizes[index] = Math.min(originalSize, 0xffffffff);
      directory.methodsAndFlags[index] =
        (recordView.getUint16(record + 10, true) << 16) | flags;
      directory.collectedNames?.push(name);
    });
    return directory;
  }

  private static async range(
    reader: ZipReader,
    offset: number,
    length: number,
  ): Promise<Uint8Array> {
    if (reader.cancelled?.()) {
      const error = new Error('ZIP loading cancelled');
      error.name = 'AbortError';
      throw error;
    }
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      length < 0 ||
      offset + length > reader.size
    )
      throw new Error('Truncated ZIP data');
    const bytes = await reader.read(offset, length);
    if (bytes.length !== length) throw new Error('Truncated ZIP data');
    return bytes;
  }

  /** 中央目录按小窗口顺序读取，长循环主动让出线程。 / Scan central records in bounded, cooperative windows. */
  private async scan(
    visit: (offset: number, name: string, view: DataView) => void,
  ): Promise<void> {
    let position = this.centralOffset;
    const end = position + this.centralSize;
    let windowOffset = -1;
    let bytes: Uint8Array = new Uint8Array(0);
    let view = new DataView(bytes.buffer);
    let deadline = performance.now() + 4;
    let records = 0;
    while (position < end) {
      if (records++ >= this.count)
        throw new Error('Invalid ZIP directory entry count');
      if (
        position < windowOffset ||
        position + 46 > windowOffset + bytes.length
      ) {
        windowOffset = position;
        bytes = await ZipDirectory.range(
          this.reader,
          position,
          Math.min(DIRECTORY_WINDOW, end - position),
        );
        view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      }
      let offset = position - windowOffset;
      if (
        offset + 46 > bytes.length ||
        view.getUint32(offset, true) !== 0x02014b50
      )
        throw new Error('Invalid ZIP central directory');
      const nameLength = view.getUint16(offset + 28, true);
      const extraLength = view.getUint16(offset + 30, true);
      const commentLength = view.getUint16(offset + 32, true);
      const length = 46 + nameLength + extraLength + commentLength;
      if (position + length > end)
        throw new Error('Truncated ZIP central directory');
      if (offset + length > bytes.length) {
        windowOffset = position;
        bytes = await ZipDirectory.range(
          this.reader,
          position,
          Math.min(DIRECTORY_WINDOW, end - position),
        );
        view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        offset = 0;
      }
      const flags = view.getUint16(offset + 8, true);
      const name = strFromU8(
        bytes.subarray(offset + 46, offset + 46 + nameLength),
        !(flags & 2048),
      );
      visit(offset, name, view);
      position += length;
      if (performance.now() >= deadline) {
        await yieldToMain('background');
        deadline = performance.now() + 4;
      }
    }
    if (records !== this.count)
      throw new Error('Invalid ZIP directory entry count');
  }

  /** 首次列举交出暂存数组，之后不再持有百万名称。 / Transfer names once, leaving no retained name array. */
  async listNames(): Promise<string[]> {
    if (this.collectedNames) {
      const names = this.collectedNames;
      this.collectedNames = null;
      return names;
    }
    const names: string[] = [];
    await this.scan((_offset, name) => {
      if (!name.endsWith('/')) names.push(name);
    });
    return names;
  }

  /**
   * 读取单个条目的原始字节 / Reads one entry as raw bytes.
   *
   * 与 {@link read} 共用同一条校验与解压路径；导入器需要字体等二进制条目，
   * 不能先按 UTF-8 解码。
   * Shares the validation and inflation path with {@link read}; importers need
   * binary entries such as fonts, which must not be decoded as UTF-8 first.
   */
  async readBytes(
    path: string,
    maxBytes = MAX_ICON_BYTES,
  ): Promise<Uint8Array | null> {
    const hash = hashName(path);
    let bucket = hash & (this.buckets.length - 1);
    let selected: { index: number; start: number } | null = null;
    while (this.buckets[bucket]) {
      const index = this.buckets[bucket] - 1;
      bucket = (bucket + 1) & (this.buckets.length - 1);
      if (this.hashes[index] !== hash) continue;
      const localOffset = this.offsets[index];
      const header = await ZipDirectory.range(this.reader, localOffset, 30);
      const view = new DataView(
        header.buffer,
        header.byteOffset,
        header.byteLength,
      );
      if (view.getUint32(0, true) !== 0x04034b50)
        throw new Error('Invalid ZIP local header');
      const nameLength = view.getUint16(26, true);
      const extraLength = view.getUint16(28, true);
      const flags = this.methodsAndFlags[index] & 65535;
      const nameBytes = await ZipDirectory.range(
        this.reader,
        localOffset + 30,
        nameLength,
      );
      if (strFromU8(nameBytes, !(flags & 2048)) !== path) continue;
      // 重名条目沿用旧 Map 的最后一项语义。 / Match the previous Map's last-entry-wins semantics.
      selected = { index, start: localOffset + 30 + nameLength + extraLength };
    }
    if (!selected) return null;
    const { index, start } = selected;
    if (this.methodsAndFlags[index] & 1)
      throw new Error('Encrypted ZIP icons are unsupported');
    const originalSize = this.originalSizes[index];
    const size = this.sizes[index];
    if (originalSize > maxBytes || size > maxBytes * 2)
      throw new Error(
        maxBytes === MAX_ICON_BYTES
          ? 'SVG exceeds the 8 MB per-icon limit'
          : `Archive entry exceeds the ${Math.round(
              maxBytes / 1024 / 1024,
            )} MB limit`,
      );
    const method = this.methodsAndFlags[index] >>> 16;
    if (method !== 0 && method !== 8)
      throw new Error('Unsupported ZIP compression method');
    const data = await ZipDirectory.range(this.reader, start, size);
    const decoded =
      method === 0
        ? data
        : inflateSync(data, { out: new Uint8Array(originalSize) });
    if (decoded.length !== originalSize)
      throw new Error('Invalid ZIP icon size');
    // 固定输出缓冲区可能截断损坏的 deflate；校验原始 CRC 后才允许缓存图标。
    // Fixed output buffers can truncate corrupt deflate streams; verify CRC before caching.
    let checksum = 0xffffffff;
    let deadline = performance.now() + 4;
    for (let offset = 0; offset < decoded.length; offset++) {
      checksum =
        CRC_TABLE[(checksum ^ decoded[offset]) & 255] ^ (checksum >>> 8);
      if ((offset & 65535) === 65535 && performance.now() >= deadline) {
        await yieldToMain('user-visible');
        deadline = performance.now() + 4;
      }
      if ((offset & 65535) === 0 && this.reader.cancelled?.()) {
        const error = new Error('ZIP loading cancelled');
        error.name = 'AbortError';
        throw error;
      }
    }
    if ((checksum ^ 0xffffffff) >>> 0 !== this.checksums[index])
      throw new Error('Invalid ZIP icon checksum');
    return decoded;
  }

  /**
   * 条目的解压后大小 / Inflated size of one entry.
   *
   * 只读中央目录与本地文件名，不解压内容；用于在选择大 JSON 图标集前给出提示。
   * Reads the central directory and local file name without inflating; useful for
   * warning about large JSON sets before reading them.
   */
  async sizeOf(path: string): Promise<number | null> {
    const hash = hashName(path);
    let bucket = hash & (this.buckets.length - 1);
    let selected: number | null = null;
    while (this.buckets[bucket]) {
      const index = this.buckets[bucket] - 1;
      bucket = (bucket + 1) & (this.buckets.length - 1);
      if (this.hashes[index] !== hash) continue;
      const localOffset = this.offsets[index];
      const header = await ZipDirectory.range(this.reader, localOffset, 30);
      const view = new DataView(
        header.buffer,
        header.byteOffset,
        header.byteLength,
      );
      if (view.getUint32(0, true) !== 0x04034b50)
        throw new Error('Invalid ZIP local header');
      const nameLength = view.getUint16(26, true);
      const flags = this.methodsAndFlags[index] & 65535;
      const nameBytes = await ZipDirectory.range(
        this.reader,
        localOffset + 30,
        nameLength,
      );
      if (strFromU8(nameBytes, !(flags & 2048)) !== path) continue;
      selected = index;
    }
    return selected === null ? null : this.originalSizes[selected];
  }

  async read(path: string, maxBytes = MAX_ICON_BYTES): Promise<string | null> {
    const decoded = await this.readBytes(path, maxBytes);
    return decoded ? strFromU8(decoded) : null;
  }
}
