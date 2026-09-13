/**
 * 按需加载生成状态在磁盘上的位置 / Where the lazy loading layer keeps its state.
 *
 * 图标包本身永远不会被解压。所有生成的状态都放在插件自己的目录下，而不是图标包目录内：
 * legacy 的 IconPackManager 会把 iconPacksPath 下的每个文件夹都当成图标包，
 * 因此把缓存放在那里既会产生噪声，也会让 background check 误删缓存文件。
 *
 * Packs themselves are never unpacked. All generated state lives under the
 * plugin's own directory rather than inside the icon packs path, because the
 * legacy IconPackManager treats every folder under iconPacksPath as an icon
 * pack — which both adds noise and lets the background check delete cache files.
 *
 * ```
 * .obsidian/plugins/obsidian-icon-folder/
 *   main.js
 *   .iconize/
 *     index/feather-icons.json      what is inside that pack
 *     cache/LiHome.json             icons extracted on first use
 * ```
 *
 * 每条路径都在这里推导而不是在各调用点拼接，因此改动布局只需要编辑本文件。
 * Every path is derived here rather than assembled at call sites.
 */

import IconizePlugin from '@app/main';

/** 持有全部生成状态的目录名 / Directory holding all generated state. */
export const STATE_DIR_NAME = '.iconize';

/** 每个图标包一个索引文件的子目录 / Subdirectory holding one index file per pack. */
export const INDEX_DIR_NAME = 'index';

/** 首次使用时提取出来的图标的子目录 / Subdirectory holding icons extracted on first use. */
export const CACHE_DIR_NAME = 'cache';

/** 插件目录不可用时的回退路径 / Fallback when the plugin directory is unavailable. */
const FALLBACK_PLUGIN_DIR = '.obsidian/plugins/obsidian-icon-folder';

/**
 * 插件自身的目录 / The plugin's own directory.
 */
export function pluginDir(plugin: IconizePlugin): string {
  const dir = plugin.manifest?.dir;
  return dir && dir.length > 0 ? dir : FALLBACK_PLUGIN_DIR;
}

/**
 * 全部生成状态的根目录 / Root of all generated state.
 */
export function stateRoot(plugin: IconizePlugin): string {
  return `${pluginDir(plugin)}/${STATE_DIR_NAME}`;
}

/**
 * 存放每个图标包索引的目录 / Directory holding every pack index.
 */
export function indexDir(plugin: IconizePlugin): string {
  return `${stateRoot(plugin)}/${INDEX_DIR_NAME}`;
}

/**
 * 存放已提取图标的目录 / Directory holding every cached icon.
 */
export function cacheDir(plugin: IconizePlugin): string {
  return `${stateRoot(plugin)}/${CACHE_DIR_NAME}`;
}
