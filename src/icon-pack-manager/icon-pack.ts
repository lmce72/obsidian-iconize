import { logger } from '@app/lib/logger';
import { generateIcon, getNormalizedName } from './util';
import IconizePlugin from '@app/main';
import { Icon } from '.';
import { IconEntry, IconPackIndex } from '@app/lib/icon-indexing';
import { IconSource } from '@app/lib/icon-sources';
import { CompactIconIndex } from '@app/lib/compact-icon-index';

/**
 * 一个已安装的图标包 / One installed icon pack.
 *
 * 图标包持有的是它的**索引**而不是图标本身：索引只有元数据，因此上万个图标的包
 * 只花费一份名称列表，而不是上万个已解析的 SVG 文档，其归档也始终保持压缩。
 *
 * A pack holds an *index* of what it contains, never the icons themselves. The
 * index is metadata only, so a pack of ten thousand icons costs a list of names
 * rather than ten thousand parsed SVG documents, and the archive stays zipped.
 *
 * 把条目变成可渲染的东西是解析器的职责；图标包只知道存在什么、以及去哪里读。
 * Turning an entry into something renderable is the resolver's job.
 */
export class IconPack {
  /**
   * 已解析的图标，仅用于两条不走索引的路径：Obsidian 原生 Lucide（图标已在内存中），
   * 以及用户刚上传的自定义图标包。
   * Resolved icons, used only by the two paths that do not go through an index.
   */
  private icons: Icon[];

  /** 索引条目 / Index entries. */
  private entries: CompactIconIndex;

  private prefix: string;

  /**
   * @param plugin 插件实例 / Plugin instance.
   * @param name 图标包名，用于设置界面与缓存键 / Pack name.
   * @param isCustom 用户是否自己维护这个包的文件 / Whether the user maintains its files.
   * @param source 从哪里读取图标 / Where the pack's icons are read from.
   * @param prefix 覆盖推导出的前缀，仅用于历史固定前缀（如 Lucide 的 `Li`）。
   */
  constructor(
    private plugin: IconizePlugin,
    private name: string,
    private isCustom: boolean,
    private source?: IconSource,
    prefix?: string,
  ) {
    this.icons = [];
    this.prefix = prefix ?? this.generatePrefix();
    this.entries = new CompactIconIndex(this.prefix);
  }

  private generatePrefix(): string {
    if (this.name.includes('-')) {
      const splitted = this.name.split('-');
      let result = splitted[0].charAt(0).toUpperCase();
      for (let i = 1; i < splitted.length; i++) {
        result += splitted[i].charAt(0).toLowerCase();
      }

      return result;
    }

    return (
      this.name.charAt(0).toUpperCase() + this.name.charAt(1).toLowerCase()
    );
  }

  public async delete(): Promise<void> {
    const path = this.plugin.getIconPackManager().getPath();
    // Check for the icon pack directory and delete it.
    if (await this.plugin.app.vault.adapter.exists(`${path}/${this.name}`)) {
      await this.plugin.app.vault.adapter.rmdir(`${path}/${this.name}`, true);
    }
    // Check for the icon pack zip file and delete it.
    if (
      await this.plugin.app.vault.adapter.exists(`${path}/${this.name}.zip`)
    ) {
      await this.plugin.app.vault.adapter.remove(`${path}/${this.name}.zip`);
    }
  }

  public addIcon(iconName: string, iconContent: string): Icon | undefined {
    // Normalize the icon name to remove `-` or `_` in the name.
    iconName = getNormalizedName(iconName);
    const icon = generateIcon(this, iconName, iconContent);
    if (!icon) {
      logger.warn(
        `Icon could not be generated (icon: ${iconName}, content: ${iconContent})`,
      );
      return undefined;
    }

    this.icons.push(icon);

    return icon;
  }

  public removeIcon(path: string, iconName: string): Promise<void> {
    if (this.isCustom) {
      return;
    }

    return this.plugin.app.vault.adapter.rmdir(
      `${path}/${this.name}/${iconName}.svg`,
      true,
    );
  }

  /**
   * 用新建或加载到的索引替换图标包内容 / Replaces the pack's contents with an index.
   */
  public setIndex(index: IconPackIndex | IconEntry[] | CompactIconIndex): void {
    const entries =
      index instanceof CompactIconIndex || Array.isArray(index)
        ? index
        : index.entries;
    this.entries =
      entries instanceof CompactIconIndex
        ? entries
        : CompactIconIndex.fromEntriesSync(entries);
  }

  /** 大包的启动登记分片执行。 / Register large packs cooperatively at startup. */
  public async loadIndex(index: IconPackIndex): Promise<void> {
    this.entries =
      index.entries instanceof CompactIconIndex
        ? index.entries
        : await CompactIconIndex.fromEntries(index.entries);
  }

  /**
   * 按 id 或裸名查找条目 / Looks an entry up by its full id or by its bare name.
   */
  public getEntry(nameOrId: string): IconEntry | undefined {
    return this.entries.getEntry(nameOrId);
  }

  /**
   * 该图标包的全部条目 / Every entry in the pack, as metadata.
   */
  public getEntries(): IconEntry[] {
    return Array.from(this.entries);
  }

  /** 内部检索使用紧凑表；显式的旧列表 API 仍返回数组。 / Internal compact access; retain the legacy array API. */
  public getCompactIndex(): CompactIconIndex {
    return this.entries;
  }

  /** 解析器共享此包的查找器，避免再次为百万条目登记两个字符串键。 / Share the pack lookup with the resolver. */
  public getEntryLookup(): {
    length: number;
    getEntry(query: string): IconEntry | undefined;
  } {
    return this.entries;
  }

  public getSource(): IconSource | undefined {
    return this.source;
  }

  /**
   * 用户是否自己维护这个包的文件 / Whether the user maintains this pack's files.
   *
   * 只有自定义包才允许被写入；归档包保持压缩，绝不落外部 SVG 文件。
   * Only custom packs may be written to; archives stay compressed.
   */
  public isCustomPack(): boolean {
    return this.isCustom;
  }

  /**
   * 按图标名查找 / Looks an icon up by name.
   *
   * 索引包返回只含元数据的图标对象（`svgElement` 为空），真正的标记由解析器按需提供。
   * Index-backed packs return metadata-only icons; the resolver supplies the markup.
   */
  public getIcon(iconName: string): Icon | undefined {
    const entry = this.getEntry(iconName);
    if (entry) {
      return this.toMetadataIcon(entry);
    }

    return this.icons.find((icon) => getNormalizedName(icon.name) === iconName);
  }

  /** 精确匹配优先，避免短名被其它名称的子串挤到后面。 / Prioritize exact names over substring matches. */
  public findExactIcon(query: string): Icon | undefined {
    const entry = this.getEntry(query);
    if (entry) return this.toMetadataIcon(entry);
    const key = query.trim().toLowerCase();
    return this.icons.find(
      (icon) =>
        icon.name.toLowerCase() === key ||
        (icon.prefix + icon.name).toLowerCase() === key ||
        icon.displayName.toLowerCase() === key,
    );
  }

  /**
   * 把索引条目转换为只含元数据的图标对象 / Maps an index entry to a metadata-only icon.
   */
  private toMetadataIcon(entry: IconEntry): Icon {
    return {
      name: entry.name,
      prefix: this.prefix,
      displayName: entry.displayName,
      iconPackName: this.name,
      filename: entry.name,
      svgContent: '',
      svgViewbox: '',
      svgElement: '',
    };
  }

  /**
   * 用已解析的图标替换图标包内容 / Replaces the pack's contents with resolved icons.
   */
  public setIcons(icons: Icon[]): void {
    this.icons = icons;
  }

  public getName(): string {
    return this.name;
  }

  public getPrefix(): string {
    return this.prefix;
  }

  /**
   * 图标包中的图标数量 / Number of icons in the pack.
   */
  public get size(): number {
    return this.entries.length > 0 ? this.entries.length : this.icons.length;
  }

  /**
   * 该图标包的全部图标 / Every icon in the pack.
   *
   * 索引包返回元数据（`svgElement` 为空），调用方若需要标记应通过解析器按需获取。
   * Index-backed packs return metadata; callers needing markup resolve on demand.
   */
  public getIcons(): Icon[] {
    if (this.entries.length > 0) {
      return Array.from(this.entries, (entry) => this.toMetadataIcon(entry));
    }

    return this.icons;
  }

  /** 逐条枚举元数据，避免每次搜索复制整个包。 / Iterate without allocating a full metadata array. */
  public *iterateIcons(): Generator<Icon> {
    if (this.entries.length) {
      for (const entry of this.entries) yield this.toMetadataIcon(entry);
    } else {
      yield* this.icons;
    }
  }
}
