import type { DataAdapter } from 'obsidian';
import { CompactIconIndex } from './compact-icon-index';
import {
  ICON_PACK_INDEX_VERSION,
  IconEntry,
  IconPackIndex,
  isIndexStale,
} from './icon-indexing';
import type { SourceFingerprint } from './icon-sources';
import { logger } from './logger';
import { throwIfAborted, yieldToMain } from './task-scheduler';

const PAGE_ROWS = 4096;
const PAGE_CHARS = 256 * 1024;
const MAX_PAGE_CHARS = 2 * 1024 * 1024;
const MAX_MANIFEST_CHARS = 64 * 1024;
const MAX_LEGACY_BYTES = 8 * 1024 * 1024;
interface IndexManifest {
  storageVersion: 1;
  generation: string;
  pages: number;
  count: number;
  version: number;
  packName: string;
  prefix: string;
  sourceType: 'zip' | 'folder';
  fingerprint: SourceFingerprint;
  builtAt: number;
}

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function metadata(
  value: unknown,
): value is Omit<IconPackIndex, 'entries'> & Record<string, unknown> {
  if (!object(value) || !object(value.fingerprint)) return false;
  const fingerprint = value.fingerprint;
  return (
    typeof value.packName === 'string' &&
    typeof value.prefix === 'string' &&
    value.prefix.length <= 256 &&
    (value.sourceType === 'zip' || value.sourceType === 'folder') &&
    typeof value.version === 'number' &&
    typeof value.builtAt === 'number' &&
    Number.isFinite(value.builtAt) &&
    ['size', 'mtime', 'count'].every(
      (key) =>
        typeof fingerprint[key] === 'number' &&
        Number.isFinite(fingerprint[key]),
    )
  );
}
function manifest(value: unknown): value is IndexManifest {
  return (
    metadata(value) &&
    object(value) &&
    value.storageVersion === 1 &&
    typeof value.generation === 'string' &&
    /^[a-z0-9]+-[a-z0-9]+$/.test(value.generation) &&
    Number.isSafeInteger(value.pages) &&
    Number.isSafeInteger(value.count) &&
    Number(value.pages) >= 0 &&
    Number(value.count) >= 0 &&
    Number(value.pages) <= Number(value.count)
  );
}

/** 小清单先校验指纹，分片读取元数据，避免巨型解析及百万对象峰值。
 * Check a small manifest first; page metadata into compact storage without a giant object graph. */
export class IconIndexStore {
  constructor(
    private adapter: DataAdapter,
    private indexPath: string,
    private signal?: AbortSignal,
  ) {}

  private paths(packName: string): {
    legacy: string;
    manifest: string;
    pages: string;
  } {
    if (
      !packName ||
      /[\\/\0]/.test(packName) ||
      packName === '.' ||
      packName === '..'
    )
      throw new Error('Invalid icon pack index name');
    return {
      legacy: `${this.indexPath}/${packName}.json`,
      manifest: `${this.indexPath}/${packName}.pages/manifest.json`,
      pages: `${this.indexPath}/${packName}.pages`,
    };
  }

  async ensureDirectory(): Promise<void> {
    if (!(await this.adapter.exists(this.indexPath)))
      await this.adapter.mkdir(this.indexPath);
  }

  async save(packName: string, index: IconPackIndex): Promise<void> {
    throwIfAborted(this.signal);
    const paths = this.paths(packName);
    await this.ensureDirectory();
    if (!(await this.adapter.exists(paths.pages)))
      await this.adapter.mkdir(paths.pages);
    const generation = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10) || '0'}`;
    let pages = 0,
      count = 0,
      chars = 0;
    let page: Array<[string, string]> = [];
    const flush = async () => {
      throwIfAborted(this.signal);
      if (!page.length) return;
      const serialized = JSON.stringify(page);
      if (serialized.length > MAX_PAGE_CHARS)
        throw new Error('Icon index page exceeds size limit');
      await this.adapter.write(
        `${paths.pages}/${generation}-${pages++}.json`,
        serialized,
      );
      page = [];
      chars = 0;
      await yieldToMain('background');
      throwIfAborted(this.signal);
    };
    for (const entry of index.entries) {
      if (count % 128 === 0) throwIfAborted(this.signal);
      if (entry.name.length + entry.path.length > 64 * 1024)
        throw new Error('Icon index row exceeds size limit');
      if (
        page.length &&
        (page.length >= PAGE_ROWS ||
          chars + entry.name.length + entry.path.length > PAGE_CHARS)
      )
        await flush();
      page.push([entry.name, entry.path]);
      chars += entry.name.length + entry.path.length;
      count++;
    }
    await flush();
    const header: IndexManifest = {
      storageVersion: 1,
      generation,
      pages,
      count,
      version: index.version,
      packName,
      prefix: index.prefix,
      sourceType: index.sourceType,
      fingerprint: index.fingerprint,
      builtAt: index.builtAt,
    };
    // 页面先写完，再更新清单；中断只使可重建索引失效，不涉及用户配置。
    // Commit manifest last; interrupted writes invalidate rebuildable cache, never user configuration.
    throwIfAborted(this.signal);
    await this.adapter.write(paths.manifest, JSON.stringify(header));
    if (await this.adapter.exists(paths.legacy))
      await this.adapter.remove(paths.legacy);
    const listing = await this.adapter.list(paths.pages);
    let removed = 0;
    for (const file of listing.files) {
      const name = file.substring(file.lastIndexOf('/') + 1);
      if (
        /^[a-z0-9]+-[a-z0-9]+-\d+\.json$/.test(name) &&
        !name.startsWith(`${generation}-`)
      ) {
        throwIfAborted(this.signal);
        await this.adapter.remove(file);
        if (++removed % 16 === 0) await yieldToMain('background');
      }
    }
  }

  async load(
    packName: string,
    current?: SourceFingerprint,
  ): Promise<IconPackIndex | null> {
    try {
      throwIfAborted(this.signal);
      const paths = this.paths(packName);
      if (!(await this.adapter.exists(paths.manifest)))
        return await this.loadLegacy(packName, current);
      const rawHeader = await this.readBounded(
        paths.manifest,
        MAX_MANIFEST_CHARS,
      );
      if (rawHeader === null) return null;
      const header: unknown = JSON.parse(rawHeader);
      if (
        !manifest(header) ||
        header.packName !== packName ||
        header.version !== ICON_PACK_INDEX_VERSION
      )
        return null;
      const compact = new CompactIconIndex(
        header.prefix,
        header.count,
        this.signal,
      );
      const index: IconPackIndex = { ...header, entries: compact };
      if (current && isIndexStale(index, current)) return null;
      for (let page = 0; page < header.pages; page++) {
        throwIfAborted(this.signal);
        const rawPage = await this.readBounded(
          `${paths.pages}/${header.generation}-${page}.json`,
          MAX_PAGE_CHARS,
        );
        if (rawPage === null) return null;
        const rows: unknown = JSON.parse(rawPage);
        if (!Array.isArray(rows) || rows.length > PAGE_ROWS || !rows.length)
          return null;
        for (const row of rows) {
          const entry = this.expand(header.prefix, row);
          if (!entry || compact.length >= header.count) return null;
          compact.append(entry);
        }
        await yieldToMain('background');
        throwIfAborted(this.signal);
      }
      if (compact.length !== header.count) return null;
      await compact.finish();
      return index;
    } catch (error) {
      throwIfAborted(this.signal);
      logger.error('[Iconize] Could not load icon index:', undefined, error);
      return null;
    }
  }

  private async readBounded(
    path: string,
    maxCharacters: number,
  ): Promise<string | null> {
    throwIfAborted(this.signal);
    const stat = await this.adapter.stat(path);
    throwIfAborted(this.signal);
    // UTF-8 每个 UTF-16 码元至多三字节；先限制读入量，再验证实际字符数。
    // UTF-8 needs at most three bytes per UTF-16 code unit; bound I/O before checking characters.
    if (
      !stat ||
      !Number.isFinite(stat.size) ||
      stat.size < 0 ||
      stat.size > maxCharacters * 3
    )
      return null;
    const raw = await this.adapter.read(path);
    throwIfAborted(this.signal);
    return raw.length > maxCharacters ? null : raw;
  }

  private expand(prefix: string, row: unknown): IconEntry | undefined {
    let name: string, path: string;
    if (
      Array.isArray(row) &&
      row.length === 2 &&
      typeof row[0] === 'string' &&
      typeof row[1] === 'string'
    )
      [name, path] = row;
    else if (
      object(row) &&
      typeof row.name === 'string' &&
      typeof row.path === 'string'
    ) {
      name = row.name;
      path = row.path;
    } else return undefined;
    if (name.length + path.length > 64 * 1024) return undefined;
    const slash = path.lastIndexOf('/');
    return {
      id: `${prefix}${name}`,
      name,
      path,
      displayName: path.substring(slash + 1).replace(/\.svg$/i, ''),
      folder: slash < 0 ? '' : path.substring(0, slash),
    };
  }

  private async loadLegacy(
    packName: string,
    current?: SourceFingerprint,
  ): Promise<IconPackIndex | null> {
    const paths = this.paths(packName);
    if (!(await this.adapter.exists(paths.legacy))) return null;
    throwIfAborted(this.signal);
    const stat = await this.adapter.stat(paths.legacy);
    if (stat && stat.size > MAX_LEGACY_BYTES) return null;
    // 老版单文件仅迁移一次；之后启动只读小清单和有界页面。
    // Migrate monolithic legacy JSON once; subsequent starts use bounded pages.
    const raw = await this.adapter.read(paths.legacy);
    throwIfAborted(this.signal);
    if (raw.length > MAX_LEGACY_BYTES) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      !metadata(parsed) ||
      !object(parsed) ||
      parsed.packName !== packName ||
      !Array.isArray(parsed.entries)
    )
      return null;
    const entries = new CompactIconIndex(
      parsed.prefix,
      parsed.entries.length,
      this.signal,
    );
    const index: IconPackIndex = {
      version: parsed.version,
      packName,
      prefix: parsed.prefix,
      sourceType: parsed.sourceType,
      fingerprint: parsed.fingerprint,
      builtAt: parsed.builtAt,
      entries,
    };
    if (isIndexStale(index, current ?? parsed.fingerprint)) return null;
    let slice = performance.now();
    for (let i = 0; i < parsed.entries.length; i++) {
      const entry = this.expand(parsed.prefix, parsed.entries[i]);
      if (!entry) return null;
      entries.append(entry);
      parsed.entries[i] = null;
      if (i % 128 === 0 && performance.now() - slice >= 4) {
        await yieldToMain('background');
        throwIfAborted(this.signal);
        slice = performance.now();
      }
    }
    await entries.finish();
    try {
      await this.save(packName, index);
    } catch (error) {
      logger.error(
        '[Iconize] Could not migrate legacy icon index cache:',
        undefined,
        error,
      );
    }
    return index;
  }

  async delete(packName: string): Promise<void> {
    const paths = this.paths(packName);
    for (const file of [paths.legacy, paths.manifest])
      if (await this.adapter.exists(file)) await this.adapter.remove(file);
    if (await this.adapter.exists(paths.pages))
      await this.adapter.rmdir(paths.pages, true);
  }

  async listIndexedPacks(): Promise<string[]> {
    if (!(await this.adapter.exists(this.indexPath))) return [];
    const listing = await this.adapter.list(this.indexPath);
    return [
      ...new Set([
        ...listing.files
          .filter((file) => file.endsWith('.json'))
          .map((file) =>
            file
              .substring(file.lastIndexOf('/') + 1)
              .replace(/(?:\.manifest)?\.json$/, ''),
          ),
        ...listing.folders
          .filter((folder) => folder.endsWith('.pages'))
          .map((folder) =>
            folder.substring(folder.lastIndexOf('/') + 1).slice(0, -6),
          ),
      ]),
    ];
  }

  async clearAll(): Promise<void> {
    if (await this.adapter.exists(this.indexPath))
      await this.adapter.rmdir(this.indexPath, true);
  }
}
