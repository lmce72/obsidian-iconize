/**
 * JavaScript 图标模块转换 / JavaScript icon-module conversion.
 *
 * 以 `@heroicons/react` 为代表的 npm 包把每个图标编译成一个 JS 模块：虚拟 DOM 的
 * `createElement("svg", …)` 与 `createElement("path", …)` 调用里保存着全部几何与表现
 * 属性。这里直接从源码文本中提取白名单属性，重建独立 SVG；不执行任何包内代码。
 *
 * npm packages such as `@heroicons/react` compile each icon into a JS module: the
 * `createElement("svg", …)` and `createElement("path", …)` calls of the virtual DOM hold
 * all geometry and presentation attributes. This module extracts a whitelist of
 * attributes from the source text and rebuilds standalone SVGs without ever executing
 * code from the package.
 */

import { baseName, dirName, type ArchiveReader } from './archive';
import {
  packNameFromFileName,
  sanitizeFolder,
  sanitizeIconName,
} from './names';
import { SVG_NAMESPACE } from './svg';
import type { ConversionResult, GeneratedIcon, ImportContext } from './types';
import { throwIfAborted } from '../task-scheduler';

/** 参与提取的扩展名 / Extensions that may contain icon modules. */
const MODULE_EXTENSION = /\.(?:js|mjs|cjs)$/i;

/** 根 `<svg>` 上保留的表现属性 / Presentation attributes kept on the root `<svg>`. */
const ROOT_ATTRIBUTES: ReadonlyArray<readonly [string, string]> = [
  ['fill', 'fill'],
  ['stroke', 'stroke'],
  ['strokeWidth', 'stroke-width'],
  ['fillRule', 'fill-rule'],
  ['clipRule', 'clip-rule'],
  ['strokeLinecap', 'stroke-linecap'],
  ['strokeLinejoin', 'stroke-linejoin'],
];

/** `<path>` 上保留的表现属性 / Presentation attributes kept on each `<path>`. */
const PATH_ATTRIBUTES: ReadonlyArray<readonly [string, string]> = [
  ['d', 'd'],
  ['fillRule', 'fill-rule'],
  ['clipRule', 'clip-rule'],
  ['strokeLinecap', 'stroke-linecap'],
  ['strokeLinejoin', 'stroke-linejoin'],
  ['fill', 'fill'],
  ['stroke', 'stroke'],
  ['strokeWidth', 'stroke-width'],
];

const PRESENTATION_ATTRIBUTES: ReadonlyArray<readonly [string, string]> = [
  ['fillRule', 'fill-rule'],
  ['clipRule', 'clip-rule'],
  ['strokeLinecap', 'stroke-linecap'],
  ['strokeLinejoin', 'stroke-linejoin'],
  ['fill', 'fill'],
  ['stroke', 'stroke'],
  ['strokeWidth', 'stroke-width'],
];

/**
 * 可提取的几何元素及属性 / Extractable geometry elements and their attributes.
 *
 * Heroicons 的 `StopIcon` 等使用 `rect`；只认 `path` 会让这些图标整批消失。
 * Heroicons' `StopIcon` and friends use `rect`; paths alone would drop them wholesale.
 */
const SHAPES: Record<
  string,
  {
    attributes: ReadonlyArray<readonly [string, string]>;
    geometry: readonly string[];
  }
> = {
  path: {
    attributes: PATH_ATTRIBUTES,
    geometry: ['d'],
  },
  rect: {
    attributes: [
      ['x', 'x'],
      ['y', 'y'],
      ['width', 'width'],
      ['height', 'height'],
      ['rx', 'rx'],
      ['ry', 'ry'],
      ...PRESENTATION_ATTRIBUTES,
    ],
    geometry: ['width', 'height'],
  },
  circle: {
    attributes: [
      ['cx', 'cx'],
      ['cy', 'cy'],
      ['r', 'r'],
      ...PRESENTATION_ATTRIBUTES,
    ],
    geometry: ['r'],
  },
  ellipse: {
    attributes: [
      ['cx', 'cx'],
      ['cy', 'cy'],
      ['rx', 'rx'],
      ['ry', 'ry'],
      ...PRESENTATION_ATTRIBUTES,
    ],
    geometry: ['rx', 'ry'],
  },
  line: {
    attributes: [
      ['x1', 'x1'],
      ['y1', 'y1'],
      ['x2', 'x2'],
      ['y2', 'y2'],
      ...PRESENTATION_ATTRIBUTES,
    ],
    geometry: ['x1', 'y1', 'x2', 'y2'],
  },
  polyline: {
    attributes: [['points', 'points'], ...PRESENTATION_ATTRIBUTES],
    geometry: ['points'],
  },
  polygon: {
    attributes: [['points', 'points'], ...PRESENTATION_ATTRIBUTES],
    geometry: ['points'],
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 判断一个条目是否值得作为图标模块读取 / Whether an entry is worth reading.
 *
 * 类型声明、source map 与聚合入口（`index.js` / `index.esm.js`）都不包含图标几何。
 * Type declarations, source maps and aggregate entry points carry no icon geometry.
 */
function isIconModulePath(path: string): boolean {
  if (!MODULE_EXTENSION.test(path)) return false;
  const file = baseName(path);
  const stem = file.replace(MODULE_EXTENSION, '');
  // `index`、`index.esm` 等是再导出入口，不是单个图标。
  // `index`, `index.esm` and friends are re-export barrels, not single icons.
  return stem !== 'index' && !stem.startsWith('index.');
}

/**
 * 从起点取出一个配平的对象字面量 / Extracts a balanced object literal from `start`.
 *
 * 扫描时跳过字符串内容，避免路径数据里的括号或大括号打乱配对。
 * String contents are skipped so parentheses or braces inside path data cannot break
 * the pairing.
 */
function balancedObjectAt(source: string, start: number): string | null {
  if (source[start] !== '{') return null;
  let depth = 0;
  let quote: string | null = null;
  for (let index = start; index < source.length; index++) {
    // 病态输入不能把一次提取拖成整文件扫描。
    // A pathological input must not turn one extraction into a whole-file scan.
    if (index - start > 256 * 1024) return null;
    const character = source[index];
    if (quote) {
      if (character === '\\') {
        index++;
        continue;
      }
      if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'" || character === '`') {
      quote = character;
      continue;
    }
    if (character === '{') depth++;
    else if (character === '}') {
      depth--;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  return null;
}

/**
 * 取工厂调用中第一个对象字面量 / First object literal of a factory call.
 *
 * 只在起点后的有限窗口里找 `{`，避免大量无对象的 marker 退化成平方级扫描。
 * Only a bounded window after the marker is searched, so thousands of markers without
 * an object cannot degrade into a quadratic scan.
 */
function firstObjectAfter(source: string, from: number): string | null {
  const window = source.slice(from, from + 16 * 1024);
  const brace = window.indexOf('{');
  if (brace === -1) return null;
  const close = window.indexOf(')');
  if (close !== -1 && close < brace) return null;
  return balancedObjectAt(source, from + brace);
}

/**
 * 读取对象里的字面量属性 / Reads a literal attribute from an object literal.
 *
 * 只接受字符串与数字字面量；变量、展开与运算结果无法静态确定，直接忽略。
 * Only string and numeric literals are accepted; variables, spreads and computed values
 * cannot be determined statically and are ignored.
 */
function literalAttribute(object: string, key: string): string | null {
  const pattern = new RegExp(
    `(?:^|[{,\\s])${key}\\s*:\\s*(?:"((?:[^"\\\\]|\\\\.)*)"|'((?:[^'\\\\]|\\\\.)*)'|(-?(?:\\d+(?:\\.\\d+)?|\\.\\d+)))`,
  );
  const match = pattern.exec(object);
  if (!match) return null;
  const value = match[1] ?? match[2] ?? match[3];
  if (value === undefined) return null;
  // 仅还原引号/反斜杠转义，路径数据里没有其他转义序列。
  // Only quote and backslash escapes are restored; path data has no other sequences.
  return value.replace(/\\(["'\\])/g, '$1').trim();
}

/** 从整段源码里找 viewBox（冒号或等号写法）/ Finds viewBox in either syntax. */
function literalViewBox(source: string): string | null {
  const match = /viewBox\s*[:=]\s*(?:"([^"]*)"|'([^']*)')/.exec(source);
  const value = match?.[1] ?? match?.[2];
  return value?.trim() || null;
}

/** XML 属性值转义 / Escapes an XML attribute value. */
function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function renderAttributes(
  pairs: ReadonlyArray<readonly [string, string]>,
): string {
  return pairs
    .map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`)
    .join('');
}

function collectAttributes(
  object: string,
  specs: ReadonlyArray<readonly [string, string]>,
): Array<readonly [string, string]> {
  const result: Array<readonly [string, string]> = [];
  for (const [key, outputName] of specs) {
    const value = literalAttribute(object, key);
    if (value !== null && value !== '') result.push([outputName, value]);
  }
  return result;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 找出虚拟 DOM 工厂名 / Finds the virtual-DOM factory name.
 *
 * `import { createElement as h }` 的别名构建同样能提取；否则整包会被判为不可读。
 * Aliased builds such as `import { createElement as h }` are supported too; otherwise
 * the whole package would be rejected as unreadable.
 */
function factoryName(source: string): string {
  const alias = /\bcreateElement\s+as\s+([A-Za-z_$][\w$]*)/.exec(source);
  return alias ? alias[1] : 'createElement';
}

/**
 * 把一个 JS 模块源码转为独立 SVG / Turns one JS module source into a standalone SVG.
 *
 * 支持 `path/rect/circle/ellipse/line/polyline/polygon`；只认 `path` 会丢掉
 * `StopIcon` 这类使用 `rect` 的图标。`null` 表示没有可提取的几何图形。
 *
 * Paths, rects, circles, ellipses, lines, polylines and polygons are supported; taking
 * only `path` would drop icons such as `StopIcon`. `null` means no drawable geometry.
 */
export function svgFromModuleSource(source: string): string | null {
  const factory = escapeRegExp(factoryName(source));
  let rootObject: string | null = null;
  const svgMarker = new RegExp(`${factory}\\(\\s*(?:"svg"|'svg')\\s*,`, 'g');
  const svgMatch = svgMarker.exec(source);
  if (svgMatch)
    rootObject = firstObjectAfter(source, svgMatch.index + svgMatch[0].length);

  const viewBox =
    (rootObject ? literalAttribute(rootObject, 'viewBox') : null) ??
    literalViewBox(source) ??
    '0 0 16 16';
  const rootAttributes = rootObject
    ? collectAttributes(rootObject, ROOT_ATTRIBUTES)
    : [];

  const shapes: string[] = [];
  const shapeMarker = new RegExp(
    `${factory}\\(\\s*(?:"(path|rect|circle|ellipse|line|polyline|polygon)"|'(path|rect|circle|ellipse|line|polyline|polygon)')\\s*,`,
    'g',
  );
  for (
    let match = shapeMarker.exec(source);
    match;
    match = shapeMarker.exec(source)
  ) {
    const tag = match[1] ?? match[2];
    const spec = SHAPES[tag];
    if (!spec) continue;
    const object = firstObjectAfter(source, match.index + match[0].length);
    if (!object) continue;
    const attributes = collectAttributes(object, spec.attributes);
    // 缺少几何属性（path 的 d、rect 的宽高等）无法绘制；其余图形仍然保留。
    // Without geometry (a path's d, a rect's size, ...) nothing is drawn; keep the rest.
    if (!spec.geometry.some((key) => attributes.some(([name]) => name === key)))
      continue;
    shapes.push(`<${tag}${renderAttributes(attributes)}/>`);
  }
  if (!shapes.length) return null;

  return `<svg xmlns="${SVG_NAMESPACE}" viewBox="${escapeAttribute(viewBox)}"${renderAttributes(rootAttributes)}>${shapes.join('')}</svg>`;
}

/**
 * 由文件路径推导图标名 / Derives the icon name from an entry path.
 *
 * `AcademicCapIcon.js` 去掉扩展名与 `Icon` 后缀后得到 `AcademicCap`。
 * `AcademicCapIcon.js` loses its extension and the `Icon` suffix, yielding `AcademicCap`.
 */
function iconNameFromPath(path: string): string | null {
  const stem = baseName(path).replace(MODULE_EXTENSION, '');
  const withoutSuffix = stem.replace(/Icon$/, '');
  return sanitizeIconName(withoutSuffix);
}

/** 路径深度，用于「保留更浅的重复项」/ Path depth, used to keep the shallower duplicate. */
function pathDepth(path: string): number {
  return path.split('/').length;
}

/** 读取包名并转为图标包建议名 / Reads the package name and derives a pack name. */
async function readSuggestedName(
  reader: ArchiveReader,
  warnings: string[],
): Promise<string | undefined> {
  const manifests = reader.names.filter(
    (name) => baseName(name).toLowerCase() === 'package.json',
  );
  if (!manifests.length) return undefined;
  // 优先根清单；嵌套清单（如 `package/16/solid/package.json`）通常只声明模块类型。
  // Prefer the root manifest; nested ones usually only declare the module type.
  const manifest =
    manifests.find((name) => name === 'package/package.json') ??
    manifests.reduce((shallowest, name) =>
      pathDepth(name) < pathDepth(shallowest) ? name : shallowest,
    );

  const text = await reader.readText(manifest);
  if (text === null) {
    warnings.push(`无法读取 ${manifest}，已忽略包名`);
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    warnings.push(`${manifest} 不是合法 JSON，已忽略包名`);
    return undefined;
  }
  if (
    !isRecord(parsed) ||
    typeof parsed.name !== 'string' ||
    !parsed.name.trim()
  )
    return undefined;

  // 去掉作用域前缀但保留包结构：`@heroicons/react` -> `heroicons-react`。
  // Drop the scope marker but keep the package structure: `@heroicons/react` ->
  // `heroicons-react`.
  const unscoped = parsed.name.trim().replace(/^@/, '').replace(/\//g, '-');
  return packNameFromFileName(unscoped);
}

/**
 * 转换一个 JavaScript 图标模块归档 / Converts a JavaScript icon-module archive.
 *
 * 先按路径去重（ESM 构建与非 ESM 构建完全相同），再按生成名去重并保留较浅路径，
 * 最后逐文件提取 SVG。整个过程不执行归档中的任何代码。
 *
 * Paths are deduplicated first (ESM and non-ESM builds are identical), then generated
 * names are deduplicated keeping the shallower path, and finally each file is parsed for
 * SVG markup. No code from the archive is ever executed.
 */
export async function convertJsModuleArchive(
  reader: ArchiveReader,
  context: ImportContext,
): Promise<ConversionResult> {
  throwIfAborted(context.signal);
  const warnings: string[] = [];
  const suggestedName = await readSuggestedName(reader, warnings);

  const candidates = reader.names.filter(isIconModulePath);
  const candidateSet = new Set(candidates);
  const esmCopies = new Set<string>();

  // ESM 目录只是同一份构建的另一种模块语法；同一路径去掉 `/esm/` 后若存在，就跳过 ESM 副本。
  // The ESM directory is the same build in another module syntax; when the path without
  // `/esm/` also exists, the ESM copy is skipped.
  for (const path of candidates) {
    if (!path.includes('/esm/')) continue;
    if (candidateSet.has(path.replace(/\/esm\//g, '/'))) esmCopies.add(path);
  }

  let skipped = 0;
  const byName = new Map<
    string,
    { path: string; name: string; folder: string; depth: number; order: number }
  >();
  let order = 0;
  for (const path of candidates) {
    throwIfAborted(context.signal);
    order++;
    if (esmCopies.has(path)) {
      skipped++;
      continue;
    }
    const name = iconNameFromPath(path);
    if (!name) {
      skipped++;
      continue;
    }
    // 目录是风格/尺寸的一部分（16/solid 与 24/outline 同名），按「目录 + 名称」去重，
    // 否则 npm 包里的多风格图标只会剩下第一套。
    //
    // The folder carries style and size (16/solid vs 24/outline share names), so dedupe
    // by folder + name; otherwise only the first style of an npm package survives.
    const folder = sanitizeFolder(dirName(path.replace(/^package\//, '')));
    const key = `${folder.toLowerCase()}/${name.toLowerCase()}`;
    const existing = byName.get(key);
    if (existing) {
      // 同一目录同名时保留路径更浅的一份，路径深度相同时保留首次出现者。
      // Within one folder keep the shallower path; equal depth keeps the first one seen.
      if (pathDepth(path) < existing.depth) {
        byName.set(key, { path, name, folder, depth: pathDepth(path), order });
      }
      skipped++;
      continue;
    }
    byName.set(key, { path, name, folder, depth: pathDepth(path), order });
  }

  const selected = Array.from(byName.values()).sort(
    (a, b) => a.order - b.order,
  );
  const icons: GeneratedIcon[] = [];
  let processed = 0;

  for (const entry of selected) {
    throwIfAborted(context.signal);
    const source = await reader.readText(entry.path);
    const svg = source === null ? null : svgFromModuleSource(source);
    if (svg === null) {
      skipped++;
    } else {
      icons.push({
        name: entry.name,
        folder: entry.folder,
        svg,
      });
    }

    processed++;
    if (processed % 200 === 0) {
      context.onProgress?.(
        `正在提取 JS 图标 ${processed}/${selected.length}… / Extracting JS icons ${processed}/${selected.length}…`,
      );
      await context.yieldToMain?.();
    }
  }

  if (!icons.length)
    throw new Error('The archive contains no extractable JS icon modules');

  if (skipped > 0) warnings.push(`${skipped} 个重复或无法解析的 JS 模块已跳过`);

  return {
    format: 'js-icon-module',
    label: 'JS 图标模块 / JS icon module',
    icons,
    skipped,
    warnings,
    suggestedName,
  };
}
