import { describe, expect, it } from 'vitest';
import type { ArchiveReader } from './archive';
import { convertJsModuleArchive, svgFromModuleSource } from './js-module';
import type { ImportContext } from './types';

/**
 * 构造一个内存归档读取器 / Builds an in-memory archive reader.
 *
 * 测试数据全部是合成字符串，不依赖任何真实 npm 包。
 * All fixtures are synthetic strings and never depend on a real npm package.
 */
function readerOf(files: Record<string, string>): ArchiveReader {
  return {
    kind: 'zip',
    names: Object.keys(files),
    async readBytes(name: string): Promise<Uint8Array | null> {
      const text = files[name];
      return text === undefined ? null : new TextEncoder().encode(text);
    },
    async readText(name: string): Promise<string | null> {
      return files[name] ?? null;
    },
  };
}

function context(overrides: ImportContext = {}): ImportContext {
  return { ...overrides };
}

/** 一段 CJS 风格图标模块 / One CJS-style icon module. */
function cjsIcon(options: {
  name?: string;
  viewBox?: string;
  root?: string;
  paths: string;
}): string {
  const viewBox = options.viewBox ?? '0 0 24 24';
  const root = options.root ?? 'xmlns: "http://www.w3.org/2000/svg"';
  return `const React = require("react");
function ${options.name ?? 'AcademicCapIcon'}(props) {
  return React.createElement("svg", Object.assign({ ${root}, viewBox: "${viewBox}" }, props), ${options.paths});
}`;
}

const ONE_PATH =
  'React.createElement("path", { strokeLinecap: "round", strokeLinejoin: "round", d: "M4 4L8 8" })';

describe('svgFromModuleSource', () => {
  it('extracts root presentation attributes and path geometry', () => {
    const source = cjsIcon({
      root: 'fill: "none", stroke: "currentColor", strokeWidth: 1.5, fillRule: "evenodd", clipRule: "evenodd"',
      paths: ONE_PATH,
    });
    const svg = svgFromModuleSource(source);
    expect(svg).not.toBeNull();
    expect(svg).toContain('viewBox="0 0 24 24"');
    expect(svg).toContain('fill="none"');
    expect(svg).toContain('stroke="currentColor"');
    expect(svg).toContain('stroke-width="1.5"');
    expect(svg).toContain('fill-rule="evenodd"');
    expect(svg).toContain('clip-rule="evenodd"');
    expect(svg).toContain('<path d="M4 4L8 8"');
    expect(svg).toContain('stroke-linecap="round"');
    expect(svg).toContain('stroke-linejoin="round"');
    expect(svg?.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(
      true,
    );
  });

  it('supports single quotes and attribute-style viewBox', () => {
    const source = `element = createElement('svg', { fill: 'currentColor' });
raw = '<svg viewBox="0 0 20 20"></svg>';
element2 = createElement('path', { d: 'M1 1L2 2' });`;
    const svg = svgFromModuleSource(source);
    expect(svg).toContain('viewBox="0 0 20 20"');
    expect(svg).toContain('fill="currentColor"');
    expect(svg).toContain('d="M1 1L2 2"');
  });

  it('keeps every drawable path and drops paths without d', () => {
    const source = cjsIcon({
      paths: `React.createElement("path", { d: "M1 1L2 2" }),
        React.createElement("path", { fillRule: "evenodd" }),
        React.createElement("path", { fillRule: "evenodd", d: "M3 3L4 4" })`,
    });
    const svg = svgFromModuleSource(source);
    expect(svg?.match(/<path/g)).toHaveLength(2);
    expect(svg).toContain('fill-rule="evenodd"');
    expect(svg).not.toContain('M5');
  });

  it('returns null when no path geometry exists', () => {
    expect(
      svgFromModuleSource(
        'React.createElement("svg", { viewBox: "0 0 24 24" })',
      ),
    ).toBeNull();
    expect(svgFromModuleSource('module.exports = {};')).toBeNull();
  });

  it('extracts non-path primitives such as rect and keeps root line caps', () => {
    const svg = svgFromModuleSource(
      'React.createElement("svg", { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeLinecap: "round", strokeLinejoin: "round" }, React.createElement("rect", { width: 10, height: 10, x: 3, y: 3, rx: 1.5 }), React.createElement("circle", { cx: 8, cy: 8, r: 4 }))',
    );
    expect(svg).toContain('<rect');
    for (const attribute of [
      'x="3"',
      'y="3"',
      'width="10"',
      'height="10"',
      'rx="1.5"',
    ])
      expect(svg).toContain(attribute);
    expect(svg).toContain('<circle cx="8" cy="8" r="4"/>');
    expect(svg).toContain('stroke-linecap="round"');
    expect(svg).toContain('stroke-linejoin="round"');
  });

  it('supports an aliased createElement factory', () => {
    const svg = svgFromModuleSource(
      'import { createElement as h } from "react"; const Icon = () => h("svg", { viewBox: "0 0 16 16" }, h("path", { d: "M0 0h16" }));',
    );
    expect(svg).toContain('viewBox="0 0 16 16"');
    expect(svg).toContain('<path d="M0 0h16"/>');
  });
});

describe('convertJsModuleArchive', () => {
  it('converts a CJS module and reports the JS format', async () => {
    const result = await convertJsModuleArchive(
      readerOf({
        'package/24/outline/AcademicCapIcon.js': cjsIcon({ paths: ONE_PATH }),
      }),
      context(),
    );
    expect(result.format).toBe('js-icon-module');
    expect(result.label).toBe('JS 图标模块 / JS icon module');
    expect(result.icons).toHaveLength(1);
    expect(result.icons[0].name).toBe('AcademicCap');
    expect(result.icons[0].folder).toBe('24/outline');
    expect(result.icons[0].svg).toContain('viewBox="0 0 24 24"');
    expect(result.skipped).toBe(0);
  });

  it('skips the ESM copy when the non-ESM twin exists', async () => {
    const source = cjsIcon({ paths: ONE_PATH });
    const result = await convertJsModuleArchive(
      readerOf({
        'package/24/outline/AcademicCapIcon.js': source,
        'package/24/outline/esm/AcademicCapIcon.js': source,
      }),
      context(),
    );
    expect(result.icons).toHaveLength(1);
    expect(result.skipped).toBe(1);
  });

  it('keeps ESM-only modules that have no non-ESM twin', async () => {
    const result = await convertJsModuleArchive(
      readerOf({
        'package/24/esm/SoloIcon.js': cjsIcon({
          name: 'SoloIcon',
          paths: ONE_PATH,
        }),
      }),
      context(),
    );
    expect(result.icons.map((icon) => icon.name)).toEqual(['Solo']);
  });

  it('keeps the same icon name in different style folders', async () => {
    const result = await convertJsModuleArchive(
      readerOf({
        'package/24/outline/HeartIcon.js': cjsIcon({
          name: 'HeartIcon',
          viewBox: '0 0 24 24',
          paths: ONE_PATH,
        }),
        'package/HeartIcon.js': cjsIcon({
          name: 'HeartIcon',
          viewBox: '0 0 16 16',
          paths: ONE_PATH,
        }),
      }),
      context(),
    );
    expect(result.icons).toHaveLength(2);
    expect(result.icons.map((icon) => icon.folder ?? '').sort()).toEqual([
      '',
      '24/outline',
    ]);
    expect(result.icons.every((icon) => icon.name === 'Heart')).toBe(true);
  });

  it('deduplicates the same name within one folder, keeping the first', async () => {
    const result = await convertJsModuleArchive(
      readerOf({
        'package/HeartIcon.js': cjsIcon({
          name: 'HeartIcon',
          viewBox: '0 0 24 24',
          paths: ONE_PATH,
        }),
        'package/heartIcon.js': cjsIcon({
          name: 'heartIcon',
          viewBox: '0 0 16 16',
          paths: ONE_PATH,
        }),
      }),
      context(),
    );
    expect(result.icons).toHaveLength(1);
    expect(result.icons[0].svg).toContain('viewBox="0 0 24 24"');
    expect(result.skipped).toBe(1);
  });

  it('strips the Icon suffix and drops names that sanitize to nothing', async () => {
    const result = await convertJsModuleArchive(
      readerOf({
        'package/AcademicCapIcon.js': cjsIcon({ paths: ONE_PATH }),
        'package/Heart.js': cjsIcon({ name: 'Heart', paths: ONE_PATH }),
        'package/Icon.js': cjsIcon({ name: 'Icon', paths: ONE_PATH }),
      }),
      context(),
    );
    expect(result.icons.map((icon) => icon.name).sort()).toEqual([
      'AcademicCap',
      'Heart',
    ]);
    expect(result.skipped).toBe(1);
  });

  it('reads the package name from package/package.json', async () => {
    const result = await convertJsModuleArchive(
      readerOf({
        'package/package.json': JSON.stringify({
          name: '@heroicons/react',
          version: '2.0.0',
        }),
        'package/package.json.nested/package.json': '{"type":"module"}',
        'package/AcademicCapIcon.js': cjsIcon({ paths: ONE_PATH }),
      }),
      context(),
    );
    expect(result.suggestedName).toBe('heroicons-react');
  });

  it('ignores type declarations, maps and index barrels', async () => {
    const result = await convertJsModuleArchive(
      readerOf({
        'package/index.esm.js': cjsIcon({ paths: ONE_PATH }),
        'package/24/outline/index.js': cjsIcon({ paths: ONE_PATH }),
        'package/types.d.ts':
          'declare const x: "React.createElement(\\"path\\", { d: \\"M0 0\\" })";',
        'package/AcademicCapIcon.js.map': cjsIcon({ paths: ONE_PATH }),
        'package/AcademicCapIcon.js': cjsIcon({ paths: ONE_PATH }),
      }),
      context(),
    );
    expect(result.icons).toHaveLength(1);
    expect(result.skipped).toBe(0);
  });

  it('reports progress and yields every 200 files', async () => {
    const files: Record<string, string> = {};
    for (let index = 0; index < 201; index++)
      files[`package/Icon${index}Icon.js`] = cjsIcon({
        name: `Icon${index}Icon`,
        paths: ONE_PATH,
      });
    const messages: string[] = [];
    let yields = 0;
    const result = await convertJsModuleArchive(
      readerOf(files),
      context({
        onProgress: (message) => messages.push(message),
        yieldToMain: async () => {
          yields++;
        },
      }),
    );
    expect(result.icons).toHaveLength(201);
    expect(yields).toBe(1);
    expect(messages.some((message) => message.includes('200/201'))).toBe(true);
  });

  it('throws when nothing can be extracted', async () => {
    await expect(
      convertJsModuleArchive(
        readerOf({
          'package/index.js': 'module.exports = {};',
          'package/EmptyIcon.js': 'module.exports = null;',
        }),
        context(),
      ),
    ).rejects.toThrow('no extractable JS icon modules');
  });
});
