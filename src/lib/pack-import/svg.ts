/**
 * SVG 归一化工具 / SVG normalization helpers.
 *
 * 导入的图标来自不受信任的归档，进入索引前必须变成自包含、无脚本、无外部引用的
 * 独立 `<svg>`。这里集中处理解析、清理、序列化与 sprite 拆分，避免每个格式各写一份。
 *
 * Imported icons come from untrusted archives. Before they reach the index they must
 * become standalone `<svg>` documents without scripts or external references. Parsing,
 * sanitizing, serialization and sprite splitting live here so every format shares one
 * implementation.
 */

import { throwIfAborted } from '../task-scheduler';

export const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

/** 单个 sprite 允许的 symbol 上限 / Symbol ceiling for one sprite sheet. */
export const MAX_SPRITE_SYMBOLS = 20_000;

/** 解析失败时返回 `null` / Returns `null` when the markup cannot be parsed. */
export function parseSvgDocument(markup: string): Document | null {
  const parser = new DOMParser();
  let document: Document | null = null;
  try {
    document = parser.parseFromString(markup, 'image/svg+xml');
    if (
      !document.documentElement ||
      document.documentElement.localName !== 'svg' ||
      document.querySelector('parsererror')
    ) {
      document = null;
    }
  } catch {
    document = null;
  }
  if (!document) {
    // 部分 JSON/sprite 来源带有 HTML 风格的属性，退回 HTML 解析器仍能拿到 `<svg>`。
    // Some sources carry HTML-style attributes; the HTML parser still recovers the `<svg>`.
    try {
      const fallback = parser.parseFromString(markup, 'text/html');
      const root = fallback.querySelector('svg');
      if (root) return fallback;
    } catch {
      return null;
    }
  }
  return document;
}

/** 取 `<svg>` 根节点 / Returns the `<svg>` root element. */
export function svgRoot(document: Document): SVGSVGElement | null {
  if (document.documentElement?.localName === 'svg')
    return document.documentElement as unknown as SVGSVGElement;
  return document.querySelector('svg');
}

function numericAttribute(element: Element, name: string): number | null {
  const raw = element.getAttribute(name);
  if (!raw) return null;
  const match = /^\s*(-?[\d.]+)(?:px)?\s*$/.exec(raw);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) && value > 0 ? value : null;
}

/** 校验并规范化 viewBox 值 / Validates and normalizes a viewBox value. */
export function validViewBox(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const parts = raw
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  if (parts.length !== 4 || !parts.every((value) => Number.isFinite(value)))
    return null;
  if (parts[2] <= 0 || parts[3] <= 0) return null;
  return parts.join(' ');
}

/**
 * 读取或推导 viewBox / Reads or derives a viewBox.
 *
 * 优先使用元素自己的 viewBox，其次继承者的 viewBox，再其次 width/height，
 * 最后退回 16×16（Iconize 默认图标尺寸）。
 *
 * Uses the element's viewBox first, then the fallback element's, then width/height,
 * and finally 16×16 (Iconize's default icon size).
 */
export function viewBoxOf(
  element: Element | null | undefined,
  fallback?: Element | null,
): string {
  for (const candidate of [element, fallback]) {
    if (!candidate) continue;
    const viewBox = validViewBox(candidate.getAttribute('viewBox'));
    if (viewBox) return viewBox;
  }
  for (const candidate of [element, fallback]) {
    if (!candidate) continue;
    const width = numericAttribute(candidate, 'width');
    const height = numericAttribute(candidate, 'height');
    if (width && height) return `0 0 ${width} ${height}`;
  }
  return '0 0 16 16';
}

const BLOCKED_ELEMENTS =
  'script, foreignObject, style, image, a, animate, animateTransform, set';

function hasExternalReference(value: string): boolean {
  const matches = value.match(/url\(\s*['"]?([^)'"]*)['"]?\s*\)/gi) ?? [];
  return matches.some((match) => {
    const target = match
      .replace(/^url\(\s*['"]?/i, '')
      .replace(/['"]?\s*\)$/, '')
      .trim();
    return target !== '' && !target.startsWith('#');
  });
}

/**
 * 清理 SVG 子树 / Sanitizes an SVG subtree in place.
 *
 * 移除脚本、外来对象、样式表与外部引用；保留同文档 `url(#id)` 与内部 `<use>`，
 * 它们是正常图形依赖，不是网络访问。
 *
 * Removes scripts, foreign objects, stylesheets and external references while keeping
 * same-document `url(#id)` and internal `<use>`, which are normal drawing dependencies
 * rather than network access.
 */
export function sanitizeSvg(root: Element): void {
  root
    .querySelectorAll(BLOCKED_ELEMENTS)
    .forEach((element) => element.remove());
  // 只删除指向外部的 use/image 链接；同文档 symbol 引用可以保留。
  // Only external use/image links are removed; same-document references may stay.
  root.querySelectorAll('use').forEach((element) => {
    const href =
      element.getAttribute('href') ??
      element.getAttributeNS('http://www.w3.org/1999/xlink', 'href') ??
      '';
    if (!href.startsWith('#')) element.remove();
  });

  for (const element of [root, ...Array.from(root.querySelectorAll('*'))]) {
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      if (name.startsWith('on')) {
        element.removeAttribute(attribute.name);
        continue;
      }
      if (name === 'style') {
        element.removeAttribute(attribute.name);
        continue;
      }
      if (name === 'href' || name === 'xlink:href') {
        if (!attribute.value.startsWith('#'))
          element.removeAttribute(attribute.name);
        continue;
      }
      if (hasExternalReference(attribute.value))
        element.removeAttribute(attribute.name);
    }
  }
}

/** 序列化单个元素 / Serializes one element. */
export function serializeElement(element: Element): string {
  const serializer = new XMLSerializer();
  return serializer.serializeToString(element);
}

function hasDrawableContent(root: Element): boolean {
  return Array.from(
    root.querySelectorAll(
      'path, rect, circle, ellipse, line, polyline, polygon, text, use',
    ),
  ).some(
    (element) =>
      !element.closest('symbol, defs, clipPath, mask, pattern, marker'),
  );
}

/** 子树是否含有会实际绘制的图形 / Whether the subtree contains a painted shape. */
export function isDrawable(root: Element): boolean {
  return hasDrawableContent(root);
}

/**
 * 归一化一个完整 SVG 文档 / Normalizes a complete SVG document.
 *
 * 保留根节点上的 `fill` / `stroke` / `stroke-width` 等表现属性——轮廓图标依赖它们；
 * 只清理危险内容。`null` 表示它不能成为独立图标（无效或只有 symbol 定义）。
 *
 * Presentation attributes on the root such as `fill`, `stroke` and `stroke-width` are
 * preserved because outline icons depend on them; only unsafe content is removed. `null`
 * means it cannot be a standalone icon (invalid, or a symbol-only sheet).
 */
export function normalizeSvgDocument(markup: string): string | null {
  const document = parseSvgDocument(markup);
  if (!document) return null;
  const root = svgRoot(document);
  if (!root) return null;
  if (!hasDrawableContent(root)) return null;
  sanitizeSvg(root);
  if (!hasDrawableContent(root)) return null;
  root.setAttribute('xmlns', SVG_NAMESPACE);
  return serializeElement(root);
}

/**
 * 构建独立 SVG 根节点 / Builds a standalone SVG root element.
 *
 * 返回元素而不是字符串，调用方可以在序列化前检查是否可绘制，避免一次多余的解析。
 * Returns the element rather than a string so callers can check drawability before
 * serialization and avoid one extra parse.
 */
export function buildStandaloneSvg(options: {
  document: Document;
  viewBox: string;
  children: Node[];
  attributes?: Record<string, string>;
}): SVGSVGElement {
  const root = options.document.createElementNS(
    SVG_NAMESPACE,
    'svg',
  ) as SVGSVGElement;
  root.setAttribute('xmlns', SVG_NAMESPACE);
  root.setAttribute('viewBox', options.viewBox);
  for (const [name, value] of Object.entries(options.attributes ?? {}))
    root.setAttribute(name, value);
  for (const child of options.children)
    root.appendChild(options.document.importNode(child, true));
  sanitizeSvg(root);
  return root;
}

/** 把一棵 SVG 子树转为独立文档 / Turns an SVG subtree into a standalone document. */
export function standaloneSvg(options: {
  document: Document;
  viewBox: string;
  children: Node[];
  attributes?: Record<string, string>;
}): string {
  return serializeElement(buildStandaloneSvg(options));
}

/**
 * 单个 SVG 文件转为一个独立图标 / Converts one SVG file into a standalone icon.
 *
 * `null` 表示文件不是可渲染的 SVG（例如只有 symbol 定义）。
 * `null` means the file is not a renderable SVG, for example a symbol-only sheet.
 */
export function standaloneFromFile(markup: string): string | null {
  return normalizeSvgDocument(markup);
}

export interface SpriteSymbol {
  name: string;
  svg: string;
}

/** sprite 拆分可用的协作入口 / Cooperative hooks for sprite splitting. */
export interface SpriteContext {
  signal?: AbortSignal;
  yieldToMain?: () => Promise<void>;
  onProgress?: (done: number, total: number) => void;
}

/** 从根节点继承的绘制属性 / Paint attributes inherited from the sheet root. */
const SHEET_ATTRIBUTES = [
  'fill',
  'stroke',
  'stroke-width',
  'color',
  'fill-rule',
  'stroke-linecap',
  'stroke-linejoin',
  'vector-effect',
];

function referencedIds(element: Element): string[] {
  const ids: string[] = [];
  const push = (value: string | null): void => {
    if (!value) return;
    if (value.startsWith('#')) {
      ids.push(value.slice(1));
      return;
    }
    const matches = value.matchAll(/url\(\s*['"]?#([^)'"\s]+)/gi);
    for (const match of matches) ids.push(match[1]);
  };
  for (const attribute of Array.from(element.attributes)) {
    push(attribute.value);
    if (attribute.name === 'href')
      push(element.getAttributeNS('http://www.w3.org/1999/xlink', 'href'));
  }
  return ids;
}

/** 收集文档中可复用的 id 元素 / Indexes reusable elements by id. */
function collectDefinitions(document: Document): Map<string, Element> {
  const definitions = new Map<string, Element>();
  document.querySelectorAll('[id]').forEach((element) => {
    // symbol 自身不在复用表里；它只能被引用为整体，而不是作为定义。
    // Symbols are not definitions: they can only be referenced as a whole.
    if (element.closest('symbol') || element.localName === 'symbol') return;
    const id = element.getAttribute('id');
    if (id) definitions.set(id, element);
  });
  return definitions;
}

/** 复制被引用的定义（含传递依赖） / Copies referenced definitions, transitively. */
function referencedDefinitions(
  symbol: Element,
  definitions: Map<string, Element>,
): Element[] {
  const selected = new Map<string, Element>();
  const queue: string[] = [];
  for (const node of [symbol, ...Array.from(symbol.querySelectorAll('*'))])
    for (const id of referencedIds(node))
      if (definitions.has(id) && !selected.has(id)) queue.push(id);
  while (queue.length) {
    const id = queue.shift();
    if (id === undefined) break;
    if (selected.has(id)) continue;
    const element = definitions.get(id);
    if (!element) continue;
    selected.set(id, element);
    for (const node of [element, ...Array.from(element.querySelectorAll('*'))])
      for (const dependency of referencedIds(node))
        if (definitions.has(dependency) && !selected.has(dependency))
          queue.push(dependency);
  }
  return Array.from(selected.values());
}

function isSvgNamespace(element: Element): boolean {
  // HTML 解析器会把孤立的 `<symbol>` 变成 HTMLUnknownElement，不能当作 sprite。
  // The HTML parser turns an orphan `<symbol>` into an HTMLUnknownElement; not a sprite.
  return element.namespaceURI === SVG_NAMESPACE;
}

/**
 * 拆分 SVG symbol sprite / Splits an SVG symbol sprite.
 *
 * 返回 `null` 表示这不是 sprite；空数组表示是 sprite 但没有可绘制 symbol。
 * 复制 symbol 引用的 `<defs>`（渐变、遮罩、共享路径），并继承 sprite 根节点的
 * 绘制属性——否则拆出来的图标会引用不存在的定义而整片空白。
 *
 * Returns `null` when the markup is not a sprite; an empty array means it is a sprite
 * without any drawable symbol. Referenced `<defs>` (gradients, masks, shared paths) are
 * copied and paint attributes are inherited from the sheet root; otherwise the split
 * icons would reference missing definitions and render blank.
 */
export async function splitSprite(
  markup: string,
  context: SpriteContext = {},
): Promise<SpriteSymbol[] | null> {
  const document = parseSvgDocument(markup);
  if (!document) return null;
  const allSymbols = Array.from(document.querySelectorAll('symbol')).filter(
    isSvgNamespace,
  );
  if (!allSymbols.length) return null;
  if (allSymbols.length > MAX_SPRITE_SYMBOLS)
    throw new Error(
      `sprite 包含超过 ${MAX_SPRITE_SYMBOLS} 个 symbol，已拒绝 / The sprite exceeds ${MAX_SPRITE_SYMBOLS} symbols`,
    );

  const sheet = svgRoot(document);
  const sheetAttributes: Record<string, string> = {};
  for (const name of SHEET_ATTRIBUTES) {
    const value = sheet?.getAttribute(name);
    if (value) sheetAttributes[name] = value;
  }
  const definitions = collectDefinitions(document);
  const result: SpriteSymbol[] = [];

  for (let index = 0; index < allSymbols.length; index++) {
    const symbol = allSymbols[index];
    if (index % 200 === 0) {
      throwIfAborted(context.signal);
      await context.yieldToMain?.();
      context.onProgress?.(index, allSymbols.length);
    }
    const id = (symbol.getAttribute('id') ?? '').trim();
    if (!id) continue;

    // symbol 上的表现属性（fill / stroke / stroke-width）覆盖 sprite 根节点。
    // Presentation attributes on the symbol override the sheet root.
    const attributes: Record<string, string> = { ...sheetAttributes };
    for (const attribute of Array.from(symbol.attributes)) {
      if (['id', 'viewBox', 'class', 'style'].includes(attribute.name))
        continue;
      attributes[attribute.name] = attribute.value;
    }

    const children: Node[] = Array.from(symbol.childNodes);
    const definitionsUsed = referencedDefinitions(symbol, definitions);
    if (definitionsUsed.length) {
      const container = document.createElementNS(SVG_NAMESPACE, 'defs');
      for (const definition of definitionsUsed)
        container.appendChild(document.importNode(definition, true));
      children.unshift(container);
    }

    const root = buildStandaloneSvg({
      document,
      viewBox: viewBoxOf(symbol, sheet),
      children,
      attributes,
    });
    if (hasDrawableContent(root))
      result.push({ name: id, svg: serializeElement(root) });
  }

  return result;
}

/** 判断标记里是否出现 symbol 定义 / Whether the markup declares symbols. */
export function hasSymbols(markup: string): boolean {
  return /<symbol[\s>]/i.test(markup);
}
