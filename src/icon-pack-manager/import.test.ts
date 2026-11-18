import { beforeEach, describe, expect, it, vi } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import type IconizePlugin from '@app/main';
import { IconPackManager } from './index';
import { IconPack } from './icon-pack';
import { ZipSource } from '@app/lib/icon-sources';
import type { DataAdapter } from 'obsidian';
import { indexAndRegisterPack } from '@app/lib/lazy-loading-integration';

vi.mock('obsidian', () => ({
  Notice: class {},
  Platform: { isDesktop: false },
}));
vi.mock('@app/lib/lazy-loading-integration', () => ({
  indexAndRegisterPack: vi.fn(),
}));

function archive(name: string): ArrayBuffer {
  return zipSync({
    [name + '.svg']: strToU8(
      '<svg viewBox="0 0 16 16"><path d="M0 0h16v16z"/></svg>',
    ),
  }).slice().buffer as ArrayBuffer;
}

function fixture() {
  const original = archive('old');
  const files = new Map<string, ArrayBuffer>([['icons/test.zip', original]]);
  const adapter = {
    exists: vi.fn(async (path: string) => files.has(path)),
    readBinary: vi.fn(async (path: string) => files.get(path)!),
    writeBinary: vi.fn(async (path: string, data: ArrayBuffer) => {
      files.set(path, data);
    }),
    stat: vi.fn(async (path: string) => ({
      size: files.get(path)?.byteLength ?? 0,
      mtime: 1,
    })),
    rename: vi.fn(async (from: string, to: string) => {
      if (!files.has(from)) throw new Error('Missing source');
      files.set(to, files.get(from)!);
      files.delete(from);
    }),
    remove: vi.fn(async (path: string) => {
      files.delete(path);
    }),
  };
  const plugin = {
    app: { vault: { adapter } },
    lazyLoadingSystem: {},
    iconResolver: {},
  } as unknown as IconizePlugin;
  const source = new ZipSource(
    adapter as unknown as DataAdapter,
    'icons/test.zip',
  );
  const oldPack = new IconPack(plugin, 'test', false, source);
  const manager = Object.assign(Object.create(IconPackManager.prototype), {
    plugin,
    path: 'icons',
    iconPacks: [oldPack],
    importing: new Set<string>(),
  }) as IconPackManager;
  return { manager, adapter, files, oldPack, original, source, plugin };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(indexAndRegisterPack).mockImplementation(
    async (_plugin, pack, index) => {
      if (index) await pack.loadIndex(index);
      return index?.entries.length ?? 1;
    },
  );
});

describe('transactional archive import', () => {
  it('detects loaded, folder and archive pack names before creating a folder', async () => {
    const f = fixture();
    f.files.set('icons/archive-only.zip', archive('disk'));
    f.files.set('icons/folder-only', new ArrayBuffer(0));
    const native = new IconPack(f.plugin, 'native', false);
    f.manager.addIconPack(native);
    for (const name of ['test', 'archive-only', 'folder-only', 'native']) {
      expect(await f.manager.doesIconPackExist(name)).toBe(true);
      await expect(
        f.manager.createCustomIconPackDirectory(name),
      ).rejects.toThrow('already exists');
    }
    expect(await f.manager.doesIconPackExist('unused')).toBe(false);
    f.source.dispose();
  });

  it('rejects a ZIP import that would shadow a folder pack', async () => {
    const f = fixture();
    f.manager.addIconPack(new IconPack(f.plugin, 'custom', true));
    f.files.set('icons/disk-folder', new ArrayBuffer(0));
    for (const name of ['custom', 'disk-folder'])
      await expect(
        f.manager.registerIconPack(name, archive('new')),
      ).rejects.toThrow('folder pack');
    expect(f.adapter.writeBinary).not.toHaveBeenCalled();
    expect(indexAndRegisterPack).not.toHaveBeenCalled();
    f.source.dispose();
  });

  it('rolls back if unloading clears the lazy system during registration', async () => {
    const f = fixture();
    const controller = new AbortController();
    const removeIndex = vi.fn(async () => {});
    f.plugin.lazyLoadingSystem = {
      signal: controller.signal,
      store: { delete: removeIndex },
    } as unknown as NonNullable<IconizePlugin['lazyLoadingSystem']>;
    vi.mocked(indexAndRegisterPack).mockImplementationOnce(async () => {
      controller.abort();
      f.plugin.lazyLoadingSystem = undefined;
      return 1;
    });
    await expect(
      f.manager.registerIconPack('test', archive('new')),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.files.get('icons/test.zip')).toBe(f.original);
    expect([...f.files.keys()]).toEqual(['icons/test.zip']);
    expect(f.manager.getIconPackByName('test')).toBe(f.oldPack);
    expect(indexAndRegisterPack).toHaveBeenCalledTimes(1);
    expect(removeIndex).toHaveBeenCalledWith('test');
    f.source.dispose();
  });

  it('replaces a same-name archive and publishes the newly validated index', async () => {
    const f = fixture();
    const replacement = archive('new');
    await f.manager.registerIconPack('test', replacement);
    expect(f.files.get('icons/test.zip')).toBe(replacement);
    expect([...f.files.keys()]).toEqual(['icons/test.zip']);
    const pack = f.manager.getIconPackByName('test')!;
    expect(pack).not.toBe(f.oldPack);
    expect(pack.getEntry('TeNew')).toBeDefined();
    expect(pack.getEntry('TeOld')).toBeUndefined();
    expect(f.manager.getIconPacks()).toHaveLength(1);
    expect(await f.source.readEntry('old.svg')).toBeNull();
  });

  it.each([
    new Uint8Array([1, 2, 3]).buffer,
    zipSync({ 'readme.txt': strToU8('empty') }).slice().buffer,
  ])(
    'preserves the old pack when incoming bytes are corrupt or contain no icons',
    async (bytes) => {
      const f = fixture();
      await expect(
        f.manager.registerIconPack('test', bytes as ArrayBuffer),
      ).rejects.toThrow();
      expect(f.files.get('icons/test.zip')).toBe(f.original);
      expect([...f.files.keys()]).toEqual(['icons/test.zip']);
      expect(f.manager.getIconPackByName('test')).toBe(f.oldPack);
      expect(indexAndRegisterPack).not.toHaveBeenCalled();
      f.source.dispose();
    },
  );

  it('restores the old archive when the final file move fails', async () => {
    const f = fixture();
    const rename = f.adapter.rename.getMockImplementation()!;
    f.adapter.rename.mockImplementation(async (from, to) => {
      if (from.includes('.iconize-import-')) throw new Error('Move failed');
      await rename(from, to);
    });
    await expect(
      f.manager.registerIconPack('test', archive('new')),
    ).rejects.toThrow('Move failed');
    expect(f.files.get('icons/test.zip')).toBe(f.original);
    expect([...f.files.keys()]).toEqual(['icons/test.zip']);
    expect(f.manager.getIconPackByName('test')).toBe(f.oldPack);
    f.source.dispose();
  });

  it('restores the old archive and resolver registration if publishing fails', async () => {
    const f = fixture();
    vi.mocked(indexAndRegisterPack).mockRejectedValueOnce(
      new Error('Registration failed'),
    );
    await expect(
      f.manager.registerIconPack('test', archive('new')),
    ).rejects.toThrow('Registration failed');
    expect(f.files.get('icons/test.zip')).toBe(f.original);
    expect([...f.files.keys()]).toEqual(['icons/test.zip']);
    expect(f.manager.getIconPackByName('test')).toBe(f.oldPack);
    expect(indexAndRegisterPack).toHaveBeenLastCalledWith(
      expect.anything(),
      f.oldPack,
    );
    f.source.dispose();
  });
});
