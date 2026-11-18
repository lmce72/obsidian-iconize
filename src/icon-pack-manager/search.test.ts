import { describe, expect, it, vi } from 'vitest';
import { IconPackManager } from './index';
import { IconPack } from './icon-pack';
import type IconizePlugin from '@app/main';

vi.mock('obsidian', () => ({ Notice: class {} }));

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
  it('bounds results and yields to the event loop during a 300,000-entry miss', async () => {
    const pack = new IconPack(
      {} as IconizePlugin,
      'synthetic',
      false,
      undefined,
      'Sy',
    );
    pack.setIndex(
      Array.from({ length: 300000 }, (_, i) => ({
        id: `SyIcon${i}`,
        name: `Icon${i}`,
        displayName: `icon-${i}`,
        folder: '',
        path: `icon-${i}.svg`,
      })),
    );
    const getIcons = vi.spyOn(pack, 'getIcons');
    const manager: IconPackManager = Object.assign(
      Object.create(IconPackManager.prototype),
      { iconPacks: [pack] },
    );
    let heartbeat = false;
    const timer = window.setTimeout(() => {
      heartbeat = true;
    }, 0);
    expect(await manager.searchIcons('no-such-icon')).toEqual([]);
    expect(heartbeat).toBe(true);
    expect(await manager.searchIcons('icon', 50)).toHaveLength(50);
    expect(await manager.searchIcons('icon', 50, () => true)).toEqual([]);
    expect(getIcons).not.toHaveBeenCalled();
    window.clearTimeout(timer);
  });
});
