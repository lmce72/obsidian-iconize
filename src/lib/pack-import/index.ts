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
import { baseName, openArchive, type ArchiveReader } from './archive';
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
  type ImportContext,
  type NormalizedIconPack,
  type PackInputFile,
} from './types';
import { throwIfAborted, yieldToMain } from '../task-scheduler';

export { packNameFromFileName } from './names';
export { PACK_MANIFEST_NAME } from './types';
export type {
  IconPackFormat,
  NormalizedIconPack,
  PackInputFile,
} from './types';

const FONT_EXTENSIONS = ['.ttf', '.otf', '.woff', '.woff2'];
const CSS_EXTENSIONS = ['.css'];

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
    const bytes = await reader.readBytes(name);
    if (bytes) inputs.push({ fileName: baseName(name), bytes });
  }
  for (const css of cssNames) {
    const bytes = await reader.readBytes(css);
    if (bytes) inputs.push({ fileName: baseName(css), bytes });
  }
  return inputs;
}

/**
 * 按标志性内容选择转换器 / Dispatches to the converter selected by marker content.
 */
export async function convertPackInputs(
  inputs: PackInputFile[],
  context: ImportContext,
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
  options: {
    signal?: AbortSignal;
    onProgress?: (message: string) => void;
  } = {},
): Promise<NormalizedIconPack> {
  const context: ImportContext = {
    signal: options.signal,
    onProgress: options.onProgress,
    yieldToMain: () => yieldToMain('user-visible'),
  };
  const converted = await convertPackInputs(inputs, context);
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
