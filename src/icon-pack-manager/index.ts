import config from '@app/config';
import { Notice } from 'obsidian';
import { LUCIDE_ICON_PACK_NAME, LucideIconPack } from './lucide';
import IconizePlugin from '@app/main';
import { FileManager } from './file-manager';
import { IconPack } from './icon-pack';
import { readZipFile } from '@app/zip-util';
import { logger } from '@app/lib/logger';
import JSZip from 'jszip';
import { generateIcon, getNormalizedName, nextIdentifier } from './util';
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

  private preloadedIcons: Icon[];

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
    this.preloadedIcons = [];
    this.shadowedFolders = new Map();
  }

  /**
   * 发现已安装的图标包 / Discovers installed packs.
   *
   * 这里只建立图标包对象并挂上读取源，不解压任何内容。
   * Only pack objects and their read sources are created here; nothing is unpacked.
   */
  public async init(): Promise<void> {
    this.iconPacks = [];
    this.shadowedFolders = new Map();

    if (!(await this.plugin.app.vault.adapter.exists(this.path))) {
      await this.createDefaultDirectory();
    }

    const loadedIconPacks = await this.plugin.app.vault.adapter.list(this.path);

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

  // [LEGACY] 旧方法：全量解压所有图标包到内存（约 2 秒 / 数千个图标），
  // 已被按需加载取代 —— 索引在 init 阶段建立，图标由 IconResolver 按需解析。
  // 保留为 no-op 以兼容既有调用点，日后可连同调用点一起移除。
  public async loadAll(): Promise<void> {
    logger.info(
      'loadAll() is a no-op: icon packs are index-backed and icons resolve on demand',
    );
  }

  // [LEGACY] 旧的全量解压实现，保留仅供参考，日后可删除。
  private async loadAllUnpacked(): Promise<void> {
    const loadedIconPacks = await this.plugin.app.vault.adapter.list(this.path);

    // Extract all zip files which will be downloaded icon packs.
    const zipFiles: Record<string, JSZip.JSZipObject[]> = {};
    for (let i = 0; i < loadedIconPacks.files.length; i++) {
      const fileName = loadedIconPacks.files[i];
      if (fileName.endsWith('.zip')) {
        const arrayBuffer =
          await this.plugin.app.vault.adapter.readBinary(fileName);
        const files = await readZipFile(arrayBuffer);
        const iconPackName = fileName.split('/').pop().split('.zip')[0];
        zipFiles[iconPackName] = files;
      }
    }

    // Check for custom-made icon packs.
    for (let i = 0; i < loadedIconPacks.folders.length; i++) {
      const folderName = loadedIconPacks.folders[i].split('/').pop();
      // Continue if the icon pack does have a zip file.
      if (zipFiles[folderName]) {
        continue;
      }

      const iconPack = new IconPack(this.plugin, folderName, true);

      const files = await this.fileManager.getFilesInDirectory(
        `${this.path}/${folderName}`,
      );
      const loadedIcons: Icon[] = [];
      // Convert files into loaded svgs.
      for (let j = 0; j < files.length; j++) {
        const iconNameRegex = files[j].match(
          new RegExp(this.path + '/' + folderName + '/(.*)'),
        );
        const iconName = getNormalizedName(iconNameRegex[1]);
        const iconContent = await this.plugin.app.vault.adapter.read(files[j]);
        const icon = generateIcon(iconPack, iconName, iconContent);
        if (icon) {
          loadedIcons.push(icon);
        }
      }

      if (!this.getIconPackByName(folderName)) {
        this.iconPacks.push(iconPack);
        logger.info(
          `Loaded icon pack '${folderName}' (amount of icons: ${loadedIcons.length})`,
        );
      }
    }

    // Extract all files from the zip files.
    for (const zipFile in zipFiles) {
      const files = zipFiles[zipFile];
      const existingIconPack = this.getIconPackByName(zipFile);
      const iconPack =
        existingIconPack ?? new IconPack(this.plugin, zipFile, false);
      const loadedIcons: Icon[] = await this.fileManager.getIconsFromZipFile(
        iconPack,
        files,
      );
      if (
        zipFile === LUCIDE_ICON_PACK_NAME &&
        !this.plugin.doesUseCustomLucideIconPack()
      ) {
        continue;
      }

      iconPack.setIcons(loadedIcons);
      if (!existingIconPack) {
        this.iconPacks.push(iconPack);
      }
      logger.info(
        `Loaded icon pack '${zipFile}' (amount of icons: ${loadedIcons.length})`,
      );
    }
  }

  public async createDefaultDirectory(): Promise<void> {
    await this.fileManager.createDirectory(this.path, '');
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

  // [LEGACY] 旧的解压到外部 SVG 文件实现，保留仅供参考，日后可删除。
  private async extractIconToFile(
    icon: Icon,
    iconContent: string,
  ): Promise<void> {
    const doesIconPackDirExist = await this.plugin.app.vault.adapter.exists(
      `${this.path}/${icon.iconPackName}`,
    );
    if (!doesIconPackDirExist) {
      await this.plugin.app.vault.adapter.mkdir(
        `${this.path}/${icon.iconPackName}`,
      );
    }

    const doesIconFileExists = await this.plugin.app.vault.adapter.exists(
      `${this.path}/${icon.iconPackName}/${icon.name}.svg`,
    );
    if (!doesIconFileExists) {
      await this.fileManager.createFile(
        icon.iconPackName,
        this.path,
        `${icon.name}.svg`,
        iconContent,
      );
    }
  }

  public async loadUsedIcons(icons: string[]): Promise<void> {
    for (let i = 0; i < icons.length; i++) {
      const entry = icons[i];
      if (!entry) {
        continue;
      }

      await this.loadPreloadedIcon(entry);
    }
  }

  public async loadPreloadedIcon(iconName: string): Promise<void> {
    const nextLetter = nextIdentifier(iconName);
    const prefix = iconName.substring(0, nextLetter);
    const name = iconName.substring(nextLetter);

    const iconPack = this.getIconPackByPrefix(prefix);

    if (!iconPack) {
      // Ignore because background check automatically adds the icons and icon pack
      // directories.
      if (!this.plugin.getSettings().iconsBackgroundCheckEnabled) {
        new Notice(
          `Seems like you do not have an icon pack installed. (${iconName})`,
          5000,
        );
      }
      return;
    }

    if (
      iconPack.getName() === LUCIDE_ICON_PACK_NAME &&
      this.plugin.doesUseNativeLucideIconPack()
    ) {
      // Native lucide icons already exist for Obsidian.
      const lucideIcons = this.iconPacks.find(
        (iconPack) => iconPack.getName() === LUCIDE_ICON_PACK_NAME,
      );
      const icon = lucideIcons.getIcons().find((icon) => icon.name === name);
      if (!icon) {
        logger.warn(
          `Icon ${icon} does not exist in the native Lucide icon pack.`,
        );
        return;
      }

      this.preloadedIcons.push(icon);
      return;
    }

    const fullPath = this.path + '/' + iconPack.getName() + '/' + name + '.svg';
    if (!(await this.plugin.app.vault.adapter.exists(fullPath))) {
      logger.error(
        `Icon with name '${name}' was not found (full path: ${fullPath})`,
      );
      return;
    }

    const content = await this.plugin.app.vault.adapter.read(fullPath);
    const icon = generateIcon(iconPack, name, content);
    this.preloadedIcons.push(icon);
  }

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
      // 按需加载层不可用（或归档无可索引图标）时退回旧的内存结构，保证图标仍可用。
      const files = await readZipFile(arrayBuffer);
      const loadedIcons: Icon[] = await this.fileManager.getIconsFromZipFile(
        iconPack,
        files,
      );
      iconPack.setIcons(loadedIcons);
      logger.info(
        `Loaded icon pack ${name} into memory (amount of icons: ${loadedIcons.length})`,
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
    const iconPackIndex = this.iconPacks.findIndex(
      (ip) => ip.getName() === iconPack.getName(),
    );
    if (iconPackIndex > -1) {
      this.iconPacks.splice(iconPackIndex);
    }
    await iconPack.delete();
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

  public getPreloadedIcons(): Icon[] {
    return this.preloadedIcons;
  }

  public getFileManager(): FileManager {
    return this.fileManager;
  }
}
