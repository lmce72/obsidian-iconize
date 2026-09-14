/**
 * 图标索引构建 / Icon pack index building.
 *
 * 索引只读名称不读字节：一个数千图标的图标包只需解析一次归档目录。
 * Indexing is deliberately cheap: it reads names, not bytes.
 */

import { getNormalizedName } from '@app/icon-pack-manager/util';
import { logger } from './logger';
import {
  IconSource,
  IconPackSourceType,
  RawEntry,
  SourceFingerprint,
} from './icon-sources';

// ===== PATCHED: 索引类型定义 / Index types =====
/** 索引格式版本，改动索引结构或命名规则时必须递增。 */
export const ICON_PACK_INDEX_VERSION = 3;

/**
 * 图标包中的一个图标（不含 SVG 内容）/ A single icon inside a pack, without its SVG.
 */
export interface IconEntry {
  /** 全局唯一标识，含前缀（如 `LiHome`），持久化在插件数据中。 */
  id: string;
  /** 不含前缀的标识（如 `Home`）。 */
  name: string;
  /** 人类可读名称，来自原始文件名（如 `home`）。 */
  displayName: string;
  /** 图标所在目录，相对图标包根目录（如 `Design`），根目录为空串。 */
  folder: string;
  /** 图标在其源中的路径，用于读回字节（zip 条目名，或目录包的仓库路径）。 */
  path: string;
}

/**
 * 单个图标包的持久化索引 / The persisted index of a single icon pack.
 */
export interface IconPackIndex {
  version: number;
  packName: string;
  prefix: string;
  sourceType: IconPackSourceType;
  fingerprint: SourceFingerprint;
  builtAt: number;
  entries: IconEntry[];
}
// ===== END PATCH =====

/** 图标名必须以大写字母或数字开头，否则前缀切分无法确定边界。 */
const VALID_ICON_NAME = /^[A-Z0-9]/;

function stripExtension(filename: string): string {
  return filename.replace(/\.svg$/i, '');
}

function dirnameOf(path: string): string {
  const index = path.lastIndexOf('/');
  return index === -1 ? '' : path.substring(0, index);
}

/**
 * 计算所有路径共有的最深目录 / Deepest directory shared by every given path.
 *
 * 图标 zip 通常包着一层无意义的样板目录（如 `icons/ffffff/transparent/1x1/`），
 * 剥掉公共根之后剩下的目录才是真正区分图标的那个。
 */
export function commonRootOf(paths: string[]): string {
  if (paths.length === 0) {
    return '';
  }

  const segmentLists = paths.map((path) => {
    const dir = dirnameOf(path);
    return dir === '' ? [] : dir.split('/');
  });

  let common = segmentLists[0];
  for (const segments of segmentLists.slice(1)) {
    let i = 0;
    while (
      i < common.length &&
      i < segments.length &&
      common[i] === segments[i]
    ) {
      i++;
    }
    common = common.slice(0, i);
    if (common.length === 0) {
      break;
    }
  }

  return common.length === 0 ? '' : `${common.join('/')}/`;
}

/**
 * 把（可能嵌套的）目录路径规范化为 PascalCase 名称片段。
 * Normalizes a (possibly nested) folder path into a PascalCase name fragment.
 */
function normalizeFolder(folder: string): string {
  if (folder === '') {
    return '';
  }

  return getNormalizedName(folder.split('/').join('-'));
}

interface Candidate {
  path: string;
  folder: string;
  base: string;
  displayName: string;
}

/**
 * 找出能区分一组同名图标的那几个目录层级。
 * Picks the folder segments that tell a group of same-named icons apart.
 */
function distinguishingSegments(folders: string[]): number[] {
  const segmentLists = folders.map((folder) =>
    folder === '' ? [] : folder.split('/'),
  );
  const depth = Math.max(...segmentLists.map((segments) => segments.length), 0);
  const indices: number[] = [];

  for (let i = 0; i < depth; i++) {
    const values = new Set(segmentLists.map((segments) => segments[i] ?? ''));
    if (values.size > 1) {
      indices.push(i);
    }
  }

  return indices;
}

/**
 * 把原始源条目转换为完整命名的 {@link IconEntry}。
 * Turns raw source entries into fully named {@link IconEntry} objects.
 *
 * 命名分三趟，结果只取决于路径集合、与发现顺序无关：
 * 1. 包内唯一的文件名保留短名（与旧版本字节级兼容）。
 * 2. 重名的文件名折入目录（只折真正有区分度的层级）。
 * 3. 仍然冲突的按路径顺序加数字后缀。
 */
export function resolveEntryIds(
  prefix: string,
  raws: RawEntry[],
  commonRoot = commonRootOf(raws.map((raw) => raw.path)),
): IconEntry[] {
  const candidates: Candidate[] = [];

  for (const raw of raws) {
    const displayName = stripExtension(basenameOf(raw.path));
    const base = getNormalizedName(displayName);

    // 前缀切分无法处理不以大写字母/数字开头的名称，这类图标不可寻址。
    if (!VALID_ICON_NAME.test(base)) {
      continue;
    }

    const dir = dirnameOf(raw.path);
    const folder = dir.startsWith(commonRoot.replace(/\/$/, ''))
      ? dir.substring(commonRoot.length)
      : dir;

    candidates.push({ path: raw.path, folder, base, displayName });
  }

  // 预先排序使每一次后续的平局决策都是确定的。
  candidates.sort((a, b) => a.path.localeCompare(b.path));

  const groups = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const key = candidate.base.toLowerCase();
    const group = groups.get(key);
    if (group) {
      group.push(candidate);
    } else {
      groups.set(key, [candidate]);
    }
  }

  const qualifierByPath = new Map<string, string>();
  for (const group of groups.values()) {
    if (group.length === 1) {
      qualifierByPath.set(group[0].path, '');
      continue;
    }

    const indices = distinguishingSegments(
      group.map((candidate) => candidate.folder),
    );

    for (const candidate of group) {
      const segments =
        candidate.folder === '' ? [] : candidate.folder.split('/');
      const qualifier = indices
        .map((index) => normalizeFolder(segments[index] ?? ''))
        .join('');
      qualifierByPath.set(candidate.path, qualifier);
    }
  }

  const entries: IconEntry[] = candidates.map((candidate) => {
    const name = `${qualifierByPath.get(candidate.path) ?? ''}${candidate.base}`;

    return {
      id: `${prefix}${name}`,
      name,
      displayName: candidate.displayName,
      folder: candidate.folder,
      path: candidate.path,
    };
  });

  // 第三趟：文件名与目录名都相同的两个图标（如 a/x/icon.svg 与 b/x/icon.svg）仍会冲突，用数字区分。
  const seen = new Map<string, number>();
  for (const entry of entries) {
    const key = entry.id.toLowerCase();
    const occurrence = seen.get(key) ?? 0;
    seen.set(key, occurrence + 1);

    if (occurrence > 0) {
      entry.name = `${entry.name}${occurrence + 1}`;
      entry.id = `${prefix}${entry.name}`;
    }
  }

  return entries;
}

function basenameOf(path: string): string {
  return path.substring(path.lastIndexOf('/') + 1);
}

/**
 * 从图标包源构建可检索索引 / Builds the searchable index of a pack from its source.
 */
export async function buildIndex(
  packName: string,
  prefix: string,
  source: IconSource,
): Promise<IconPackIndex> {
  const raws = await source.listEntries();
  const entries = resolveEntryIds(prefix, raws);
  const fingerprint = await source.fingerprint();

  return {
    version: ICON_PACK_INDEX_VERSION,
    packName,
    prefix,
    sourceType: source.type,
    // 指纹必须原样保留源报告的计数：`entries` 已经过滤掉命名不合法的文件，
    // 用它覆盖计数会让「索引计数 ≠ 源计数」永久成立，每次启动都判定为过期并重建。
    //
    // Keep the source's own count: `entries` has invalid names filtered out, and storing
    // that count here would make the index permanently stale and rebuild on every launch.
    fingerprint,
    builtAt: Date.now(),
    entries,
  };
}

/**
 * 把索引序列化为紧凑形式 / Serializes an index into its compact form.
 *
 * 每个条目只落地 `name` 与 `path`：`id` 是前缀加名称、`displayName` 是 path 的文件名，
 * `folder` 只在建索引时用于重名消解、之后不再读取——三者都可推导。加上不再缩进输出，
 * 索引文件可缩小数倍，直接减轻同步负担。
 *
 * Only `name` and `path` are written per entry: `id` is the prefix plus the name,
 * `displayName` is the path's filename, and `folder` is used only while building the index
 * for collision handling and never read afterwards — all three are derivable. Combined with
 * dropping the pretty-printing, the index file shrinks several-fold, which is directly less
 * to sync.
 */
export function serializeIndex(index: IconPackIndex): string {
  return JSON.stringify({
    ...index,
    entries: index.entries.map((entry) => [entry.name, entry.path]),
  });
}

/**
 * 由紧凑条目还原完整条目 / Expands a compact entry back into a full one.
 */
function expandEntry(prefix: string, name: string, path: string): IconEntry {
  const lastSlash = path.lastIndexOf('/');
  return {
    id: `${prefix}${name}`,
    name,
    displayName: path.substring(lastSlash + 1).replace(/\.svg$/i, ''),
    folder: lastSlash === -1 ? '' : path.substring(0, lastSlash),
    path,
  };
}

/**
 * 解析索引文件 / Parses an index file.
 *
 * 同时接受紧凑形式（条目为二元数组）与早期形式（条目为对象），因此旧索引不会失效。
 * Accepts both the compact form (entries as pairs) and the earlier form (entries as
 * objects), so an existing index keeps working.
 */
export function deserializeIndex(raw: string): IconPackIndex | null {
  try {
    const parsed = JSON.parse(raw) as IconPackIndex & {
      entries: unknown[];
    };
    if (!parsed || !Array.isArray(parsed.entries)) {
      return null;
    }

    const prefix = parsed.prefix ?? '';
    parsed.entries = parsed.entries.map((entry) =>
      Array.isArray(entry)
        ? expandEntry(prefix, entry[0] as string, entry[1] as string)
        : (entry as IconEntry),
    );

    return parsed;
  } catch (error) {
    logger.warn(`Could not parse the icon index (${error})`);
    return null;
  }
}

/**
 * 判断持久化索引是否仍然可信 / Decides whether a persisted index can still be trusted.
 *
 * 索引由旧版本 schema 写入、或源已不再与索引时一致时重建。
 * 归档看大小与时间戳，目录看文件数量。
 */
export function isIndexStale(
  index: IconPackIndex | null,
  current: SourceFingerprint,
): boolean {
  if (!index || index.version !== ICON_PACK_INDEX_VERSION) {
    return true;
  }

  const previous = index.fingerprint;
  if (!previous) {
    return true;
  }

  if (index.sourceType === 'folder') {
    return previous.count !== current.count || previous.mtime !== current.mtime;
  }

  return previous.size !== current.size || previous.mtime !== current.mtime;
}

/**
 * 取源指纹 / Fingerprint of a pack source.
 */
export async function getSourceFingerprint(
  source: IconSource,
): Promise<SourceFingerprint> {
  return source.fingerprint();
}

// ===== PATCHED: 图标包前缀推导 =====
/**
 * 由图标包名推导前缀 / Derives the short prefix used to address a pack's icons.
 * 与 IconPack.generatePrefix 保持一致（多词包每段首字母，单词包取前两位）。
 */
export function createIconPackPrefix(name: string): string {
  if (name.includes('-')) {
    const splitted = name.split('-');
    let result = splitted[0].charAt(0).toUpperCase();
    for (let i = 1; i < splitted.length; i++) {
      result += splitted[i].charAt(0).toLowerCase();
    }
    return result;
  }

  return name.charAt(0).toUpperCase() + name.charAt(1).toLowerCase();
}
// ===== END PATCH =====

export { getNormalizedName };
