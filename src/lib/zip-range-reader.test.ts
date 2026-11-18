import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { strToU8, zipSync } from 'fflate';
import { FileSystemAdapter, Platform } from 'obsidian';
import type { DataAdapter } from 'obsidian';
import { createDesktopZipReader } from './zip-range-reader';
import { ZipDirectory } from './zip-directory';

vi.mock('obsidian', () => ({
  Platform: { isDesktop: true },
  FileSystemAdapter: class {
    getBasePath(): string {
      return '';
    }
  },
}));

const temporary: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  Platform.isDesktop = true;
  await Promise.all(
    temporary
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'iconize-range-'));
  temporary.push(root);
  const vault = join(root, 'vault');
  await mkdir(vault);
  const adapter = new FileSystemAdapter();
  vi.spyOn(adapter, 'getBasePath').mockReturnValue(vault);
  return { root, vault, adapter, loader: createRequire(import.meta.url) };
}

describe('desktop ZIP range reader', () => {
  it('opens a real vault file by range and detects replacement', async () => {
    const { vault, adapter, loader } = await fixture();
    const zip = zipSync({ 'heart.svg': strToU8('<svg/>') });
    const filename = join(vault, 'icons.zip');
    await writeFile(filename, zip);
    const reader = await createDesktopZipReader(adapter, 'icons.zip', loader);
    expect(reader?.residentBytes).toBe(0);
    expect(
      await (await ZipDirectory.openReader(reader)).read('heart.svg'),
    ).toBe('<svg/>');
    await writeFile(filename, new Uint8Array(zip.length + 1));
    await expect(reader.read(0, 4)).rejects.toThrow('changed');
    // A subsequent rename/write/removal succeeds because every read closes its handle.
    await rm(filename);
  });

  it('rejects traversal and symlink escapes before reading outside the vault', async () => {
    const { root, vault, adapter, loader } = await fixture();
    const outside = join(root, 'outside.zip');
    await writeFile(outside, new Uint8Array(22));
    await symlink(outside, join(vault, 'escape.zip'));
    await expect(
      createDesktopZipReader(adapter, '../outside.zip', loader),
    ).rejects.toThrow('inside the vault');
    await expect(
      createDesktopZipReader(adapter, 'escape.zip', loader),
    ).rejects.toThrow('inside the vault');
  });

  it('never loads desktop modules for mobile or other adapter types', async () => {
    const { adapter } = await fixture();
    const loader = vi.fn(() => {
      throw new Error('Node must not be loaded');
    });
    Platform.isDesktop = false;
    expect(
      await createDesktopZipReader(
        adapter,
        'icons.zip',
        loader as unknown as NodeJS.Require,
      ),
    ).toBeNull();
    Platform.isDesktop = true;
    expect(
      await createDesktopZipReader(
        {} as DataAdapter,
        'icons.zip',
        loader as unknown as NodeJS.Require,
      ),
    ).toBeNull();
    expect(loader).not.toHaveBeenCalled();
  });

  it('uses the adapter fallback if the host does not provide require', async () => {
    const { adapter } = await fixture();
    expect(await createDesktopZipReader(adapter, 'icons.zip', null)).toBeNull();
  });

  it.each(['fs', 'path'])(
    'uses the adapter fallback when %s cannot be loaded',
    async (missing) => {
      const { adapter, loader } = await fixture();
      const unavailable = vi.fn((name: string) => {
        if (name === missing)
          throw new Error(`Cannot find module '${missing}'`);
        return loader(name);
      });
      expect(
        await createDesktopZipReader(
          adapter,
          'icons.zip',
          unavailable as unknown as NodeJS.Require,
        ),
      ).toBeNull();
      expect(unavailable).toHaveBeenCalledWith(missing);
    },
  );

  it.each([
    ['fs', undefined],
    ['fs', {}],
    ['fs', { promises: {} }],
    ['path', null],
    ['path', {}],
  ])(
    'uses the adapter fallback for an incomplete %s module (%j)',
    async (name, value) => {
      const { adapter, loader } = await fixture();
      const incomplete = (module: string) =>
        module === name ? value : loader(module);
      expect(
        await createDesktopZipReader(
          adapter,
          'icons.zip',
          incomplete as NodeJS.Require,
        ),
      ).toBeNull();
    },
  );

  it('preserves actual filesystem failures instead of taking the adapter fallback', async () => {
    const { adapter, loader } = await fixture();
    await expect(
      createDesktopZipReader(adapter, 'missing.zip', loader),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    const denied = Object.assign(new Error('Permission denied'), {
      code: 'EACCES',
    });
    const unavailable = (module: string) =>
      module === 'fs'
        ? {
            promises: {
              ...loader('fs').promises,
              realpath: async () => {
                throw denied;
              },
            },
          }
        : loader(module);
    await expect(
      createDesktopZipReader(
        adapter,
        'icons.zip',
        unavailable as NodeJS.Require,
      ),
    ).rejects.toBe(denied);
  });
});
