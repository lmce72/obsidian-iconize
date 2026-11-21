import { describe, expect, it, vi } from 'vitest';
import { parse } from 'opentype.js';
import type { Font, Glyph, Path } from 'opentype.js';
import { convertFontPackage, parseCssIconMap } from './font';
import type { ImportContext, PackInputFile } from './types';

vi.mock('opentype.js', () => ({ parse: vi.fn() }));

const parseMock = vi.mocked(parse);

interface GlyphSpec {
  name: string | null;
  codepoint?: number;
  pathData?: string;
  bbox?: { x1: number; y1: number; x2: number; y2: number };
}

/**
 * 构造一个只实现导入器所需接口的假字体 / Builds a fake font with only the surface the importer uses.
 *
 * 真实字体是二进制文件，测试不应依赖它们；这里用字形索引与码位表复刻 opentype 的行为。
 * Real fonts are binary files and tests must not depend on them; glyph indices and a
 * codepoint table reproduce the parts of opentype's behavior the importer touches.
 */
function fakeFont(options: {
  glyphs: GlyphSpec[];
  unitsPerEm?: number;
  ascender?: number;
  descender?: number;
  names?: unknown;
}): Font {
  const glyphs: Glyph[] = options.glyphs.map((spec, index) => ({
    index,
    name: spec.name,
    unicode: spec.codepoint,
    getPath: (): Path => ({
      toPathData: () => spec.pathData ?? '',
      getBoundingBox: () => spec.bbox ?? { x1: 0, y1: 0, x2: 0, y2: 0 },
    }),
  }));
  const notdef = glyphs[0];
  return {
    unitsPerEm: options.unitsPerEm ?? 1000,
    ascender: options.ascender ?? 800,
    descender: options.descender ?? -200,
    numGlyphs: glyphs.length,
    glyphs: {
      length: glyphs.length,
      get: (index: number) => glyphs[index] ?? notdef,
    },
    charToGlyph: (char: string) => {
      const codepoint = char.codePointAt(0);
      const match = options.glyphs.find(
        (spec) => spec.codepoint !== undefined && spec.codepoint === codepoint,
      );
      return match ? glyphs[options.glyphs.indexOf(match)] : notdef;
    },
    names: options.names as Font['names'],
  };
}

function file(fileName: string, content = ''): PackInputFile {
  return {
    fileName,
    bytes:
      content === ''
        ? new Uint8Array([0, 1, 2, 3])
        : new TextEncoder().encode(content),
  };
}

function context(overrides: Partial<ImportContext> = {}): ImportContext {
  return {
    onProgress: vi.fn(),
    yieldToMain: vi.fn(async () => undefined),
    ...overrides,
  };
}

const NOTDEF: GlyphSpec = { name: '.notdef', pathData: '' };

describe('parseCssIconMap', () => {
  it('reads content codepoints and strips the library prefix', () => {
    const map = parseCssIconMap('.fa-home::before{content:"\\f015"}');
    expect(map.get('home')).toBe(0xf015);
  });

  it('reads Font Awesome 7 --fa declarations with a trailing escape space', () => {
    const map = parseCssIconMap('.fa-0{--fa:"\\30 "}');
    expect(map.get('0')).toBe(0x30);
  });

  it('maps every class selector of a grouped rule', () => {
    const map = parseCssIconMap('.fa-user,.fa-user-alt{--fa:"\\f007"}');
    expect(map.get('user')).toBe(0xf007);
    expect(map.get('user-alt')).toBe(0xf007);
  });

  it('ignores attribute selectors, comments and non-escaped content', () => {
    const map = parseCssIconMap(
      '/* .fa-fake{content:"\\f001"} */\n' +
        '[class^="bi-"]::before{content:"\\f101"}\n' +
        '.bi-alarm::before{content:"\\f102"}\n' +
        '.bi-literal::before{content:"x"}',
    );
    expect(map.has('fake')).toBe(false);
    expect(map.has('literal')).toBe(false);
    expect(map.get('alarm')).toBe(0xf102);
    expect(map.size).toBe(1);
  });
});

describe('font package conversion', () => {
  it('converts CSS codepoints with the font design-space viewBox', async () => {
    parseMock.mockReturnValue(
      fakeFont({
        glyphs: [
          NOTDEF,
          { name: 'home', codepoint: 0xf015, pathData: 'M10 0L20 20Z' },
        ],
      }),
    );

    const result = await convertFontPackage(
      [
        file('icons.ttf'),
        file('icons.css', '.fa-home::before{content:"\\f015"}'),
      ],
      context(),
    );

    expect(result.format).toBe('font-package');
    expect(result.label).toBe('字体图标 / Font package');
    expect(result.icons).toEqual([
      {
        name: 'home',
        svg:
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -800 1000 1000">' +
          '<path fill="currentColor" d="M10 0L20 20Z"/></svg>',
      },
    ]);
    expect(result.skipped).toBe(0);
  });

  it('expands the viewBox so glyphs wider than the em box are not clipped', async () => {
    parseMock.mockReturnValue(
      fakeFont({
        unitsPerEm: 512,
        ascender: 459,
        descender: -75,
        glyphs: [
          NOTDEF,
          {
            name: 'house',
            pathData: 'M0 0h576v512H0z',
            bbox: { x1: 0, y1: -459, x2: 576, y2: 75 },
          },
          {
            name: 'text-slash',
            pathData: 'M0 0h640v512H0z',
            bbox: { x1: 0, y1: -459, x2: 640, y2: 75 },
          },
        ],
      }),
    );

    const result = await convertFontPackage([file('fa.ttf')], context());

    expect(result.icons).toHaveLength(2);
    for (const icon of result.icons)
      expect(icon.svg).toContain('viewBox="0 -459 640 534"');
  });

  it('emits one icon per class of a grouped --fa rule and skips .notdef codepoints', async () => {
    parseMock.mockReturnValue(
      fakeFont({
        glyphs: [
          NOTDEF,
          { name: 'user', codepoint: 0xf007, pathData: 'M0 0H10' },
        ],
      }),
    );

    const result = await convertFontPackage(
      [
        file('icons.ttf'),
        file(
          'fontawesome.css',
          '.fa-user,.fa-user-alt{--fa:"\\f007"}' +
            '.fa-brand-only{--fa:"\\e999"}',
        ),
      ],
      context(),
    );

    expect(result.icons.map((icon) => icon.name)).toEqual(['user', 'user-alt']);
    expect(result.skipped).toBe(1);
  });

  it('falls back to glyph names and filters junk names', async () => {
    parseMock.mockReturnValue(
      fakeFont({
        glyphs: [
          NOTDEF,
          { name: 'exclamation', pathData: 'M0 0H10' },
          { name: 'space', pathData: 'M0 0H1' },
          { name: 'UNIE001', pathData: 'M0 0H1' },
          { name: 'u1f600', pathData: 'M0 0H1' },
          { name: 'glyph42', pathData: 'M0 0H1' },
          { name: 'NULL', pathData: 'M0 0H1' },
          { name: '', pathData: 'M0 0H1' },
          { name: null, pathData: 'M0 0H1' },
          { name: 'uniE002', pathData: 'M0 0H1' },
        ],
      }),
    );

    const result = await convertFontPackage([file('solid.ttf')], context());

    expect(result.icons.map((icon) => icon.name)).toEqual(['exclamation']);
    expect(result.skipped).toBe(8);
  });

  it('keeps glyphs whose path data is empty out of the icon list', async () => {
    parseMock.mockReturnValue(
      fakeFont({
        glyphs: [
          NOTDEF,
          { name: 'empty', pathData: '' },
          { name: 'filled', pathData: 'M0 0H5' },
        ],
      }),
    );

    const result = await convertFontPackage([file('solid.ttf')], context());

    expect(result.icons.map((icon) => icon.name)).toEqual(['filled']);
    expect(result.skipped).toBe(1);
  });

  it('rejects WOFF2 before parsing', async () => {
    parseMock.mockClear();
    const woff2 = {
      fileName: 'icons.woff2',
      bytes: new Uint8Array([0x77, 0x4f, 0x46, 0x32, 0, 0, 0, 0]),
    };

    await expect(convertFontPackage([woff2], context())).rejects.toThrow(
      /WOFF2[\s\S]*TTF/,
    );
    await expect(convertFontPackage([woff2], context())).rejects.toThrow(
      /不支持 WOFF2/,
    );
    expect(parseMock).not.toHaveBeenCalled();
  });

  it('detects WOFF2 by magic bytes even when the extension lies', async () => {
    const disguised = {
      fileName: 'icons.ttf',
      bytes: new Uint8Array([0x77, 0x4f, 0x46, 0x32, 0, 0, 0, 0]),
    };

    await expect(convertFontPackage([disguised], context())).rejects.toThrow(
      /WOFF2/,
    );
  });

  it('warns when several font files are supplied and uses the first', async () => {
    parseMock.mockReturnValue(
      fakeFont({
        glyphs: [NOTDEF, { name: 'heart', pathData: 'M0 0H5' }],
      }),
    );

    const result = await convertFontPackage(
      [file('first.ttf'), file('second.otf')],
      context(),
    );

    expect(result.icons.map((icon) => icon.name)).toEqual(['heart']);
    expect(
      result.warnings.some((warning) => warning.includes('first.ttf')),
    ).toBe(true);
  });

  it('falls back to the next font when one candidate cannot be parsed', async () => {
    const font = fakeFont({
      glyphs: [NOTDEF, { name: 'heart', pathData: 'M0 0H5' }],
    });
    parseMock.mockImplementationOnce(() => {
      throw new Error('broken font');
    });
    parseMock.mockImplementation(() => font);

    const result = await convertFontPackage(
      [file('broken.ttf'), file('good.woff')],
      context(),
    );

    expect(result.icons.map((icon) => icon.name)).toEqual(['heart']);
    expect(
      result.warnings.some((warning) => warning.includes('good.woff')),
    ).toBe(true);
  });

  it('derives suggestedName from the font family, then from the file name', async () => {
    parseMock.mockReturnValue(
      fakeFont({
        glyphs: [NOTDEF, { name: 'a', pathData: 'M0 0H1' }],
        names: { fontFamily: { en: 'Test Icons' } },
      }),
    );
    const named = await convertFontPackage([file('solid.ttf')], context());
    expect(named.suggestedName).toBe('Test Icons');

    parseMock.mockReturnValue(
      fakeFont({ glyphs: [NOTDEF, { name: 'a', pathData: 'M0 0H1' }] }),
    );
    const unnamed = await convertFontPackage([file('My-Icons.ttf')], context());
    expect(unnamed.suggestedName).toBe('my-icons');
  });

  it('reads the nested platform tables real fonts use for the family name', async () => {
    parseMock.mockReturnValue(
      fakeFont({
        glyphs: [NOTDEF, { name: 'a', pathData: 'M0 0H1' }],
        names: { macintosh: { fontFamily: { en: 'Nested Family' } } },
      }),
    );

    const result = await convertFontPackage([file('solid.ttf')], context());

    expect(result.suggestedName).toBe('Nested Family');
  });

  it('yields and reports progress every 200 entries', async () => {
    const specs: GlyphSpec[] = [NOTDEF];
    for (let index = 0; index < 401; index++)
      specs.push({ name: `icon-${index}`, pathData: 'M0 0H1' });
    parseMock.mockReturnValue(fakeFont({ glyphs: specs }));
    const onProgress = vi.fn();
    const yieldToMain = vi.fn(async () => undefined);

    const result = await convertFontPackage(
      [file('solid.ttf')],
      context({ onProgress, yieldToMain }),
    );

    expect(result.icons).toHaveLength(401);
    expect(yieldToMain).toHaveBeenCalledTimes(2);
    expect(onProgress).toHaveBeenCalledWith(expect.stringContaining('/402'));
  });

  it('falls back to glyph names when supplied CSS matches no glyph', async () => {
    parseMock.mockReturnValue(
      fakeFont({
        glyphs: [NOTDEF, { name: 'clock', pathData: 'M0 0H5' }],
      }),
    );

    const result = await convertFontPackage(
      [file('solid.ttf'), file('solid.css', '.fa-brand{--fa:"\\e999"}')],
      context(),
    );

    expect(result.icons.map((icon) => icon.name)).toEqual(['clock']);
    expect(
      result.warnings.some((warning) => warning.includes('字形名称')),
    ).toBe(true);
  });
});
