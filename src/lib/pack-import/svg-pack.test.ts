import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { openArchive, type ArchiveReader } from './archive';
import { convertSvgArchive, selectIconRoot } from './svg-pack';

/** 一个可正常归一化的独立图标 / A standalone icon that normalizes successfully. */
function icon(fill = '#000'): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" fill="${fill}"/></svg>`;
}

/** 只含 symbol 的 sprite 容器 / A symbol-only sprite sheet. */
function sprite(ids: string[]): string {
  const symbols = ids
    .map(
      (id) =>
        `<symbol id="${id}" viewBox="0 0 16 16"><path d="M0 0h8v8H0z"/></symbol>`,
    )
    .join('');
  return `<svg xmlns="http://www.w3.org/2000/svg">${symbols}</svg>`;
}

function zip(files: Record<string, string>): Uint8Array {
  return zipSync(
    Object.fromEntries(
      Object.entries(files).map(([path, text]) => [path, strToU8(text)]),
    ),
  );
}

/** 用真实 ZIP 字节打开归档；失败时给出明确错误而不是非空断言。 */
/** Opens a real ZIP archive; throws a clear error instead of a non-null assertion. */
async function readerFor(
  files: Record<string, string>,
): Promise<ArchiveReader> {
  const reader = await openArchive(zip(files));
  if (!reader) throw new Error('Test archive was not recognized as an archive');
  return reader;
}

/**
 * 归档转换器输出不含扩展名的图标名 / The archive converter emits names without extensions.
 */
function namesOf(icons: { name: string }[]): string[] {
  return icons.map((entry) => entry.name).sort();
}

describe('convertSvgArchive', () => {
  it('excludes noise directories before counting icons', async () => {
    const reader = await readerFor({
      'icons/a.svg': icon(),
      'icons/b.svg': icon(),
      'icons/c.svg': icon(),
      'docs/preview.svg': icon(),
      'docs/hero.svg': icon(),
      '.github/logo.svg': icon(),
      'test/fixture.svg': icon(),
    });

    const result = await convertSvgArchive(reader, {});

    expect(namesOf(result.icons)).toEqual(['a', 'b', 'c']);
    expect(result.skipped).toBe(4);
    expect(result.warnings.some((warning) => warning.includes('4'))).toBe(true);
  });

  it('prefers an icons/ root over a documentation directory', async () => {
    const reader = await readerFor({
      'icons/heart.svg': icon(),
      'icons/star.svg': icon(),
      'icons/bell.svg': icon(),
      'docs/d1.svg': icon(),
      'docs/d2.svg': icon(),
      'docs/d3.svg': icon(),
      'docs/d4.svg': icon(),
      'docs/d5.svg': icon(),
    });

    const result = await convertSvgArchive(reader, {});

    expect(namesOf(result.icons)).toEqual(['bell', 'heart', 'star']);
    expect(result.icons.every((entry) => entry.folder === '')).toBe(true);
  });

  it('keeps both style subtrees when the archive is rooted at src/', async () => {
    const reader = await readerFor({
      'src/24/outline/a.svg': icon(),
      'src/24/outline/b.svg': icon(),
      'src/24/outline/c.svg': icon(),
      'src/24/solid/d.svg': icon(),
      'src/24/solid/e.svg': icon(),
      'src/24/solid/f.svg': icon(),
    });

    const result = await convertSvgArchive(reader, {});

    expect(result.icons).toHaveLength(6);
    expect(namesOf(result.icons)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
    expect(
      [...new Set(result.icons.map((entry) => entry.folder))].sort(),
    ).toEqual(['24/outline', '24/solid']);
  });

  it('falls back to the archive root for a flat zip', async () => {
    const reader = await readerFor({
      'a.svg': icon(),
      'b.svg': icon(),
      'c.svg': icon(),
    });

    const result = await convertSvgArchive(reader, {});

    expect(namesOf(result.icons)).toEqual(['a', 'b', 'c']);
    expect(result.icons.every((entry) => entry.folder === '')).toBe(true);
    expect(result.skipped).toBe(0);
  });

  it('falls back to the single wrapper directory of a zip', async () => {
    const reader = await readerFor({
      'pack/a.svg': icon(),
      'pack/b.svg': icon(),
      'pack/c.svg': icon(),
    });

    const result = await convertSvgArchive(reader, {});

    expect(namesOf(result.icons)).toEqual(['a', 'b', 'c']);
    // 根目录被识别为 pack/，相对目录为空，名称里不应带容器目录。
    // The root is pack/, so relative folders stay empty and names keep no wrapper.
    expect(result.icons.every((entry) => entry.folder === '')).toBe(true);
  });

  it('splits a sprite sheet found inside the archive', async () => {
    const reader = await readerFor({
      'icons/all.svg': sprite(['heart', 'star']),
    });

    const result = await convertSvgArchive(reader, {});

    expect(namesOf(result.icons)).toEqual(['heart', 'star']);
    expect(result.icons.every((entry) => entry.svg.startsWith('<svg'))).toBe(
      true,
    );
    expect(
      result.icons.every((entry) => entry.svg.includes('viewBox="0 0 16 16"')),
    ).toBe(true);
    expect(result.warnings.some((warning) => warning.includes('sprite'))).toBe(
      true,
    );
  });

  it('skips sprite symbols already provided as individual SVGs', async () => {
    const reader = await readerFor({
      'icons/x/heart.svg': icon(),
      'icons/x/star.svg': icon(),
      'icons/x/bell.svg': icon(),
      'icons/x/merged.svg': sprite(['heart', 'star', 'bell']),
    });

    const result = await convertSvgArchive(reader, {});

    // 个体图标优先；合并容器里的三个 symbol 都会被识别为重复。
    // Individual icons win; all three merged symbols are duplicates.
    expect(result.icons).toHaveLength(3);
    expect(namesOf(result.icons)).toEqual(['bell', 'heart', 'star']);
    expect(result.icons.every((entry) => entry.folder === 'x')).toBe(true);
    expect(result.warnings.some((warning) => warning.includes('重复'))).toBe(
      true,
    );
  });

  it('keeps icons whose file name ends in "symbol"', async () => {
    const reader = await readerFor({
      'icons/usb-symbol.svg': icon(),
      'icons/usb-c.svg': icon(),
      'icons/usb-drive.svg': icon(),
      'icons/usb-plug.svg': icon(),
    });

    const result = await convertSvgArchive(reader, {});

    // 文件名不是 sprite 判据；内容才是。 / The file name is not a sprite marker; content is.
    expect(namesOf(result.icons)).toEqual([
      'usb-c',
      'usb-drive',
      'usb-plug',
      'usb-symbol',
    ]);
  });

  it('does not crash on an orphan symbol next to a real SVG', async () => {
    const reader = await readerFor({
      'icons/all.svg':
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><path d="M0 0h8v8H0z"/></svg><symbol id="b"><path d="M0 0h8v8H0z"/></symbol>',
    });

    const result = await convertSvgArchive(reader, {});

    expect(result.icons).toHaveLength(1);
    expect(namesOf(result.icons)).toEqual(['all']);
  });

  it('reports iconize-zip when every entry is an SVG', async () => {
    const reader = await readerFor({
      'a.svg': icon(),
      'b.svg': icon(),
      'c.svg': icon(),
    });

    const result = await convertSvgArchive(reader, {});

    expect(result.format).toBe('iconize-zip');
    expect(result.label).toBe('Iconize ZIP');
  });

  it('reports svg-archive when the archive contains other entries', async () => {
    const reader = await readerFor({
      'a.svg': icon(),
      'b.svg': icon(),
      'c.svg': icon(),
      'README.md': '# icons',
    });

    const result = await convertSvgArchive(reader, {});

    expect(result.format).toBe('svg-archive');
    expect(result.label).toBe('SVG 图标包');
    expect(result.icons).toHaveLength(3);
  });

  it('rejects an archive without SVG entries', async () => {
    const reader = await readerFor({
      'README.md': '# icons',
      'docs/guide.md': 'nothing to import',
    });

    await expect(convertSvgArchive(reader, {})).rejects.toThrow(
      'contains no SVG files',
    );
  });
});

describe('selectIconRoot', () => {
  it('returns the archive root when there are no paths', () => {
    expect(selectIconRoot([])).toBe('');
  });

  it('returns the archive root for flat paths', () => {
    expect(selectIconRoot(['a.svg', 'b.svg', 'c.svg'])).toBe('');
  });

  it('selects a marker directory with at least three icons', () => {
    expect(selectIconRoot(['icons/a.svg', 'icons/b.svg', 'icons/c.svg'])).toBe(
      'icons/',
    );
  });

  it('ignores a marker directory below the three-icon threshold', () => {
    // icons 只有 2 个图标，其余图标散在归档根目录。
    // icons holds only two icons while the rest sit at the archive root.
    expect(selectIconRoot(['icons/a.svg', 'icons/b.svg', 'docs/c.svg'])).toBe(
      '',
    );
  });

  it('breaks equal marker counts by segment priority', () => {
    expect(
      selectIconRoot([
        'icons/a.svg',
        'icons/b.svg',
        'icons/c.svg',
        'svgs/d.svg',
        'svgs/e.svg',
        'svgs/f.svg',
      ]),
    ).toBe('icons/');
    // 数量更多时数量优先于优先级。
    // A larger count beats the segment priority.
    expect(
      selectIconRoot([
        'icons/a.svg',
        'icons/b.svg',
        'icons/c.svg',
        'svgs/d.svg',
        'svgs/e.svg',
        'svgs/f.svg',
        'svgs/g.svg',
      ]),
    ).toBe('svgs/');
  });

  it('falls back to the deepest directory covering at least 95%', () => {
    expect(selectIconRoot(['a/x.svg', 'a/y.svg', 'a/z.svg', 'a/b/w.svg'])).toBe(
      'a/',
    );
    expect(selectIconRoot(['pack/a.svg', 'pack/b.svg', 'pack/c.svg'])).toBe(
      'pack/',
    );
  });

  it('does not treat partial directory names as markers', () => {
    // my-icons 不是标记目录，且只覆盖 3/4，因此退回归档根目录。
    // my-icons is not a marker and only covers 3/4, so the root wins.
    expect(
      selectIconRoot([
        'my-icons/a.svg',
        'my-icons/b.svg',
        'my-icons/c.svg',
        'other/d.svg',
      ]),
    ).toBe('');
  });

  it('ignores paths with only a few icons per directory', () => {
    expect(selectIconRoot(['one/a.svg', 'two/b.svg', 'three/c.svg'])).toBe('');
  });
});
