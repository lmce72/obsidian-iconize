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
import { indexDir, cacheDir } from './icon-layout';

export interface LazyLoadingSystem {
  store: IconIndexStore;
  resolver: IconResolver;
  loader: InlineIconLoader;
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
): Promise<LazyLoadingSystem | null> {
  try {
    const store = new IconIndexStore(
      plugin.app.vault.adapter,
      indexDir(plugin),
    );
    const resolver = new IconResolver(plugin, cacheDir(plugin));
    const manager = plugin.getIconPackManager();

    // 强制重建，使旧的索引格式或残留的索引文件不会沿用。
    return await initializeWithStore(
      plugin,
      usedIconNames,
      store,
      resolver,
      manager,
    );
  } catch (error) {
    console.error(
      '[Iconize] Lazy loading initialization failed, falling back to legacy:',
      error,
    );
    return null;
  }
}

async function initializeWithStore(
  plugin: IconizePlugin,
  usedIconNames: string[],
  store: IconIndexStore,
  resolver: IconResolver,
  manager: ReturnType<IconizePlugin['getIconPackManager']>,
): Promise<LazyLoadingSystem> {
  // 归档索引为 0 的包名，稍后回退到同名解压目录。
  const emptyArchives = new Set<string>();

  for (const pack of manager.getIconPacks()) {
    const count = await loadPackIndex(store, resolver, pack);
    if (count === 0 && pack.getSource()?.type === 'zip') {
      emptyArchives.add(pack.getName());
    }
  }

  // 归档匹配不到图标时（预定义包固定了带版本号的路径，用户装的却是别的版本），
  // 回退到旧版本按需解压出来的同名目录，否则用户已保存的图标会全部失效。
  for (const name of emptyArchives) {
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

    const count = await loadPackIndex(store, resolver, pack);
    if (count > 0) {
      logger.info(
        `Icon pack '${name}' resolved from its unpacked directory (${count} icons); its archive matched no icons`,
      );
    }
  }

  const loader = new InlineIconLoader(plugin);

  // 预取已用图标，使同步渲染路径能找到它们。
  const result = await resolver.prefetch(usedIconNames);
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

  return { store, resolver, loader };
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
): Promise<number> {
  const name = pack.getName();
  const source = pack.getSource();

  // 没有读取源的包（例如 Obsidian 原生 Lucide）已经持有已解析的图标，不需要索引。
  if (!source) {
    return pack.size;
  }

  try {
    const stored = await store.load(name);
    const fingerprint = await source.fingerprint();

    let index: IconPackIndex;
    if (!isIndexStale(stored, fingerprint)) {
      index = stored as IconPackIndex;
    } else {
      index = await buildIndex(name, pack.getPrefix(), source);
      await store.save(name, index);
      logger.info(
        `Indexed icon pack '${name}' (${index.entries.length} icons)`,
      );
    }

    pack.setIndex(index);
    resolver.registerPack(name, index.prefix, index.entries, source);

    return index.entries.length;
  } catch (error) {
    logger.error(`Could not index icon pack '${name}' (${error})`);
    return 0;
  }
}

/**
 * 清理按需加载系统 / Cleanup the lazy loading system.
 */
export function cleanupLazyLoading(system: LazyLoadingSystem): void {
  system.loader.reset();
  system.resolver.clearMemoryCache();
}
