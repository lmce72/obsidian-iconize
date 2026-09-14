import config from '@app/config';
import { logger } from '@app/lib/logger';
import IconizePlugin from '@app/main';
import { Notice } from 'obsidian';
import { getNormalizedName } from './util';

export class FileManager {
  constructor(private plugin: IconizePlugin) {}

  // TODO: Maybe remove `path` and combine with `dir` param.
  public async createFile(
    iconPackName: string,
    path: string,
    filename: string,
    content: string,
    absoluteFilename?: string,
  ): Promise<void> {
    // ===== PATCHED: 仅允许在自定义图标包目录内创建文件 =====
    // 归档图标包保持压缩，图标只存在于归档与缓存中，不再解压成外部 SVG 文件。
    // Archived packs stay compressed; icons live in the archive and the cache, never
    // as extracted SVG files.
    const pack = this.plugin
      .getIconPackManager()
      .getIconPackByName(iconPackName);
    if (!pack || !pack.isCustomPack()) {
      logger.warn(
        `Prevented external SVG write: ${iconPackName}/${filename} (not a custom pack)`,
      );
      return;
    }
    // ===== END PATCH =====

    const normalizedFilename = getNormalizedName(filename);
    const exists = await this.plugin.app.vault.adapter.exists(
      `${path}/${iconPackName}/${normalizedFilename}`,
    );
    if (exists) {
      // `absoluteFilename` 是可选参数（两个调用方都没传），缺失时不能直接解引用。
      // `absoluteFilename` is optional and both callers omit it, so it must be guarded.
      const folderSplit = (absoluteFilename ?? '').split('/');
      if (folderSplit.length >= 2) {
        const folderName = folderSplit[folderSplit.length - 2];
        const newFilename = folderName + normalizedFilename;
        await this.plugin.app.vault.adapter.write(
          `${path}/${iconPackName}/${newFilename}`,
          content,
        );
        logger.info(
          `Renamed old file ${normalizedFilename} to ${newFilename} due to duplication`,
        );
        new Notice(
          `[${config.PLUGIN_NAME}] Renamed ${normalizedFilename} to ${newFilename} to avoid duplication.`,
          8000,
        );
      } else {
        logger.warn(
          `Could not create icons with duplicated file names (file name: ${normalizedFilename})`,
        );
        new Notice(
          `[${config.PLUGIN_NAME}] Could not create duplicated icon name (${normalizedFilename})`,
          8000,
        );
      }
    } else {
      await this.plugin.app.vault.adapter.write(
        `${path}/${iconPackName}/${normalizedFilename}`,
        content,
      );
    }
  }

  // TODO: Maybe remove `path` and combine with `dir` param.
  public async createDirectory(path: string, dir: string): Promise<boolean> {
    const doesDirExist = await this.plugin.app.vault.adapter.exists(
      `${path}/${dir}`,
    );
    if (!doesDirExist) {
      await this.plugin.app.vault.adapter.mkdir(`${path}/${dir}`);
    }

    return doesDirExist;
  }

  public async deleteFile(filePath: string): Promise<void> {
    await this.plugin.app.vault.adapter.remove(filePath);
  }

  public async getFilesInDirectory(dir: string): Promise<string[]> {
    if (!(await this.plugin.app.vault.adapter.exists(dir))) {
      return [];
    }

    return (await this.plugin.app.vault.adapter.list(dir)).files;
  }

  // TODO: Maybe remove `path` and combine with `dir` param.
  public async createZipFile(
    path: string,
    filename: string,
    buffer: ArrayBuffer,
  ): Promise<void> {
    await this.plugin.app.vault.adapter.writeBinary(
      `${path}/${filename}`,
      buffer,
    );
  }
}
