/**
 * Iconify JSON 转换 / Iconify JSON conversion.
 *
 * Iconify 把整套图标放在单个 JSON 中：`icons` 是自包含的 SVG 片段，`aliases` 只是
 * 指向父图标并附带镜像/旋转的别名。这里把每个可寻址名称展开成一张独立 SVG，
 * 别名保留（它们正是 Iconify 使用者能找到图标的名称）。
 *
 * Iconify stores a whole set in one JSON file: `icons` holds self-contained SVG
 * fragments and `aliases` merely point at a parent with flips or rotation. Each
 * addressable name is expanded into a standalone SVG; aliases are kept because they are
 * exactly the names Iconify users search for.
 */

import { SVG_NAMESPACE } from './svg';
import type { ConversionResult, GeneratedIcon, ImportContext } from './types';
import { throwIfAborted } from '../task-scheduler';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

interface IconifyData {
  body: string;
  width?: number;
  height?: number;
  left?: number;
  top?: number;
}

interface IconifyAlias {
  parent: string;
  rotate?: number;
  hFlip?: boolean;
  vFlip?: boolean;
  width?: number;
  height?: number;
  left?: number;
  top?: number;
}

interface IconifySource {
  prefix: string;
  icons: Record<string, IconifyData>;
  aliases: Record<string, IconifyAlias>;
  width: number;
  height: number;
  left: number;
  top: number;
}

/** 判断 JSON 是否符合 Iconify 标志性结构 / Recognizes the Iconify shape. */
export function isIconifyJson(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.prefix === 'string' &&
    isRecord(value.icons) &&
    Object.keys(value.icons).length > 0
  );
}

function readIconify(value: unknown): IconifySource {
  if (
    !isRecord(value) ||
    !isRecord(value.icons) ||
    typeof value.prefix !== 'string'
  )
    throw new Error('Not an Iconify icon set');
  const icons: Record<string, IconifyData> = {};
  for (const [name, icon] of Object.entries(value.icons)) {
    if (!isRecord(icon) || typeof icon.body !== 'string' || !icon.body.trim())
      continue;
    // 单个图标可以覆盖根尺寸；@iconify-json/fa6-brands 就有大量非默认宽度。
    // One icon may override the root dimensions; @iconify-json/fa6-brands relies on it.
    icons[name] = {
      body: icon.body,
      width: optionalNumber(icon.width),
      height: optionalNumber(icon.height),
      left: optionalNumber(icon.left),
      top: optionalNumber(icon.top),
    };
  }
  const aliases: Record<string, IconifyAlias> = {};
  if (isRecord(value.aliases)) {
    for (const [name, alias] of Object.entries(value.aliases)) {
      if (!isRecord(alias) || typeof alias.parent !== 'string') continue;
      aliases[name] = {
        parent: alias.parent,
        rotate: optionalNumber(alias.rotate),
        hFlip: alias.hFlip === true,
        vFlip: alias.vFlip === true,
        width: optionalNumber(alias.width),
        height: optionalNumber(alias.height),
        left: optionalNumber(alias.left),
        top: optionalNumber(alias.top),
      };
    }
  }
  return {
    prefix: value.prefix,
    icons,
    aliases,
    width: numberOr(value.width, 16),
    height: numberOr(value.height, 16),
    left: numberOr(value.left, 0),
    top: numberOr(value.top, 0),
  };
}

interface ResolvedIcon {
  body: string;
  width: number;
  height: number;
  left: number;
  top: number;
}

/**
 * 把别名上的镜像与旋转写成 SVG transform / Applies alias transforms.
 *
 * Iconify 的 `rotate` 是 90° 的四分之一圈数（1 = 90°）；transform 顺序为旋转在前、
 * 镜像在后，与 Iconify 渲染器一致。`left`/`top` 参与镜像的平移量。
 *
 * Iconify's `rotate` is a number of quarter turns (1 = 90°). Rotation comes before the
 * flip transforms, matching Iconify's renderer; `left`/`top` shift the flip translation.
 */
function transformBody(
  parent: ResolvedIcon,
  alias: IconifyAlias,
): ResolvedIcon {
  // 别名可以覆盖尺寸；变换必须围绕最终尺寸计算。
  // An alias may override dimensions; transforms must use the final box.
  const width = alias.width ?? parent.width;
  const height = alias.height ?? parent.height;
  const left = alias.left ?? parent.left;
  const top = alias.top ?? parent.top;
  const transforms: string[] = [];
  if (alias.rotate)
    transforms.push(
      `rotate(${alias.rotate * 90} ${left + width / 2} ${top + height / 2})`,
    );
  if (alias.hFlip)
    transforms.push(`translate(${width + left} ${-top}) scale(-1 1)`);
  if (alias.vFlip)
    transforms.push(`translate(${-left} ${height + top}) scale(1 -1)`);
  return {
    body: transforms.length
      ? `<g transform="${transforms.join(' ')}">${parent.body}</g>`
      : parent.body,
    width,
    height,
    left,
    top,
  };
}

/**
 * 转换一个 Iconify JSON / Converts one Iconify JSON set.
 *
 * @param value 已解析的 JSON / Parsed JSON.
 * @param context 取消与进度 / Cancellation and progress.
 * @param suggestedName 调用方更合适的包名；缺省用 JSON 的 `prefix`。
 */
export async function convertIconifyJson(
  value: unknown,
  context: ImportContext,
  suggestedName?: string,
): Promise<ConversionResult> {
  const source = readIconify(value);
  const iconNames = Object.keys(source.icons);
  const aliasNames = Object.keys(source.aliases);
  const total = iconNames.length + aliasNames.length;
  const icons: GeneratedIcon[] = [];
  const resolvedCache = new Map<string, ResolvedIcon | null>();

  const resolveIcon = (name: string, depth = 0): ResolvedIcon | null => {
    const cached = resolvedCache.get(name);
    if (cached !== undefined) return cached;
    if (depth > 8) return null;
    const direct = source.icons[name];
    let resolved: ResolvedIcon | null = null;
    if (direct) {
      resolved = {
        body: direct.body,
        width: direct.width ?? source.width,
        height: direct.height ?? source.height,
        left: direct.left ?? source.left,
        top: direct.top ?? source.top,
      };
    } else {
      const alias = source.aliases[name];
      const parent = alias ? resolveIcon(alias.parent, depth + 1) : null;
      resolved = alias && parent ? transformBody(parent, alias) : null;
    }
    resolvedCache.set(name, resolved);
    return resolved;
  };

  let processed = 0;
  for (const name of [...iconNames, ...aliasNames]) {
    throwIfAborted(context.signal);
    const resolved = resolveIcon(name);
    if (resolved) {
      const viewBox = `${resolved.left} ${resolved.top} ${resolved.width} ${resolved.height}`;
      icons.push({
        name,
        svg: `<svg xmlns="${SVG_NAMESPACE}" viewBox="${viewBox}">${resolved.body}</svg>`,
      });
    }
    processed++;
    if (processed % 500 === 0) {
      context.onProgress?.(`正在转换 Iconify 图标 ${processed}/${total}…`);
      await context.yieldToMain?.();
    }
  }

  const warnings: string[] = [];
  const skipped = total - icons.length;
  if (skipped > 0)
    warnings.push(`${skipped} 个 Iconify 名称无法解析父图标，已跳过`);

  return {
    format: 'iconify-json',
    label: 'Iconify JSON',
    icons,
    skipped,
    warnings,
    suggestedName: suggestedName ?? source.prefix,
  };
}
