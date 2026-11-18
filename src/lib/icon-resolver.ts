/** 按需解析，所有 SVG 缓存均有数量和字节上限。 / Demand loading with bounded SVG caches. */
import type IconizePlugin from '@app/main';
import type { Icon } from '@app/icon-pack-manager';
import type { IconEntry } from './icon-indexing';
import type { IconSource } from './icon-sources';
import { logger } from './logger';
import { yieldToMain } from './task-scheduler';
import svg from './util/svg';

export interface ResolveOptions {
  persist?: boolean;
  foreground?: string | null;
}

export interface LocatedIcon {
  packName: string;
  prefix: string;
  entry: IconEntry;
  source: IconSource;
}

/** 与图标包共享查找表，不再为每个图标建立第二份索引。 / Share the pack's lookup. */
export interface IconEntryLookup {
  readonly length: number;
  getEntry(query: string): IconEntry | undefined;
}

export type ResolvedIcon = Icon;

export interface IconCacheLimits {
  memoryBytes: number;
  memoryEntries: number;
  previewBytes: number;
  previewEntries: number;
  diskBytes: number;
  diskEntries: number;
}

export const DEFAULT_ICON_CACHE_LIMITS: Readonly<IconCacheLimits> = {
  memoryBytes: 4 * 1024 * 1024,
  memoryEntries: 2048,
  previewBytes: 512 * 1024,
  previewEntries: 128,
  diskBytes: 2 * 1024 * 1024,
  diskEntries: 2048,
};

/** UTF-16 文本及少量对象开销的保守预算。 / Conservative UTF-16 and object accounting. */
function iconBytes(icon: ResolvedIcon): number {
  return (
    256 +
    2 *
      (icon.svgElement.length +
        (icon.svgContent === icon.svgElement ? 0 : icon.svgContent.length) +
        icon.name.length +
        icon.prefix.length +
        icon.displayName.length +
        (icon.iconPackName?.length ?? 0))
  );
}

class BoundedCache<T> {
  readonly entries = new Map<string, T>();
  bytes = 0;

  constructor(
    private readonly maxBytes: number,
    private readonly maxEntries: number,
    private readonly weight: (value: T, key: string) => number,
  ) {}

  get(key: string): T | undefined {
    const value = this.entries.get(key);
    if (value !== undefined) {
      this.entries.delete(key);
      this.entries.set(key, value);
    }
    return value;
  }

  set(key: string, value: T): boolean {
    this.delete(key);
    const bytes = this.weight(value, key);
    if (bytes > this.maxBytes || this.maxEntries < 1) return false;
    this.entries.set(key, value);
    this.bytes += bytes;
    while (this.bytes > this.maxBytes || this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.delete(oldest);
    }
    return true;
  }

  delete(key: string): boolean {
    const value = this.entries.get(key);
    if (value === undefined) return false;
    this.bytes -= this.weight(value, key);
    return this.entries.delete(key);
  }

  clear(): void {
    this.entries.clear();
    this.bytes = 0;
  }
}

interface RegisteredPack {
  name: string;
  prefix: string;
  lowerPrefix: string;
  lookup: IconEntryLookup;
  source: IconSource;
}

interface DiskIcon {
  packName: string;
  svgElement: string;
}

interface ResolveJob {
  key: string;
  located: LocatedIcon;
  generation: number;
  persist: boolean;
  promise: Promise<ResolvedIcon | null>;
  complete: (icon: ResolvedIcon | null) => void;
}

const HOT_LOOKUP_LIMIT = 512;
const MAX_CONCURRENT_LOADS = 2;
const SLICE_MS = 4;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export class IconResolver {
  private readonly limits: IconCacheLimits;
  private readonly memory: BoundedCache<ResolvedIcon>;
  private readonly previews: BoundedCache<ResolvedIcon>;
  private readonly packs = new Map<string, RegisteredPack>();
  private readonly hotLookup = new Map<string, LocatedIcon>();
  private readonly inFlight = new Map<string, ResolveJob>();
  private pending: ResolveJob[] = [];
  private activeLoads = 0;
  private deadline = 0;
  private generation = 0;
  private disposed = false;
  private disposal: Promise<void> | null = null;
  private diskCache: BoundedCache<DiskIcon> | null = null;
  private diskCacheLoad: Promise<BoundedCache<DiskIcon>> | null = null;
  private diskGeneration = 0;
  private diskCacheDirty = false;
  private flushTimer: number | null = null;
  private flushing: Promise<void> | null = null;
  private directoryReady = false;

  constructor(
    private readonly plugin: IconizePlugin,
    private readonly diskCachePath: string,
    limits: Partial<IconCacheLimits> = {},
  ) {
    this.limits = { ...DEFAULT_ICON_CACHE_LIMITS, ...limits };
    this.memory = new BoundedCache(
      this.limits.memoryBytes,
      this.limits.memoryEntries,
      iconBytes,
    );
    this.previews = new BoundedCache(
      this.limits.previewBytes,
      this.limits.previewEntries,
      iconBytes,
    );
  }

  /** 保留既有诊断接口；键始终是规范 id。 / Retain the existing canonical-key map API. */
  get memoryCache(): Map<string, ResolvedIcon> {
    return this.memory.entries;
  }

  private createDiskCache(): BoundedCache<DiskIcon> {
    return new BoundedCache(
      this.limits.diskBytes,
      this.limits.diskEntries,
      (value, key) =>
        128 +
        2 * (key.length + value.packName.length + value.svgElement.length),
    );
  }

  /** 所有并发请求等待同一个读取任务，不能提前发布空表。 / Publish only the fully loaded cache. */
  private ensureDiskCacheLoaded(): Promise<BoundedCache<DiskIcon>> {
    if (this.diskCacheLoad) return this.diskCacheLoad;
    if (this.diskCache) return Promise.resolve(this.diskCache);
    if (this.disposed) return Promise.resolve(this.createDiskCache());
    const generation = this.diskGeneration;
    const cache = this.createDiskCache();
    const loading = this.readDiskCache(cache, generation);
    this.diskCacheLoad = loading;
    void loading.then(() => {
      if (this.diskCacheLoad === loading) this.diskCacheLoad = null;
    });
    return loading;
  }

  private async readDiskCache(
    cache: BoundedCache<DiskIcon>,
    generation: number,
  ): Promise<BoundedCache<DiskIcon>> {
    try {
      const adapter = this.plugin.app.vault.adapter;
      const stat = await adapter.stat(this.diskCachePath);
      // 旧版本可能留下巨型缓存，先 stat 再读，避免仅迁移就占用大量内存。
      // Check size before reading a potentially unbounded legacy cache.
      const maxFileBytes = Math.max(1024, this.limits.diskBytes * 2);
      if (
        stat &&
        stat.size <= maxFileBytes &&
        !this.disposed &&
        generation === this.diskGeneration
      ) {
        this.directoryReady = true;
        const raw = await adapter.read(this.diskCachePath);
        if (
          raw.length <= maxFileBytes &&
          !this.disposed &&
          generation === this.diskGeneration
        ) {
          const parsed: unknown = JSON.parse(raw);
          const rows: unknown[] =
            record(parsed) &&
            parsed.version === 2 &&
            Array.isArray(parsed.entries)
              ? parsed.entries
              : record(parsed)
                ? Object.entries(parsed)
                : [];
          let deadline = performance.now() + SLICE_MS;
          for (const row of rows) {
            if (this.disposed || generation !== this.diskGeneration) break;
            if (Array.isArray(row) && typeof row[0] === 'string') {
              if (
                row.length === 3 &&
                typeof row[1] === 'string' &&
                typeof row[2] === 'string' &&
                row[2]
              ) {
                cache.set(row[0], { packName: row[1], svgElement: row[2] });
              } else if (
                record(row[1]) &&
                typeof row[1].iconPackName === 'string' &&
                typeof row[1].svgElement === 'string' &&
                row[1].svgElement
              ) {
                cache.set(row[0], {
                  packName: row[1].iconPackName,
                  svgElement: row[1].svgElement,
                });
              }
            }
            if (performance.now() >= deadline) {
              await yieldToMain('background');
              deadline = performance.now() + SLICE_MS;
            }
          }
        }
      }
    } catch (error) {
      logger.warn('Could not read the icon cache', undefined, error);
    }
    if (!this.disposed && generation === this.diskGeneration)
      this.diskCache = cache;
    return cache;
  }

  private scheduleFlush(): void {
    this.diskCacheDirty = true;
    if (this.disposed || this.flushTimer !== null || this.flushing) return;
    this.flushTimer = window.setTimeout(() => {
      this.flushTimer = null;
      void this.flushDiskCache();
    }, 1500);
  }

  /** 一个有界文件，写入串行化；每项仅存一份 SVG。 / One bounded file, serialized writes, one SVG per row. */
  private async flushDiskCache(onDispose = false): Promise<void> {
    if (this.flushing) {
      await this.flushing;
      return this.flushDiskCache(onDispose);
    }
    if (
      !this.diskCacheDirty ||
      !this.diskCache ||
      (this.disposed && !onDispose)
    )
      return;
    const cache = this.diskCache;
    const generation = this.diskGeneration;
    this.diskCacheDirty = false;
    let failed = false;
    const writing = (async () => {
      try {
        await yieldToMain('background');
        if (generation !== this.diskGeneration) return;
        if (this.disposed && !onDispose) {
          this.diskCacheDirty = true;
          return;
        }
        const entries: Array<[string, string, string]> = [];
        for (const [id, value] of cache.entries)
          entries.push([id, value.packName, value.svgElement]);
        const content = JSON.stringify({ version: 2, entries });
        const dir = this.diskCachePath.substring(
          0,
          this.diskCachePath.lastIndexOf('/'),
        );
        if (dir) await this.ensureDirectoryPath(dir);
        if (generation !== this.diskGeneration) return;
        if (this.disposed && !onDispose) {
          this.diskCacheDirty = true;
          return;
        }
        await this.plugin.app.vault.adapter.write(this.diskCachePath, content);
      } catch (error) {
        failed = true;
        this.directoryReady = false;
        if (generation === this.diskGeneration) this.diskCacheDirty = true;
        logger.error('Failed to write the icon cache', undefined, error);
      }
    })();
    this.flushing = writing;
    await writing;
    if (this.flushing === writing) this.flushing = null;
    if (this.diskCacheDirty && !this.disposed && !failed) this.scheduleFlush();
  }

  async registerPack(
    packName: string,
    prefix: string,
    entries: IconEntry[] | IconEntryLookup,
    source: IconSource,
  ): Promise<void> {
    if (this.disposed) return;
    let lookup: IconEntryLookup;
    if (Array.isArray(entries)) {
      // 兼容旧 API；正常启动直接共享 IconPack 的紧凑查找表。
      // Legacy array callers remain supported; normal startup shares the pack lookup.
      const byKey = new Map<string, IconEntry>();
      let deadline = performance.now() + SLICE_MS;
      for (const entry of entries) {
        byKey.set(entry.id.toLowerCase(), entry);
        if (performance.now() >= deadline) {
          await yieldToMain('background');
          if (this.disposed) return;
          deadline = performance.now() + SLICE_MS;
        }
      }
      for (const entry of entries) {
        const key = entry.name.toLowerCase();
        if (!byKey.has(key)) byKey.set(key, entry);
        if (performance.now() >= deadline) {
          await yieldToMain('background');
          if (this.disposed) return;
          deadline = performance.now() + SLICE_MS;
        }
      }
      lookup = {
        length: entries.length,
        getEntry: (query) => byKey.get(query.toLowerCase()),
      };
    } else {
      lookup = entries;
    }
    this.cancelPending();
    this.hotLookup.clear();
    this.packs.delete(packName);
    this.packs.set(packName, {
      name: packName,
      prefix,
      lowerPrefix: prefix.toLowerCase(),
      lookup,
      source,
    });
  }

  /** 两阶段查询使任何包的全 id 都优先于另一包的裸名。 / Full ids win across prefix collisions. */
  find(iconId: string): LocatedIcon | undefined {
    if (!iconId || this.disposed) return undefined;
    const key = iconId.toLowerCase();
    const cached = this.hotLookup.get(key);
    if (cached) return cached;
    let found: LocatedIcon | undefined;
    for (const pack of this.packs.values()) {
      if (!key.startsWith(pack.lowerPrefix)) continue;
      const entry = pack.lookup.getEntry(key);
      if (entry?.id.toLowerCase() === key)
        found = {
          packName: pack.name,
          prefix: pack.prefix,
          entry,
          source: pack.source,
        };
    }
    if (!found) {
      for (const pack of this.packs.values()) {
        const entry = pack.lookup.getEntry(key);
        if (entry?.name.toLowerCase() === key) {
          found = {
            packName: pack.name,
            prefix: pack.prefix,
            entry,
            source: pack.source,
          };
          break;
        }
      }
    }
    if (found) {
      this.hotLookup.set(key, found);
      if (this.hotLookup.size > HOT_LOOKUP_LIMIT) {
        const first = this.hotLookup.keys().next().value as string | undefined;
        if (first !== undefined) this.hotLookup.delete(first);
      }
    }
    return found;
  }

  peek(iconId: string): ResolvedIcon | undefined {
    const located = this.find(iconId);
    if (!located) return undefined;
    const cached =
      this.memory.get(located.entry.id) ?? this.previews.get(located.entry.id);
    if (cached && cached.iconPackName !== located.packName) {
      this.memory.delete(located.entry.id);
      this.previews.delete(located.entry.id);
      return undefined;
    }
    return cached;
  }

  private remember(key: string, icon: ResolvedIcon, persist: boolean): void {
    if (persist) {
      this.previews.delete(key);
      this.memory.set(key, icon);
    } else if (!this.memory.get(key)) {
      this.previews.set(key, icon);
    }
  }

  async resolve(
    iconId: string,
    options: ResolveOptions = {},
  ): Promise<ResolvedIcon | null> {
    if (this.disposed) return null;
    const located = this.find(iconId);
    if (!located) return null;
    const key = located.entry.id;
    const generation = this.generation;
    const persist = options.persist ?? true;
    const memoized = this.peek(key);
    let result: ResolvedIcon | null;
    if (memoized) {
      if (persist && !this.memory.entries.has(key)) {
        this.remember(key, memoized, true);
        await this.saveToDiskCache(key, memoized);
      }
      result =
        this.disposed || generation !== this.generation ? null : memoized;
    } else {
      let job = this.inFlight.get(key);
      if (job) {
        job.persist ||= persist;
      } else {
        // executor 的初始化同步发生，排入队列后才启动 I/O。 / Initialize synchronously before starting I/O.
        const pendingJob = {} as ResolveJob;
        const promise = new Promise<ResolvedIcon | null>((complete) => {
          Object.assign(pendingJob, {
            key,
            located,
            persist,
            generation: this.generation,
            complete,
          });
        });
        pendingJob.promise = promise;
        job = pendingJob;
        this.inFlight.set(key, job);
        this.pending.push(job);
        this.drain();
      }
      result = await job.promise;
    }
    // 颜色属于调用方，不能污染所有 alias 共用的 SVG 缓存。
    // Foreground colors belong to a caller, never to the shared canonical cache.
    return result && options.foreground
      ? {
          ...result,
          svgElement: svg.colorize(result.svgElement, options.foreground),
        }
      : result;
  }

  private drain(): void {
    while (
      !this.disposed &&
      this.activeLoads < MAX_CONCURRENT_LOADS &&
      this.pending.length
    ) {
      const job = this.pending.shift();
      if (!job) break;
      this.activeLoads++;
      void this.load(job).then((icon) => {
        job.complete(icon);
        this.activeLoads--;
        if (this.inFlight.get(job.key) === job) this.inFlight.delete(job.key);
        this.drain();
      });
    }
  }

  private current(job: ResolveJob): boolean {
    return !this.disposed && job.generation === this.generation;
  }

  /** 只校验真正请求的 SVG，不解析索引元数据或已命中的内存缓存。
   * Validate only requested SVGs, never index metadata or memory-cache hits. */
  private normalizeSvg(markup: string): string | null {
    const parsed = new DOMParser().parseFromString(markup, 'image/svg+xml');
    const root = parsed.documentElement;
    if (
      !root ||
      root.localName !== 'svg' ||
      (root.namespaceURI &&
        root.namespaceURI !== 'http://www.w3.org/2000/svg') ||
      parsed.querySelector('parsererror')
    )
      return null;
    // symbol/defs 本身不绘制；只有其外部的图形或 use 才能形成独立图标。
    // Definitions do not paint by themselves; a visible shape or use must exist outside them.
    if (
      root.querySelector('symbol, defs') &&
      !Array.from(
        root.querySelectorAll(
          'path, rect, circle, ellipse, line, polyline, polygon, text, image, use, foreignObject',
        ),
      ).some(
        (element) =>
          !element.closest('symbol, defs, clipPath, mask, pattern, marker'),
      )
    )
      return null;
    return svg.extract(markup) || null;
  }

  private async load(job: ResolveJob): Promise<ResolvedIcon | null> {
    try {
      if (performance.now() >= this.deadline) {
        await yieldToMain('user-visible');
        this.deadline = performance.now() + SLICE_MS;
      }
      if (!this.current(job)) return null;
      // 目录 mtime 不代表嵌套 SVG 的内容版本；目录包每会话按需读源。
      // A directory timestamp cannot validate nested SVG contents across sessions.
      const cache =
        job.located.source.type === 'folder'
          ? null
          : await this.ensureDiskCacheLoaded();
      if (!this.current(job)) return null;
      const cached = cache?.get(job.key);
      let normalized: string | null = null;
      if (cached?.packName === job.located.packName) {
        try {
          normalized = this.normalizeSvg(cached.svgElement);
        } catch (error) {
          logger.warn(
            'Invalid cached SVG; reading the icon source',
            undefined,
            error,
          );
        }
        if (!normalized && cache) {
          cache.delete(job.key);
          this.scheduleFlush();
        }
      }
      if (!normalized) {
        const markup = await job.located.source.readEntry(
          job.located.entry.path,
        );
        if (!this.current(job)) return null;
        if (markup === null) return null;
        if (performance.now() >= this.deadline) {
          await yieldToMain('user-visible');
          this.deadline = performance.now() + SLICE_MS;
        }
        if (!this.current(job)) return null;
        normalized = this.normalizeSvg(markup);
        if (!normalized) return null;
      }
      const icon = this.fromNormalized(job.located, normalized);
      if (!this.current(job)) return null;
      this.remember(job.key, icon, job.persist);
      if (job.persist && cache) {
        cache.set(job.key, {
          packName: job.located.packName,
          svgElement: icon.svgElement,
        });
        this.scheduleFlush();
      }
      return icon;
    } catch (error) {
      if (this.current(job))
        logger.error('Failed to resolve an icon', undefined, error);
      return null;
    }
  }

  async prefetch(
    iconIds: string[],
    limit = 128,
    signal?: AbortSignal,
  ): Promise<{ loaded: number; failed: string[]; skipped: number }> {
    const failed: string[] = [];
    const seen = new Set<string>();
    const generation = this.generation;
    let loaded = 0;
    let visited = 0;
    let processed = 0;
    const maximum = Number.isFinite(limit)
      ? Math.max(0, Math.floor(limit))
      : 128;
    let deadline = performance.now() + SLICE_MS;
    for (const iconId of iconIds) {
      if (
        this.disposed ||
        generation !== this.generation ||
        signal?.aborted ||
        processed >= maximum
      )
        break;
      if (performance.now() >= deadline) {
        await yieldToMain('background');
        deadline = performance.now() + SLICE_MS;
        if (this.disposed || generation !== this.generation || signal?.aborted)
          break;
      }
      visited++;
      const key = this.find(iconId)?.entry.id ?? iconId;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      processed++;
      if (await this.resolve(key)) loaded++;
      else failed.push(iconId);
      if (performance.now() >= deadline) {
        await yieldToMain('background');
        deadline = performance.now() + SLICE_MS;
      }
    }
    return { loaded, failed, skipped: iconIds.length - visited };
  }

  async resolveSvg(iconId: string): Promise<string | undefined> {
    return (await this.resolve(iconId))?.svgElement || undefined;
  }

  private fromNormalized(
    located: LocatedIcon,
    normalized: string,
  ): ResolvedIcon {
    return {
      name: located.entry.name,
      prefix: located.prefix,
      displayName: located.entry.displayName,
      iconPackName: located.packName,
      filename: located.entry.name,
      svgContent: normalized,
      svgViewbox: extractViewBox(normalized),
      svgElement: normalized,
    };
  }

  async saveToDiskCache(iconId: string, icon: ResolvedIcon): Promise<void> {
    if (this.disposed || !icon.iconPackName) return;
    const located = this.find(iconId);
    if (located?.source.type === 'folder') return;
    const generation = this.generation;
    const cache = await this.ensureDiskCacheLoaded();
    if (this.disposed || generation !== this.generation) return;
    const key = located?.entry.id ?? iconId;
    cache.set(key, {
      packName: icon.iconPackName,
      svgElement: icon.svgElement,
    });
    this.scheduleFlush();
  }

  private async ensureDirectoryPath(path: string): Promise<void> {
    if (this.directoryReady) return;
    let current = '';
    for (const part of path.split('/')) {
      current = current ? `${current}/${part}` : part;
      if (!(await this.plugin.app.vault.adapter.exists(current)))
        await this.plugin.app.vault.adapter.mkdir(current);
    }
    this.directoryReady = true;
  }

  private cancelPending(): void {
    this.generation++;
    for (const job of this.inFlight.values()) job.complete(null);
    this.pending = [];
    this.inFlight.clear();
  }

  clearMemoryCache(): void {
    this.cancelPending();
    this.memory.clear();
    this.previews.clear();
  }

  async clearDiskCache(): Promise<void> {
    this.cancelPending();
    this.diskGeneration++;
    if (this.flushTimer !== null) window.clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.diskCacheDirty = false;
    this.diskCache = this.createDiskCache();
    this.diskCacheLoad = null;
    try {
      if (this.flushing) await this.flushing;
      if (await this.plugin.app.vault.adapter.exists(this.diskCachePath))
        await this.plugin.app.vault.adapter.remove(this.diskCachePath);
    } catch (error) {
      logger.error('Failed to clear the icon cache', undefined, error);
    }
  }

  async removePackCache(packName: string): Promise<void> {
    this.cancelPending();
    this.hotLookup.clear();
    this.packs.delete(packName);
    for (const cache of [this.memory, this.previews]) {
      for (const [id, icon] of cache.entries)
        if (icon.iconPackName === packName) cache.delete(id);
    }
    const cache = await this.ensureDiskCacheLoaded();
    if (this.disposed) return;
    let changed = false;
    for (const [id, value] of cache.entries)
      if (value.packName === packName) changed = cache.delete(id) || changed;
    if (changed) this.scheduleFlush();
  }

  /** 卸载先失效所有任务，串行结束已开始的写盘，再释放引用。 / Invalidate work, finish writes, release references. */
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.disposed = true;
    this.cancelPending();
    if (this.flushTimer !== null) window.clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.disposal = this.flushDiskCache(true).then(() => {
      this.diskGeneration++;
      this.memory.clear();
      this.previews.clear();
      this.hotLookup.clear();
      this.packs.clear();
      this.diskCache?.clear();
      this.diskCache = null;
      this.diskCacheLoad = null;
    });
    return this.disposal;
  }

  getCacheStats(): {
    memorySize: number;
    previewSize: number;
    lookupSize: number;
    memoryBytes: number;
    previewBytes: number;
    diskSize: number;
    diskBytes: number;
    packCount: number;
    inFlight: number;
  } {
    let lookupSize = 0;
    for (const pack of this.packs.values()) lookupSize += pack.lookup.length;
    return {
      memorySize: this.memory.entries.size,
      previewSize: this.previews.entries.size,
      lookupSize,
      memoryBytes: this.memory.bytes,
      previewBytes: this.previews.bytes,
      diskSize: this.diskCache?.entries.size ?? 0,
      diskBytes: this.diskCache?.bytes ?? 0,
      packCount: this.packs.size,
      inFlight: this.inFlight.size,
    };
  }
}

function extractViewBox(markup: string): string {
  return markup.match(/viewBox=["']([^"']+)["']/i)?.[1] ?? '';
}

export type { IconEntry };
