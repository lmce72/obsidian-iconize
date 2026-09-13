/**
 * 图标源抽象 / Icon source abstraction.
 *
 * 参考 glyphit 的架构：图标包保持压缩，索引只读名称不读内容，
 * 只有真正被使用的图标才解压读取。
 * Modeled on glyphit's architecture: packs stay compressed, indexing reads
 * names rather than bytes, and only icons actually used get decompressed.
 */

import JSZip from 'jszip';
import { DataAdapter } from 'obsidian';
import { logger } from './logger';

// ===== PATCHED: 图标源类型定义 / Icon source types =====
/** 源中的一个条目，尚未应用命名规则 / An entry as discovered by a source. */
export interface RawEntry {
  /** 源内的完整路径 / Full path of the icon inside the source. */
  path: string;
  size?: number;
}

/** 源指纹，用于判断索引是否过期 / Cheap staleness signal for a pack source. */
export interface SourceFingerprint {
  size: number;
  mtime: number;
  count: number;
}

export type IconPackSourceType = 'zip' | 'folder';

/**
 * 图标读取源 / A place icons can be read from.
 *
 * `listEntries` 必须廉价（索引期遍历数千条目）；`readEntry` 才允许做真正的解压工作。
 * `listEntries` must be cheap; `readEntry` is the only method allowed to do real work.
 */
export interface IconSource {
  readonly type: IconPackSourceType;
  listEntries(): Promise<RawEntry[]>;
  readEntry(path: string): Promise<string | null>;
  fingerprint(): Promise<SourceFingerprint>;
  dispose(): void;
}
// ===== END PATCH =====

/**
 * 从 `.zip` 归档中读取图标，始终不落盘解压。
 * Reads icons out of a `.zip` archive without ever unpacking it to disk.
 */
export class ZipSource implements IconSource {
  public readonly type = 'zip' as const;

  /**
   * 归档读取结果，保存 Promise 使并发调用共享同一次文件读取。
   * Stored as a promise rather than the result so concurrent callers share one read.
   */
  private archive: Promise<JSZip> | null = null;

  constructor(
    private readonly adapter: DataAdapter,
    private readonly zipPath: string,
    private readonly extraPath = '',
  ) {}

  private open(): Promise<JSZip> {
    if (this.archive === null) {
      this.archive = this.adapter
        .readBinary(this.zipPath)
        .then((buffer) => JSZip.loadAsync(buffer));

      // 读取失败不能缓存，否则之后每次读取都会失败。
      // A failed read must not be cached, otherwise every later read fails too.
      this.archive.catch(() => {
        this.archive = null;
      });
    }

    return this.archive;
  }

  /**
   * 归档中全部条目的名称 / Every entry name in the archive.
   */
  private async listNames(): Promise<string[]> {
    const zip = await this.open();

    const names: string[] = [];
    zip.forEach((relativePath: string, file: JSZip.JSZipObject) => {
      if (!file.dir) {
        names.push(relativePath);
      }
    });
    return names;
  }

  private isSvg(name: string): boolean {
    return !name.endsWith('/') && name.toLowerCase().endsWith('.svg');
  }

  /**
   * 去掉配置路径的首段。
   * Drops the leading segment of the configured extra path.
   *
   * 预定义图标包固定了一个带版本号的路径（如 `fontawesome-free-7.2.0-web/svgs/solid/`），
   * 用户安装的往往是别的版本，导致固定路径匹配不到、图标包静默索引为 0。
   * 匹配版本段之后的部分（`svgs/solid/`）可以让图标包跨版本继续工作。
   */
  private relaxedExtraPath(): string {
    const firstSlash = this.extraPath.indexOf('/');
    return firstSlash === -1 ? '' : this.extraPath.substring(firstSlash + 1);
  }

  public async listEntries(): Promise<RawEntry[]> {
    const names = await this.listNames();
    const svgs = names.filter((name) => this.isSvg(name));

    if (this.extraPath === '') {
      return svgs.map((path) => ({ path }));
    }

    const exact = svgs.filter((name) => name.startsWith(this.extraPath));
    if (exact.length > 0) {
      return exact.map((path) => ({ path }));
    }

    // 精确路径没有匹配，多半是安装的归档版本与固定路径不同。
    const relaxed = this.relaxedExtraPath();
    if (relaxed !== '') {
      const matched = svgs.filter((name) => name.includes(`/${relaxed}`));
      if (matched.length > 0) {
        logger.info(
          `Matched icon pack entries in '${this.zipPath}' on relaxed path '${relaxed}' because '${this.extraPath}' matched nothing`,
        );
        return matched.map((path) => ({ path }));
      }
    }

    return [];
  }

  public async readEntry(path: string): Promise<string | null> {
    const zip = await this.open();
    const file = zip.file(path);
    if (!file) {
      return null;
    }

    return file.async('text');
  }

  public async fingerprint(): Promise<SourceFingerprint> {
    try {
      const stat = await this.adapter.stat(this.zipPath);
      return { size: stat?.size ?? 0, mtime: stat?.mtime ?? 0, count: 0 };
    } catch (error) {
      logger.warn(`Could not stat '${this.zipPath}' (${error})`);
      return { size: 0, mtime: 0, count: 0 };
    }
  }

  public dispose(): void {
    this.archive = null;
  }
}

/**
 * 从普通 `.svg` 文件目录读取图标（用户自建图标包，或旧版本解压出来的图标）。
 * Reads icons out of a plain directory of `.svg` files.
 *
 * 与旧实现不同，遍历是递归的，因此自定义图标包可以按子文件夹组织。
 * Unlike the previous implementation the walk is recursive.
 */
export class FolderSource implements IconSource {
  public readonly type = 'folder' as const;

  constructor(
    private readonly adapter: DataAdapter,
    private readonly root: string,
  ) {}

  private async walk(dir: string, collected: RawEntry[]): Promise<void> {
    if (!(await this.adapter.exists(dir))) {
      return;
    }

    let listing: { files: string[]; folders: string[] };
    try {
      listing = await this.adapter.list(dir);
    } catch (error) {
      logger.warn(`Could not list '${dir}' (${error})`);
      return;
    }

    for (const file of listing.files) {
      if (file.toLowerCase().endsWith('.svg')) {
        collected.push({ path: file });
      }
    }

    for (const folder of listing.folders) {
      await this.walk(folder, collected);
    }
  }

  public async listEntries(): Promise<RawEntry[]> {
    const collected: RawEntry[] = [];
    await this.walk(this.root, collected);
    return collected;
  }

  public async readEntry(path: string): Promise<string | null> {
    if (!(await this.adapter.exists(path))) {
      return null;
    }

    return this.adapter.read(path);
  }

  public async fingerprint(): Promise<SourceFingerprint> {
    const entries = await this.listEntries();
    let mtime = 0;
    try {
      const stat = await this.adapter.stat(this.root);
      mtime = stat?.mtime ?? 0;
    } catch (error) {
      logger.warn(`Could not stat '${this.root}' (${error})`);
    }

    // 目录自身的大小没有意义，用文件数量承载信号：增删图标都会改变它。
    return { size: 0, mtime, count: entries.length };
  }

  public dispose(): void {
    // 不持有任何句柄，每次读取都直接走文件系统。
  }
}

/**
 * 目录是否是插件生成的状态而非用户的图标包。
 * Whether a directory is generated state rather than a user's icon pack.
 */
export function isReservedDirectory(name: string): boolean {
  return name === '.cache' || name.startsWith('.');
}

/**
 * 取路径的最后一段 / Returns the last path segment.
 */
export function basename(path: string): string {
  return path.substring(path.lastIndexOf('/') + 1);
}

/**
 * 去掉开头斜杠（Obsidian 适配器视其与无斜杠等价，但会破坏路径比较）。
 * Strips a leading slash so path comparisons stay consistent.
 */
export function normalizePath(path: string): string {
  return path.startsWith('/') ? path.slice(1) : path;
}
