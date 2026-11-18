import { describe, expect, it, vi } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import type { DataAdapter } from 'obsidian';
import { FileSystemAdapter, Platform } from 'obsidian';
import { FolderSource, ZipSource } from './icon-sources';
import * as rangeReader from './zip-range-reader';
import { logger } from './logger';

vi.mock('obsidian', () => ({
  Platform: { isDesktop: false },
  FileSystemAdapter: class {},
}));

function archive(value = '<svg/>'): ArrayBuffer {
  return zipSync({ 'icons/heart.svg': strToU8(value) }).slice()
    .buffer as ArrayBuffer;
}

describe('ZIP source lifecycle', () => {
  it('omits paired distribution symbol sheets while retaining both SVG canvas variants', async () => {
    const paths = [
      'release/sprites/brands.svg',
      'release/sprites-full/brands.svg',
      'release/svgs/brands/github.svg',
      'release/svgs-full/brands/github.svg',
      'custom/sprites/unpaired.svg',
      'custom/sprite.svg',
    ];
    const bytes = zipSync(
      Object.fromEntries(paths.map((path) => [path, strToU8('<svg/>')])),
    ).slice().buffer as ArrayBuffer;
    const source = new ZipSource(
      { readBinary: async () => bytes } as unknown as DataAdapter,
      'renamed.zip',
    );
    try {
      expect((await source.listEntries()).map((entry) => entry.path)).toEqual(
        paths.slice(2),
      );
    } finally {
      source.dispose();
    }
  });
  it('returns null and reports the original error for a corrupt ZIP icon', async () => {
    const bytes = new Uint8Array(archive('<svg>hello world</svg>'));
    const view = new DataView(bytes.buffer);
    const central = view.getUint32(bytes.length - 22 + 16, true);
    view.setUint32(central + 24, 5, true);
    const errorLog = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const source = new ZipSource(
      { readBinary: async () => bytes.buffer } as unknown as DataAdapter,
      'corrupt.zip',
    );
    try {
      expect(await source.readEntry('icons/heart.svg')).toBeNull();
      expect(errorLog).toHaveBeenCalledWith(
        expect.stringContaining('Could not read'),
        undefined,
        expect.objectContaining({ message: 'Invalid ZIP icon checksum' }),
      );
    } finally {
      source.dispose();
      errorLog.mockRestore();
    }
  });

  it('lists and reads ZIP icons through the adapter when desktop modules are unavailable', async () => {
    const createReader = rangeReader.createDesktopZipReader;
    const unavailable = vi.fn(() => {
      throw new Error("Cannot find module 'fs'");
    });
    const spy = vi
      .spyOn(rangeReader, 'createDesktopZipReader')
      .mockImplementation((adapter, path) =>
        createReader(adapter, path, unavailable as unknown as NodeJS.Require),
      );
    Platform.isDesktop = true;
    const readBinary = vi.fn(async () => archive());
    const adapter = Object.assign(new FileSystemAdapter(), { readBinary });
    const source = new ZipSource(adapter, 'fallback.zip');
    try {
      expect(await source.listEntries()).toEqual([{ path: 'icons/heart.svg' }]);
      expect(await source.readEntry('icons/heart.svg')).toBe('<svg/>');
      expect(unavailable).toHaveBeenCalledWith('fs');
      expect(readBinary).toHaveBeenCalledTimes(1);
    } finally {
      source.dispose();
      Platform.isDesktop = false;
      spy.mockRestore();
    }
  });

  it('reuses a recently read archive and releases it after idle time', async () => {
    vi.useFakeTimers();
    const readBinary = vi.fn(async () => archive());
    const source = new ZipSource(
      { readBinary } as unknown as DataAdapter,
      'idle.zip',
    );
    try {
      await source.readEntry('icons/heart.svg');
      await source.readEntry('icons/heart.svg');
      expect(readBinary).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(16000);
      await source.readEntry('icons/heart.svg');
      expect(readBinary).toHaveBeenCalledTimes(2);
    } finally {
      source.dispose();
      vi.useRealTimers();
    }
  });

  it('cancels a source without letting an unfinished open enter the cache', async () => {
    let finish!: (value: ArrayBuffer) => void;
    const source = new ZipSource(
      {
        readBinary: () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      } as unknown as DataAdapter,
      'cancel.zip',
    );
    const pending = source.readEntry('icons/heart.svg');
    for (let i = 0; i < 5; i++) await Promise.resolve();
    source.cancel();
    finish(archive());
    expect(await pending).toBeNull();
    expect(await source.readEntry('icons/heart.svg')).toBeNull();
  });
  it('shares one open across simultaneous listing and icon reads', async () => {
    const readBinary = vi.fn(async () => archive());
    const source = new ZipSource(
      { readBinary } as unknown as DataAdapter,
      'icons.zip',
    );
    const [entries, icon, repeated] = await Promise.all([
      source.listEntries(),
      source.readEntry('icons/heart.svg'),
      source.readEntry('icons/heart.svg'),
    ]);
    expect(entries).toEqual([{ path: 'icons/heart.svg' }]);
    expect(icon).toBe('<svg/>');
    expect(repeated).toBe('<svg/>');
    expect(readBinary).toHaveBeenCalledTimes(1);
    await source.readEntry('icons/heart.svg');
    expect(readBinary).toHaveBeenCalledTimes(1);
    source.dispose();
    await source.readEntry('icons/heart.svg');
    expect(readBinary).toHaveBeenCalledTimes(2);
    source.dispose();
  });

  it('does not let an old open repopulate or clear a newer generation', async () => {
    let resolveOld: (value: ArrayBuffer) => void;
    const old = new Promise<ArrayBuffer>((resolve) => {
      resolveOld = resolve;
    });
    const readBinary = vi
      .fn()
      .mockReturnValueOnce(old)
      .mockResolvedValue(archive('<svg>new</svg>'));
    const source = new ZipSource(
      { readBinary } as unknown as DataAdapter,
      'icons.zip',
    );
    const previous = source.readEntry('icons/heart.svg');
    await Promise.resolve();
    source.dispose();
    const current = source.readEntry('icons/heart.svg');
    resolveOld(archive('<svg>old</svg>'));
    expect(await previous).toBe('<svg>old</svg>');
    expect(await current).toBe('<svg>new</svg>');
    expect(await source.readEntry('icons/heart.svg')).toBe('<svg>new</svg>');
    expect(readBinary).toHaveBeenCalledTimes(2);
    source.dispose();
  });

  it('retains exact path preference over a relaxed version match', async () => {
    const bytes = zipSync({
      'old/svgs/solid/old.svg': strToU8('<svg/>'),
      'new/svgs/solid/new.svg': strToU8('<svg/>'),
    }).slice().buffer as ArrayBuffer;
    const source = new ZipSource(
      { readBinary: async () => bytes } as unknown as DataAdapter,
      'icons.zip',
      'new/svgs/solid/',
    );
    expect(await source.listEntries()).toEqual([
      { path: 'new/svgs/solid/new.svg' },
    ]);
    source.dispose();
  });
});

describe('folder indexing snapshot', () => {
  it('reuses one scan for fingerprint, listing, and final fingerprint', async () => {
    const adapter = {
      exists: vi.fn(),
      list: vi.fn(async (path: string) =>
        path === 'icons'
          ? {
              files: ['icons/one.svg', 'icons/readme.txt'],
              folders: ['icons/sub'],
            }
          : { files: ['icons/sub/two.svg'], folders: [] },
      ),
      stat: vi.fn(async () => ({ mtime: 1 })),
      read: vi.fn(async () => '<svg/>'),
    };
    const source = new FolderSource(adapter as unknown as DataAdapter, 'icons');
    expect((await source.fingerprint()).count).toBe(2);
    expect(await source.listEntries()).toHaveLength(2);
    expect((await source.fingerprint()).count).toBe(2);
    expect(adapter.list).toHaveBeenCalledTimes(2);
    expect(adapter.exists).not.toHaveBeenCalled();
    expect(await source.readEntry('icons/one.svg')).toBe('<svg/>');
    expect(adapter.exists).not.toHaveBeenCalled();
    source.dispose();
    await source.fingerprint();
    expect(adapter.list).toHaveBeenCalledTimes(4);
  });
});
