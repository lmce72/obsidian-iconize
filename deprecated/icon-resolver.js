/**
 * IconResolver - 图标解析器（三层缓存架构）
 * Icon Resolver with Three-Tier Cache Architecture
 *
 * Layer 1: Memory Cache (已解析的 Icon 对象 / Parsed Icon objects)
 * Layer 2: Disk Cache (.obsidian/icons/.cache / Processed SVG files)
 * Layer 3: Source (ZIP 压缩包或文件夹 / ZIP archives or folders)
 */

'use strict';

const JSZip = require('jszip');

class IconResolver {
  /**
   * @param {Object} plugin - Iconize plugin instance
   * @param {Object} iconPacksRef - Reference to global iconPacks array
   * @param {Function} svgExtract - SVG extraction function
   */
  constructor(plugin, iconPacksRef, svgExtract) {
    this.plugin = plugin;
    this.iconPacks = iconPacksRef;
    this.svgExtract = svgExtract;

    // Layer 1: Memory cache (iconId -> Icon object)
    this.memoryCache = new Map();

    // Disk cache path
    this.diskCachePath = `${this.plugin.getSettings().iconPacksPath}/.cache`;

    // Prefix index for O(1) lookup
    this.prefixIndex = new Map();
  }

  /**
   * 构建前缀索引
   * Build prefix index for fast lookup
   */
  buildPrefixIndex() {
    this.prefixIndex.clear();
    this.iconPacks.forEach((pack) => {
      if (pack.prefix) {
        this.prefixIndex.set(pack.prefix, pack);
      }
    });
    console.log(
      `[IconResolver] Built prefix index with ${this.prefixIndex.size} entries`,
    );
  }

  /**
   * 同步查询 - 仅返回已加载到内存的图标
   * Synchronous peek - returns only memory-cached icons
   *
   * @param {string} iconId - Full icon identifier (e.g., "LiHome")
   * @returns {Object|undefined} Icon object or undefined
   */
  peek(iconId) {
    return this.memoryCache.get(iconId);
  }

  /**
   * 异步解析 - 按需加载
   * Async resolve - load on demand
   *
   * @param {string} iconId - Full icon identifier
   * @param {Object} options - Resolve options
   * @param {boolean} options.persist - Whether to persist to disk cache (default: true)
   * @param {string|null} options.color - Icon color override
   * @returns {Promise<Object|null>} Icon object or null
   */
  async resolve(iconId, options = {}) {
    const { persist = true, color = null } = options;

    try {
      // Layer 1: Memory cache hit
      if (this.memoryCache.has(iconId)) {
        return this.memoryCache.get(iconId);
      }

      // Find entry in index
      const entry = this.findEntry(iconId);
      if (!entry) {
        console.warn(
          `[IconResolver] Icon "${iconId}" not found in any pack index`,
        );
        return null;
      }

      // Layer 2: Try disk cache
      const cacheKey = `${entry.packName}/${entry.filename}`;
      const cached = await this.loadFromDiskCache(cacheKey);
      if (cached) {
        this.memoryCache.set(iconId, cached);
        return cached;
      }

      // Layer 3: Extract from source
      const svgContent = await this.extractFromSource(entry);
      if (!svgContent) {
        console.error(`[IconResolver] Failed to extract SVG for ${iconId}`);
        return null;
      }

      // Parse and build icon object
      const icon = {
        name: entry.name,
        filename: entry.filename,
        prefix: entry.prefix,
        svgElement: this.svgExtract(svgContent),
        svgContent: svgContent,
        svgViewbox: this.extractViewBox(svgContent),
        iconPackName: entry.packName,
      };

      // Save to caches
      if (persist) {
        await this.saveToDiskCache(cacheKey, icon);
      }
      this.memoryCache.set(iconId, icon);

      return icon;
    } catch (error) {
      console.error(`[IconResolver] Failed to resolve ${iconId}:`, error);
      return null;
    }
  }

  /**
   * 批量预加载图标
   * Batch prefetch icons
   *
   * @param {string[]} iconIds - Array of icon identifiers
   * @returns {Promise<{loaded: number, failed: string[]}>}
   */
  async prefetch(iconIds) {
    const uniqueIds = [...new Set(iconIds)];
    const failed = [];
    let loaded = 0;

    for (const iconId of uniqueIds) {
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
   * 从索引查找条目 (O(1) 查找)
   * Find entry from index (O(1) lookup)
   *
   * @param {string} iconId - Full icon identifier
   * @returns {Object|null} Entry object or null
   */
  findEntry(iconId) {
    if (!iconId) return null;

    // Extract prefix and name
    const split = this.nextIdentifier(iconId);
    const prefix = iconId.substring(0, split);
    const name = iconId.substring(split);

    // Fast lookup by prefix
    const pack = this.prefixIndex.get(prefix);
    if (!pack || !pack.index) {
      return null;
    }

    // Find in pack's index
    const entry = pack.index.entries.find(
      (e) => e.id === iconId || e.name.toLowerCase() === name.toLowerCase(),
    );

    return entry ? { ...entry, packName: pack.name } : null;
  }

  /**
   * 从源文件提取 SVG
   * Extract SVG from source (ZIP or folder)
   *
   * @param {Object} entry - Index entry
   * @returns {Promise<string|null>} SVG content or null
   */
  async extractFromSource(entry) {
    const pack = this.iconPacks.find((p) => p.name === entry.packName);
    if (!pack || !pack.source) {
      return null;
    }

    try {
      if (pack.source.type === 'zip') {
        // Extract from ZIP
        const zipPath = pack.source.path;
        const zipContent =
          await this.plugin.app.vault.adapter.readBinary(zipPath);
        const zip = await JSZip.loadAsync(zipContent);

        // Try with extra path prefix
        const extraPath = pack.source.extraPath || '';
        const filePath = extraPath
          ? `${extraPath}/${entry.filename}`
          : entry.filename;

        const file = zip.file(filePath);
        if (!file) {
          console.warn(`[IconResolver] File not found in ZIP: ${filePath}`);
          return null;
        }

        return await file.async('text');
      } else if (pack.source.type === 'folder') {
        // Read from folder
        const filePath = `${pack.source.path}/${entry.filename}`;
        return await this.plugin.app.vault.adapter.read(filePath);
      }
    } catch (error) {
      console.error(
        `[IconResolver] Failed to extract ${entry.filename}:`,
        error,
      );
      return null;
    }

    return null;
  }

  /**
   * 从磁盘缓存加载
   * Load from disk cache
   *
   * @param {string} cacheKey - Cache key (packName/filename)
   * @returns {Promise<Object|null>}
   */
  async loadFromDiskCache(cacheKey) {
    try {
      const path = `${this.diskCachePath}/${cacheKey}.json`;
      if (!(await this.plugin.app.vault.adapter.exists(path))) {
        return null;
      }
      const content = await this.plugin.app.vault.adapter.read(path);
      return JSON.parse(content);
    } catch (error) {
      // Silent fail for cache miss
      return null;
    }
  }

  /**
   * 保存到磁盘缓存
   * Save to disk cache
   *
   * @param {string} cacheKey - Cache key
   * @param {Object} icon - Icon object
   * @returns {Promise<void>}
   */
  async saveToDiskCache(cacheKey, icon) {
    try {
      const path = `${this.diskCachePath}/${cacheKey}.json`;
      const dir = path.substring(0, path.lastIndexOf('/'));

      // Ensure directory exists
      if (!(await this.plugin.app.vault.adapter.exists(dir))) {
        await this.ensureDirectoryPath(dir);
      }

      await this.plugin.app.vault.adapter.write(path, JSON.stringify(icon));
    } catch (error) {
      console.error(
        `[IconResolver] Failed to save to disk cache: ${cacheKey}`,
        error,
      );
    }
  }

  /**
   * 递归创建目录路径
   * Recursively create directory path
   */
  async ensureDirectoryPath(path) {
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
   * 提取 SVG viewBox
   * Extract SVG viewBox
   */
  extractViewBox(svgContent) {
    const match = svgContent.match(/viewBox=["']([^"']+)["']/i);
    return match ? match[1] : '';
  }

  /**
   * 查找下一个大写字母或数字的位置（用于分离前缀）
   * Find next uppercase letter or digit position (for prefix separation)
   */
  nextIdentifier(iconName) {
    return iconName.substring(1).search(/[A-Z0-9]/) + 1;
  }

  /**
   * 清空内存缓存
   * Clear memory cache
   */
  clearMemoryCache() {
    this.memoryCache.clear();
    console.log('[IconResolver] Memory cache cleared');
  }

  /**
   * 清空磁盘缓存
   * Clear disk cache
   */
  async clearDiskCache() {
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
   * 移除特定图标包的缓存
   * Remove cache for specific icon pack
   */
  async removePackCache(packName) {
    try {
      const packCachePath = `${this.diskCachePath}/${packName}`;
      if (await this.plugin.app.vault.adapter.exists(packCachePath)) {
        await this.plugin.app.vault.adapter.rmdir(packCachePath, true);
        console.log(`[IconResolver] Removed cache for ${packName}`);
      }

      // Remove from memory cache
      for (const [key, value] of this.memoryCache.entries()) {
        if (value.iconPackName === packName) {
          this.memoryCache.delete(key);
        }
      }
    } catch (error) {
      console.error(
        `[IconResolver] Failed to remove cache for ${packName}:`,
        error,
      );
    }
  }

  /**
   * 获取缓存统计信息
   * Get cache statistics
   */
  getCacheStats() {
    return {
      memorySize: this.memoryCache.size,
      prefixIndexSize: this.prefixIndex.size,
    };
  }
}

module.exports = IconResolver;
