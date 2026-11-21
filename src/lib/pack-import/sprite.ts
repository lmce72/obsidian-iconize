/**
 * 单文件与 sprite 转换 / Single SVG files and symbol sprites.
 *
 * 用户可能只选了一个 `.svg` 文件：它要么是普通图标，要么是带 `<symbol>` 定义的
 * sprite。sprite 按 symbol 拆成多个独立图标；普通文件整体归一化为一个图标。
 *
 * A user may select a single `.svg` file. It is either an ordinary icon or a sprite
 * carrying `<symbol>` definitions. Sprites are split into one icon per symbol; ordinary
 * files are normalized as a whole into a single icon.
 */

import { packNameFromFileName } from './names';
import { normalizeSvgDocument, splitSprite } from './svg';
import type { ConversionResult, ImportContext } from './types';
import { throwIfAborted } from '../task-scheduler';

const SVG_EXTENSION = /\.svg$/i;
/** 单个 SVG 文本上限（UTF-16 码元）/ Text ceiling for one SVG (UTF-16 code units). */
const MAX_SVG_CHARS = 16 * 1024 * 1024;

/** 去掉目录与扩展名，得到文件名主干 / Strips the directory and extension. */
function fileNameStem(fileName: string): string {
  return fileName
    .replace(/^.*[\\/]/, '')
    .replace(SVG_EXTENSION, '')
    .trim();
}

/**
 * 转换一个 SVG 文件 / Converts one SVG file.
 *
 * sprite 的 symbol 名称与普通图标名一律保留原值；同名冲突交给归一化器的路径去重
 * 与索引的数字后缀处理，不在这里丢弃用户数据。
 *
 * Sprite symbol names and ordinary icon names are kept as-is. Name collisions are
 * resolved by the normalizer's path dedup and the index's numeric suffix; no user data
 * is dropped here.
 */
export async function convertSvgFile(
  fileName: string,
  text: string,
  context: ImportContext,
): Promise<ConversionResult> {
  throwIfAborted(context.signal);
  if (text.length > MAX_SVG_CHARS)
    throw new Error(
      `"${fileName}" 超过单个 SVG 文件大小上限 / The SVG exceeds the per-file limit`,
    );

  const suggestedName = packNameFromFileName(fileName);
  const symbols = await splitSprite(text, {
    signal: context.signal,
    yieldToMain: context.yieldToMain,
    onProgress: (done, total) =>
      context.onProgress?.(`正在拆分 sprite ${done}/${total}…`),
  });

  if (symbols !== null) {
    if (!symbols.length)
      throw new Error(
        `"${fileName}" is an SVG sprite without any drawable symbol`,
      );

    return {
      format: 'svg-sprite',
      label: 'SVG Sprite',
      icons: symbols.map((symbol) => ({
        name: symbol.name,
        svg: symbol.svg,
      })),
      skipped: 0,
      warnings: [],
      suggestedName,
    };
  }

  const svg = normalizeSvgDocument(text);
  if (svg === null)
    throw new Error(`"${fileName}" is not a renderable SVG file`);

  return {
    format: 'svg-file',
    label: 'SVG 文件 / SVG file',
    icons: [{ name: fileNameStem(fileName) || 'icon', svg }],
    skipped: 0,
    warnings: [],
    suggestedName,
  };
}
