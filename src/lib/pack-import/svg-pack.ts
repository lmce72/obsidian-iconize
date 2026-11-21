/**
 * SVG 归档转换 / SVG archive conversion.
 *
 * 通用图标包仓库往往把图标、文档截图、构建产物和测试素材混在一个 ZIP 里。导入器
 * 用象征性目录（`icons`、`svg`、`svgs`、`src`）定位真正的图标集合，只保留其下的
 * SVG；`.github`、`docs`、`test` 等噪声目录在计数前就被排除。
 *
 * Generic icon repositories mix icons with documentation screenshots, build outputs and
 * test fixtures. The importer uses marker directories (`icons`, `svg`, `svgs`, `src`) to
 * locate the real collection and keeps only the SVGs beneath it; noise directories such
 * as `.github`, `docs` and `test` are excluded before counting.
 */

import { baseName, dirName, type ArchiveReader } from './archive';
import { hasSymbols, normalizeSvgDocument, splitSprite } from './svg';
import { PACK_MANIFEST_NAME } from './types';
import type { ConversionResult, GeneratedIcon, ImportContext } from './types';
import { throwIfAborted } from '../task-scheduler';

/** 不参与图标计数的目录名 / Directory names that never hold pack icons. */
const NOISE_SEGMENTS = new Set([
  '.agents',
  '.build',
  '.changeset',
  '.git',
  '.github',
  '.vscode',
  '__tests__',
  'demo',
  'demos',
  'doc',
  'docs',
  'documentation',
  'example',
  'examples',
  'fixture',
  'fixtures',
  'node_modules',
  'site',
  'test',
  'tests',
  'website',
]);

/** 标志性图标目录，越靠前越优先 / Marker directories, highest priority first. */
const PREFERRED_SEGMENTS = [
  'icons',
  'icon',
  'svgs',
  'svg',
  'glyphs',
  'src',
  'assets',
  'dist',
];

function isSvg(path: string): boolean {
  return !path.endsWith('/') && path.toLowerCase().endsWith('.svg');
}

function hasNoiseSegment(path: string): boolean {
  return path
    .split('/')
    .slice(0, -1)
    .some((segment) => NOISE_SEGMENTS.has(segment.toLowerCase()));
}

/** 目录下的 SVG 数量 / SVG counts per directory. */
function countDirectories(paths: string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const path of paths) {
    const segments = dirName(path).split('/').filter(Boolean);
    for (let depth = 0; depth <= segments.length; depth++) {
      const directory = segments.slice(0, depth).join('/');
      counts.set(directory, (counts.get(directory) ?? 0) + 1);
    }
  }
  return counts;
}

/**
 * 选择图标根目录 / Picks the icon root.
 *
 * 先找标志性目录；找不到时选「覆盖 95% 以上图标的最深目录」，这样既不会因为
 * 几个文档截图就退回归档根目录，也不会在只有单一风格时选中它的子目录。
 *
 * Marker directories win first. Otherwise the deepest directory covering at least 95%
 * of the icons is chosen, so a few documentation screenshots cannot force the archive
 * root while a style-only subtree cannot win over its parent.
 */
export function selectIconRoot(paths: string[]): string {
  if (!paths.length) return '';
  const counts = countDirectories(paths);

  let preferred: { directory: string; count: number; priority: number } | null =
    null;
  for (const [directory, count] of counts) {
    if (directory === '') continue;
    const segment = baseName(directory).toLowerCase();
    const priority = PREFERRED_SEGMENTS.indexOf(segment);
    if (priority === -1 || count < 3) continue;
    if (
      !preferred ||
      count > preferred.count ||
      (count === preferred.count && priority < preferred.priority)
    )
      preferred = { directory, count, priority };
  }
  if (preferred) return `${preferred.directory}/`;

  let max = 0;
  for (const count of counts.values()) max = Math.max(max, count);
  let best = '';
  let bestDepth = -1;
  for (const [directory, count] of counts) {
    if (count < max * 0.95) continue;
    const depth = directory ? directory.split('/').length : 0;
    if (
      depth > bestDepth ||
      (depth === bestDepth && directory.length < best.length)
    ) {
      best = directory;
      bestDepth = depth;
    }
  }
  return best ? `${best}/` : '';
}

/**
 * 转换一个 SVG 归档 / Converts an SVG archive.
 *
 * 先处理独立 SVG，再处理 sprite 容器；symbol 与已有独立图标同名时跳过，避免
 * `sprites/solid.svg` 把 `svgs/solid/*.svg` 的图标重复一遍。判断 sprite 只看内容，
 * 不按文件名猜测——`usb-symbol.svg`、`math-symbols.svg` 都是正常图标。
 *
 * Individual SVGs are processed first, then sprite containers; a symbol whose name
 * already exists as an individual icon is skipped, so `sprites/solid.svg` does not
 * duplicate `svgs/solid/*.svg`. Sprite detection inspects content only, never the file
 * name: `usb-symbol.svg` and `math-symbols.svg` are ordinary icons.
 */
export async function convertSvgArchive(
  reader: ArchiveReader,
  context: ImportContext,
): Promise<ConversionResult> {
  const allSvgPaths = reader.names.filter(isSvg);
  if (!allSvgPaths.length) throw new Error('The archive contains no SVG files');

  const cleanPaths = allSvgPaths.filter((path) => !hasNoiseSegment(path));
  const candidates = cleanPaths.length ? cleanPaths : allSvgPaths;
  const root = selectIconRoot(candidates);
  let selected = candidates
    .filter((path) => path.startsWith(root))
    .map((path) => ({ full: path, relative: path.substring(root.length) }));
  if (!selected.length) {
    selected = allSvgPaths.map((path) => ({ full: path, relative: path }));
  }

  const icons: GeneratedIcon[] = [];
  const sheets: { relative: string; text: string }[] = [];
  const knownNames = new Set<string>();
  const knownPaths = new Set<string>();
  let skipped = allSvgPaths.length - selected.length;
  let duplicates = 0;
  let processed = 0;

  const add = (name: string, folder: string, svg: string): boolean => {
    const key = name.toLowerCase();
    const pathKey = `${folder.toLowerCase()}/${key}`;
    // 同一目录同名才需要数字后缀；不同风格目录的同名图标必须都保留。
    // Only same-folder duplicates need a suffix; equal names in different style
    // folders must all survive.
    if (knownPaths.has(pathKey)) {
      duplicates++;
      return false;
    }
    knownPaths.add(pathKey);
    knownNames.add(key);
    icons.push({ name, folder, svg });
    return true;
  };

  for (const entry of selected) {
    throwIfAborted(context.signal);
    const text = await reader.readText(entry.full);
    if (text === null) {
      skipped++;
      continue;
    }
    const folder = dirName(entry.relative);
    if (hasSymbols(text)) {
      // 只有真正带 SVG symbol 的文件才在第二趟拆分；这里先存文本。
      // Only files with real SVG symbols are split in the second pass.
      sheets.push({ relative: entry.relative, text });
    } else {
      const svg = normalizeSvgDocument(text);
      if (svg)
        add(baseName(entry.relative).replace(/\.svg$/i, ''), folder, svg);
      else skipped++;
    }

    processed++;
    if (processed % 100 === 0) {
      context.onProgress?.(`正在转换图标 ${processed}/${selected.length}…`);
      await context.yieldToMain?.();
    }
  }

  let spriteSheets = 0;
  for (const sheet of sheets) {
    throwIfAborted(context.signal);
    const symbols = await splitSprite(sheet.text, {
      signal: context.signal,
      yieldToMain: context.yieldToMain,
    });
    if (symbols === null || !symbols.length) {
      // 孤立 symbol 或空 sprite：按普通 SVG 再试一次，仍失败才计为跳过。
      const svg = normalizeSvgDocument(sheet.text);
      if (svg)
        add(
          baseName(sheet.relative).replace(/\.svg$/i, ''),
          dirName(sheet.relative),
          svg,
        );
      else skipped++;
      continue;
    }
    spriteSheets++;
    const folder = dirName(sheet.relative);
    for (const symbol of symbols) {
      // 独立图标优先：sprite 只是同一批图标的合并副本。
      // Individual icons win: the sprite is only a merged copy of the same set.
      if (knownNames.has(symbol.name.toLowerCase())) {
        duplicates++;
        continue;
      }
      add(symbol.name, folder, symbol.svg);
    }
  }

  if (!icons.length)
    throw new Error('No usable SVG icons were found in the archive');

  // 归自带清单的归档应继续被识别为 Iconize ZIP，而不是通用 SVG 包。
  // An archive carrying our manifest stays recognizable as an Iconize ZIP.
  const native = reader.names
    .filter((name) => name !== PACK_MANIFEST_NAME)
    .every((name) => isSvg(name));
  const warnings: string[] = [];
  if (skipped > 0) warnings.push(`${skipped} 个非图标或无效 SVG 已跳过`);
  if (spriteSheets > 0)
    warnings.push(`${spriteSheets} 个 sprite 容器已拆分为独立图标`);
  if (duplicates > 0)
    warnings.push(`${duplicates} 个与独立图标重复的 sprite symbol 已跳过`);

  return {
    format: native ? 'iconize-zip' : 'svg-archive',
    label: native ? 'Iconize ZIP' : 'SVG 图标包',
    icons,
    skipped,
    warnings,
  };
}
