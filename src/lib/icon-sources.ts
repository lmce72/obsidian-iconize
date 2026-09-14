/**
 * 图标源抽象 / Icon source abstraction.
 *
 * 参考 glyphit 的架构：图标包保持压缩，索引只读名称不读内容，
 * 只有真正被使用的图标才解压读取。
 * Modeled on glyphit's architecture: packs stay compressed, indexing reads
 * names rather than bytes, and only icons actually used get decompressed.
 */

import { strFromU8, unzipSync } from 'fflate';
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
  /**
   * 归档的原始字节，读取后保留以复用。存 Promise 而非结果，使并发调用共享同一次读取。
   * Raw archive bytes, kept after the first read. A promise so concurrent callers share
   * one read.
   */
  private archive: Promise<Uint8Array> | null = null;

  constructor(
    private readonly adapter: DataAdapter,
    private readonly zipPath: string,
    private readonly extraPath = '',
  ) {}

  private open(): Promise<Uint8Array> {
    if (this.archive === null) {
      this.archive = this.adapter
        .readBinary(this.zipPath)
        .then((buffer) => new Uint8Array(buffer));

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
   *
   * `filter` 对每个条目都会被调用，返回 `false` 即跳过解压——因此这里只走一遍归档末尾的
   * 中央目录，不碰任何压缩数据。这是整套按需加载成立的前提：数千个图标的名字只花一次
   * 目录遍历的代价。
   *
   * `filter` runs per entry, and returning `false` skips inflation — so this walks only the
   * central directory at the end of the archive and never touches compressed data. That is
   * what makes the whole scheme work: thousands of names for one directory pass.
   */
  private async listNames(): Promise<string[]> {
    const bytes = await this.open();

    const names: string[] = [];
    unzipSync(bytes, {
      filter: (file) => {
        if (!file.name.endsWith('/')) {
          names.push(file.name);
        }
        return false;
      },
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

  /**
   * 判断条目是否位于某个路径片段之下。
   * Whether an entry sits under a path fragment.
   *
   * 归档既可能在片段前还有一层包装目录（`pack-x/svgs/solid/…`），也可能直接从该片段开始
   * （`svgs/solid/…`）。两种都要认，否则没有包装目录的归档会索引不到任何图标。
   *
   * The fragment may follow a wrapper directory or start the entry, and both must match;
   * otherwise an archive without a wrapper indexes to nothing.
   */
  private underFragment(name: string, fragment: string): boolean {
    return name.startsWith(fragment) || name.includes(`/${fragment}`);
  }

  public async listEntries(): Promise<RawEntry[]> {
    const names = await this.listNames();
    const svgs = names.filter((name) => this.isSvg(name));

    if (this.extraPath === '') {
      return svgs.map((path) => ({ path }));
    }

    const exact = svgs.filter((name) =>
      this.underFragment(name, this.extraPath),
    );
    if (exact.length > 0) {
      return exact.map((path) => ({ path }));
    }

    // 精确路径没有匹配，多半是安装的归档版本与固定路径不同。
    // 逐级放宽：先去掉带版本号的首段，再退到路径末段。
    const relaxedCandidates = [
      this.relaxedExtraPath(),
      this.extraPath.substring(this.extraPath.lastIndexOf('/') + 1),
    ].filter((candidate) => candidate !== '');

    for (const candidate of relaxedCandidates) {
      const matched = svgs.filter((name) =>
        this.underFragment(name, candidate),
      );
      if (matched.length > 0) {
        logger.info(
          `Matched icon pack entries in '${this.zipPath}' on relaxed path '${candidate}' because '${this.extraPath}' matched nothing`,
        );
        return matched.map((path) => ({ path }));
      }
    }

    return [];
  }

  /**
   * 读取单个条目 / Reads a single entry.
   *
   * `filter` 只放行目标条目，因此无论归档里有几千个图标，这里只解压这一个。
   * The filter admits exactly one entry, so however many icons the archive holds, only
   * this one is inflated.
   */
  public async readEntry(path: string): Promise<string | null> {
    try {
      const bytes = await this.open();

      const unzipped = unzipSync(bytes, {
        filter: (file) => file.name === path,
      });
      const data = unzipped[path];

      if (!data) {
        return null;
      }

      return strFromU8(data);
    } catch (error) {
      logger.error(
        `Could not read '${path}' from '${this.zipPath}' (${error})`,
      );
      return null;
    }
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
  return name.startsWith('.');
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
