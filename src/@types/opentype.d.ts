/**
 * opentype.js 的最小类型声明 / Minimal typings for opentype.js.
 *
 * 该包 2.x 不自带类型，@types 仍停留在 1.3。这里只声明导入器实际使用的接口，
 * 不复制整个库的 API，也不引入版本不匹配的类型包。
 *
 * The 2.x package ships no types and @types still targets 1.3. Only the surface the
 * importer actually uses is declared, rather than pulling in a mismatched type package.
 */
declare module 'opentype.js' {
  export interface Path {
    toPathData(decimalPlaces?: number): string;
    getBoundingBox(): { x1: number; y1: number; x2: number; y2: number };
  }

  export interface Glyph {
    index: number;
    name: string | null;
    unicode?: number;
    getPath(x?: number, y?: number, fontSize?: number): Path;
  }

  export interface Font {
    unitsPerEm: number;
    ascender: number;
    descender: number;
    numGlyphs: number;
    glyphs: { get(index: number): Glyph; length: number };
    charToGlyph(char: string): Glyph;
    names?: {
      fontFamily?: Record<string, string>;
      fullName?: Record<string, string>;
    };
  }

  export function parse(buffer: ArrayBuffer, options?: unknown): Font;
}
