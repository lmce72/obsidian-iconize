import { afterEach, describe, expect, it, vi } from 'vitest';
import { CompactIconIndex } from './compact-icon-index';
import type { IconEntry } from './icon-indexing';
import { yieldToMain } from './task-scheduler';

vi.mock('./task-scheduler', () => ({
  yieldToMain: vi.fn(async () => {}),
  throwIfAborted(signal?: AbortSignal) {
    if (signal?.aborted) {
      const error = new Error('Aborted');
      error.name = 'AbortError';
      throw error;
    }
  },
}));

function entry(name: string, path = `${name}.svg`): IconEntry {
  return {
    id: `Sy${name}`,
    name,
    path,
    displayName: path
      .substring(path.lastIndexOf('/') + 1)
      .replace(/\.svg$/i, ''),
    folder: path.substring(0, Math.max(0, path.lastIndexOf('/'))),
  };
}

async function matches(
  index: CompactIconIndex,
  query: string,
  pack = 'synthetic',
): Promise<string[]> {
  const found: string[] = [];
  await index.forEachMatch(
    query.toLowerCase().split(/\s+/).filter(Boolean),
    pack,
    (item) => {
      found.push(item.id);
      return true;
    },
    () => false,
  );
  return found;
}

afterEach(() => vi.restoreAllMocks());

describe('CompactIconIndex', () => {
  it('preserves fields and case-insensitive full ID precedence over bare aliases', async () => {
    const entries = [
      entry('Heart', 'icons/图标/heart-outline.svg'),
      entry('SyHeart'),
      {
        ...entry('Other'),
        id: 'LegacyOther',
        displayName: 'old label',
        folder: 'retained',
      },
    ];
    const index = await CompactIconIndex.fromEntries(entries);
    expect([...index]).toEqual(entries);
    expect(index.getEntry('syHEART')).toEqual(entries[0]);
    expect(index.getEntry('HEART')).toEqual(entries[0]);
    expect(index.getEntry('sySYheart')).toEqual(entries[1]);
    expect(index.getEntry('legacyother')).toEqual(entries[2]);
    expect(index.getEntry('missing')).toBeUndefined();
    expect(index.entryAt(-1)).toBeUndefined();
    expect(index.entryAt(index.length)).toBeUndefined();
  });

  it('retains the common-root-relative folder without per-entry overrides', async () => {
    const entries = [
      { ...entry('One', 'icons/v2/one.svg'), folder: '' },
      { ...entry('Two', 'icons/v2/design/two.svg'), folder: 'design' },
    ];
    const index = await CompactIconIndex.fromEntries(entries);
    expect([...index]).toEqual(entries);
    expect(index.getStorageStats().overrideEntries).toBe(0);
  });

  it('searches IDs, original filenames and pack names, with every word confined to one row', async () => {
    const index = await CompactIconIndex.fromEntries([
      entry('ArrowCircle', 'arrow-circle.svg'),
      entry('Blue'),
      entry('Circle'),
    ]);
    expect(await matches(index, 'syarrow')).toEqual(['SyArrowCircle']);
    expect(await matches(index, 'arrow-circle')).toEqual(['SyArrowCircle']);
    expect(await matches(index, 'synthetic circle')).toEqual([
      'SyArrowCircle',
      'SyCircle',
    ]);
    expect(await matches(index, 'blue circle')).toEqual([]);
    expect(await matches(index, 'synthetic')).toEqual([
      'SyArrowCircle',
      'SyBlue',
      'SyCircle',
    ]);
  });

  it('preserves row order across chunks and incremental finishes', async () => {
    const index = new CompactIconIndex('Sy', 2048);
    for (let row = 0; row < 1025; row++) index.append(entry(`Item${row}`));
    await index.finish();
    index.append(entry('Last'));
    await index.finish();
    expect(index.getEntry('sylast')?.name).toBe('Last');
    expect(index.entryAt(1024)?.name).toBe('Item1024');
    expect(index.entryAt(1025)?.name).toBe('Last');
    const last: string[] = [];
    await index.forEachMatch(
      ['item102'],
      '',
      (item) => {
        last.push(item.name);
        return last.length < 3;
      },
      () => false,
    );
    expect(last).toEqual(['Item102', 'Item1020', 'Item1021']);
    expect([...index].at(-1)?.name).toBe('Last');
  });

  it('does not retain source objects and keeps lookup/offset storage bounded', async () => {
    function* entries(): Generator<IconEntry> {
      for (let row = 0; row < 10000; row++) yield entry(`Item${row}`);
    }
    const index = await CompactIconIndex.fromEntries(entries());
    const stats = index.getStorageStats();
    expect(stats.entries).toBe(10000);
    expect(stats.overrideEntries).toBe(0);
    expect(stats.numericBytes).toBeLessThan(24 * index.length);
    for (const row of [0, 1, 1023, 1024, 9987, 9999]) {
      expect(index.getEntry(`syitem${row}`)?.path).toBe(`Item${row}.svg`);
    }
    const onlyHit = vi.spyOn(index, 'entryAt');
    expect(index.getEntry('does-not-exist')).toBeUndefined();
    expect(onlyHit).not.toHaveBeenCalled();
    expect(index.getEntry('syitem9987')?.name).toBe('Item9987');
    expect(onlyHit).toHaveBeenCalledTimes(1);
  });

  it('cooperatively constructs the table and allows stale searches to stop between chunks', async () => {
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => (clock += 5));
    const index = await CompactIconIndex.fromEntries(
      Array.from({ length: 4096 }, (_, row) => entry(`Item${row}`)),
    );
    expect(yieldToMain).toHaveBeenCalledWith('background');
    vi.mocked(yieldToMain).mockClear();
    let cancelled = false;
    vi.mocked(yieldToMain).mockImplementation(async () => {
      cancelled = true;
    });
    const visited = vi.fn(() => true);
    await index.forEachMatch(['not-present'], '', visited, () => cancelled);
    expect(yieldToMain).toHaveBeenCalledWith('user-visible');
    expect(visited).not.toHaveBeenCalled();
    expect(cancelled).toBe(true);
    vi.mocked(yieldToMain).mockImplementation(async () => {});
  });

  it('aborts an unfinished lookup table immediately after yielding', async () => {
    let clock = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => (clock += 5));
    const controller = new AbortController();
    const index = new CompactIconIndex('Sy', 2048, controller.signal);
    for (let row = 0; row < 2048; row++) index.append(entry(`Item${row}`));
    vi.mocked(yieldToMain).mockImplementation(async () => controller.abort());
    await expect(index.finish()).rejects.toMatchObject({ name: 'AbortError' });
    expect(() => index.append(entry('AfterUnload'))).toThrow('Aborted');
    await expect(index.finish()).rejects.toMatchObject({ name: 'AbortError' });
    await expect(
      CompactIconIndex.fromEntries([entry('One')], controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });
    vi.mocked(yieldToMain).mockImplementation(async () => {});
  });
});
