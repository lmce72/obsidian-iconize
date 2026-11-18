import type { IconEntry } from './icon-indexing';
import { throwIfAborted, yieldToMain } from './task-scheduler';

const ROWS_PER_CHUNK = 1024;
const MAX_CHUNK_CHARACTERS = 128 * 1024;
const SLICE_MS = 4;

interface IndexChunk {
  firstRow: number;
  rows: number;
  data: string;
  offsets: Uint32Array;
  search: string;
  searchOffsets: Uint32Array;
}

interface EntryOverrides {
  id?: string;
  displayName?: string;
  folder?: string;
}

function dirname(path: string): string {
  return path.substring(0, Math.max(0, path.lastIndexOf('/')));
}

function displayName(path: string): string {
  return path.substring(path.lastIndexOf('/') + 1).replace(/\.svg$/i, '');
}

function hashName(value: string): number {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
  }
  return hash >>> 0;
}

/**
 * 图标元数据保存在小字串块和数值偏移中，不为每个图标保留对象或字符串 Map。
 * Metadata lives in bounded string slabs and numeric offsets, without per-icon objects/maps.
 */
export class CompactIconIndex implements Iterable<IconEntry> {
  private chunks: IndexChunk[] = [];
  private names: string[] = [];
  private paths: string[] = [];
  private searchParts: string[] = [];
  private dataOffsets: number[] = [0];
  private searchOffsets: number[] = [0];
  private sealedRows = 0;
  private count = 0;
  private prefix: string;
  private inferPrefix: boolean;
  private folderRoot: string | undefined;
  private overrides?: Map<number, EntryOverrides>;
  private identifierOverrides?: Map<string, number>;
  private table?: Uint32Array;
  private tableReady = false;
  private duplicateRows?: Map<number, number>;

  constructor(
    prefix?: string,
    _expectedCount = 0,
    private readonly signal?: AbortSignal,
  ) {
    this.prefix = prefix ?? '';
    this.inferPrefix = prefix === undefined;
  }

  get length(): number {
    return this.count;
  }

  static async fromEntries(
    entries: Iterable<IconEntry>,
    signal?: AbortSignal,
  ): Promise<CompactIconIndex> {
    throwIfAborted(signal);
    if (entries instanceof CompactIconIndex) return entries;
    const expectedCount = (entries as { length?: number }).length ?? 0;
    const index = new CompactIconIndex(undefined, expectedCount, signal);
    let slice = performance.now();
    for (const entry of entries) {
      index.append(entry);
      if (index.length % 128 === 0 && performance.now() - slice >= SLICE_MS) {
        await yieldToMain('background');
        throwIfAborted(signal);
        slice = performance.now();
      }
    }
    await index.finish();
    return index;
  }

  /** 小型同步调用的兼容入口；生产载入使用 fromEntries/finish。 / Small synchronous compatibility path. */
  static fromEntriesSync(entries: Iterable<IconEntry>): CompactIconIndex {
    const index = new CompactIconIndex();
    for (const entry of entries) index.append(entry);
    index.sealChunk();
    index.allocateTable();
    for (let row = 0; row < index.length; row++) index.registerRow(row);
    index.tableReady = true;
    return index;
  }

  append(entry: IconEntry): void {
    throwIfAborted(this.signal);
    if (this.count === 0) {
      if (this.inferPrefix && entry.id.endsWith(entry.name)) {
        this.prefix = entry.id.slice(0, entry.id.length - entry.name.length);
      }
      const dir = dirname(entry.path);
      this.folderRoot =
        entry.folder === ''
          ? dir
          : dir.endsWith(`/${entry.folder}`)
            ? dir.slice(0, -entry.folder.length - 1)
            : '';
    }
    const originalDisplayName = displayName(entry.path);
    let override: EntryOverrides | undefined;
    if (entry.id !== this.prefix + entry.name) {
      (override ??= {}).id = entry.id;
      (this.identifierOverrides ??= new Map()).set(
        entry.id.toLowerCase(),
        this.count,
      );
    }
    if (entry.displayName !== originalDisplayName)
      (override ??= {}).displayName = entry.displayName;
    if (entry.folder !== this.folderFor(entry.path))
      (override ??= {}).folder = entry.folder;
    if (override) {
      (this.overrides ??= new Map()).set(this.count, override);
    }
    this.names.push(entry.name);
    this.paths.push(entry.path);
    const end = this.dataOffsets[this.dataOffsets.length - 1];
    this.dataOffsets.push(
      end + entry.name.length,
      end + entry.name.length + entry.path.length,
    );
    const id = entry.id.toLowerCase();
    const label = entry.displayName.toLowerCase();
    const search = (id.includes(label) ? id : `${id} ${label}`) + '\n';
    this.searchParts.push(search);
    this.searchOffsets.push(
      this.searchOffsets[this.searchOffsets.length - 1] + search.length,
    );
    this.count++;
    if (
      this.names.length === ROWS_PER_CHUNK ||
      this.dataOffsets[this.dataOffsets.length - 1] >= MAX_CHUNK_CHARACTERS ||
      this.searchOffsets[this.searchOffsets.length - 1] >= MAX_CHUNK_CHARACTERS
    )
      this.sealChunk();
    // 完成后追加少量条目仍为常数开销；扩容留给异步 finish，禁止同步重建大表。
    // Appending to a completed table is cheap; growth is rebuilt only by async finish.
    if (
      this.tableReady &&
      this.table &&
      this.count <= this.table.length * 0.7
    ) {
      this.registerRow(this.count - 1);
    } else {
      this.tableReady = false;
    }
  }

  async finish(): Promise<void> {
    throwIfAborted(this.signal);
    this.sealChunk();
    if (this.tableReady) return;
    this.allocateTable();
    let slice = performance.now();
    for (let row = 0; row < this.count; row++) {
      this.registerRow(row);
      if (row % 128 === 0 && performance.now() - slice >= SLICE_MS) {
        await yieldToMain('background');
        throwIfAborted(this.signal);
        slice = performance.now();
      }
    }
    this.tableReady = true;
  }

  private sealChunk(): void {
    if (!this.names.length) return;
    const data: string[] = [];
    for (let i = 0; i < this.names.length; i++)
      data.push(this.names[i], this.paths[i]);
    this.chunks.push({
      firstRow: this.sealedRows,
      rows: this.names.length,
      data: data.join(''),
      offsets: Uint32Array.from(this.dataOffsets),
      search: this.searchParts.join(''),
      searchOffsets: Uint32Array.from(this.searchOffsets),
    });
    this.sealedRows = this.count;
    this.names = [];
    this.paths = [];
    this.searchParts = [];
    this.dataOffsets = [0];
    this.searchOffsets = [0];
  }

  private allocateTable(): void {
    let capacity = 8;
    // 只按实际行数分配，损坏的 manifest 计数不能申请任意大的内存。
    // Allocate from actual rows, never an untrusted manifest's claimed count.
    const rows = this.count;
    while (capacity * 0.7 < rows) capacity *= 2;
    this.table = new Uint32Array(capacity);
    this.duplicateRows = undefined;
  }

  private registerRow(row: number): void {
    const name = this.nameAt(row).toLowerCase();
    const table = this.table!;
    const mask = table.length - 1;
    let slot = hashName(name) & mask;
    while (table[slot]) {
      const previous = table[slot] - 1;
      if (this.nameAt(previous).toLowerCase() === name) {
        (this.duplicateRows ??= new Map()).set(previous, row);
        return;
      }
      slot = (slot + 1) & mask;
    }
    table[slot] = row + 1;
  }

  private rowByName(name: string): number {
    if (!this.tableReady || !this.table) {
      for (let row = 0; row < this.count; row++) {
        if (this.nameAt(row).toLowerCase() === name) return row;
      }
      return -1;
    }
    const mask = this.table.length - 1;
    let slot = hashName(name) & mask;
    while (this.table[slot]) {
      const row = this.table[slot] - 1;
      if (this.nameAt(row).toLowerCase() === name) return row;
      slot = (slot + 1) & mask;
    }
    return -1;
  }

  getEntry(query: string): IconEntry | undefined {
    const key = query.toLowerCase();
    const prefix = this.prefix.toLowerCase();
    if (prefix && key.startsWith(prefix)) {
      const row = this.rowByName(key.slice(prefix.length));
      if (row !== -1) {
        const fullRow = this.duplicateRows?.get(row) ?? row;
        const override = this.overrides?.get(fullRow)?.id;
        if (!override || override.toLowerCase() === key)
          return this.entryAt(fullRow);
      }
    }
    const legacyRow = this.identifierOverrides?.get(key);
    if (legacyRow !== undefined) return this.entryAt(legacyRow);
    const row = this.rowByName(key);
    if (row !== -1) return this.entryAt(row);
    return undefined;
  }

  entryAt(row: number): IconEntry | undefined {
    if (row < 0 || row >= this.count || !Number.isInteger(row))
      return undefined;
    let name: string;
    let path: string;
    if (row >= this.sealedRows) {
      name = this.names[row - this.sealedRows];
      path = this.paths[row - this.sealedRows];
    } else {
      const chunk = this.chunkAt(row);
      const local = row - chunk.firstRow;
      name = chunk.data.slice(
        chunk.offsets[local * 2],
        chunk.offsets[local * 2 + 1],
      );
      path = chunk.data.slice(
        chunk.offsets[local * 2 + 1],
        chunk.offsets[local * 2 + 2],
      );
    }
    const override = this.overrides?.get(row);
    return {
      id: override?.id ?? this.prefix + name,
      name,
      path,
      displayName: override?.displayName ?? displayName(path),
      folder: override?.folder ?? this.folderFor(path),
    };
  }

  private folderFor(path: string): string {
    const dir = dirname(path);
    const root = this.folderRoot;
    return root && (dir === root || dir.startsWith(`${root}/`))
      ? dir.slice(Math.min(dir.length, root.length + 1))
      : dir;
  }

  private chunkAt(row: number): IndexChunk {
    let low = 0;
    let high = this.chunks.length - 1;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (this.chunks[middle].firstRow <= row) low = middle;
      else high = middle - 1;
    }
    return this.chunks[low];
  }

  private nameAt(row: number): string {
    if (row >= this.sealedRows) return this.names[row - this.sealedRows];
    const chunk = this.chunkAt(row);
    const local = (row - chunk.firstRow) * 2;
    return chunk.data.slice(chunk.offsets[local], chunk.offsets[local + 1]);
  }

  *[Symbol.iterator](): Generator<IconEntry> {
    for (let row = 0; row < this.count; row++) yield this.entryAt(row)!;
  }

  /**
   * 块内原生子串搜索只物化命中项；多词仍须在同一行内全部匹配。
   * Native substring search materializes only matches; all words must match the same row.
   */
  async forEachMatch(
    words: readonly string[],
    packName: string,
    visit: (entry: IconEntry) => boolean,
    cancelled: () => boolean,
  ): Promise<void> {
    this.sealChunk();
    const pack = packName.toLowerCase();
    const remaining = words.filter((word) => !pack.includes(word));
    const anchor = remaining.reduce(
      (longest, word) => (word.length > longest.length ? word : longest),
      '',
    );
    let slice = performance.now();
    let inspected = 0;
    for (const chunk of this.chunks) {
      if (cancelled()) return;
      let row = 0;
      while (row < chunk.rows) {
        if (cancelled()) return;
        if (anchor) {
          const position = chunk.search.indexOf(
            anchor,
            chunk.searchOffsets[row],
          );
          if (position === -1) break;
          let low = row;
          let high = chunk.rows - 1;
          while (low < high) {
            const middle = Math.ceil((low + high) / 2);
            if (chunk.searchOffsets[middle] <= position) low = middle;
            else high = middle - 1;
          }
          row = low;
        }
        const start = chunk.searchOffsets[row];
        const end = chunk.searchOffsets[row + 1] - 1;
        if (
          remaining.every((word) => {
            const position = chunk.search.indexOf(word, start);
            return position !== -1 && position + word.length <= end;
          }) &&
          !visit(this.entryAt(chunk.firstRow + row)!)
        )
          return;
        row++;
        if (++inspected % 128 === 0 && performance.now() - slice >= SLICE_MS) {
          await yieldToMain('user-visible');
          slice = performance.now();
        }
      }
      if (performance.now() - slice >= SLICE_MS) {
        await yieldToMain('user-visible');
        slice = performance.now();
      }
    }
  }

  /** 字串按 UTF-16 上限计数；实际 Chromium 的 ASCII 字串通常更小。 / Conservative UTF-16 storage estimate. */
  getStorageStats(): {
    entries: number;
    chunks: number;
    dataCharacters: number;
    searchCharacters: number;
    numericBytes: number;
    lookupBytes: number;
    textBytes: number;
    totalBytes: number;
    overrideEntries: number;
  } {
    const dataCharacters =
      this.chunks.reduce((total, chunk) => total + chunk.data.length, 0) +
      this.dataOffsets[this.dataOffsets.length - 1];
    const searchCharacters =
      this.chunks.reduce((total, chunk) => total + chunk.search.length, 0) +
      this.searchOffsets[this.searchOffsets.length - 1];
    const lookupBytes = this.table?.byteLength ?? 0;
    const numericBytes =
      lookupBytes +
      this.chunks.reduce(
        (total, chunk) =>
          total + chunk.offsets.byteLength + chunk.searchOffsets.byteLength,
        0,
      );
    const textBytes = (dataCharacters + searchCharacters) * 2;
    return {
      entries: this.count,
      chunks: this.chunks.length,
      dataCharacters,
      searchCharacters,
      numericBytes,
      lookupBytes,
      textBytes,
      totalBytes: numericBytes + textBytes,
      overrideEntries: this.overrides?.size ?? 0,
    };
  }
}
