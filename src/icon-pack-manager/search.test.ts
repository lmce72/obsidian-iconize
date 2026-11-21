import { describe, expect, it, vi } from 'vitest';
import { IconPackManager } from './index';
import { IconPack } from './icon-pack';
import type IconizePlugin from '@app/main';
import { CompactIconIndex } from '@app/lib/compact-icon-index';
import type { IconEntry } from '@app/lib/icon-indexing';

vi.mock('obsidian', () => ({
  Notice: class {},
  Platform: { isDesktop: true },
}));

describe('large icon search', () => {
  it('puts an exact name before partial names without duplicate results', async () => {
    const pack = new IconPack(
      {} as IconizePlugin,
      'synthetic',
      false,
      undefined,
      'Sy',
    );
    pack.setIndex(
      ['BookHeart', 'Heart'].map((name) => ({
        id: `Sy${name}`,
        name,
        displayName: name,
        folder: '',
        path: `${name}.svg`,
      })),
    );
    const manager: IconPackManager = Object.assign(
      Object.create(IconPackManager.prototype),
      { iconPacks: [pack] },
    );
    const results = await manager.searchIcons('heart');
    expect(results.map((item) => item.name)).toEqual(['Heart', 'BookHeart']);
  });
  it('bounds results and searches 300,000 compact entries without materializing the pack', async () => {
    const pack = new IconPack(
      {} as IconizePlugin,
      'synthetic',
      false,
      undefined,
      'Sy',
    );
    function* entries(): Generator<IconEntry> {
      for (let i = 0; i < 300000; i++)
        yield {
          id: `SyIcon${i}`,
          name: `Icon${i}`,
          displayName: `icon-${i}`,
          folder: '',
          path: `icon-${i}.svg`,
        };
    }
    pack.setIndex(await CompactIconIndex.fromEntries(entries()));
    const getIcons = vi.spyOn(pack, 'getIcons');
    const getEntries = vi.spyOn(pack, 'getEntries');
    const manager: IconPackManager = Object.assign(
      Object.create(IconPackManager.prototype),
      { iconPacks: [pack] },
    );
    expect(await manager.searchIcons('no-such-icon')).toEqual([]);
    expect(await manager.searchIcons('icon', 50)).toHaveLength(50);
    expect(
      (await manager.searchIcons('icon-299999', 50)).map((item) => item.name),
    ).toEqual(['Icon299999']);
    expect(await manager.searchIcons('icon', 50, () => true)).toEqual([]);
    expect(getIcons).not.toHaveBeenCalled();
    expect(getEntries).not.toHaveBeenCalled();
    expect(pack.getCompactIndex().getStorageStats().numericBytes).toBeLessThan(
      24 * pack.size,
    );
  });
  it('matches multiple words across name, original filename and pack, preserving order', async () => {
    const pack = new IconPack(
      {} as IconizePlugin,
      'outline-tools',
      false,
      undefined,
      'Ot',
    );
    pack.setIndex(
      ['ArrowRight', 'Circle', 'ArrowLeft'].map((name) => ({
        id: `Ot${name}`,
        name,
        displayName: name.replace('Arrow', 'arrow-'),
        folder: '',
        path: `${name.replace('Arrow', 'arrow-')}.svg`,
      })),
    );
    const manager: IconPackManager = Object.assign(
      Object.create(IconPackManager.prototype),
      { iconPacks: [pack] },
    );
    expect(
      (await manager.searchIcons('outline arrow-')).map((item) => item.name),
    ).toEqual(['ArrowRight', 'ArrowLeft']);
    expect(
      (await manager.searchIcons('tools arrow left')).map((item) => item.name),
    ).toEqual(['ArrowLeft']);
    expect(await manager.searchIcons('circle right')).toEqual([]);
    expect(await manager.searchIcons('outline', 0)).toEqual([]);
  });
  it('filters packs, fuzzy-matches and sorts by relevance', async () => {
    const makePack = (name: string, prefix: string, icons: string[]) => {
      const pack = new IconPack(
        {} as IconizePlugin,
        name,
        false,
        undefined,
        prefix,
      );
      pack.setIndex(
        icons.map((icon) => ({
          id: `${prefix}${icon}`,
          name: icon,
          displayName: icon,
          folder: '',
          path: `${icon}.svg`,
        })),
      );
      return pack;
    };
    const alpha = makePack('alpha', 'Al', ['Home', 'Star']);
    const beta = makePack('beta', 'Be', [
      'Home',
      'Heart',
      'BookHeart',
      'Heartbeat',
    ]);
    const manager: IconPackManager = Object.assign(
      Object.create(IconPackManager.prototype),
      { iconPacks: [alpha, beta] },
    );

    expect(
      (
        await manager.searchIcons('home', 10, () => false, undefined, {
          packs: new Set(['alpha']),
        })
      ).map((item) => item.prefix + item.name),
    ).toEqual(['AlHome']);

    expect(await manager.searchIcons('hrt', 10)).toEqual([]);
    expect(
      (
        await manager.searchIcons('hrt', 10, () => false, undefined, {
          fuzzy: true,
        })
      ).map((item) => item.name),
    ).toContain('Heart');

    expect(
      (
        await manager.searchIcons('heart', 10, () => false, undefined, {
          packs: new Set(['beta']),
          sortByRelevance: true,
        })
      ).map((item) => item.name),
    ).toEqual(['Heart', 'Heartbeat', 'BookHeart']);
  });

  it('returns the next unseen batch when an exclusion is provided', async () => {
    const pack = new IconPack(
      {} as IconizePlugin,
      'synthetic',
      false,
      undefined,
      'Sy',
    );
    pack.setIndex(
      Array.from({ length: 8 }, (_, index) => ({
        id: `SyIcon${index}`,
        name: `Icon${index}`,
        displayName: `Icon${index}`,
        folder: '',
        path: `Icon${index}.svg`,
      })),
    );
    const manager: IconPackManager = Object.assign(
      Object.create(IconPackManager.prototype),
      { iconPacks: [pack] },
    );
    const first = await manager.searchIcons('icon', 3);
    const excluded = new Set(first.map((item) => item.prefix + item.name));
    const second = await manager.searchIcons(
      'icon',
      3,
      () => false,
      (id) => excluded.has(id),
    );
    expect(second).toHaveLength(3);
    for (const item of second)
      expect(excluded.has(item.prefix + item.name)).toBe(false);

    // 精确命中被排除后不能重复返回。 / An excluded exact match must not return.
    const exact = await manager.searchIcons('Icon5', 5);
    expect(exact.map((item) => item.name)).toEqual(['Icon5']);
    expect(
      await manager.searchIcons(
        'Icon5',
        5,
        () => false,
        (id) => id === 'SyIcon5',
      ),
    ).toEqual([]);
  });
});
