// Cache for font size
let cachedFontSize: number | null = null;
let fontSizeCacheTime: number = 0;

/** 无法读出字号时的兜底值 / Fallback when a font size cannot be read. */
const DEFAULT_FONT_SIZE = 16;
/** 内联标题相对正文字号的默认倍数 / Default inline-title scale relative to body text. */
const DEFAULT_INLINE_TITLE_SCALE = 1.5;

const calculateFontTextSize = () => {
  // get cached font size if available
  const now = Date.now();
  if (cachedFontSize !== null && now - fontSizeCacheTime < 2000) {
    return cachedFontSize;
  }

  let fontSize = parseFloat(
    getComputedStyle(document.body).getPropertyValue('--font-text-size') ?? '0',
  );
  if (!fontSize) {
    fontSize = parseFloat(getComputedStyle(document.documentElement).fontSize);
  }
  // 两处都读不出来时给出兜底：NaN 会一路传到 setFontSize，把宽高写成 NaNpx。
  // Fall back when neither can be read: NaN travels into setFontSize and writes NaNpx.
  if (!Number.isFinite(fontSize) || fontSize <= 0) {
    fontSize = DEFAULT_FONT_SIZE;
  }
  // set font size cache
  cachedFontSize = fontSize;
  fontSizeCacheTime = now;
  return fontSize;
};

const calculateInlineTitleSize = (): number => {
  const fontSize = calculateFontTextSize();
  const inlineTitleSizeValue = getComputedStyle(document.body).getPropertyValue(
    '--inline-title-size',
  );
  const unit = inlineTitleSizeValue.replace(/[\d.]/g, '');
  let inlineTitleSize = parseFloat(inlineTitleSizeValue);

  // `--inline-title-size` 并非在所有平台与主题下都存在。缺失时 `parseFloat('')` 得到 NaN，
  // 而它的唯一用途就是标题图标的字号——于是图标的宽高会被写成 `NaNpx`，标题上方看起来
  // 什么都没有，其它图标却完全正常。这里给出兜底倍数。
  //
  // The variable does not exist on every platform and theme. When it is missing,
  // `parseFloat('')` is NaN, and its only consumer is the title icon — so the icon's
  // width/height become `NaNpx` and nothing appears above the title while every other icon
  // is fine. Fall back to a sensible scale.
  if (!Number.isFinite(inlineTitleSize) || inlineTitleSize <= 0) {
    inlineTitleSize = DEFAULT_INLINE_TITLE_SCALE;
  }

  if (unit === 'px') {
    inlineTitleSize /= 16;
  }

  const size = fontSize * inlineTitleSize;
  return Number.isFinite(size) && size > 0 ? size : DEFAULT_FONT_SIZE;
};

// Type is being used for the HTML header tags.
export type HTMLHeader = 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
// Type is being used for the header token types in codemirror.
export type HeaderToken =
  | 'header-1'
  | 'header-2'
  | 'header-3'
  | 'header-4'
  | 'header-5'
  | 'header-6';

const isHeader = (value: string): boolean => {
  return /^h[1-6]$/.test(value);
};

const getHTMLHeaderByToken = (header: HeaderToken): HTMLHeader | null => {
  for (let i = 1; i <= 6; i++) {
    if (header === `header-${i}`) {
      return `h${i}` as HTMLHeader;
    }
  }
  return null;
};

const calculateHeaderSize = (header: HTMLHeader | HeaderToken): number => {
  const fontSize = calculateFontTextSize();
  const htmlHeader = getHTMLHeaderByToken(header as HeaderToken) ?? header;
  const headerComputedStyle = getComputedStyle(document.body).getPropertyValue(
    `--${htmlHeader}-size`,
  );
  let headerSize = parseFloat(headerComputedStyle);
  if (isPx(headerComputedStyle)) {
    headerSize = pxToRem(headerSize, fontSize);
  }

  // If there is some `calc` operation going on, it has to be evaluated.
  if (headerComputedStyle.includes('calc')) {
    const temp = document.createElement('div');

    temp.style.setProperty('font-size', `var(--${htmlHeader}-size)`);
    document.body.appendChild(temp);

    const computedStyle = window.getComputedStyle(temp);
    const computedValue = computedStyle.getPropertyValue('font-size');
    headerSize = parseFloat(computedValue);
    if (isPx(computedValue)) {
      headerSize = pxToRem(headerSize, fontSize);
    }

    document.body.removeChild(temp);
  }

  return fontSize * headerSize;
};

const pxToRem = (px: number, baseSize = 16): number => {
  return px / baseSize;
};

const isPx = (value: string): boolean => {
  return /^-?\d+(\.\d+)?px$/.test(value);
};

export {
  calculateInlineTitleSize,
  calculateHeaderSize,
  calculateFontTextSize,
  isHeader,
  isPx,
  pxToRem,
};
