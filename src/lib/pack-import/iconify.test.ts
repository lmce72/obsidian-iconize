import { describe, expect, it, vi } from 'vitest';
import { convertIconifyJson, isIconifyJson } from './iconify';

/** 构造最小 Iconify 集合 / Builds a minimal Iconify set. */
function iconify(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    prefix: 'test',
    width: 16,
    height: 16,
    icons: { home: { body: '<path d="M1 1h14v14H1z"/>' } },
    ...overrides,
  };
}

function svgOf(
  result: { icons: { name: string; svg: string }[] },
  name: string,
): string {
  const icon = result.icons.find((entry) => entry.name === name);
  if (!icon) throw new Error(`Expected an icon named ${name}`);
  return icon.svg;
}

describe('isIconifyJson', () => {
  it('accepts a set with a prefix marker and at least one icon', () => {
    expect(isIconifyJson(iconify())).toBe(true);
    expect(isIconifyJson({ prefix: 'mdi', icons: { a: { body: '' } } })).toBe(
      true,
    );
  });

  it('rejects arrays, non-objects and shapes without icons or prefix', () => {
    expect(isIconifyJson([iconify()])).toBe(false);
    expect(isIconifyJson(null)).toBe(false);
    expect(isIconifyJson('{"prefix":"x"}')).toBe(false);
    expect(isIconifyJson({ prefix: 'x' })).toBe(false);
    expect(isIconifyJson({ prefix: 'x', icons: {} })).toBe(false);
    expect(isIconifyJson({ icons: { a: { body: '<path/>' } } })).toBe(false);
    expect(isIconifyJson({ prefix: 'x', icons: [{ body: '<path/>' }] })).toBe(
      false,
    );
  });
});

describe('convertIconifyJson', () => {
  it('generates standalone icons using width, height, left and top', async () => {
    const result = await convertIconifyJson(
      iconify({ width: 24, height: 20, left: 4, top: -2 }),
      {},
    );

    expect(result.format).toBe('iconify-json');
    expect(result.label).toBe('Iconify JSON');
    expect(result.suggestedName).toBe('test');
    expect(result.skipped).toBe(0);
    expect(result.icons).toHaveLength(1);
    expect(result.icons[0]?.name).toBe('home');
    expect(result.icons[0]?.svg).toBe(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="4 -2 24 20"><path d="M1 1h14v14H1z"/></svg>',
    );
  });

  it('defaults missing dimensions to a 16x16 viewBox', async () => {
    const result = await convertIconifyJson(
      { prefix: 'test', icons: { home: { body: '<path d="M0 0h1v1H0z"/>' } } },
      {},
    );
    expect(result.icons[0]?.svg).toContain('viewBox="0 0 16 16"');
  });

  it('expands an alias that only names a parent into the parent body', async () => {
    const result = await convertIconifyJson(
      iconify({ aliases: { copy: { parent: 'home' } } }),
      {},
    );

    expect(result.icons.map((icon) => icon.name)).toEqual(['home', 'copy']);
    expect(svgOf(result, 'copy')).toBe(svgOf(result, 'home'));
  });

  it('writes rotate (quarter turns) before hFlip and vFlip on an alias', async () => {
    const result = await convertIconifyJson(
      iconify({
        width: 24,
        height: 20,
        aliases: {
          flipped: { parent: 'home', hFlip: true, vFlip: true, rotate: 1 },
        },
      }),
      {},
    );

    const flipped = svgOf(result, 'flipped');
    expect(flipped).toContain(
      '<g transform="rotate(90 12 10) translate(24 0) scale(-1 1) translate(0 20) scale(1 -1)">',
    );
    expect(flipped).toContain('<path d="M1 1h14v14H1z"/>');
  });

  it('uses per-icon dimensions instead of the root viewBox', async () => {
    const result = await convertIconifyJson(
      {
        prefix: 'test',
        width: 24,
        height: 24,
        icons: {
          wide: {
            body: '<path d="M0 0h100v10H0z"/>',
            width: 100,
            height: 10,
            left: -2,
            top: 1,
          },
        },
      },
      {},
    );
    expect(result.icons[0]?.svg).toContain('viewBox="-2 1 100 10"');
  });

  it('resolves an alias chain and keeps every addressable name', async () => {
    const result = await convertIconifyJson(
      iconify({
        aliases: {
          middle: { parent: 'home' },
          top: { parent: 'middle', rotate: 2 },
        },
      }),
      {},
    );

    expect(result.icons.map((icon) => icon.name)).toEqual([
      'home',
      'middle',
      'top',
    ]);
    const top = svgOf(result, 'top');
    expect(top).toContain('<g transform="rotate(180 8 8)">');
    expect(top).toContain('<path d="M1 1h14v14H1z"/>');
    expect(result.skipped).toBe(0);
    expect(result.warnings).toEqual([]);
  });

  it('reports an unresolved alias as skipped instead of throwing', async () => {
    const result = await convertIconifyJson(
      iconify({ aliases: { ghost: { parent: 'does-not-exist' } } }),
      {},
    );

    expect(result.icons.map((icon) => icon.name)).toEqual(['home']);
    expect(result.skipped).toBe(1);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('1');
  });

  it('skips empty or invalid icon bodies without aborting the set', async () => {
    const result = await convertIconifyJson(
      {
        prefix: 'test',
        icons: {
          ok: { body: '<path d="M2 2h12v12H2z"/>' },
          empty: { body: '   ' },
          broken: {},
          numeric: 42,
        },
        // 指向被过滤掉的空图标，父级因此不可解析。
        // Points at the filtered-out empty icon, so the parent cannot be resolved.
        aliases: { emptyAlias: { parent: 'empty' } },
      },
      {},
    );

    expect(result.icons.map((icon) => icon.name)).toEqual(['ok']);
    // 非法 body 在读取阶段就被丢弃，不计入 skipped；只有无法解析的别名计入。
    // Invalid bodies are dropped while reading and are not counted in `skipped`;
    // only the unresolvable alias is.
    expect(result.skipped).toBe(1);
    expect(result.warnings).toHaveLength(1);
  });

  it('rejects input that is not an Iconify set', async () => {
    await expect(convertIconifyJson({ icons: [] }, {})).rejects.toThrow(
      'Not an Iconify icon set',
    );
  });

  it('yields to the main thread for a large set', async () => {
    const icons: Record<string, { body: string }> = {};
    for (let index = 0; index < 600; index++)
      icons[`icon-${index}`] = { body: `<path d="M0 0h${index + 1}v1H0z"/>` };

    const yieldToMain = vi.fn(async () => {});
    const onProgress = vi.fn();
    const result = await convertIconifyJson(
      { prefix: 'big', icons },
      { yieldToMain, onProgress },
    );

    expect(result.icons).toHaveLength(600);
    expect(result.skipped).toBe(0);
    // 600 个名称只在第 500 个之后让出一次主线程。
    // 600 names cross the 500-entry checkpoint exactly once.
    expect(yieldToMain).toHaveBeenCalledTimes(1);
    expect(onProgress).toHaveBeenCalledTimes(1);
  });
});
