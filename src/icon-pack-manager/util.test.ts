import { it, describe, expect, vi } from 'vitest';
import {
  generateIcon,
  getNormalizedName,
  getSvgFromLoadedIcon,
  nextIdentifier,
} from './util';
import IconizePlugin from '@app/main';
import { IconPack } from './icon-pack';

describe('getNormalizedName', () => {
  it('should return a string with all words capitalized and no spaces or underscores', () => {
    const input = 'this is a test_name';
    const expectedOutput = 'ThisIsATestName';
    expect(getNormalizedName(input)).toEqual(expectedOutput);
  });

  it('should handle input with only one word', () => {
    const input = 'test';
    const expectedOutput = 'Test';
    expect(getNormalizedName(input)).toEqual(expectedOutput);
  });

  it('should handle input with spaces and underscores', () => {
    const input = 'this_is a_test name';
    const expectedOutput = 'ThisIsATestName';
    expect(getNormalizedName(input)).toEqual(expectedOutput);
  });

  it('should handle input with spaces and hyphens', () => {
    const input = 'this-is a-test-name';
    const expectedOutput = 'ThisIsATestName';
    expect(getNormalizedName(input)).toEqual(expectedOutput);
  });
});

describe('nextIdentifier', () => {
  it('should find first uppercase letter or number', () => {
    expect(nextIdentifier('aBcDef')).toBe(1);
    expect(nextIdentifier('a1bcDef')).toBe(1);
    expect(nextIdentifier('aBc123')).toBe(1);
  });

  it('should return 0 when no match found', () => {
    expect(nextIdentifier('abcdef')).toBe(0);
  });

  it('should handle empty string', () => {
    expect(nextIdentifier('')).toBe(0);
  });
});

describe('getSvgFromLoadedIcon', () => {
  const packFor = (prefix: string, name: string, svgElement: string) => ({
    getIcon: vi.fn((iconName: string) =>
      iconName === name ? { prefix, name, svgElement } : undefined,
    ),
  });

  const mockPlugin = {
    getIconPackManager: vi.fn(() => ({
      getIconPackByPrefix: vi.fn((prefix: string) =>
        prefix === 'md'
          ? packFor('md', 'settings', '<svg>material</svg>')
          : undefined,
      ),
    })),
  } as unknown as IconizePlugin;

  it('should prefer the icon the resolver already holds in memory', () => {
    const withResolver = {
      ...mockPlugin,
      iconResolver: { peek: () => ({ svgElement: '<svg>memory</svg>' }) },
    } as unknown as IconizePlugin;

    expect(getSvgFromLoadedIcon(withResolver, 'md', 'settings')).toBe(
      '<svg>memory</svg>',
    );
  });

  it('should look the pack up by prefix when the resolver has nothing', () => {
    expect(getSvgFromLoadedIcon(mockPlugin, 'md', 'settings')).toBe(
      '<svg>material</svg>',
    );
  });

  it('should return empty string when not found', () => {
    expect(getSvgFromLoadedIcon(mockPlugin, 'none', 'missing')).toBe('');
  });
});

describe('generateIcon', () => {
  const mockIconPack = {
    getPrefix: () => 'fa',
    getName: () => 'font-awesome',
  } as IconPack;

  it('should create valid icon structure', () => {
    const result = generateIcon(
      mockIconPack,
      'test',
      '<svg viewBox="0 0 24 24"><path/></svg>',
    );

    expect(result).toEqual({
      name: 'Test',
      prefix: 'fa',
      iconPackName: 'font-awesome',
      displayName: 'test',
      filename: 'test',
      svgContent: '<path/>',
      svgViewbox: 'viewBox="0 0 24 24"',
      svgElement: expect.any(String),
    });
  });

  it('should handle SVG normalization', () => {
    const result = generateIcon(
      mockIconPack,
      'test',
      `
      <svg
        viewBox="0 0 24 24"
        class="test"
      >
        <path />
      </svg>
    `,
    );

    expect(result?.svgContent).toBe('<path />');
    expect(result?.svgViewbox).toBe('viewBox="0 0 24 24"');
  });
});
