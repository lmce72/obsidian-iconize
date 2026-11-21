/**
 * sprite 转换测试 / Tests for single SVG files and symbol sprites.
 *
 * 全部使用合成 fixture，不依赖仓库外的真实图标包。
 * All fixtures are synthetic and never depend on real icon packs outside the repository.
 */

import { describe, expect, it } from 'vitest';
import { convertSvgFile } from './sprite';
import type { ImportContext } from './types';

const context: ImportContext = {};

function spriteMarkup(symbols: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" style="display:none">${symbols}</svg>`;
}

describe('convertSvgFile', () => {
  it('splits a sprite into one icon per symbol, keeping viewBox and fill', async () => {
    const text = spriteMarkup(`
      <symbol id="arrow-left" viewBox="0 0 24 24" fill="currentColor">
        <path d="M2 2h20v20H2z"/>
      </symbol>
      <symbol id="star" viewBox="0 0 32 32" fill="#ff0">
        <path d="M16 0l4 12h12l-10 7 4 13-10-8-10 8 4-13-10-7h12z"/>
      </symbol>
    `);

    const result = await convertSvgFile('brand-sprite.svg', text, context);

    expect(result.format).toBe('svg-sprite');
    expect(result.label).toBe('SVG Sprite');
    expect(result.suggestedName).toBe('brand-sprite');
    expect(result.skipped).toBe(0);
    expect(result.warnings).toEqual([]);
    expect(result.icons.map((icon) => icon.name)).toEqual([
      'arrow-left',
      'star',
    ]);
    for (const icon of result.icons) {
      expect(icon.folder).toBeUndefined();
    }

    const [arrow, star] = result.icons;
    expect(arrow.svg).toContain('viewBox="0 0 24 24"');
    expect(arrow.svg).toContain('fill="currentColor"');
    expect(arrow.svg).toContain('d="M2 2h20v20H2z"');
    expect(star.svg).toContain('viewBox="0 0 32 32"');
    expect(star.svg).toContain('fill="#ff0"');
  });

  it('normalizes a single SVG file into one icon', async () => {
    const text = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" fill="none" stroke="currentColor">
      <path d="M1 1h14v14H1z"/>
    </svg>`;

    const result = await convertSvgFile('plain-icon.svg', text, context);

    expect(result.format).toBe('svg-file');
    expect(result.label).toBe('SVG 文件 / SVG file');
    expect(result.suggestedName).toBe('plain-icon');
    expect(result.skipped).toBe(0);
    expect(result.warnings).toEqual([]);
    expect(result.icons).toHaveLength(1);
    const [icon] = result.icons;
    expect(icon.name).toBe('plain-icon');
    expect(icon.folder).toBeUndefined();
    expect(icon.svg).toContain('viewBox="0 0 16 16"');
    expect(icon.svg).toContain('stroke="currentColor"');
  });

  it('rejects a sprite whose symbols have no drawable content', async () => {
    const text = spriteMarkup('<symbol id="empty"></symbol>');

    await expect(convertSvgFile('empty.svg', text, context)).rejects.toThrow(
      /without any drawable symbol/,
    );
  });

  it('rejects markup that is not a renderable SVG', async () => {
    await expect(
      convertSvgFile('notes.svg', 'this is not markup at all', context),
    ).rejects.toThrow(/not a renderable SVG/);

    await expect(
      convertSvgFile('blank.svg', '<svg></svg>', context),
    ).rejects.toThrow(/not a renderable SVG/);
  });

  it('keeps duplicate symbol ids for the normalizer to disambiguate', async () => {
    const text = spriteMarkup(`
      <symbol id="arrow" viewBox="0 0 24 24"><path d="M0 0h24v24H0z"/></symbol>
      <symbol id="arrow" viewBox="0 0 24 24"><path d="M1 1h22v22H1z"/></symbol>
      <symbol id="star" viewBox="0 0 24 24"><path d="M2 2h20v20H2z"/></symbol>
    `);

    const result = await convertSvgFile('dupes.svg', text, context);

    expect(result.format).toBe('svg-sprite');
    expect(result.skipped).toBe(0);
    expect(result.icons.map((icon) => icon.name)).toEqual([
      'arrow',
      'arrow',
      'star',
    ]);
    // 第二阶段由归一化器把第二条写成 arrow-2.svg，而不是在这里丢弃。
    // The normalizer turns the second into arrow-2.svg instead of dropping it here.
    expect(result.icons[1].svg).toContain('M1 1h22v22H1z');
  });
});
