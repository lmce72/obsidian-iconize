/**
 * 归档读取 / Archive reading.
 *
 * 导入器只按需读取真正保留的条目：ZIP 复用插件的中央目录与单个条目读取路径，
 * tar/tar.gz 在内存中建立偏移表。两者都不把整个归档解压到磁盘。
 *
 * Importers only read the entries they keep: ZIP reuses the plugin's central
 * directory and single-entry reader, while tar/tar.gz builds an offset table in
 * memory. Neither extracts the archive to disk.
 */

import { gunzipSync, strFromU8 } from 'fflate';
import { ZipDirectory } from '../zip-directory';
import { throwIfAborted } from '../task-scheduler';

/** 单个归档允许的解压上限，防止压缩炸弹 / Inflation ceiling per archive. */
const MAX_INFLATED_BYTES = 512 * 1024 * 1024;
/** 条目数上限，防止异常归档耗尽内存 / Entry-count ceiling. */
const MAX_ENTRIES = 200_000;

export type ArchiveKind = 'zip' | 'tar';

export interface ArchiveReader {
  readonly kind: ArchiveKind;
  /** 文件条目名（不含目录）/ File entry names, without directories. */
  readonly names: string[];
  readBytes(name: string): Promise<Uint8Array | null>;
  readText(name: string): Promise<string | null>;
}

/** 按魔数判断归档类型 / Sniffs the archive type from magic bytes. */
export function sniffArchive(bytes: Uint8Array): ArchiveKind | null {
  if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b) {
    // Local file, empty archive, or spanned marker: all are ZIP containers.
    return bytes[2] === 3 || bytes[2] === 5 || bytes[2] === 7 ? 'zip' : null;
  }
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    return 'tar';
  }
  // Uncompressed POSIX tar carries "ustar" at offset 257.
  if (
    bytes.length >= 512 &&
    bytes[257] === 0x75 &&
    bytes[258] === 0x73 &&
    bytes[259] === 0x74 &&
    bytes[260] === 0x61 &&
    bytes[261] === 0x72
  ) {
    return 'tar';
  }
  return null;
}

class ZipArchiveReader implements ArchiveReader {
  readonly kind = 'zip' as const;

  constructor(
    private readonly directory: ZipDirectory,
    readonly names: string[],
  ) {}

  async readBytes(name: string): Promise<Uint8Array | null> {
    return this.directory.readBytes(name);
  }

  async readText(name: string): Promise<string | null> {
    const bytes = await this.readBytes(name);
    return bytes ? strFromU8(bytes) : null;
  }
}

interface TarEntry {
  offset: number;
  size: number;
}

class TarArchiveReader implements ArchiveReader {
  readonly kind = 'tar' as const;

  constructor(
    private readonly data: Uint8Array,
    readonly names: string[],
    private readonly entries: Map<string, TarEntry>,
  ) {}

  async readBytes(name: string): Promise<Uint8Array | null> {
    const entry = this.entries.get(name);
    if (!entry) return null;
    return this.data.slice(entry.offset, entry.offset + entry.size);
  }

  async readText(name: string): Promise<string | null> {
    const bytes = await this.readBytes(name);
    return bytes ? strFromU8(bytes) : null;
  }
}

function cstring(bytes: Uint8Array, start: number, length: number): string {
  const end = start + length;
  let stop = start;
  while (stop < end && bytes[stop] !== 0) stop++;
  return strFromU8(bytes.subarray(start, stop));
}

/** 读取 tar 的八进制字段，兼容结尾空格与 NUL。 / Parses a tar octal field. */
function tarNumber(bytes: Uint8Array, start: number, length: number): number {
  const first = bytes[start];
  // Base-256 encoding (GNU): high bit marks a binary two's-complement number.
  if (first & 0x80) {
    let value = first & 0x7f;
    for (let i = 1; i < length; i++) value = value * 256 + bytes[start + i];
    return value;
  }
  let value = 0;
  let seen = false;
  for (let i = start; i < start + length; i++) {
    const byte = bytes[i];
    if (byte === 0 || byte === 0x20) {
      if (seen) break;
      continue;
    }
    if (byte < 0x30 || byte > 0x37) break;
    seen = true;
    value = value * 8 + (byte - 0x30);
  }
  return value;
}

/** 解析 POSIX pax 扩展头中的 path 字段 / Reads the `path` record of a pax header. */
function paxPath(payload: Uint8Array): string | undefined {
  const text = strFromU8(payload);
  for (const line of text.split('\n')) {
    const match = /^\d+ path=(.*)$/.exec(line);
    if (match) return match[1];
  }
  return undefined;
}

/**
 * 建立 tar 偏移表 / Builds a tar offset table.
 *
 * 只记录普通文件；链接、目录与扩展头在列表中不产生图标条目。
 * Only regular files are recorded; links, directories and extended headers never
 * become icon entries.
 */
function parseTar(data: Uint8Array): {
  entries: Map<string, TarEntry>;
  names: string[];
} {
  const entries = new Map<string, TarEntry>();
  const names: string[] = [];
  let offset = 0;
  let pendingPath: string | undefined;
  while (offset + 512 <= data.length) {
    if (data[offset] === 0) break;
    const header = data.subarray(offset, offset + 512);
    let name = cstring(header, 0, 100);
    const size = tarNumber(header, 124, 12);
    const type = String.fromCharCode(header[156] || 0x30);
    const magic = cstring(header, 257, 6);
    if (magic.startsWith('ustar')) {
      const prefix = cstring(header, 345, 155);
      if (prefix) name = `${prefix}/${name}`;
    }
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > data.length) {
      throw new Error('Truncated tar entry');
    }
    if (type === 'L') {
      // GNU long name applies to the next entry.
      pendingPath = cstring(data, dataStart, size);
    } else if (type === 'x' || type === 'X') {
      pendingPath = paxPath(data.subarray(dataStart, dataEnd)) ?? pendingPath;
    } else if (type === '0' || type === '\0' || type === '7') {
      const finalName = pendingPath ?? name;
      pendingPath = undefined;
      if (finalName && !finalName.endsWith('/')) {
        if (!entries.has(finalName)) {
          entries.set(finalName, { offset: dataStart, size });
          names.push(finalName);
          if (names.length > MAX_ENTRIES)
            throw new Error('The archive contains too many files');
        }
      }
    } else {
      // Directories, links, devices and other metadata carry no file content.
      pendingPath = undefined;
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  return { entries, names };
}

/**
 * 打开 ZIP / tar / tar.gz 归档 / Opens a ZIP, tar or tar.gz archive.
 *
 * 返回 `null` 表示字节不是受支持的归档；错误只用于损坏的归档。
 * Returns `null` when the bytes are not a supported archive; errors are reserved
 * for damaged archives.
 */
export async function openArchive(
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<ArchiveReader | null> {
  throwIfAborted(signal);
  const kind = sniffArchive(bytes);
  if (!kind) return null;

  if (kind === 'zip') {
    const directory = await ZipDirectory.open(
      bytes,
      true,
      () => signal?.aborted === true,
    );
    throwIfAborted(signal);
    const names = await directory.listNames();
    return new ZipArchiveReader(directory, names);
  }

  // gzip 的 ISIZE 字段是解压后大小的低 32 位，可在解压前拒绝异常输入。
  // The gzip ISIZE field is the low 32 bits of the inflated size; reject anomalies early.
  if (bytes.length >= 4 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    const view = new DataView(
      bytes.buffer,
      bytes.byteOffset + bytes.byteLength - 4,
      4,
    );
    if (view.getUint32(0, true) > MAX_INFLATED_BYTES)
      throw new Error('The compressed archive is too large to import');
  }
  const inflated =
    bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes;
  throwIfAborted(signal);
  if (inflated.length > MAX_INFLATED_BYTES)
    throw new Error('The archive is too large to import');
  const { entries, names } = parseTar(inflated);
  return new TarArchiveReader(inflated, names, entries);
}

/** 取路径的最后一段 / Returns the final path segment. */
export function baseName(path: string): string {
  return path.substring(path.lastIndexOf('/') + 1);
}

/** 取目录部分，根目录返回空串 / Directory part; the archive root is `''`. */
export function dirName(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.substring(0, slash);
}

/** 去掉扩展名 / Strips one extension. */
export function stripExtension(name: string, extension: string): string {
  return name.toLowerCase().endsWith(extension)
    ? name.slice(0, -extension.length)
    : name;
}
