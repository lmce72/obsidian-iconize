/**
 * IconIndexStore - 图标索引存储系统
 * Icon Index Storage System.
 *
 * 负责持久化图标包的元数据索引到磁盘，避免每次启动都重新扫描 ZIP 文件。
 * Persists icon pack metadata indexes to disk to avoid rescanning ZIP files on every startup.
 *
 * 索引存放在插件目录下（见 icon-layout），不放在图标包目录内，
 * 以免被 legacy 的 IconPackManager 当成图标包。
 */

import { DataAdapter } from 'obsidian';
import {
  IconPackIndex,
  deserializeIndex,
  serializeIndex,
} from './icon-indexing';

export class IconIndexStore {
  private adapter: DataAdapter;
  private indexPath: string;

  /**
   * @param adapter 仓库适配器 / Vault adapter.
   * @param indexPath 索引目录（由 icon-layout 推导）/ Index directory.
   */
  constructor(adapter: DataAdapter, indexPath: string) {
    this.adapter = adapter;
    this.indexPath = indexPath;
  }

  /**
   * 确保索引目录存在 / Ensure index directory exists.
   */
  async ensureDirectory(): Promise<void> {
    try {
      if (!(await this.adapter.exists(this.indexPath))) {
        await this.adapter.mkdir(this.indexPath);
      }
    } catch (error) {
      console.error(
        '[IconIndexStore] Failed to create index directory:',
        error,
      );
    }
  }

  /**
   * 保存图标包索引 / Save icon pack index.
   */
  async save(packName: string, index: IconPackIndex): Promise<void> {
    try {
      await this.ensureDirectory();
      const path = `${this.indexPath}/${packName}.json`;
      // 紧凑序列化：条目只落地推导不出来的字段（见 `serializeIndex`）。
      // Compact form: only the non-derivable fields are written (see `serializeIndex`).
      const content = serializeIndex(index);
      await this.adapter.write(path, content);
      console.log(
        `[IconIndexStore] Saved index for ${packName} (${index.entries.length} icons)`,
      );
    } catch (error) {
      console.error(
        `[IconIndexStore] Failed to save index for ${packName}:`,
        error,
      );
      throw error;
    }
  }

  /**
   * 加载图标包索引 / Load icon pack index.
   */
  async load(packName: string): Promise<IconPackIndex | null> {
    try {
      const path = `${this.indexPath}/${packName}.json`;
      if (!(await this.adapter.exists(path))) {
        return null;
      }
      const content = await this.adapter.read(path);
      return deserializeIndex(content);
    } catch (error) {
      console.error(
        `[IconIndexStore] Failed to load index for ${packName}:`,
        error,
      );
      return null;
    }
  }

  /**
   * 删除图标包索引 / Delete icon pack index.
   */
  async delete(packName: string): Promise<void> {
    try {
      const path = `${this.indexPath}/${packName}.json`;
      if (await this.adapter.exists(path)) {
        await this.adapter.remove(path);
        console.log(`[IconIndexStore] Deleted index for ${packName}`);
      }
    } catch (error) {
      console.error(
        `[IconIndexStore] Failed to delete index for ${packName}:`,
        error,
      );
    }
  }

  /**
   * 列出所有已索引的图标包 / List all indexed icon packs.
   */
  async listIndexedPacks(): Promise<string[]> {
    try {
      if (!(await this.adapter.exists(this.indexPath))) {
        return [];
      }
      const listing = await this.adapter.list(this.indexPath);
      return listing.files
        .filter((file) => file.endsWith('.json'))
        .map((file) => file.split('/').pop()?.replace('.json', '') || '');
    } catch (error) {
      console.error('[IconIndexStore] Failed to list indexed packs:', error);
      return [];
    }
  }

  /**
   * 清空所有索引（用于重置或迁移）/ Clear all indexes.
   */
  async clearAll(): Promise<void> {
    try {
      if (await this.adapter.exists(this.indexPath)) {
        await this.adapter.rmdir(this.indexPath, true);
        console.log('[IconIndexStore] Cleared all indexes');
      }
    } catch (error) {
      console.error('[IconIndexStore] Failed to clear indexes:', error);
    }
  }
}
