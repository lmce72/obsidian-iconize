import { afterEach, describe, expect, it, vi } from 'vitest';
import type IconizePlugin from '@app/main';
import type { IconSource } from './icon-sources';
import svg from './util/svg';
import {
  IconResolver,
  type IconCacheLimits,
  type IconEntry,
} from './icon-resolver';

vi.mock('./task-scheduler', () => ({
  yieldToMain: vi.fn(() => Promise.resolve()),
}));
vi.mock('./util/svg', () => ({
  default: {
    extract: (markup: string) => markup.replace('RAW', 'NORMAL'),
    colorize: (markup: string, color: string) =>
      markup.replace(/currentColor/g, color),
  },
}));

const CACHE_PATH = '.obsidian/plugins/iconize/cache/icons.json';
const MARKUP =
  '<svg viewBox="0 0 16 16" fill="currentColor"><path d="RAW"/></svg>';
const resolvers: IconResolver[] = [];

function gate<T>() {
  let finish!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    finish = resolve;
  });
  return { promise, finish };
}

async function settle() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

function entry(name: string, prefix = 'Pa'): IconEntry {
  return {
    id: prefix + name,
    name,
    displayName: name,
    path: `${name}.svg`,
    folder: '',
  };
}

function fixture(limits: Partial<IconCacheLimits> = {}) {
  const files = new Map<string, string>();
  const directories = new Set([
    '.obsidian',
    '.obsidian/plugins',
    '.obsidian/plugins/iconize',
    '.obsidian/plugins/iconize/cache',
  ]);
  const adapter = {
    stat: vi.fn(async (path: string) =>
      files.has(path)
        ? {
            size: new TextEncoder().encode(files.get(path)!).length,
            type: 'file',
            mtime: 1,
            ctime: 1,
          }
        : null,
    ),
    read: vi.fn(async (path: string) => files.get(path)!),
    write: vi.fn(async (path: string, content: string) => {
      files.set(path, content);
    }),
    exists: vi.fn(
      async (path: string) => files.has(path) || directories.has(path),
    ),
    mkdir: vi.fn(async (path: string) => {
      directories.add(path);
    }),
    remove: vi.fn(async (path: string) => {
      files.delete(path);
    }),
  };
  const plugin = { app: { vault: { adapter } } } as unknown as IconizePlugin;
  const resolver = new IconResolver(plugin, CACHE_PATH, limits);
  resolvers.push(resolver);
  const source: IconSource = {
    type: 'zip',
    listEntries: vi.fn(async () => []),
    readEntry: vi.fn(async () => MARKUP),
    fingerprint: vi.fn(async () => ({ size: 1, count: 3, mtime: 1 })),
    dispose: vi.fn(),
  };
  return { files, adapter, resolver, source, plugin };
}

afterEach(async () => {
  await Promise.all(resolvers.splice(0).map((resolver) => resolver.dispose()));
  vi.useRealTimers();
});

describe('bounded icon resolution', () => {
  it('rejects standalone definition sheets without caching their invisible markup', async () => {
    const f = fixture();
    vi.mocked(f.source.readEntry).mockResolvedValue(
      '<svg xmlns="http://www.w3.org/2000/svg" style="display:none"><symbol id="heart"><path d="M0 0h10v10z"/></symbol></svg>',
    );
    await f.resolver.registerPack('pack', 'Pa', [entry('One')], f.source);
    expect(await f.resolver.resolve('PaOne')).toBeNull();
    expect(f.resolver.memoryCache.size).toBe(0);
    await f.resolver.flushDiskCache();
    expect(f.files.has(CACHE_PATH)).toBe(false);
  });

  it('keeps icons that render a local definition through use', async () => {
    const f = fixture();
    const markup =
      '<svg xmlns="http://www.w3.org/2000/svg"><defs><path id="heart" d="M0 0h10v10z"/></defs><use href="#heart"/></svg>';
    vi.mocked(f.source.readEntry).mockResolvedValue(markup);
    await f.resolver.registerPack('pack', 'Pa', [entry('One')], f.source);
    expect((await f.resolver.resolve('PaOne'))?.svgElement).toBe(markup);
  });
  it('recovers when cached SVG normalization throws', async () => {
    const f = fixture();
    f.files.set(
      CACHE_PATH,
      JSON.stringify({ version: 2, entries: [['PaOne', 'pack', '<svg/>']] }),
    );
    const normalize = vi.spyOn(svg, 'extract').mockImplementationOnce(() => {
      throw new Error('Invalid cached SVG');
    });
    try {
      await f.resolver.registerPack('pack', 'Pa', [entry('One')], f.source);
      expect((await f.resolver.resolve('PaOne'))?.svgElement).toContain(
        'NORMAL',
      );
      expect(f.source.readEntry).toHaveBeenCalledTimes(1);
    } finally {
      normalize.mockRestore();
    }
  });

  it('validates a requested disk SVG once and reuses it from memory', async () => {
    const f = fixture();
    f.files.set(
      CACHE_PATH,
      JSON.stringify({ version: 2, entries: [['PaOne', 'pack', MARKUP]] }),
    );
    const parse = vi.spyOn(DOMParser.prototype, 'parseFromString');
    try {
      await f.resolver.registerPack('pack', 'Pa', [entry('One')], f.source);
      expect(parse).not.toHaveBeenCalled();
      expect((await f.resolver.resolve('PaOne'))?.svgElement).toContain(
        'NORMAL',
      );
      expect(parse).toHaveBeenCalledTimes(1);
      await f.resolver.resolve('One');
      expect(parse).toHaveBeenCalledTimes(1);
      expect(f.source.readEntry).not.toHaveBeenCalled();
    } finally {
      parse.mockRestore();
    }
  });

  it.each(['not an SVG', '<path d="M0 0"/>', '<div><svg/></div>'])(
    'replaces a corrupt disk SVG (%s) from its source and persists the repair',
    async (corrupt) => {
      const f = fixture();
      f.files.set(
        CACHE_PATH,
        JSON.stringify({ version: 2, entries: [['PaOne', 'pack', corrupt]] }),
      );
      await f.resolver.registerPack('pack', 'Pa', [entry('One')], f.source);
      const icon = await f.resolver.resolve('PaOne');
      expect(icon?.svgElement).toBe(MARKUP.replace('RAW', 'NORMAL'));
      expect(f.source.readEntry).toHaveBeenCalledTimes(1);
      await f.resolver.dispose();
      expect(f.files.get(CACHE_PATH)).not.toContain(corrupt);
    },
  );

  it('removes a corrupt disk entry when its source is also invalid', async () => {
    const f = fixture();
    f.files.set(
      CACHE_PATH,
      JSON.stringify({
        version: 2,
        entries: [['PaOne', 'pack', 'corrupt cache']],
      }),
    );
    vi.mocked(f.source.readEntry).mockResolvedValue('<path/>');
    await f.resolver.registerPack('pack', 'Pa', [entry('One')], f.source);
    await expect(f.resolver.resolve('PaOne')).resolves.toBeNull();
    expect(f.resolver.peek('PaOne')).toBeUndefined();
    await f.resolver.dispose();
    expect(JSON.parse(f.files.get(CACHE_PATH)!).entries).toEqual([]);
  });

  it('bounds startup prefetch work including misses and canonical aliases', async () => {
    const f = fixture();
    await f.resolver.registerPack(
      'pack',
      'Pa',
      [entry('One'), entry('Two'), entry('Three')],
      f.source,
    );
    const result = await f.resolver.prefetch(
      ['One', 'PaOne', 'Missing', 'Two', 'Three'],
      3,
    );
    expect(result).toEqual({ loaded: 2, failed: ['Missing'], skipped: 1 });
    expect(f.source.readEntry).toHaveBeenCalledTimes(2);
    const controller = new AbortController();
    controller.abort();
    expect(
      await f.resolver.prefetch(['Three'], 128, controller.signal),
    ).toEqual({ loaded: 0, failed: [], skipped: 1 });
    expect(f.source.readEntry).toHaveBeenCalledTimes(2);
  });
  it('registers a million-entry shared lookup without enumerating or duplicating it', async () => {
    const f = fixture();
    const one = entry('One');
    const getEntry = vi.fn((query: string) =>
      ['paone', 'one'].includes(query) ? one : undefined,
    );
    await f.resolver.registerPack(
      'pack',
      'Pa',
      { length: 1_000_000, getEntry },
      f.source,
    );
    expect(getEntry).not.toHaveBeenCalled();
    expect(f.resolver.getCacheStats()).toMatchObject({
      packCount: 1,
      lookupSize: 1_000_000,
      memorySize: 0,
    });
    expect(f.resolver.find('PaOne')?.entry).toBe(one);
    expect(f.resolver.find('ONE')?.entry).toBe(one);
  });

  it('gives full ids precedence over bare aliases in other packs, regardless of registration order', async () => {
    for (const reverse of [false, true]) {
      const f = fixture();
      const registrations = [
        () => f.resolver.registerPack('short', 'Pa', [entry('One')], f.source),
        () =>
          f.resolver.registerPack(
            'alias',
            'X',
            [entry('PaOne', 'X')],
            f.source,
          ),
      ];
      if (reverse) registrations.reverse();
      for (const register of registrations) await register();
      expect(f.resolver.find('pAoNe')?.packName).toBe('short');
      expect(f.resolver.find('XPAONE')?.packName).toBe('alias');
    }
  });

  it('coalesces concurrent aliases, promotes preview requests, and isolates foreground colors', async () => {
    const f = fixture();
    const read = gate<string>();
    vi.mocked(f.source.readEntry).mockReturnValue(read.promise);
    await f.resolver.registerPack('pack', 'Pa', [entry('One')], f.source);
    const first = f.resolver.resolve('One', {
      persist: false,
      foreground: '#f00',
    });
    const second = f.resolver.resolve('pAoNe', {
      persist: true,
      foreground: '#0f0',
    });
    await settle();
    expect(f.source.readEntry).toHaveBeenCalledTimes(1);
    read.finish(MARKUP);
    const [red, green] = await Promise.all([first, second]);
    expect(red?.svgElement).toContain('#f00');
    expect(green?.svgElement).toContain('#0f0');
    expect(f.resolver.peek('ONE')?.svgElement).toContain('currentColor');
    expect(f.resolver.peek('paone')).toBe(f.resolver.peek('One'));
    expect(f.resolver.getCacheStats()).toMatchObject({
      memorySize: 1,
      previewSize: 0,
      diskSize: 1,
    });
    expect([...f.resolver.memoryCache.keys()]).toEqual(['PaOne']);
  });

  it('shares a cold disk-cache read instead of exposing an unfinished empty table', async () => {
    const f = fixture();
    const content = JSON.stringify({
      version: 2,
      entries: [
        ['PaOne', 'pack', '<svg data-cached="one"/>'],
        ['PaTwo', 'pack', '<svg data-cached="two"/>'],
      ],
    });
    f.files.set(CACHE_PATH, content);
    const read = gate<string>();
    f.adapter.read.mockReturnValue(read.promise);
    await f.resolver.registerPack(
      'pack',
      'Pa',
      [entry('One'), entry('Two')],
      f.source,
    );
    const requests = [f.resolver.resolve('PaOne'), f.resolver.resolve('PaTwo')];
    await settle();
    expect(f.adapter.read).toHaveBeenCalledTimes(1);
    expect(f.source.readEntry).not.toHaveBeenCalled();
    read.finish(content);
    const icons = await Promise.all(requests);
    expect(icons[1]?.svgElement).toContain('data-cached="two"');
    expect(f.source.readEntry).not.toHaveBeenCalled();
  });

  it('limits source reads to two concurrent jobs even for many direct callers', async () => {
    const f = fixture();
    const read = gate<string>();
    let active = 0;
    let peak = 0;
    vi.mocked(f.source.readEntry).mockImplementation(async () => {
      peak = Math.max(peak, ++active);
      const markup = await read.promise;
      active--;
      return markup;
    });
    const entries = Array.from({ length: 12 }, (_, index) =>
      entry(`Icon${index}`),
    );
    await f.resolver.registerPack('pack', 'Pa', entries, f.source);
    const requests = entries.map((icon) => f.resolver.resolve(icon.id));
    await settle();
    expect(f.source.readEntry).toHaveBeenCalledTimes(2);
    read.finish(MARKUP);
    expect((await Promise.all(requests)).every(Boolean)).toBe(true);
    expect(peak).toBe(2);
  });

  it('uses least-recently-used eviction and keeps preview and used-icon budgets independent', async () => {
    const f = fixture({ memoryEntries: 2, previewEntries: 1 });
    await f.resolver.registerPack(
      'pack',
      'Pa',
      ['One', 'Two', 'Three', 'Four'].map((name) => entry(name)),
      f.source,
    );
    await f.resolver.resolve('One');
    await f.resolver.resolve('Two');
    f.resolver.peek('One');
    await f.resolver.resolve('Three');
    expect(f.resolver.peek('Two')).toBeUndefined();
    expect(f.resolver.peek('One')).toBeDefined();
    await f.resolver.resolve('Two', { persist: false });
    await f.resolver.resolve('Four', { persist: false });
    expect(f.resolver.peek('Two')).toBeUndefined();
    expect(f.resolver.peek('Four')).toBeDefined();
    expect(f.resolver.getCacheStats()).toMatchObject({
      memorySize: 2,
      previewSize: 1,
    });
  });

  it('enforces byte budgets and returns an oversized icon without keeping it alive in caches', async () => {
    const f = fixture({ memoryBytes: 1100, previewBytes: 500, diskBytes: 900 });
    vi.mocked(f.source.readEntry).mockImplementation(
      async (path) =>
        `<svg>${'x'.repeat(path === 'Huge.svg' ? 5000 : 200)}</svg>`,
    );
    await f.resolver.registerPack(
      'pack',
      'Pa',
      ['One', 'Two', 'Huge'].map((name) => entry(name)),
      f.source,
    );
    await f.resolver.resolve('One');
    await f.resolver.resolve('Two');
    expect(f.resolver.getCacheStats()).toMatchObject({
      memorySize: 1,
      diskSize: 1,
    });
    expect(
      (await f.resolver.resolve('Huge'))?.svgElement.length,
    ).toBeGreaterThan(5000);
    expect(f.resolver.peek('Huge')).toBeUndefined();
    await f.resolver.resolve('One', { persist: false });
    const stats = f.resolver.getCacheStats();
    expect(stats.memoryBytes).toBeLessThanOrEqual(1100);
    expect(stats.previewBytes).toBeLessThanOrEqual(500);
    expect(stats.diskBytes).toBeLessThanOrEqual(900);
  });

  it('flushes compact canonical rows once on dispose and cancels the delayed write', async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.resolver.registerPack('pack', 'Pa', [entry('One')], f.source);
    const icon = await f.resolver.resolve('one');
    expect(icon?.svgContent).toBe(icon?.svgElement);
    expect(f.adapter.write).not.toHaveBeenCalled();
    const disposing = f.resolver.dispose();
    expect(f.resolver.dispose()).toBe(disposing);
    await disposing;
    await vi.runAllTimersAsync();
    expect(f.adapter.write).toHaveBeenCalledTimes(1);
    const output = f.files.get(CACHE_PATH)!;
    expect(JSON.parse(output)).toEqual({
      version: 2,
      entries: [['PaOne', 'pack', icon!.svgElement]],
    });
    expect(output).not.toContain('svgContent');
    expect(output).not.toContain('RAW');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('skips an oversized legacy cache before allocating or parsing its contents', async () => {
    const f = fixture({ diskBytes: 1000 });
    f.files.set(CACHE_PATH, 'x'.repeat(10_000));
    await f.resolver.registerPack('pack', 'Pa', [entry('One')], f.source);
    expect(await f.resolver.resolve('One')).toBeDefined();
    expect(f.adapter.read).not.toHaveBeenCalled();
    expect(f.source.readEntry).toHaveBeenCalledTimes(1);
  });

  it('invalidates a removed pack in a not-yet-loaded persisted cache', async () => {
    const f = fixture();
    f.files.set(
      CACHE_PATH,
      JSON.stringify({
        version: 2,
        entries: [
          ['PaOne', 'pack', '<svg data-old="yes"/>'],
          ['OtOne', 'other', '<svg/>'],
        ],
      }),
    );
    await f.resolver.removePackCache('pack');
    await f.resolver.registerPack('pack', 'Pa', [entry('One')], f.source);
    const icon = await f.resolver.resolve('PaOne');
    expect(icon?.svgElement).not.toContain('data-old');
    expect(f.source.readEntry).toHaveBeenCalledTimes(1);
    await f.resolver.dispose();
    expect(f.files.get(CACHE_PATH)).not.toContain('data-old');
  });

  it('reads folder SVGs from their source each session rather than trusting directory mtimes', async () => {
    const f = fixture();
    const folder = { ...f.source, type: 'folder' as const };
    f.files.set(
      CACHE_PATH,
      JSON.stringify({
        version: 2,
        entries: [['PaOne', 'pack', '<svg data-old="yes"/>']],
      }),
    );
    await f.resolver.registerPack('pack', 'Pa', [entry('One')], folder);
    expect((await f.resolver.resolve('One'))?.svgElement).not.toContain(
      'data-old',
    );
    await f.resolver.resolve('One');
    expect(f.source.readEntry).toHaveBeenCalledTimes(1);
    expect(f.adapter.read).not.toHaveBeenCalled();
    expect(f.resolver.getCacheStats().diskSize).toBe(0);
    await f.resolver.dispose();
    const second = new IconResolver(f.plugin, CACHE_PATH);
    resolvers.push(second);
    vi.mocked(folder.readEntry).mockResolvedValue('<svg data-updated="yes"/>');
    await second.registerPack('pack', 'Pa', [entry('One')], folder);
    expect((await second.resolve('One'))?.svgElement).toContain('data-updated');
  });

  it('settles pending callers on dispose and prevents late source reads from repopulating caches', async () => {
    const f = fixture();
    const read = gate<string>();
    vi.mocked(f.source.readEntry).mockReturnValue(read.promise);
    await f.resolver.registerPack(
      'pack',
      'Pa',
      ['One', 'Two', 'Three'].map((name) => entry(name)),
      f.source,
    );
    const requests = ['One', 'Two', 'Three'].map((id) =>
      f.resolver.resolve(id),
    );
    await settle();
    expect(f.source.readEntry).toHaveBeenCalledTimes(2);
    await f.resolver.dispose();
    expect(await Promise.all(requests)).toEqual([null, null, null]);
    read.finish(MARKUP);
    await settle();
    expect(f.resolver.getCacheStats()).toMatchObject({
      memorySize: 0,
      diskSize: 0,
      inFlight: 0,
      packCount: 0,
    });
    expect(f.adapter.write).not.toHaveBeenCalled();
    expect(await f.resolver.resolve('PaOne')).toBeNull();
  });
});
