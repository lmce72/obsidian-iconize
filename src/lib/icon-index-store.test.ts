import { describe, expect, it, vi } from 'vitest';
import type { DataAdapter } from 'obsidian';
import { IconIndexStore } from './icon-index-store';
import {
  ICON_PACK_INDEX_VERSION,
  IconPackIndex,
  resolveEntryIds,
  resolveEntryIdsCompact,
} from './icon-indexing';

const fingerprint = { size: 123, mtime: 456, count: 0 };
function fixture() {
  const files = new Map<string, string>();
  const directories = new Set(['index']);
  const read = vi.fn(async (path: string) => {
    const raw = files.get(path);
    if (raw === undefined) throw Error('Missing page');
    return raw;
  });
  const write = vi.fn(async (path: string, value: string) => {
    files.set(path, value);
  });
  const adapter = {
    stat: async (path: string) =>
      files.has(path)
        ? { size: files.get(path)!.length, mtime: 1, ctime: 1, type: 'file' }
        : null,
    exists: async (path: string) => files.has(path) || directories.has(path),
    mkdir: async (path: string) => {
      directories.add(path);
    },
    read,
    write,
    remove: async (path: string) => {
      files.delete(path);
    },
    list: async (path: string) => ({
      files: Array.from(files.keys()).filter(
        (file) =>
          file.startsWith(path + '/') &&
          !file.slice(path.length + 1).includes('/'),
      ),
      folders: Array.from(directories).filter(
        (folder) =>
          folder.startsWith(path + '/') &&
          !folder.slice(path.length + 1).includes('/'),
      ),
    }),
    rmdir: async (path: string) => {
      directories.delete(path);
      for (const file of files.keys())
        if (file.startsWith(path + '/')) files.delete(file);
    },
  } as unknown as DataAdapter;
  return {
    files,
    read,
    write,
    adapter,
    store: new IconIndexStore(adapter, 'index'),
  };
}
function index(count = 9000): IconPackIndex {
  return {
    version: ICON_PACK_INDEX_VERSION,
    packName: 'test',
    prefix: 'Te',
    sourceType: 'zip',
    fingerprint,
    builtAt: 1,
    entries: Array.from({ length: count }, (_, row) => ({
      id: `TeIcon${row}`,
      name: `Icon${row}`,
      path: `root/icon-${row}.svg`,
      displayName: `icon-${row}`,
      folder: 'root',
    })),
  };
}

describe('paged compact icon index storage', () => {
  it('roundtrips pages without monolithic JSON or expanded resident objects', async () => {
    const f = fixture();
    await f.store.save('test', index());
    expect(f.files.has('index/test.json')).toBe(false);
    expect(
      Array.from(f.files.keys()).filter(
        (path) => path.includes('.pages/') && !path.endsWith('/manifest.json'),
      ),
    ).toHaveLength(3);
    const loaded = await f.store.load('test', fingerprint);
    expect(loaded?.entries.length).toBe(9000);
    expect(Array.isArray(loaded?.entries)).toBe(false);
    expect(Array.from(loaded!.entries).at(-1)?.id).toBe('TeIcon8999');
    expect(await f.store.listIndexedPacks()).toEqual(['test']);
  });

  it('checks staleness before reading any pages', async () => {
    const f = fixture();
    await f.store.save('test', index(10));
    f.read.mockClear();
    expect(
      await f.store.load('test', { ...fingerprint, size: 999 }),
    ).toBeNull();
    expect(f.read.mock.calls.map((call) => call[0])).toEqual([
      'index/test.pages/manifest.json',
    ]);
  });

  it('migrates old pair indexes once and keeps deterministic identifiers', async () => {
    const f = fixture();
    f.files.set(
      'index/test.json',
      JSON.stringify({ ...index(1), entries: [['Heart', 'a/heart.svg']] }),
    );
    const loaded = await f.store.load('test', fingerprint);
    expect(Array.from(loaded!.entries)[0]).toMatchObject({
      id: 'TeHeart',
      path: 'a/heart.svg',
    });
    expect(f.files.has('index/test.pages/manifest.json')).toBe(true);
    expect(f.files.has('index/test.json')).toBe(false);
  });

  it('keeps the committed generation when a replacement page write fails', async () => {
    const f = fixture();
    await f.store.save('test', index(1));
    const committed = f.files.get('index/test.pages/manifest.json');
    f.write.mockRejectedValueOnce(Error('Disk unavailable'));
    await expect(f.store.save('test', index(2))).rejects.toThrow(
      'Disk unavailable',
    );
    expect(f.files.get('index/test.pages/manifest.json')).toBe(committed);
    expect((await f.store.load('test', fingerprint))?.entries.length).toBe(1);
  });

  it('rejects oversized pages before parsing them', async () => {
    const f = fixture();
    await f.store.save('test', index(1));
    const page = Array.from(f.files.keys()).find(
      (path) => path.includes('.pages/') && !path.endsWith('/manifest.json'),
    )!;
    f.files.set(page, ' '.repeat(2 * 1024 * 1024 + 1));
    expect(await f.store.load('test', fingerprint)).toBeNull();
  });

  it.each(['manifest', 'page'])(
    'skips an oversized %s before reading its contents',
    async (kind) => {
      const f = fixture();
      await f.store.save('test', index(1));
      const target = Array.from(f.files.keys()).find((path) =>
        kind === 'manifest'
          ? path.endsWith('/manifest.json')
          : !path.endsWith('/manifest.json'),
      )!;
      const maxCharacters = kind === 'manifest' ? 64 * 1024 : 2 * 1024 * 1024;
      f.files.set(target, ' '.repeat(maxCharacters * 3 + 1));
      f.read.mockClear();
      expect(await f.store.load('test', fingerprint)).toBeNull();
      expect(f.read.mock.calls.some(([path]) => path === target)).toBe(false);
    },
  );

  it.each(['missing', 'malformed', 'invalid row'])(
    'returns null for a %s page and accepts a rebuilt index',
    async (failure) => {
      const f = fixture();
      await f.store.save('test', index(1));
      const page = Array.from(f.files.keys()).find(
        (path) => !path.endsWith('/manifest.json'),
      )!;
      if (failure === 'missing') f.files.delete(page);
      else
        f.files.set(
          page,
          failure === 'malformed' ? '{' : '[[42,"broken.svg"]]',
        );
      expect(await f.store.load('test', fingerprint)).toBeNull();
      await f.store.save('test', index(2));
      expect((await f.store.load('test', fingerprint))?.entries.length).toBe(2);
    },
  );

  it('allows UTF-8 pages whose byte size exceeds their character count', async () => {
    const f = fixture();
    const original = index(1);
    original.entries[0].path = '图'.repeat(20000) + '/heart.svg';
    await f.store.save('test', original);
    const stat = f.adapter.stat.bind(f.adapter);
    f.adapter.stat = async (path) => {
      const result = await stat(path);
      return (
        result && {
          ...result,
          size: new TextEncoder().encode(f.files.get(path)!).length,
        }
      );
    };
    expect(
      Array.from((await f.store.load('test', fingerprint))!.entries)[0].path,
    ).toBe(original.entries[0].path);
  });

  it('skips giant legacy JSON before reading it and retains it for a safe rebuild', async () => {
    const f = fixture();
    f.files.set('index/test.json', 'x'.repeat(8 * 1024 * 1024 + 1));
    expect(await f.store.load('test', fingerprint)).toBeNull();
    expect(f.read).not.toHaveBeenCalled();
    expect(f.files.has('index/test.json')).toBe(true);
  });

  it('keeps a committed index when initialization is aborted between pages', async () => {
    const f = fixture();
    await f.store.save('test', index(1));
    const committed = f.files.get('index/test.pages/manifest.json');
    const controller = new AbortController();
    const store = new IconIndexStore(f.adapter, 'index', controller.signal);
    const previous = f.write.getMockImplementation()!;
    f.write.mockImplementation(async (path, value) => {
      await previous(path, value);
      controller.abort();
    });
    await expect(store.save('test', index(5000))).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(f.files.get('index/test.pages/manifest.json')).toBe(committed);
    expect((await f.store.load('test', fingerprint))?.entries.length).toBe(1);
  });
});

describe('cooperative cold index naming', () => {
  it('stops a cancelled cold build instead of continuing to name the remaining rows', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      resolveEntryIdsCompact('Te', [{ path: 'a.svg' }], controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
  it('matches historical identifiers for duplicate, Unicode, normalized and invalid paths', async () => {
    const paths = [
      'root/a/heart.svg',
      'root/b/heart.svg',
      'root/a/heart-2.svg',
      'root/a/heart_2.svg',
      'root/123.svg',
      'root/中文.svg',
      'root/lone.svg',
      'root/A/HEART.svg',
      'root/a"b.svg',
      'root/a/card.svg',
      'root/b/Card.svg',
    ];
    const raws = paths.map((path) => ({ path }));
    const compact = await resolveEntryIdsCompact('Te', raws);
    expect(Array.from(compact)).toEqual(resolveEntryIds('Te', raws));
  });

  it('keeps stable ordering across merge runs and yields during large cold builds', async () => {
    const raws = Array.from({ length: 6000 }, (_, row) => ({
      path: `root/${row % 2 ? 'a' : 'b'}/icon-${6000 - row}.svg`,
    }));
    let heartbeat = false;
    const timer = window.setTimeout(() => {
      heartbeat = true;
    }, 0);
    expect(Array.from(await resolveEntryIdsCompact('Te', raws))).toEqual(
      resolveEntryIds('Te', raws),
    );
    expect(heartbeat).toBe(true);
    window.clearTimeout(timer);
  });
});
