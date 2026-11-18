import { beforeEach, describe, expect, it, vi } from 'vitest';
import type IconizePlugin from '@app/main';
import {
  indexAndRegisterPack,
  initializeLazyLoading,
} from './lazy-loading-integration';
import type { IconPack } from '@app/icon-pack-manager/icon-pack';
import type { IconPackIndex } from './icon-indexing';

const mocks = vi.hoisted(() => ({
  load: vi.fn(),
  dispose: vi.fn(async () => {}),
  cancel: vi.fn(),
  fingerprint: vi.fn(),
  listEntries: vi.fn(),
  sourceDispose: vi.fn(),
}));
vi.mock('obsidian', () => ({ Notice: class {} }));
vi.mock('./icon-index-store', () => ({
  IconIndexStore: class {
    load = mocks.load;
  },
}));
vi.mock('./icon-resolver', () => ({
  IconResolver: class {
    dispose = mocks.dispose;
  },
}));
vi.mock('./inline-icon-loader', () => ({ InlineIconLoader: class {} }));
vi.mock('./icon-sources', () => ({ FolderSource: class {} }));

function fixture() {
  const source = {
    type: 'zip',
    fingerprint: mocks.fingerprint,
    listEntries: mocks.listEntries,
    cancel: mocks.cancel,
    dispose: mocks.sourceDispose,
  };
  const pack = {
    getName: () => 'pack',
    getPrefix: () => 'Pa',
    getSource: () => source,
  };
  return {
    getIconPackManager: () => ({ getIconPacks: () => [pack] }),
    app: { vault: { adapter: {} } },
  } as unknown as IconizePlugin;
}
beforeEach(() => {
  vi.clearAllMocks();
  mocks.fingerprint.mockResolvedValue({ size: 1, mtime: 1, count: 0 });
});

describe('initialization cancellation', () => {
  it('does not swallow import cancellation when unloading clears the system during save', async () => {
    const controller = new AbortController();
    const source = {
      fingerprint: vi.fn(async () => ({ size: 1, count: 1, mtime: 1 })),
    };
    const pack = {
      getName: () => 'pack',
      getPrefix: () => 'Pa',
      getSource: () => source,
      loadIndex: vi.fn(async () => {}),
      getEntryLookup: () => ({ length: 1 }),
    } as unknown as IconPack;
    const clearFailedList = vi.fn();
    const plugin = {
      iconResolver: {
        removePackCache: vi.fn(async () => {}),
        registerPack: vi.fn(async () => {}),
      },
      inlineIconLoader: { clearFailedList },
      lazyLoadingSystem: {
        signal: controller.signal,
        store: {
          save: vi.fn(async () => {
            controller.abort();
            plugin.lazyLoadingSystem = undefined;
            throw new Error('Save interrupted');
          }),
        },
      },
    } as unknown as IconizePlugin;
    await expect(
      indexAndRegisterPack(plugin, pack, {
        entries: { length: 1 },
      } as IconPackIndex),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(clearFailedList).not.toHaveBeenCalled();
  });
  it('does not start filesystem work for an already-disabled plugin', async () => {
    const controller = new AbortController();
    controller.abort();
    expect(
      await initializeLazyLoading(fixture(), [], controller.signal),
    ).toBeNull();
    expect(mocks.load).not.toHaveBeenCalled();
    expect(mocks.fingerprint).not.toHaveBeenCalled();
  });
  it('disposes an unpublished resolver and source and stops before a cold rebuild', async () => {
    let finish!: (value: null) => void;
    mocks.load.mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const controller = new AbortController();
    const pending = initializeLazyLoading(fixture(), [], controller.signal);
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(mocks.load).toHaveBeenCalledOnce();
    controller.abort();
    finish(null);
    expect(await pending).toBeNull();
    expect(mocks.dispose).toHaveBeenCalled();
    expect(mocks.cancel).toHaveBeenCalledOnce();
    expect(mocks.listEntries).not.toHaveBeenCalled();
    expect(mocks.sourceDispose).toHaveBeenCalled();
  });
});
