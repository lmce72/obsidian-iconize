/**
 * 导入命名 / Import naming.
 *
 * 图标名只保留文件/类名本身；图标包前缀由包名推导，因此不同包之间的同名图标
 * 天然隔离。这里只负责让名称可寻址、可复现，并避免路径穿越。
 *
 * Icon names keep only the file or class name; the pack prefix is derived from the
 * pack name, which isolates equal names across packs. This module only makes names
 * addressable and reproducible, and prevents path traversal.
 */

const MAX_NAME_LENGTH = 120;
const MAX_FOLDER_DEPTH = 6;
/** 图标名必须以字母或数字开头，前缀切分才能确定边界。 */
const ADDRESSABLE = /^[A-Za-z0-9]/;

/**
 * 清洗一个图标名 / Sanitizes one icon name.
 *
 * 返回 `null` 表示该名称无法保留任何可用字符。
 * Returns `null` when nothing usable remains.
 */
export function sanitizeIconName(raw: string): string | null {
  let name = raw
    .replace(/\.svg$/i, '')
    .replace(/[._\s]+/g, '-')
    // 保留 Unicode 字母与数字：中文图标名可以继续被搜索到。
    // Keep Unicode letters and digits so non-Latin icon names stay searchable.
    .replace(/[^\p{L}\p{N}-]+/gu, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (!name) return null;
  name = name.slice(0, MAX_NAME_LENGTH).replace(/-+$/g, '');
  if (!name) return null;
  // 索引要求名称以 ASCII 大写字母或数字开头，否则前缀切分无法确定边界。
  // The index requires an ASCII upper-case letter or digit first, or the prefix
  // boundary cannot be determined.
  if (!ADDRESSABLE.test(name)) name = `Icon-${name}`;
  return name;
}

/**
 * 清洗相对目录 / Sanitizes a relative folder path.
 *
 * 目录只用于区分同名图标，不参与前缀切分。
 * Folders only keep equal icon names apart and never participate in the prefix.
 */
export function sanitizeFolder(raw: string | undefined): string {
  if (!raw) return '';
  const segments = raw
    .split('/')
    .map((segment) =>
      segment
        .replace(/[^A-Za-z0-9 _-]+/g, '-')
        .replace(/[_\s]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-+|-+$/g, ''),
    )
    .filter((segment) => segment && segment !== '.' && segment !== '..')
    .slice(-MAX_FOLDER_DEPTH);
  return segments.join('/');
}

/**
 * 由文件名推导图标包名 / Derives a pack name from a file name.
 *
 * 结果必须满足 `registerIconPack` 的校验：非空、不以点开头、不含斜杠。
 * The result must satisfy `registerIconPack`: non-empty, no leading dot, no slash.
 */
export function packNameFromFileName(fileName: string): string {
  let name = fileName
    .replace(/^.*[\\/]/, '')
    .replace(/\.(tar\.gz|tgz|zip|json|svg|ttf|otf|woff2|woff|css)$/i, '');
  name = name
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return name && name !== '.' && name !== '..' ? name : 'icon-pack';
}

/** 去掉常见图标库的 CSS 类名前缀 / Strips common icon-library class prefixes. */
export function stripClassNamePrefix(name: string): string {
  return name.replace(/^(?:fa|bi|mdi|ri|icon|nf)[-_]/, '') || name;
}
