import config from '@app/config';
import { Notice } from 'obsidian';
import { LUCIDE_ICON_PACK_NAME, LucideIconPack } from './lucide';
import IconizePlugin from '@app/main';
import { FileManager } from './file-manager';
import { IconPack } from './icon-pack';
import { logger } from '@app/lib/logger';
import { getExtraPath } from '@app/icon-packs';
import {
  FolderSource,
  ZipSource,
  isReservedDirectory,
} from '@app/lib/icon-sources';
import type { IconSource } from '@app/lib/icon-sources';
import { indexAndRegisterPack } from '@app/lib/lazy-loading-integration';

export interface Icon {
  name: string;
  prefix: string;
  displayName: string;
  iconPackName: string | null; // Can be `null` if the icon is an emoji.
  filename: string;
  svgContent: string;
  svgViewbox: string;
  svgElement: string;
}

export class IconPackManager {
  private path: string;
  private iconPacks: IconPack[];
  private lucideIconPack: LucideIconPack;
  private fileManager: FileManager;

  /**
   * 与已安装图标包同名的解压目录。
   * Unpacked directories that share a name with an installed archive.
   *
   * 归档通常是权威来源，但旧版本会按需把用到的图标解压到同名目录；只有当归档
   * 一个图标都索引不到时（例如用户装的是与固定路径不同版本的预定义包），才回退到目录。
   */
  private shadowedFolders: Map<string, string>;

  constructor(
    private plugin: IconizePlugin,
    path: string,
  ) {
    this.setPath(path);

    this.lucideIconPack = new LucideIconPack(plugin, this);
    this.fileManager = new FileManager(plugin);
    this.iconPacks = [];
    this.shadowedFolders = new Map();
  }

  /**
   * 发现已安装的图标包 / Discovers installed packs.
   *
   * 这里只建立图标包对象并挂上读取源，不解压任何内容。
   * Only pack objects and their read sources are created here; nothing is unpacked.
   */
  /**
   * 列举目录，把「目录不存在」与「列举失败」都当作空目录。
   * Lists a directory, treating both a missing directory and a failed listing as empty.
   *
   * 移动端（尤其外置存储 / scoped storage）可能拒绝创建或列举图标包目录。此处若让异常
   * 冒出去，会从 `onload` 一路抛出，Obsidian 会把整个插件判为「加载失败」——而正确行为
   * 应当是「暂时没有图标包」。
   *
   * On mobile — external storage with scoped access in particular — the icon packs
   * directory may not be creatable or listable. Letting that throw out of `onload` makes
   * Obsidian report the whole plugin as failed to load, when the honest outcome is simply
   * "no icon packs yet".
   */
  private async safeList(
    path: string,
  ): Promise<{ files: string[]; folders: string[] }> {
    try {
      if (!(await this.plugin.app.vault.adapter.exists(path))) {
        return { files: [], folders: [] };
      }

      return await this.plugin.app.vault.adapter.list(path);
    } catch (error) {
      logger.warn(`Could not list '${path}' (${error})`);
      return { files: [], folders: [] };
    }
  }

  /**
   * 判断路径是否存在，失败时按「不存在」处理。
   * Whether a path exists, treating a failed check as "does not exist".
   */
  private async safeExists(path: string): Promise<boolean> {
    try {
      return await this.plugin.app.vault.adapter.exists(path);
    } catch (error) {
      logger.warn(`Could not check existence of '${path}' (${error})`);
      return false;
    }
  }

  public async init(): Promise<void> {
    this.iconPacks = [];
    this.shadowedFolders = new Map();

    if (!(await this.safeExists(this.path))) {
      await this.createDefaultDirectory();
    }

    const loadedIconPacks = await this.safeList(this.path);

    // 归档即保持压缩的图标包。
    for (let i = 0; i < loadedIconPacks.files.length; i++) {
      const fileName = loadedIconPacks.files[i];
      if (!fileName.endsWith('.zip')) {
        continue;
      }

      const iconPackName = fileName.split('/').pop().split('.zip')[0];
      let iconPack = new IconPack(
        this.plugin,
        iconPackName,
        false,
        new ZipSource(
          this.plugin.app.vault.adapter,
          fileName,
          getExtraPath(iconPackName) ?? '',
        ),
        iconPackName === LUCIDE_ICON_PACK_NAME ? 'Li' : undefined,
      );

      if (iconPackName === LUCIDE_ICON_PACK_NAME) {
        iconPack = this.lucideIconPack.init(iconPack);
      }

      this.iconPacks.push(iconPack);
      logger.info(`Initialized icon pack '${iconPackName}'`);
    }

    // 目录是用户自建的图标包，或旧版本从归档里解压出来的图标。
    for (let i = 0; i < loadedIconPacks.folders.length; i++) {
      const folder = loadedIconPacks.folders[i];
      const folderName = folder.split('/').pop();

      // 插件自己生成的状态不是图标包。
      if (isReservedDirectory(folderName)) {
        continue;
      }

      // 同名归档已存在时暂缓，等归档证明自己确实有图标。
      if (this.iconPacks.some((pack) => pack.getName() === folderName)) {
        this.shadowedFolders.set(folderName, folder);
        continue;
      }

      this.iconPacks.push(
        new IconPack(
          this.plugin,
          folderName,
          true,
          new FolderSource(this.plugin.app.vault.adapter, folder),
        ),
      );
      logger.info(`Initialized custom icon pack '${folderName}'`);
    }

    if (this.plugin.doesUseNativeLucideIconPack()) {
      this.iconPacks = this.iconPacks.filter(
        (pack) => pack.getName() !== LUCIDE_ICON_PACK_NAME,
      );
      const iconPack = this.lucideIconPack.init();
      if (iconPack) {
        this.iconPacks.push(iconPack);
      }
    }
  }

  /**
   * 与已安装图标包同名的解压目录 / Unpacked directories shadowed by an archive.
   */
  public getShadowedFolders(): Map<string, string> {
    return this.shadowedFolders;
  }

  /**
   * 为图标包挂上读取源 / Attaches a read source to a pack.
   *
   * 用于归档索引为空、需要回退到同名解压目录的场景。
   */
  public replacePackSource(name: string, source: IconSource): void {
    // 没有可回退的目录时不做任何改动：先删后加会让图标包凭空消失。
    // Without a directory to fall back to, change nothing — removing before adding would
    // make the pack disappear.
    const folder = this.shadowedFolders.get(name);
    if (!folder) {
      logger.warn(
        `Ignored source replacement for '${name}': no shadowed directory to fall back to`,
      );
      return;
    }

    const index = this.iconPacks.findIndex((pack) => pack.getName() === name);
    if (index > -1) {
      this.iconPacks.splice(index, 1);
    }

    this.iconPacks.push(new IconPack(this.plugin, name, true, source));
    this.shadowedFolders.delete(name);
  }

  /**
   * 确保图标包目录存在 / Ensures the icon packs directory exists.
   *
   * 创建失败不应中断加载：移动端可能不允许在该位置建目录，此时插件仍应可用，
   * 只是暂时没有图标包。
   *
   * A failed creation must not abort loading: mobile platforms may refuse to create the
   * directory, and the plugin should still load with no packs rather than fail outright.
   */
  public async createDefaultDirectory(): Promise<void> {
    try {
      await this.fileManager.createDirectory(this.path, '');
    } catch (error) {
      logger.warn(
        `Could not create the icon packs directory '${this.path}' (${error})`,
      );
    }
  }

  public addIconPack(iconPack: IconPack): void {
    this.iconPacks.push(iconPack);
  }

  // ===== PATCHED: 不再写外部 SVG 文件 / No external SVG files are written =====
  /**
   * 确保图标已进入缓存 / Ensures the icon is cached.
   *
   * 原实现把图标解压成 `.obsidian/icons/<pack>/<name>.svg` 外部文件。按需加载下
   * 归档始终保持压缩，解析一次即写入磁盘缓存，因此这里只需触发一次解析。
   *
   * The original implementation extracted icons into loose `.svg` files. Under lazy
   * loading archives stay compressed and resolving once writes the disk cache, so
   * this only has to trigger a resolve.
   */
  public async extractIcon(icon: Icon, iconContent: string): Promise<void> {
    const iconId = `${icon.prefix}${icon.name}`;

    const resolver = this.plugin.iconResolver;
    if (resolver) {
      await resolver.resolve(iconId);
      return;
    }

    logger.info(
      `Skipped external SVG write for ${iconId}; icon packs stay compressed`,
    );
    void iconContent;
  }
  // ===== END PATCH =====

  public async createCustomIconPackDirectory(dir: string): Promise<void> {
    await this.fileManager.createDirectory(this.path, dir);
    const iconPack = new IconPack(this.plugin, dir, true);
    this.iconPacks.push(iconPack);
  }

  // ===== PATCHED: 导入的图标包与启动时发现的包走同一条索引路径 =====
  /**
   * 注册一个新导入的图标包 / Registers a newly imported icon pack.
   *
   * 归档落盘后按普通图标包处理：建立索引、登记到解析器。这样导入的包立刻可用，
   * 且与重启后加载的行为完全一致（包括跨版本宽松路径匹配）。
   *
   * The archive is written to disk and then treated like any other pack: indexed and
   * registered with the resolver, so it works immediately and behaves identically to a
   * pack discovered at startup.
   */
  public async registerIconPack(
    name: string,
    arrayBuffer: ArrayBuffer,
  ): Promise<void> {
    // 归档必须落盘：它既是读取源，也是重启后的发现依据。
    const zipPath = `${this.path}/${name}.zip`;
    if (!(await this.plugin.app.vault.adapter.exists(zipPath))) {
      await this.getFileManager().createZipFile(
        this.path,
        `${name}.zip`,
        arrayBuffer,
      );
    }

    // 移除同名旧包，避免重复登记。
    const existing = this.getIconPackByName(name);
    if (existing) {
      this.iconPacks = this.iconPacks.filter((pack) => pack.getName() !== name);
    }

    const iconPack = new IconPack(
      this.plugin,
      name,
      false,
      new ZipSource(
        this.plugin.app.vault.adapter,
        zipPath,
        getExtraPath(name) ?? '',
      ),
      name === LUCIDE_ICON_PACK_NAME ? 'Li' : undefined,
    );
    this.iconPacks.push(iconPack);

    const count = await indexAndRegisterPack(this.plugin, iconPack);

    if (count === 0) {
      // 归档已落盘，但本次会话没能索引它（按需加载层未就绪，或归档里没有可索引的图标）。
      // 不做内存回退：那条路径依赖已被移除的旧结构，且会让这个包只在本次会话可用、
      // 行为与其它包不一致。明确报错让用户重载。
      //
      // The archive is on disk but was not indexed this session. No in-memory fallback: it
      // depended on the removed structures and would make this pack behave differently
      // from every other one. Report it and let the user reload.
      logger.error(
        `Icon pack ${name} was saved but could not be indexed; reload Obsidian to pick it up`,
      );
      new Notice(
        `[${config.PLUGIN_NAME}] ${name} was saved but could not be indexed. Reload Obsidian to use it.`,
        10000,
      );
      return;
    }

    logger.info(`Registered icon pack ${name} (amount of icons: ${count})`);
  }
  // ===== END PATCH =====

  public async moveIconPackDirectories(
    from: string,
    to: string,
  ): Promise<void> {
    // Tries to move all icon packs to the new folder.
    for (let i = 0; i < this.iconPacks.length; i++) {
      const iconPack = this.iconPacks[i];
      const iconPackName = iconPack.getName();
      if (
        await this.plugin.app.vault.adapter.exists(`${from}/${iconPackName}`)
      ) {
        // Tries to create a new directory in the new path.
        const doesDirExist = await this.fileManager.createDirectory(
          this.path,
          iconPackName,
        );
        if (doesDirExist) {
          new Notice(`Directory withName ${iconPackName} already exists.`);
          continue;
        }
      }

      new Notice(`Moving ${iconPackName}...`);

      // Move the zip file.
      if (
        await this.plugin.app.vault.adapter.exists(
          `${from}/${iconPackName}.zip`,
        )
      ) {
        await this.plugin.app.vault.adapter.copy(
          `${from}/${iconPackName}.zip`,
          `${to}/${iconPackName}.zip`,
        );
      }

      // Move all other files inside of the iconpack directory.
      const filesInDirectory = await this.fileManager.getFilesInDirectory(
        `${from}/${iconPackName}`,
      );

      for (const file of filesInDirectory) {
        const fileName = file.split('/').pop();
        await this.plugin.app.vault.adapter.copy(
          `${from}/${iconPackName}/${fileName}`,
          `${to}/${iconPackName}/${fileName}`,
        );
      }

      new Notice(`...moved ${iconPackName}`);
    }

    // Removes all the existing icon packs in the `from` directory.
    for (let i = 0; i < this.iconPacks.length; i++) {
      const iconPack = this.iconPacks[i];
      const iconPackName = iconPack.getName();
      if (
        await this.plugin.app.vault.adapter.exists(`${from}/${iconPackName}`)
      ) {
        await this.plugin.app.vault.adapter.rmdir(
          `${from}/${iconPackName}`,
          true,
        );
      }
    }

    // Remove root directory that contains all the icon packs.
    if (!to.startsWith(from)) {
      await this.plugin.app.vault.adapter.rmdir(`${from}`, true);
    }
  }

  public doesIconExists(iconName: string): boolean {
    return (
      this.allLoadedIconNames.find(
        (icon) =>
          icon.name === iconName || icon.prefix + icon.name === iconName,
      ) !== undefined
    );
  }

  public doesIconPackExist(iconPackName: string): Promise<boolean> {
    return this.plugin.app.vault.adapter.exists(`${this.path}/${iconPackName}`);
  }

  public get allLoadedIconNames(): Icon[] {
    return this.iconPacks.reduce((total: Icon[], iconPack) => {
      total.push(...iconPack.getIcons());
      return total;
    }, []);
  }

  public setPath(newPath: string): void {
    if (newPath === 'plugins/obsidian-icon-folder/icons') {
      newPath = '.obsidian/plugins/obsidian-icon-folder/icons';
      new Notice(
        `[${config.PLUGIN_NAME}] Due to a change in version v1.2.2, the icon pack folder changed. Please change it in the settings to not be directly in /plugins.`,
        8000,
      );
    }

    // Remove the beginning slash because paths which start with `/` are the same as without
    // a slash.
    if (newPath.startsWith('/')) {
      newPath = newPath.slice(1);
    }

    this.path = newPath;
  }

  public async removeIconPack(iconPack: IconPack): Promise<void> {
    const name = iconPack.getName();

    // 必须传删除个数：`splice(index)` 会从该位置起删掉其后所有图标包。
    // The delete count is required: `splice(index)` drops every pack from that index on.
    const iconPackIndex = this.iconPacks.findIndex(
      (ip) => ip.getName() === name,
    );
    if (iconPackIndex > -1) {
      this.iconPacks.splice(iconPackIndex, 1);
    }

    iconPack.getSource()?.dispose();
    await iconPack.delete();

    // 解析器与索引必须一并作废，否则已删除的包仍会从内存/磁盘缓存里继续提供图标。
    // The resolver and the stored index must be invalidated too, or the removed pack keeps
    // serving icons from the memory and disk caches.
    await this.plugin.iconResolver?.removePackCache(name);
    await this.plugin.lazyLoadingSystem?.store.delete(name);
  }

  public getLucideIconPack(): LucideIconPack {
    return this.lucideIconPack;
  }

  public getPath(): string {
    return this.path;
  }

  public getIconPackByName(name: string): IconPack | undefined {
    return this.iconPacks.find((iconPack) => iconPack.getName() === name);
  }

  public getIconPackByPrefix(prefix: string): IconPack | undefined {
    return this.iconPacks.find((iconPack) => iconPack.getPrefix() === prefix);
  }

  public getIconPacks(): IconPack[] {
    return this.iconPacks;
  }

  public getFileManager(): FileManager {
    return this.fileManager;
  }
}
