/**
 * IconResolver - 图标解析器（三层缓存架构）
 * Icon Resolver with three-tier cache architecture.
 *
 * 解析按三层依次尝试，命中即止：
 * 1. **内存** — 本次会话已解析过，同步返回，是渲染路径依赖的那一层。
 * 2. **磁盘缓存** — 上次会话解析过，一次小文件读取。
 * 3. **图标包本身** — 该图标首次使用，读取该条目并写入磁盘缓存，之后不再走到这一层。
 *
 * Resolution walks three tiers and stops at the first hit; the practical effect
 * is that a vault only ever pays for the icons it actually uses.
 */

import IconizePlugin from '@app/main';
import svg from './util/svg';
import { IconEntry } from './icon-indexing';
import { IconSource } from './icon-sources';
import { Icon } from '@app/icon-pack-manager';

// ===== PATCHED: 解析器类型 / Resolver types =====
export interface ResolveOptions {
  /** 是否写入磁盘缓存 / Whether to write the result to the on-disk cache. */
  persist?: boolean;
  /** 图标颜色 / Color to draw the icon in. */
  foreground?: string | null;
}

/** 一个已定位的图标：它属于哪个包、条目是什么、字节从哪里读。 */
export interface LocatedIcon {
  packName: string;
  prefix: string;
  entry: IconEntry;
  source: IconSource;
}

/** 已解析的图标，形状与 Iconize 既有 Icon 接口保持一致。 */
export type ResolvedIcon = Icon;
// ===== END PATCH =====

/** 预览图标在内存中最多保留的数量。 */
const PREVIEW_MEMORY_LIMIT = 400;

export class IconResolver {
  private plugin: IconizePlugin;

  /** 仓库实际使用的图标，无上限：渲染需要它们，数量只等于仓库引用数。 */
  public memoryCache: Map<string, ResolvedIcon>;

  /** 仅为绘制预览而解析的图标，有上限且从不写盘。 */
  private previews: Map<string, ResolvedIcon>;

  private diskCachePath: string;

  /** 图标 id（小写）到定位信息的查找表。 */
  private lookup: Map<string, LocatedIcon>;

  constructor(plugin: IconizePlugin, diskCachePath: string) {
    this.plugin = plugin;
    this.memoryCache = new Map();
    this.previews = new Map();
    this.diskCachePath = diskCachePath;
    this.lookup = new Map();
  }

  /**
   * 登记一个图标包的全部条目 / Register every entry of one pack for lookup.
   */
  registerPack(
    packName: string,
    prefix: string,
    entries: IconEntry[],
    source: IconSource,
  ): void {
    for (const entry of entries) {
      const located: LocatedIcon = { packName, prefix, entry, source };
      this.lookup.set(entry.id.toLowerCase(), located);
      // 裸名作为次级键，真正的 id 始终优先于恰好长得像 id 的名称。
      const nameKey = entry.name.toLowerCase();
      if (!this.lookup.has(nameKey)) {
        this.lookup.set(nameKey, located);
      }
    }
  }

  /**
   * 定位一个图标 / Finds an icon by its full identifier or bare name.
   */
  find(iconId: string): LocatedIcon | undefined {
    if (!iconId) {
      return undefined;
    }
    return this.lookup.get(iconId.toLowerCase());
  }

  /**
   * 同步查询 - 仅返回已加载到内存的图标 / Synchronous peek.
   *
   * 渲染路径是同步的、无法 await，因此依赖这一层；仓库用到的图标会在启动时预取。
   */
  peek(iconId: string): ResolvedIcon | undefined {
    return this.memoryCache.get(iconId) ?? this.previews.get(iconId);
  }

  /**
   * 记录一个已解析的图标到合适的分层 / Records a resolved icon in its tier.
   */
  private remember(iconId: string, icon: ResolvedIcon, persist: boolean): void {
    if (persist) {
      this.previews.delete(iconId);
      this.memoryCache.set(iconId, icon);
      return;
    }

    this.previews.set(iconId, icon);
    while (this.previews.size > PREVIEW_MEMORY_LIMIT) {
      const oldest = this.previews.keys().next().value as string | undefined;
      if (oldest === undefined) {
        break;
      }
      this.previews.delete(oldest);
    }
  }

  /**
   * 异步解析 - 仅在必要时读取图标包 / Resolves an icon, reading from the pack only if it has to.
   */
  async resolve(
    iconId: string,
    options: ResolveOptions = {},
  ): Promise<ResolvedIcon | null> {
    const persist = options.persist ?? true;

    try {
      const located = this.find(iconId);
      if (!located) {
        return null;
      }

      // 磁盘缓存一律以条目 id 为键，而不是调用方传进来的字符串。
      // 同一个图标可能以裸名（`home`）、大小写变体（`lihome`）等不同形式被查找，
      // 用查询串做键会为同一个图标写出多份文件，且无法逐条失效。
      //
      // The disk cache is always keyed by the entry id rather than the caller's string:
      // the same icon is looked up as a bare name or in another case, and keying on the
      // query would write several files for one icon with no way to invalidate them.
      const cacheKey = located.entry.id;

      const memoized = this.peek(iconId);
      if (memoized) {
        // 之前只作为预览解析过的图标，现在真正被使用，提升并写盘。
        if (persist && !this.memoryCache.has(iconId)) {
          this.remember(iconId, memoized, true);
          await this.saveToDiskCache(cacheKey, memoized);
        }
        return memoized;
      }

      // Layer 2: 磁盘缓存。
      const cached = await this.loadFromDiskCache(cacheKey);
      if (cached) {
        this.remember(iconId, cached, persist);
        return cached;
      }

      // Layer 3: 从图标包本身读取该条目。
      const markup = await located.source.readEntry(located.entry.path);
      if (markup === null) {
        console.error(
          `[IconResolver] Icon '${located.entry.id}' is missing from pack '${located.packName}' (path: ${located.entry.path})`,
        );
        return null;
      }

      const icon = this.build(located, markup);
      if (!icon) {
        return null;
      }

      // 颜色在规范化之后应用：是规范化给了标记一个可覆盖的绘制属性。
      if (options.foreground) {
        icon.svgElement = svg.colorize(icon.svgElement, options.foreground);
      }

      this.remember(iconId, icon, persist);
      if (persist) {
        await this.saveToDiskCache(cacheKey, icon);
      }

      return icon;
    } catch (error) {
      console.error(`[IconResolver] Failed to resolve ${iconId}:`, error);
      return null;
    }
  }

  /**
   * 批量预加载图标 / Resolves many icons in one batch.
   */
  async prefetch(
    iconIds: string[],
  ): Promise<{ loaded: number; failed: string[] }> {
    const uniqueIds = [...new Set(iconIds)];
    const failed: string[] = [];
    let loaded = 0;

    for (const iconId of uniqueIds) {
      if (!iconId) {
        continue;
      }

      try {
        const icon = await this.resolve(iconId);
        if (icon) {
          loaded++;
        } else {
          failed.push(iconId);
        }
      } catch (error) {
        console.error(`[IconResolver] Prefetch failed for ${iconId}:`, error);
        failed.push(iconId);
      }
    }

    console.log(
      `[IconResolver] Prefetch complete: ${loaded} loaded, ${failed.length} failed`,
    );
    return { loaded, failed };
  }

  /**
   * 只取图标标记，供同步渲染路径在内存未命中时异步补齐。
   * Resolves just the markup, for the synchronous render path to fill in asynchronously.
   */
  async resolveSvg(iconId: string): Promise<string | undefined> {
    const icon = await this.resolve(iconId);
    return icon?.svgElement || undefined;
  }

  /**
   * 通过规范化标记构建图标对象 / Builds the icon object from normalized markup.
   */
  private build(located: LocatedIcon, markup: string): ResolvedIcon | null {
    const svgElement = svg.extract(markup);
    if (!svgElement) {
      return null;
    }

    return {
      name: located.entry.name,
      prefix: located.prefix,
      displayName: located.entry.displayName,
      iconPackName: located.packName,
      filename: located.entry.name,
      svgContent: markup,
      svgViewbox: extractViewBox(markup),
      svgElement,
    };
  }

  /**
   * 磁盘缓存路径 / Path of a cached icon.
   */
  private cachePathOf(iconId: string): string {
    return `${this.diskCachePath}/${iconId}.json`;
  }

  private async loadFromDiskCache(
    iconId: string,
  ): Promise<ResolvedIcon | null> {
    try {
      const path = this.cachePathOf(iconId);
      if (!(await this.plugin.app.vault.adapter.exists(path))) {
        return null;
      }
      const content = await this.plugin.app.vault.adapter.read(path);
      const parsed = JSON.parse(content);

      // 缓存条目必须自带可用标记：截断写入或旧格式会解析出 `{}`，
      // 若当作命中返回，调用方会把 `undefined` 写进 DOM，渲染出字符串 "undefined"。
      //
      // A cache entry must carry usable markup: a truncated write or an older schema
      // parses to `{}`, and returning that as a hit makes the caller write `undefined`
      // into the DOM, rendering the literal text "undefined".
      if (
        !parsed ||
        typeof parsed.svgElement !== 'string' ||
        parsed.svgElement === ''
      ) {
        return null;
      }

      return parsed;
    } catch {
      // 缓存未命中静默失败即可。
      return null;
    }
  }

  /**
   * 保存到磁盘缓存 / Saves to the disk cache.
   */
  async saveToDiskCache(iconId: string, icon: ResolvedIcon): Promise<void> {
    try {
      const path = this.cachePathOf(iconId);
      const dir = path.substring(0, path.lastIndexOf('/'));

      if (!(await this.plugin.app.vault.adapter.exists(dir))) {
        await this.ensureDirectoryPath(dir);
      }

      await this.plugin.app.vault.adapter.write(path, JSON.stringify(icon));
    } catch (error) {
      console.error(
        `[IconResolver] Failed to save to disk cache: ${iconId}`,
        error,
      );
    }
  }

  /**
   * 递归创建目录路径 / Recursively creates a directory path.
   */
  private async ensureDirectoryPath(path: string): Promise<void> {
    const parts = path.split('/');
    let current = '';

    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!(await this.plugin.app.vault.adapter.exists(current))) {
        await this.plugin.app.vault.adapter.mkdir(current);
      }
    }
  }

  /**
   * 清空内存缓存 / Clears the memory tier.
   */
  clearMemoryCache(): void {
    this.memoryCache.clear();
    this.previews.clear();
    console.log('[IconResolver] Memory cache cleared');
  }

  /**
   * 清空磁盘缓存 / Clears the disk cache.
   */
  async clearDiskCache(): Promise<void> {
    try {
      if (await this.plugin.app.vault.adapter.exists(this.diskCachePath)) {
        await this.plugin.app.vault.adapter.rmdir(this.diskCachePath, true);
        console.log('[IconResolver] Disk cache cleared');
      }
    } catch (error) {
      console.error('[IconResolver] Failed to clear disk cache:', error);
    }
  }

  /**
   * 移除特定图标包的缓存 / Forgets every in-memory icon belonging to a pack.
   */
  async removePackCache(packName: string): Promise<void> {
    // 先收集该包的图标 id：磁盘缓存以 id 命名，entry 随 lookup 一起被删掉后就找不到了。
    // Collect the pack's icon ids first: the disk cache is keyed by id, and those entries
    // are gone once the lookup rows are removed.
    const iconIds = new Set<string>();
    for (const [key, located] of this.lookup) {
      if (located.packName === packName) {
        iconIds.add(located.entry.id);
        this.lookup.delete(key);
      }
    }

    for (const [key, value] of this.memoryCache) {
      if (value.iconPackName === packName) {
        this.memoryCache.delete(key);
      }
    }
    for (const [key, value] of this.previews) {
      if (value.iconPackName === packName) {
        this.previews.delete(key);
      }
    }

    // 磁盘缓存同样必须作废，否则下一次解析会在第 2 层命中旧内容。
    // The disk tier must be invalidated too, or the next resolve hits stale markup.
    for (const iconId of iconIds) {
      try {
        const path = this.cachePathOf(iconId);
        if (await this.plugin.app.vault.adapter.exists(path)) {
          await this.plugin.app.vault.adapter.remove(path);
        }
      } catch (error) {
        console.warn(
          `[IconResolver] Could not remove cached icon '${iconId}':`,
          error,
        );
      }
    }
  }

  /**
   * 获取缓存统计信息 / Cache statistics for diagnostics.
   */
  getCacheStats(): {
    memorySize: number;
    previewSize: number;
    lookupSize: number;
  } {
    return {
      memorySize: this.memoryCache.size,
      previewSize: this.previews.size,
      lookupSize: this.lookup.size,
    };
  }
}

/**
 * 提取 SVG viewBox / Extracts the SVG viewBox.
 */
function extractViewBox(svgContent: string): string {
  const match = svgContent.match(/viewBox=["']([^"']+)["']/i);
  return match ? match[1] : '';
}

export type { IconEntry };
