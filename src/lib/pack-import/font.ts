/**
 * 字体图标包转换 / Font icon pack conversion.
 *
 * 字体图标把图形藏在字体的字形里：CSS 负责把类名映射到码位，字体负责把码位映射到
 * 轮廓。导入器读取字形轮廓，按 `getPath` 转成路径，再用预期的 viewBox 包成独立 SVG。
 * 没有可用 CSS 时退回字形名称，这覆盖了只提供一个字体文件的发行包。
 *
 * Icon fonts hide their artwork in glyphs: CSS maps class names to codepoints and the
 * font maps codepoints to outlines. The importer reads each outline, converts it with
 * `getPath` and wraps it in a standalone SVG with the expected viewBox. Without usable
 * CSS it falls back to glyph names, which covers distributions that ship only a font file.
 */

import { parse } from 'opentype.js';
import type { Font, Glyph } from 'opentype.js';
import {
  packNameFromFileName,
  sanitizeIconName,
  stripClassNamePrefix,
} from './names';
import { SVG_NAMESPACE } from './svg';
import type {
  ConversionResult,
  GeneratedIcon,
  ImportContext,
  PackInputFile,
} from './types';
import { throwIfAborted } from '../task-scheduler';

/** 可解析的字体扩展名 / Font extensions opentype.js can decode. */
const FONT_EXTENSIONS = new Set(['ttf', 'otf', 'woff', 'woff2']);
/** WOFF2 的魔数 "wOF2" / WOFF2 magic bytes. */
const WOFF2_MAGIC = [0x77, 0x4f, 0x46, 0x32];
/** 单个 CSS 映射文件上限 / Ceiling for one CSS mapping file. */
const MAX_CSS_BYTES = 16 * 1024 * 1024;
/** 被视为无意义的字形名 / Glyph names that never make good icons. */
const MEANINGLESS_NAMES = new Set(['.notdef', 'notdef', 'space', 'null']);
const MEANINGLESS_PATTERNS = [
  /^uni[0-9a-f]{4,6}$/i,
  /^u[0-9a-f]{4,6}$/i,
  /^glyph\d+$/i,
];
/** CSS 解析用的匹配模式 / Patterns used by the CSS parser. */
const CSS_COMMENT = /\/\*[\s\S]*?\*\//g;
const CSS_RULE = /([^{}]*)\{([^{}]*)\}/g;
const CSS_CLASS = /\.(-?[A-Za-z_][A-Za-z0-9_-]*)/g;
const CSS_CODEPOINT =
  /(?:^|;)\s*(?:content|--fa)\s*:\s*("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/g;
const CSS_ESCAPE = /\\([0-9A-Fa-f]{1,6})[ \t\r\n\f]?/;

/** 取小写扩展名，没有扩展名时为空串 / Lowercase extension, or `''`. */
function extensionOf(fileName: string): string {
  const match = /\.([A-Za-z0-9]+)$/.exec(fileName);
  return match ? match[1].toLowerCase() : '';
}

/** 解码 CSS 字符串里的第一个十六进制转义 / First hex escape of a CSS string. */
function firstCodepoint(value: string): number | null {
  const match = CSS_ESCAPE.exec(value);
  if (!match) return null;
  const codepoint = Number.parseInt(match[1], 16);
  // CSS 允许 \0；它不是可渲染字符，按无码位处理。
  // CSS allows \0; it is not a renderable character, so treat it as absent.
  if (!Number.isFinite(codepoint) || codepoint <= 0 || codepoint > 0x10ffff)
    return null;
  return codepoint;
}

/**
 * 从图标 CSS 中提取「类名 → 码位」映射 / Builds a class-name → codepoint map from icon CSS.
 *
 * 同时支持 Font Awesome 7 的 `--fa:"\f007"` 与较早的 `content:"\f007"`；选择器可以
 * 是逗号分组。只取类选择器，属性选择器（`[class^="bi-"]`）与伪元素被忽略。类名前缀
 * 在这里统一剥掉，因此 `.fa-user` 得到 `user`。
 *
 * Supports both Font Awesome 7's `--fa:"\f007"` and the older `content:"\f007"`; the
 * selector may be a comma-separated group. Only class selectors are read; attribute
 * selectors (`[class^="bi-"]`) and pseudo-elements are ignored. Library prefixes are
 * stripped here, so `.fa-user` yields `user`.
 */
export function parseCssIconMap(css: string): Map<string, number> {
  const map = new Map<string, number>();
  const body = css.replace(CSS_COMMENT, '');
  CSS_RULE.lastIndex = 0;
  let rule: RegExpExecArray | null;
  while ((rule = CSS_RULE.exec(body)) !== null) {
    const selectors = rule[1];
    const declarations = rule[2];
    CSS_CODEPOINT.lastIndex = 0;
    const declaration = CSS_CODEPOINT.exec(declarations);
    if (!declaration) continue;
    const codepoint = firstCodepoint(declaration[1]);
    if (codepoint === null) continue;

    CSS_CLASS.lastIndex = 0;
    let classMatch: RegExpExecArray | null;
    while ((classMatch = CSS_CLASS.exec(selectors)) !== null) {
      const name = stripClassNamePrefix(classMatch[1]);
      // 先匹配先保留：后出现的同义类名不覆盖已确定的码位。
      // First match wins: a later alias never overrides an established codepoint.
      if (!map.has(name)) map.set(name, codepoint);
    }
  }
  return map;
}

/** 判断字节是否为 WOFF2 / Whether the bytes carry the WOFF2 signature. */
function isWoff2(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 4 &&
    WOFF2_MAGIC.every((byte, index) => bytes[index] === byte)
  );
}

interface PreparedGlyph {
  name: string;
  glyph: Glyph;
  path: string;
  bounds: { x1: number; y1: number; x2: number; y2: number } | null;
}

/**
 * 字体所有选中字形的公共视野 / Shared viewport across the selected glyphs.
 *
 * 只按 em 盒出图会裁掉超出 `unitsPerEm` 的字形（Font Awesome 有 38% 的组合超出，
 * 最宽到 640/512）。这里从「em 盒 ∪ 全部字形包围盒」取并集：既保留字体原有的
 * 相对尺寸与基线，又不会裁边。
 *
 * An em-box-only viewBox clips glyphs wider than `unitsPerEm` (38% of the CSS-matched
 * Font Awesome set, up to 640/512). The viewBox is the union of the em box and every
 * selected glyph's bounding box, preserving relative sizing and the baseline without
 * clipping.
 */
function sharedViewBox(font: Font, glyphs: PreparedGlyph[]): string {
  const unitsPerEm =
    Number.isFinite(font.unitsPerEm) && font.unitsPerEm > 0
      ? font.unitsPerEm
      : 1000;
  const ascender = Number.isFinite(font.ascender)
    ? font.ascender
    : unitsPerEm * 0.8;
  const descender = Number.isFinite(font.descender)
    ? font.descender
    : -unitsPerEm * 0.2;
  let x1 = 0;
  let y1 = -ascender;
  let x2 = unitsPerEm;
  let y2 = -descender;
  for (const prepared of glyphs) {
    const bounds = prepared.bounds;
    if (!bounds) continue;
    x1 = Math.min(x1, bounds.x1);
    y1 = Math.min(y1, bounds.y1);
    x2 = Math.max(x2, bounds.x2);
    y2 = Math.max(y2, bounds.y2);
  }
  const round = (value: number): number => Math.round(value * 100) / 100;
  return `${round(x1)} ${round(y1)} ${round(x2 - x1)} ${round(y2 - y1)}`;
}

/** 用公共 viewBox 生成一个字形 SVG / Renders one glyph with the shared viewBox. */
function glyphToSvg(path: string, viewBox: string): string {
  return (
    `<svg xmlns="${SVG_NAMESPACE}" viewBox="${viewBox}">` +
    `<path fill="currentColor" d="${path}"/></svg>`
  );
}

/** 字形名是否没有可用含义 / Whether a glyph name carries no usable meaning. */
function isMeaninglessName(name: string | null | undefined): boolean {
  const trimmed = (name ?? '').trim();
  if (!trimmed) return true;
  if (MEANINGLESS_NAMES.has(trimmed.toLowerCase())) return true;
  return MEANINGLESS_PATTERNS.some((pattern) => pattern.test(trimmed));
}

/** 读取字体的家族名 / Reads the font family name. */
function familyNameOf(font: Font): string | undefined {
  const flat = font.names?.fontFamily?.en;
  if (flat) return flat;
  // 真实字体把语言表嵌在 macintosh / windows 之下；2.x 的最小类型声明没有覆盖这一层。
  // Real fonts nest language tables under macintosh / windows; the minimal 2.x typings
  // do not describe that level.
  const tables: unknown = font.names;
  if (typeof tables !== 'object' || tables === null) return undefined;
  for (const key of Object.keys(tables as Record<string, unknown>)) {
    const platform = (tables as Record<string, unknown>)[key];
    if (typeof platform !== 'object' || platform === null) continue;
    const family = (platform as Record<string, unknown>).fontFamily;
    if (typeof family !== 'object' || family === null) continue;
    const english = (family as Record<string, unknown>).en;
    if (typeof english === 'string' && english.trim()) return english;
  }
  return undefined;
}

/**
 * 转换一个字体图标包 / Converts one font icon pack.
 *
 * 字体按扩展名选取（多个时取第一个并提示）；CSS 决定类名与码位，缺失或不可用时退回
 * 字形名称。每个字形都会转为带 `currentColor` 的独立 SVG。
 *
 * The font is chosen by extension (the first one wins, with a warning when several are
 * given); CSS supplies class names and codepoints, and glyph names are the fallback when
 * it is missing or unusable. Every glyph becomes a standalone SVG using `currentColor`.
 */
export async function convertFontPackage(
  inputs: PackInputFile[],
  context: ImportContext,
): Promise<ConversionResult> {
  throwIfAborted(context.signal);
  const fontFiles = inputs.filter((file) =>
    FONT_EXTENSIONS.has(extensionOf(file.fileName)),
  );
  if (!fontFiles.length)
    throw new Error(
      '未找到可用的字体文件（TTF/OTF/WOFF）/ No usable font file was found (TTF/OTF/WOFF)',
    );

  const warnings: string[] = [];
  // WOFF2 不可解码；其它格式按 TTF → OTF → WOFF 的稳定性顺序尝试，
  // 单个字体解析失败不应让同一归档里的可用字体一起失效。
  //
  // WOFF2 cannot be decoded; other formats are tried in stability order and one broken
  // font must not take down a usable sibling in the same package.
  const order = ['ttf', 'otf', 'woff', 'woff2'];
  const candidates = fontFiles
    .slice()
    .sort(
      (a, b) =>
        order.indexOf(extensionOf(a.fileName)) -
        order.indexOf(extensionOf(b.fileName)),
    );
  const failures: string[] = [];
  let fontFile = candidates[0];
  let font: Font | undefined;
  for (const candidate of candidates) {
    const extension = extensionOf(candidate.fileName);
    if (extension === 'woff2' || isWoff2(candidate.bytes)) continue;
    try {
      // 复制到独立缓冲区：Uint8Array 可能只是更大缓冲的切片，opentype 需要完整的 ArrayBuffer。
      // Copy into a fresh buffer: a Uint8Array may be a view into a larger buffer and
      // opentype needs the complete ArrayBuffer.
      font = parse(candidate.bytes.slice().buffer);
      fontFile = candidate;
      break;
    } catch (error) {
      failures.push(
        `${candidate.fileName}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  if (!font) {
    const sawWoff2 = candidates.some(
      (candidate) =>
        extensionOf(candidate.fileName) === 'woff2' || isWoff2(candidate.bytes),
    );
    if (sawWoff2)
      throw new Error(
        `不支持 WOFF2 字体：opentype.js 2.x 无法解码。请改用 TTF / OTF / WOFF 版本，或改用 SVG 图标包。 / WOFF2 is unsupported: opentype.js 2.x cannot decode it. Use the TTF, OTF or WOFF version, or the SVG pack instead.${
          failures.length ? ` (${failures.join('; ')})` : ''
        }`,
      );
    throw new Error(
      `字体解析失败 / Could not parse the font: ${failures.join('; ')}`,
    );
  }

  if (fontFiles.length > 1)
    warnings.push(
      `检测到 ${fontFiles.length} 个字体文件，使用 ${fontFile.fileName}`,
    );

  const unitsPerEm =
    Number.isFinite(font.unitsPerEm) && font.unitsPerEm > 0
      ? font.unitsPerEm
      : 1000;

  const cssMap = new Map<string, number>();
  const decoder = new TextDecoder();
  for (const file of inputs) {
    if (extensionOf(file.fileName) !== 'css') continue;
    throwIfAborted(context.signal);
    if (file.bytes.length > MAX_CSS_BYTES) {
      warnings.push(`${file.fileName} 超过 CSS 大小上限，已忽略`);
      continue;
    }
    for (const [name, codepoint] of parseCssIconMap(
      decoder.decode(file.bytes),
    )) {
      if (!cssMap.has(name)) cssMap.set(name, codepoint);
    }
    await context.yieldToMain?.();
  }

  const prepared: PreparedGlyph[] = [];
  const seen = new Set<string>();
  let skipped = 0;
  let processed = 0;

  const advance = async (total: number): Promise<void> => {
    if (processed % 200 !== 0) return;
    context.onProgress?.(`正在转换字体图标 ${processed}/${total}…`);
    await context.yieldToMain?.();
  };

  const prepare = (name: string | null, glyph: Glyph | null): void => {
    if (!name || !glyph || glyph.index === 0 || seen.has(name)) {
      skipped++;
      return;
    }
    try {
      const path = glyph.getPath(0, 0, unitsPerEm);
      const data = path.toPathData(2);
      if (!data || !data.trim()) {
        skipped++;
        return;
      }
      const box = path.getBoundingBox();
      const bounds =
        Number.isFinite(box.x1) &&
        Number.isFinite(box.y1) &&
        Number.isFinite(box.x2) &&
        Number.isFinite(box.y2)
          ? box
          : null;
      seen.add(name);
      prepared.push({ name, glyph, path: data, bounds });
    } catch {
      // 单个损坏字形不应让整包导入失败。 / One corrupt glyph must not fail the pack.
      skipped++;
    }
  };

  if (cssMap.size) {
    const total = cssMap.size;
    for (const [className, codepoint] of cssMap) {
      throwIfAborted(context.signal);
      processed++;
      const glyph = font.charToGlyph(String.fromCodePoint(codepoint));
      // 码位落在 .notdef 上说明该字体没有这个图标（例如 solid 字体上的 brands 类名）。
      // A codepoint resolving to .notdef means the font lacks that icon, e.g. brands
      // classes against the solid font.
      prepare(sanitizeIconName(className), glyph);
      await advance(total);
    }

    if (!prepared.length) {
      // CSS 与字体不匹配时全部落空，退回字形名称仍可能拿到整包图标。
      // When CSS and font do not match, glyph names can still recover the whole set.
      warnings.push('CSS 中未找到可用码位，已改用字形名称');
      prepared.length = 0;
      seen.clear();
      skipped = 0;
      processed = 0;
    }
  }

  if (!prepared.length) {
    const total = font.numGlyphs;
    for (let index = 1; index < total; index++) {
      throwIfAborted(context.signal);
      processed++;
      const glyph = font.glyphs.get(index);
      const rawName = glyph.name ?? '';
      prepare(
        isMeaninglessName(rawName) ? null : sanitizeIconName(rawName),
        glyph,
      );
      await advance(total);
    }
  }

  if (!prepared.length)
    throw new Error(
      '该字体中没有可用字形 / The font contains no usable glyphs',
    );

  const viewBox = sharedViewBox(font, prepared);
  const icons: GeneratedIcon[] = prepared.map((entry) => ({
    name: entry.name,
    svg: glyphToSvg(entry.path, viewBox),
  }));

  if (skipped > 0) warnings.push(`${skipped} 个条目无法转换为图标，已跳过`);

  const suggestedName =
    familyNameOf(font) ?? packNameFromFileName(fontFile.fileName);

  return {
    format: 'font-package',
    label: '字体图标 / Font package',
    icons,
    skipped,
    warnings,
    suggestedName,
  };
}
