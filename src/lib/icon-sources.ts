/**
 * 图标源抽象 / Icon source abstraction.
 *
 * 参考 glyphit 的架构：图标包保持压缩，索引只读名称不读内容，
 * 只有真正被使用的图标才解压读取。
 * Modeled on glyphit's architecture: packs stay compressed, indexing reads
 * names rather than bytes, and only icons actually used get decompressed.
 */

import { ZipDirectory } from './zip-directory';
import { DataAdapter, Platform } from 'obsidian';
import { logger } from './logger';
import { ZipCache, ZipOpenGate } from './zip-cache';
import {
  createDesktopZipReader,
  ZipSourceChangedError,
} from './zip-range-reader';
import { yieldToMain } from './task-scheduler';

// 整个插件共享预算，不能每包各自允许几十 MiB。 / One budget across all sources, not one allowance per pack.
const archiveCache = new ZipCache<ZipSource, ZipDirectory>(
  (Platform.isDesktop ? 64 : 32) * 1024 * 1024,
);
const archiveOpenGate = new ZipOpenGate(Platform.isDesktop ? 2 : 1);
let archiveIdleTimer: number | null = null;
function keepArchive(source: ZipSource, directory: ZipDirectory): void {
  archiveCache.set(source, directory, directory.residentBytes);
  touchArchives();
}
function touchArchives(): void {
  if (archiveIdleTimer !== null) window.clearTimeout(archiveIdleTimer);
  archiveIdleTimer = archiveCache.residentBytes
    ? window.setTimeout(() => {
        archiveIdleTimer = null;
        archiveCache.clear();
      }, 15000)
    : null;
}

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
  cancel?(): void;
}
// ===== END PATCH =====

/**
 * 从 `.zip` 归档中读取图标，始终不落盘解压。
 * Reads icons out of a `.zip` archive without ever unpacking it to disk.
 */
export class ZipSource implements IconSource {
  public readonly type = 'zip' as const;

  /** 仅保留正在执行的打开操作，完成后的驻留归全局 LRU 管理。 / Keep only in-flight opens outside the global LRU. */
  private archive: Promise<ZipDirectory> | null = null;
  private listing: Promise<RawEntry[]> | null = null;
  private generation = 0;
  private closed = false;

  constructor(
    private readonly adapter: DataAdapter,
    private readonly zipPath: string,
    private readonly extraPath = '',
  ) {}

  private open(collectNames = false): Promise<ZipDirectory> {
    if (this.closed) return Promise.reject(new Error('ZIP source is closed'));
    const cached = archiveCache.get(this);
    if (cached) {
      touchArchives();
      return Promise.resolve(cached);
    }
    if (this.archive) return this.archive;
    const generation = this.generation;
    const pending = archiveOpenGate.run(async () => {
      if (this.closed) throw new Error('ZIP source is closed');
      const reader = await createDesktopZipReader(this.adapter, this.zipPath);
      const directory = reader
        ? await ZipDirectory.openReader(
            { ...reader, cancelled: () => this.closed },
            collectNames,
          )
        : await ZipDirectory.open(
            new Uint8Array(await this.adapter.readBinary(this.zipPath)),
            collectNames,
            () => this.closed,
          );
      if (!collectNames && generation === this.generation)
        keepArchive(this, directory);
      return directory;
    });
    this.archive = pending;
    const clearPending = () => {
      // 旧一代完成时不能清除新一代正在执行的读取。 / Older work must not clear a newer open.
      if (this.archive === pending) this.archive = null;
    };
    void pending.then(clearPending, clearPending);
    return pending;
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

  public listEntries(): Promise<RawEntry[]> {
    if (this.listing) return this.listing;
    const pending = this.collectEntries();
    this.listing = pending;
    const clear = () => {
      if (this.listing === pending) this.listing = null;
    };
    void pending.then(clear, clear);
    return pending;
  }

  private async collectEntries(): Promise<RawEntry[]> {
    const generation = this.generation;
    const directory = await this.open(true);
    const names = await directory.listNames();
    // 名称数组先转交调用者，再入 LRU，缓存永远不持有列举用的百万字符串。
    // Transfer temporary names before caching: the LRU must never retain the listing array.
    if (generation === this.generation) keepArchive(this, directory);
    // 完整分发包同时提供独立 SVG 与 symbol 集合；后者不是可独立显示的图标。
    // A distribution may ship individual SVGs alongside non-rendering symbol sheets.
    // 只有找到对应 svgs[/类别] 才排除 sprites/类别.svg，保留任意自定义 sprite 文件。
    // Require the matching individual-icon directory; do not exclude arbitrary sprite files.
    const individualDirectories = new Set<string>();
    let scanDeadline = performance.now() + 4;
    for (const name of names) {
      const match = name.match(/^(.*\/)?svgs(-full)?\/([^/]+)\/[^/]+\.svg$/i);
      if (match)
        individualDirectories.add(
          `${match[1] ?? ''}sprites${match[2] ?? ''}/${match[3]}.svg`.toLowerCase(),
        );
      if (performance.now() >= scanDeadline) {
        await yieldToMain('background');
        if (this.closed) {
          const error = new Error('ZIP indexing cancelled');
          error.name = 'AbortError';
          throw error;
        }
        scanDeadline = performance.now() + 4;
      }
    }
    const candidates = [
      this.extraPath,
      this.relaxedExtraPath(),
      this.extraPath.substring(this.extraPath.lastIndexOf('/') + 1),
    ].filter((candidate) => candidate !== '');
    let best = candidates.length;
    const entries: RawEntry[] = [];
    let deadline = performance.now() + 4;
    for (const name of names) {
      if (this.closed) {
        const error = new Error('ZIP indexing cancelled');
        error.name = 'AbortError';
        throw error;
      }
      const isDistributionSheet =
        /(^|\/)sprites(-full)?\/[^/]+\.svg$/i.test(name) &&
        individualDirectories.has(name.toLowerCase());
      const svg = this.isSvg(name) && !isDistributionSheet;
      if (svg && !this.extraPath) entries.push({ path: name });
      else if (svg) {
        const rank = candidates.findIndex((candidate) =>
          this.underFragment(name, candidate),
        );
        if (rank !== -1 && rank <= best) {
          if (rank < best) entries.length = 0;
          best = rank;
          entries.push({ path: name });
        }
      }
      if (performance.now() >= deadline) {
        await yieldToMain('background');
        deadline = performance.now() + 4;
      }
    }
    if (best > 0 && best < candidates.length)
      logger.info(
        `Matched '${this.zipPath}' on relaxed path '${candidates[best]}'`,
      );
    return entries;
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
      return await (await this.open()).read(path);
    } catch (error) {
      if (this.closed) return null;
      if (error instanceof ZipSourceChangedError) this.dispose();
      logger.error(
        `Could not read '${path}' from '${this.zipPath}'`,
        undefined,
        error,
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
    this.generation++;
    archiveCache.delete(this);
    if (!archiveCache.residentBytes && archiveIdleTimer !== null) {
      window.clearTimeout(archiveIdleTimer);
      archiveIdleTimer = null;
    }
    this.archive = null;
    this.listing = null;
  }
  public cancel(): void {
    this.closed = true;
    this.dispose();
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
  private snapshot: Promise<RawEntry[]> | null = null;
  private closed = false;

  constructor(
    private readonly adapter: DataAdapter,
    private readonly root: string,
  ) {}

  private async walk(dir: string, collected: RawEntry[]): Promise<void> {
    if (this.closed) {
      const error = new Error('Folder indexing cancelled');
      error.name = 'AbortError';
      throw error;
    }
    let listing: { files: string[]; folders: string[] };
    try {
      listing = await this.adapter.list(dir);
    } catch (error) {
      logger.warn(`Could not list '${dir}' (${error})`);
      return;
    }

    let deadline = performance.now() + 4;
    for (const file of listing.files) {
      if (this.closed) {
        const error = new Error('Folder indexing cancelled');
        error.name = 'AbortError';
        throw error;
      }
      if (file.toLowerCase().endsWith('.svg')) {
        collected.push({ path: file });
      }
      if (performance.now() >= deadline) {
        await yieldToMain('background');
        deadline = performance.now() + 4;
      }
    }

    for (const folder of listing.folders) {
      await this.walk(folder, collected);
    }
  }

  public listEntries(): Promise<RawEntry[]> {
    if (!this.snapshot) {
      const pending = (async () => {
        const collected: RawEntry[] = [];
        await this.walk(this.root, collected);
        return collected;
      })();
      this.snapshot = pending;
      void pending.catch(() => {
        if (this.snapshot === pending) this.snapshot = null;
      });
    }
    return this.snapshot;
  }

  public async readEntry(path: string): Promise<string | null> {
    try {
      return await this.adapter.read(path);
    } catch (error) {
      logger.warn(`Could not read folder icon '${path}' (${error})`);
      return null;
    }
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
    // 快照只服务一次索引轮次，包变更/索引完成后释放。 / Release the indexing snapshot on completion or pack changes.
    this.snapshot = null;
  }
  public cancel(): void {
    this.closed = true;
    this.dispose();
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
