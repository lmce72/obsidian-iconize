/**
 * Lazy Loading Integration - 按需加载系统集成点
 * Integration point for the lazy loading system in the main plugin.
 *
 * 图标包保持压缩，启动时只为每个包建立/加载索引，图标由解析器按需读取。
 * Packs stay compressed; start-up only builds or loads one index per pack, and
 * icons are read on demand by the resolver.
 */

import { Notice } from 'obsidian';
import IconizePlugin from '@app/main';
import type { IconPack } from '@app/icon-pack-manager/icon-pack';
import { logger } from './logger';
import { IconIndexStore } from './icon-index-store';
import { IconResolver } from './icon-resolver';
import { InlineIconLoader } from './inline-icon-loader';
import { buildIndex, isIndexStale, IconPackIndex } from './icon-indexing';
import { FolderSource } from './icon-sources';
import { indexDir, cacheFile } from './icon-layout';
import { throwIfAborted } from './task-scheduler';

export interface LazyLoadingSystem {
  store: IconIndexStore;
  resolver: IconResolver;
  loader: InlineIconLoader;
  signal?: AbortSignal;
}

/**
 * 初始化按需加载系统：建立索引 → 登记条目 → 预取已用图标。
 * Initialize the lazy loading system. Returns `null` to signal a fallback to legacy loading.
 *
 * @param plugin Iconize plugin instance.
 * @param usedIconNames Icon identifiers actually in use (for prefetch).
 */
export async function initializeLazyLoading(
  plugin: IconizePlugin,
  usedIconNames: string[],
  signal?: AbortSignal,
): Promise<LazyLoadingSystem | null> {
  let resolver: IconResolver | undefined;
  const manager = plugin.getIconPackManager();
  const stop = () => {
    void resolver?.dispose();
    for (const pack of manager.getIconPacks()) pack.getSource()?.cancel?.();
  };
  signal?.addEventListener('abort', stop, { once: true });
  try {
    throwIfAborted(signal);
    const store = new IconIndexStore(
      plugin.app.vault.adapter,
      indexDir(plugin),
      signal,
    );
    resolver = new IconResolver(plugin, cacheFile(plugin));

    // 强制重建，使旧的索引格式或残留的索引文件不会沿用。
    return await initializeWithStore(
      plugin,
      usedIconNames,
      store,
      resolver,
      manager,
      signal,
    );
  } catch (error) {
    void resolver?.dispose();
    if (signal?.aborted) return null;
    console.error(
      '[Iconize] Lazy loading initialization failed, falling back to legacy:',
      error,
    );
    return null;
  } finally {
    signal?.removeEventListener('abort', stop);
  }
}

async function initializeWithStore(
  plugin: IconizePlugin,
  usedIconNames: string[],
  store: IconIndexStore,
  resolver: IconResolver,
  manager: ReturnType<IconizePlugin['getIconPackManager']>,
  signal?: AbortSignal,
): Promise<LazyLoadingSystem> {
  // 归档索引为 0 的包名，稍后回退到同名解压目录。
  const emptyArchives = new Set<string>();

  for (const pack of manager.getIconPacks()) {
    throwIfAborted(signal);
    const count = await loadPackIndex(store, resolver, pack, signal);
    if (count === 0 && pack.getSource()?.type === 'zip') {
      emptyArchives.add(pack.getName());
    }
  }

  // 归档匹配不到图标时（预定义包固定了带版本号的路径，用户装的却是别的版本），
  // 回退到旧版本按需解压出来的同名目录，否则用户已保存的图标会全部失效。
  for (const name of emptyArchives) {
    throwIfAborted(signal);
    const folder = manager.getShadowedFolders().get(name);
    if (!folder) {
      continue;
    }

    const source = new FolderSource(plugin.app.vault.adapter, folder);
    manager.replacePackSource(name, source);

    const pack = manager.getIconPackByName(name);
    if (!pack) {
      continue;
    }

    const count = await loadPackIndex(store, resolver, pack, signal);
    if (count > 0) {
      logger.info(
        `Icon pack '${name}' resolved from its unpacked directory (${count} icons); its archive matched no icons`,
      );
    }
  }

  const loader = new InlineIconLoader(plugin);

  // 预取已用图标，使同步渲染路径能找到它们。
  const result = await resolver.prefetch(usedIconNames, 128, signal);
  if (signal?.aborted) loader.dispose();
  throwIfAborted(signal);

  // 目录扫描快照立即释放；ZIP 目录由全局字节预算与 15 秒闲时释放管理。
  // Release folder snapshots; ZIP directories follow shared byte and 15-second idle limits.
  for (const pack of manager.getIconPacks()) {
    const source = pack.getSource();
    if (source?.type === 'folder') source.dispose();
  }
  if (
    result.failed.length > 0 &&
    plugin.getSettings().iconsBackgroundCheckEnabled
  ) {
    new Notice(
      `[Iconize] ${result.failed.length} icon(s) could not be loaded`,
      5000,
    );
  }

  const stats = resolver.getCacheStats();
  console.log(
    `[Iconize] Lazy loading ready: ${stats.lookupSize} icons indexed, ${result.loaded} prefetched`,
  );

  return { store, resolver, loader, signal };
}

/**
 * 为一个新加入的图标包建立索引并登记到解析器。
 * Indexes a newly added pack and registers it with the resolver.
 *
 * 新导入的图标包必须与启动时发现的包走同一条路径：否则它只存在于旧的内存结构里，
 * 对按需加载层不可见（解析器找不到、无法按需解析），必须重启 Obsidian 才能用。
 *
 * An imported pack must take the same path as packs discovered at startup; otherwise it
 * lives only in the legacy in-memory structure, invisible to the lazy layer, and only
 * becomes usable after an Obsidian restart.
 *
 * @returns 该图标包的图标数量；按需加载层尚未就绪时返回 0。
 */
export async function indexAndRegisterPack(
  plugin: IconizePlugin,
  pack: IconPack,
  preparedIndex?: IconPackIndex,
): Promise<number> {
  const store = plugin.lazyLoadingSystem?.store;
  const signal = plugin.lazyLoadingSystem?.signal;
  const resolver = plugin.iconResolver;

  if (!store || !resolver) {
    logger.warn(
      `Lazy loading is not ready; icon pack '${pack.getName()}' was not indexed`,
    );
    return 0;
  }

  // 导入已在暂存归档上完成验证，复用索引，避免替换原包后才发现新包不可用。
  // Imports validate a staged archive first; reuse its index after the archive is committed.
  if (preparedIndex) {
    throwIfAborted(signal);
    const source = pack.getSource();
    if (!source) throw new Error('Imported icon pack has no source');
    preparedIndex.fingerprint = await source.fingerprint();
    throwIfAborted(signal);
    await pack.loadIndex(preparedIndex);
    throwIfAborted(signal);
    await resolver.removePackCache(pack.getName());
    throwIfAborted(signal);
    await resolver.registerPack(
      pack.getName(),
      pack.getPrefix(),
      pack.getEntryLookup(),
      source,
    );
    throwIfAborted(signal);
    try {
      await store.save(pack.getName(), preparedIndex);
      throwIfAborted(signal);
    } catch (error) {
      throwIfAborted(signal);
      logger.error(
        'Could not persist imported icon index; using the in-memory index',
        undefined,
        error,
      );
    }
    plugin.inlineIconLoader?.clearFailedList();
    return preparedIndex.entries.length;
  }

  // 同名旧包的缓存必须作废，否则会继续提供旧内容。
  await resolver.removePackCache(pack.getName());

  const count = await loadPackIndex(store, resolver, pack, signal);

  // 索引建好后即可释放归档；新包落定后，之前加载失败的图标值得重试一次。
  const source = pack.getSource();
  if (source?.type === 'folder') source.dispose();
  plugin.inlineIconLoader?.clearFailedList();

  return count;
}

/**
 * 载入（必要时重建）单个图标包的索引，并把它的条目登记到解析器。
 * Loads a pack's index, rebuilding it when missing or out of date, and
 * registers its entries with the resolver.
 *
 * @returns 该图标包的图标数量 / The number of icons the pack contains.
 */
async function loadPackIndex(
  store: IconIndexStore,
  resolver: IconResolver,
  pack: IconPack,
  signal?: AbortSignal,
): Promise<number> {
  const name = pack.getName();
  const source = pack.getSource();

  // 没有读取源的包（例如 Obsidian 原生 Lucide）已经持有已解析的图标，不需要索引。
  if (!source) {
    return pack.size;
  }

  try {
    throwIfAborted(signal);
    const fingerprint = await source.fingerprint();
    throwIfAborted(signal);
    const stored = await store.load(name, fingerprint);

    let index: IconPackIndex;
    if (!isIndexStale(stored, fingerprint)) {
      index = stored as IconPackIndex;
    } else {
      index = await buildIndex(name, pack.getPrefix(), source, signal);
      try {
        await store.save(name, index);
      } catch (error) {
        throwIfAborted(signal);
        logger.error(
          '[Iconize] Could not persist icon index; using the in-memory index:',
          undefined,
          error,
        );
      }

      // 索引重建说明源已经变过（换了归档、加了图标），此前缓存的图标标记因此不再可信，
      // 必须一并作废——否则同一批图标 id 会继续从磁盘缓存返回旧图案。
      //
      // A rebuilt index means the source changed, so previously cached markup can no
      // longer be trusted; without this, the same icon ids keep serving the old artwork
      // from the disk cache.
      await resolver.removePackCache(name);

      logger.info(
        `Indexed icon pack '${name}' (${index.entries.length} icons)`,
      );
    }

    throwIfAborted(signal);
    await pack.loadIndex(index);
    throwIfAborted(signal);
    await resolver.registerPack(
      name,
      index.prefix,
      pack.getEntryLookup(),
      source,
    );

    return index.entries.length;
  } catch (error) {
    throwIfAborted(signal);
    logger.error(`Could not index icon pack '${name}' (${error})`);
    return 0;
  } finally {
    // 不保留目录扫描快照；ZIP 已受全局容量管理，短暂保留可避免预取再扫一次。
    // Drop folder snapshots; bounded ZIP retention avoids another scan for prefetch.
    if (source.type === 'folder' || signal?.aborted) source.dispose();
  }
}

/**
 * 清理按需加载系统 / Cleanup the lazy loading system.
 */
export function cleanupLazyLoading(system: LazyLoadingSystem): void {
  system.loader.dispose();
  void system.resolver.dispose();
}
