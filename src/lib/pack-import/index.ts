/**
 * 多标准图标包导入 / Multi-standard icon pack import.
 *
 * 入口只做三件事：识别输入属于哪种标准、把该标准交给对应转换器、把结果归一化
 * 成插件一直使用的 ZIP 图标包。运行期完全感知不到这些格式差异。
 *
 * The entry point only does three things: identify the standard, hand it to the matching
 * converter, and normalize the result into the ZIP icon pack the plugin already uses.
 * The runtime never sees any of these format differences.
 */

import { strToU8, zipSync } from 'fflate';
import {
  baseName,
  MAX_TEXT_ENTRY_BYTES,
  openArchive,
  type ArchiveReader,
} from './archive';
import { convertFontPackage } from './font';
import { convertIconifyJson, isIconifyJson } from './iconify';
import { convertJsModuleArchive } from './js-module';
import {
  sanitizeFolder,
  sanitizeIconName,
  packNameFromFileName,
} from './names';
import { convertSvgArchive } from './svg-pack';
import { convertSvgFile } from './sprite';
import { normalizeSvgDocument } from './svg';
import {
  PACK_MANIFEST_NAME,
  type ConversionResult,
  type GeneratedIcon,
  type IconifySetInfo,
  type ImportContext,
  type NormalizedIconPack,
  type PackInputFile,
} from './types';
import { throwIfAborted, yieldToMain } from '../task-scheduler';

export { packNameFromFileName } from './names';
export { PACK_MANIFEST_NAME } from './types';
export type {
  IconPackFormat,
  IconifySetInfo,
  NormalizedIconPack,
  PackInputFile,
} from './types';

/** 导入选项 / Import options shared by the normalizer and the UI. */
export interface PackImportOptions {
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
  /**
   * 让用户选择归档中要导入的 Iconify 图标集；返回 `null` 表示取消。
   * Asks the user which Iconify sets to import. Returning `null` cancels.
   */
  selectIconifySets?: (sets: IconifySetInfo[]) => Promise<string[] | null>;
}

const FONT_EXTENSIONS = ['.ttf', '.otf', '.woff', '.woff2'];
const CSS_EXTENSIONS = ['.css'];
/**
 * 单个 Iconify JSON 的安全上限。fluent-emoji 等集合超过 64 MB，转换会产生
 * 数十万个图标并耗尽内存；宁可明确跳过，也不让渲染进程崩溃。
 *
 * Safety ceiling for one Iconify JSON. Sets such as fluent-emoji exceed 64 MB and would
 * produce hundreds of thousands of icons; skip them explicitly instead of exhausting
 * renderer memory.
 */
export const MAX_ICONIFY_JSON_BYTES = 64 * 1024 * 1024;

function extensionOf(fileName: string): string {
  const name = fileName.toLowerCase();
  const dot = name.lastIndexOf('.');
  return dot === -1 ? '' : name.substring(dot);
}

function isFontFile(fileName: string): boolean {
  return FONT_EXTENSIONS.includes(extensionOf(fileName));
}

function isCssFile(fileName: string): boolean {
  return CSS_EXTENSIONS.includes(extensionOf(fileName));
}

function isJsonFile(fileName: string): boolean {
  return extensionOf(fileName) === '.json';
}

function isSvgFile(fileName: string): boolean {
  return extensionOf(fileName) === '.svg';
}

function isJsFile(fileName: string): boolean {
  const extension = extensionOf(fileName);
  return extension === '.js' || extension === '.mjs' || extension === '.cjs';
}

function decodeText(bytes: Uint8Array): string {
  return new TextDecoder('utf-8').decode(bytes);
}

function looksLikeSvg(bytes: Uint8Array): boolean {
  const head = decodeText(bytes.subarray(0, Math.min(4096, bytes.length)))
    .replace(/^\uFEFF/, '')
    .trimStart();
  return head.startsWith('<') && /<svg[\s>]/i.test(head);
}

/**
 * 把归档里的字体与 CSS 组合成字体导入 / Reads font and CSS entries from an archive.
 */
async function fontInputsFromArchive(
  reader: ArchiveReader | null,
  fontNames: string[],
  cssNames: string[],
): Promise<PackInputFile[]> {
  if (!reader) return [];
  const inputs: PackInputFile[] = [];
  for (const name of fontNames) {
    const bytes = await reader.readBytes(name, MAX_TEXT_ENTRY_BYTES);
    if (bytes) inputs.push({ fileName: baseName(name), bytes });
  }
  for (const css of cssNames) {
    const bytes = await reader.readBytes(css, MAX_TEXT_ENTRY_BYTES);
    if (bytes) inputs.push({ fileName: baseName(css), bytes });
  }
  return inputs;
}

/**
 * 找出归档中的 Iconify 图标集 / Finds Iconify sets inside an archive.
 *
 * Iconify 的 icon-sets 仓库把数百个图标集放在 `json/*.json`，没有 SVG。优先只认
 * 这个标志目录；其它归档则退回到全部 JSON，并只解析前几个确认结构。
 *
 * The Iconify icon-sets repository keeps hundreds of sets in `json/*.json` with no SVG.
 * That marker directory wins; other archives fall back to all JSON entries, parsing only
 * the first few to confirm the structure.
 */
async function findIconifySets(
  reader: ArchiveReader,
): Promise<IconifySetInfo[]> {
  const preferred = reader.names.filter((name) =>
    /(^|\/)json\/[^/]+\.json$/i.test(name),
  );
  if (preferred.length) {
    for (const path of preferred.slice(0, 3)) {
      const size = await reader.sizeOf(path);
      if (size !== null && size > MAX_ICONIFY_JSON_BYTES) continue;
      const text = await reader.readText(path, MAX_TEXT_ENTRY_BYTES);
      if (!text) continue;
      try {
        const parsed: unknown = JSON.parse(text);
        if (isIconifyJson(parsed)) {
          return Promise.all(
            preferred.map(async (candidate) => ({
              path: candidate,
              prefix: baseName(candidate).replace(/\.json$/i, ''),
              size: (await reader.sizeOf(candidate)) ?? undefined,
            })),
          );
        }
      } catch {
        // Not an Iconify JSON; keep looking among the next candidates.
      }
    }
    return [];
  }

  // 没有标志目录时逐个校验，避免把 package.json 等普通文件列为图标集。
  // Without the marker directory, verify each JSON so ordinary files such as
  // package.json are not offered as icon sets.
  const found: IconifySetInfo[] = [];
  for (const path of reader.names.filter((name) =>
    name.toLowerCase().endsWith('.json'),
  )) {
    const size = await reader.sizeOf(path);
    if (size !== null && size > MAX_ICONIFY_JSON_BYTES) continue;
    const text = await reader.readText(path, MAX_TEXT_ENTRY_BYTES);
    if (!text) continue;
    try {
      const parsed: unknown = JSON.parse(text);
      if (isIconifyJson(parsed)) {
        found.push({
          path,
          prefix: baseName(path).replace(/\.json$/i, ''),
          size: size ?? undefined,
        });
      }
    } catch {
      // Ignore non-JSON or non-Iconify entries.
    }
  }
  return found;
}

/**
 * 转换归档中的一个或多个 Iconify 图标集 / Converts one or more Iconify sets.
 *
 * 多个图标集用各自的 prefix 作为目录，避免同名图标互相覆盖；只选一个时保持平铺。
 * Multiple sets use their own prefix as a folder so equal names never collide; a single
 * selected set stays flat.
 */
async function convertIconifyArchive(
  reader: ArchiveReader,
  sets: IconifySetInfo[],
  context: ImportContext,
  options: PackImportOptions,
): Promise<ConversionResult> {
  let selected = sets;
  if (sets.length > 1 && options.selectIconifySets) {
    const chosen = await options.selectIconifySets(sets);
    if (!chosen || !chosen.length) {
      const error = new Error('已取消导入 / Import cancelled');
      error.name = 'AbortError';
      throw error;
    }
    selected = sets.filter((set) => chosen.includes(set.path));
  }
  if (!selected.length)
    throw new Error('没有选择任何 Iconify 图标集 / No Iconify sets selected');

  const icons: GeneratedIcon[] = [];
  const warnings: string[] = [];
  let skipped = 0;
  for (let index = 0; index < selected.length; index++) {
    throwIfAborted(context.signal);
    const set = selected[index];
    context.onProgress?.(
      `正在转换 Iconify 图标集 ${index + 1}/${selected.length}：${set.prefix}`,
    );
    const size = await reader.sizeOf(set.path);
    if (size !== null && size > MAX_ICONIFY_JSON_BYTES) {
      skipped++;
      warnings.push(
        `${set.prefix}：JSON 超过 ${Math.round(
          MAX_ICONIFY_JSON_BYTES / 1024 / 1024,
        )} MB，已跳过`,
      );
      continue;
    }
    const text = await reader.readText(set.path, MAX_TEXT_ENTRY_BYTES);
    if (text === null) {
      skipped++;
      warnings.push(`${set.prefix}：无法读取`);
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      skipped++;
      warnings.push(`${set.prefix}：JSON 无法解析`);
      continue;
    }
    if (!isIconifyJson(parsed)) {
      skipped++;
      warnings.push(`${set.prefix}：不是 Iconify 图标集`);
      continue;
    }
    const converted = await convertIconifyJson(parsed, context);
    const folder =
      selected.length > 1 ? (converted.suggestedName ?? set.prefix) : undefined;
    for (const convertedIcon of converted.icons)
      icons.push({ ...convertedIcon, folder });
    skipped += converted.skipped;
    warnings.push(
      ...converted.warnings.map((warning) => `${set.prefix}：${warning}`),
    );
    await context.yieldToMain?.();
  }

  if (!icons.length)
    throw new Error(
      `没有转换出任何 Iconify 图标 / No Iconify icons produced${
        warnings.length ? `：${warnings.join('；')}` : ''
      }`,
    );
  return {
    format: 'iconify-archive',
    label: 'Iconify 图标集 / Iconify sets',
    icons,
    skipped,
    warnings,
    suggestedName: selected.length === 1 ? selected[0].prefix : 'iconify',
  };
}
/**
 * 按标志性内容选择转换器 / Dispatches to the converter selected by marker content.
 */
export async function convertPackInputs(
  inputs: PackInputFile[],
  context: ImportContext,
  options: PackImportOptions = {},
): Promise<ConversionResult> {
  if (!inputs.length)
    throw new Error('没有选择任何文件 / No files were selected');
  throwIfAborted(context.signal);

  // 多文件只可能是「字体 + CSS」；其它组合没有约定。
  // Multiple files can only be a font + CSS pair; other combinations have no contract.
  if (inputs.some((file) => isFontFile(file.fileName)))
    return convertFontPackage(inputs, context);
  if (inputs.length > 1)
    throw new Error(
      '请一次导入一个图标包文件，或同时选择字体及其 CSS / Import one pack file, or a font together with its CSS',
    );

  const file = inputs[0];
  const reader = await openArchive(file.bytes, context.signal);
  if (reader) {
    throwIfAborted(context.signal);
    const svgNames = reader.names.filter(isSvgFile);
    const fontNames = reader.names.filter(isFontFile);
    const cssNames = reader.names.filter(isCssFile);

    // SVG 图标优先：完整发行包常常同时附带字体与 sprite，字体只是补充产物。
    // 只有图标样本极少（或没有 SVG）时，才把归档当作字体包。
    //
    // SVG icons win: complete distributions often bundle fonts and sprites as
    // supplementary assets. Only treat the archive as a font package when it has no or
    // very few SVG samples.
    if (svgNames.length >= 3 || (svgNames.length > 0 && !fontNames.length))
      return convertSvgArchive(reader, context);

    if (fontNames.length && cssNames.length) {
      const fontInputs = await fontInputsFromArchive(
        reader,
        fontNames,
        cssNames,
      );
      if (fontInputs.length) return convertFontPackage(fontInputs, context);
    }
    if (svgNames.length) return convertSvgArchive(reader, context);
    // Iconify 的 icon-sets 仓库只有 JSON（外加构建脚本），必须比 JS 模块先判断。
    // The Iconify icon-sets repository is JSON-only (plus build scripts); check it before
    // treating the archive as a JS module package.
    const iconifySets = await findIconifySets(reader);
    if (iconifySets.length)
      return convertIconifyArchive(reader, iconifySets, context, options);
    if (reader.names.some(isJsFile))
      return convertJsModuleArchive(reader, context);
    if (fontNames.length) {
      const fontInputs = await fontInputsFromArchive(reader, fontNames, []);
      if (fontInputs.length) return convertFontPackage(fontInputs, context);
    }
    throw new Error(
      '归档中没有可识别的 SVG、字体或图标模块 / The archive contains no recognizable SVG, font or icon module',
    );
  }

  if (isJsonFile(file.fileName)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(decodeText(file.bytes));
    } catch (error) {
      throw new Error(
        `JSON 解析失败 / Could not parse JSON: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (isIconifyJson(parsed))
      // Iconify 的 `prefix` 就是生态里的图标集名，比文件名更稳定。
      // Iconify's `prefix` is the set name used across the ecosystem and is more stable
      // than the file name.
      return convertIconifyJson(parsed, context);
    throw new Error(
      '该 JSON 不是可识别的 Iconify 图标集 / The JSON is not a recognizable Iconify set',
    );
  }

  if (isSvgFile(file.fileName) || looksLikeSvg(file.bytes))
    return convertSvgFile(file.fileName, decodeText(file.bytes), context);

  if (isFontFile(file.fileName)) return convertFontPackage([file], context);

  throw new Error(
    '无法识别的图标包格式；支持 ZIP、tar.gz、Iconify JSON、SVG/Sprite、字体及其 CSS / Unrecognized format; supported: ZIP, tar.gz, Iconify JSON, SVG/sprite, fonts and CSS',
  );
}

/**
 * 归一化为插件的 ZIP 图标包 / Normalizes into the plugin's ZIP icon pack.
 *
 * 每个图标都经过统一清理与命名，最终的归档只包含保留的 SVG 和一个清单文件。
 * Every icon passes through the shared sanitizer and naming rules; the final archive
 * contains only the kept SVGs plus one manifest.
 */
export async function normalizeIconPack(
  inputs: PackInputFile[],
  options: PackImportOptions = {},
): Promise<NormalizedIconPack> {
  const context: ImportContext = {
    signal: options.signal,
    onProgress: options.onProgress,
    yieldToMain: () => yieldToMain('user-visible'),
  };
  const converted = await convertPackInputs(inputs, context, options);
  if (!converted.icons.length)
    throw new Error('没有转换出任何可用的图标 / No usable icons were produced');

  const files: Record<string, Uint8Array> = {};
  const seen = new Map<string, number>();
  let skipped = converted.skipped;

  for (let index = 0; index < converted.icons.length; index++) {
    throwIfAborted(options.signal);
    const icon = converted.icons[index];
    const name = sanitizeIconName(icon.name);
    const svg = name ? normalizeSvgDocument(icon.svg) : null;
    if (!name || !svg) {
      skipped++;
      continue;
    }
    const folder = sanitizeFolder(icon.folder);
    let path = folder ? `${folder}/${name}.svg` : `${name}.svg`;
    const key = path.toLowerCase();
    const occurrence = seen.get(key) ?? 0;
    seen.set(key, occurrence + 1);
    if (occurrence > 0)
      path = folder
        ? `${folder}/${name}-${occurrence + 1}.svg`
        : `${name}-${occurrence + 1}.svg`;
    files[path] = strToU8(svg);

    if (index % 200 === 0) {
      options.onProgress?.(
        `正在整理图标 ${index + 1}/${converted.icons.length}…`,
      );
      await yieldToMain('user-visible');
    }
  }

  const iconCount = Object.keys(files).length;
  if (!iconCount)
    throw new Error('所有图标都无法解析 / Every icon failed to parse');

  // 固定键顺序，使相同输入生成完全相同的归档。 / Stable key order makes equal input equal archives.
  const ordered: Record<string, Uint8Array> = {};
  for (const path of Object.keys(files).sort()) ordered[path] = files[path];
  ordered[PACK_MANIFEST_NAME] = strToU8(
    JSON.stringify(
      {
        schema: 1,
        generator: 'Iconize Enhanced',
        format: converted.format,
        label: converted.label,
        iconCount,
        skipped,
        warnings: converted.warnings,
      },
      null,
      2,
    ),
  );

  return {
    format: converted.format,
    label: converted.label,
    archive: zipSync(ordered, { level: 6 }),
    iconCount,
    skipped,
    warnings: converted.warnings,
    suggestedName:
      converted.suggestedName ?? packNameFromFileName(inputs[0].fileName),
  };
}
