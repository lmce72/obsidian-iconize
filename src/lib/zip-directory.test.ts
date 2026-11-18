import { describe, expect, it } from 'vitest';
import { strToU8, zipSync } from 'fflate';
import { ZipDirectory } from './zip-directory';

describe('indexed ZIP reading', () => {
  it.each([0, 6] as const)(
    'reads just the selected UTF-8 entry at compression level %s',
    async (level) => {
      const zip = zipSync(
        {
          'icons/heart.svg': strToU8('<svg>♥</svg>'),
          '图标/星.svg': strToU8('<svg>★</svg>'),
        },
        { level },
      );
      const directory = await ZipDirectory.open(zip);
      expect(directory.entryCount).toBe(2);
      expect(await directory.listNames()).toEqual([
        'icons/heart.svg',
        '图标/星.svg',
      ]);
      expect(await directory.read('icons/heart.svg')).toBe('<svg>♥</svg>');
      expect(await directory.read('图标/星.svg')).toBe('<svg>★</svg>');
      expect(await directory.read('missing.svg')).toBeNull();
    },
  );

  it('rejects broken archives and truncated central entries', async () => {
    await expect(ZipDirectory.open(new Uint8Array(10))).rejects.toThrow();
    const zip = zipSync({ 'heart.svg': strToU8('<svg/>') });
    const view = new DataView(zip.buffer);
    const end = zip.length - 22;
    const central = view.getUint32(end + 16, true);
    view.setUint16(central + 28, 65535, true);
    await expect(ZipDirectory.open(zip)).rejects.toThrow('Truncated');
  });

  it('rejects a deflate entry whose declared output size silently truncates its bytes', async () => {
    const zip = zipSync({ 'heart.svg': strToU8('<svg>hello world</svg>') });
    const view = new DataView(zip.buffer);
    const central = view.getUint32(zip.length - 22 + 16, true);
    view.setUint32(central + 24, 5, true);
    await expect(
      (await ZipDirectory.open(zip)).read('heart.svg'),
    ).rejects.toThrow('checksum');
  });

  it.each([0, 6] as const)(
    'rejects a checksum mismatch at compression level %s',
    async (level) => {
      const zip = zipSync({ 'heart.svg': strToU8('<svg/>') }, { level });
      const view = new DataView(zip.buffer);
      const central = view.getUint32(zip.length - 22 + 16, true);
      view.setUint32(
        central + 16,
        view.getUint32(central + 16, true) ^ 1,
        true,
      );
      await expect(
        (await ZipDirectory.open(zip)).read('heart.svg'),
      ).rejects.toThrow('checksum');
    },
  );

  it('supports ZIP64 directory records for large icon collections', async () => {
    const original = zipSync({ 'heart.svg': strToU8('<svg/>') });
    const end = original.length - 22;
    const originalView = new DataView(original.buffer);
    const bytes = new Uint8Array(original.length + 76);
    bytes.set(original.subarray(0, end));
    const view = new DataView(bytes.buffer);
    view.setUint32(end, 0x06064b50, true);
    view.setUint32(end + 4, 44, true);
    view.setUint32(end + 24, 1, true);
    view.setUint32(end + 32, 1, true);
    view.setUint32(end + 40, originalView.getUint32(end + 12, true), true);
    view.setUint32(end + 48, originalView.getUint32(end + 16, true), true);
    view.setUint32(end + 56, 0x07064b50, true);
    view.setUint32(end + 64, end, true);
    view.setUint32(end + 72, 1, true);
    bytes.set(original.subarray(end), end + 76);
    view.setUint16(end + 76 + 10, 65535, true);
    view.setUint32(end + 76 + 16, 0xffffffff, true);
    expect(await (await ZipDirectory.open(bytes)).read('heart.svg')).toBe(
      '<svg/>',
    );
  });

  it('reads ZIP64 per-entry offsets and sizes from extra fields', async () => {
    const original = zipSync({ 'heart.svg': strToU8('<svg/>') });
    const source = new DataView(original.buffer);
    const end = original.length - 22;
    const central = source.getUint32(end + 16, true);
    const extra = central + 46 + source.getUint16(central + 28, true);
    const bytes = new Uint8Array(original.length + 28);
    bytes.set(original.subarray(0, extra));
    bytes.set(original.subarray(extra), extra + 28);
    const view = new DataView(bytes.buffer);
    view.setUint16(extra, 1, true);
    view.setUint16(extra + 2, 24, true);
    view.setUint32(extra + 4, source.getUint32(central + 24, true), true);
    view.setUint32(extra + 12, source.getUint32(central + 20, true), true);
    view.setUint32(extra + 20, source.getUint32(central + 42, true), true);
    view.setUint16(
      central + 30,
      source.getUint16(central + 30, true) + 28,
      true,
    );
    for (const offset of [20, 24, 42])
      view.setUint32(central + offset, 0xffffffff, true);
    view.setUint32(end + 28 + 12, source.getUint32(end + 12, true) + 28, true);
    expect(await (await ZipDirectory.open(bytes)).read('heart.svg')).toBe(
      '<svg/>',
    );
  });

  it('rejects oversized or encrypted entries before allocating their output', async () => {
    const zip = zipSync({ 'heart.svg': strToU8('<svg/>') });
    const view = new DataView(zip.buffer);
    const central = view.getUint32(zip.length - 22 + 16, true);
    view.setUint32(central + 24, 8 * 1024 * 1024 + 1, true);
    await expect(
      (await ZipDirectory.open(zip)).read('heart.svg'),
    ).rejects.toThrow('8 MB');
    view.setUint32(central + 24, 6, true);
    view.setUint16(central + 8, 1, true);
    await expect(
      (await ZipDirectory.open(zip)).read('heart.svg'),
    ).rejects.toThrow('Encrypted');
  });

  it('verifies full names when 32-bit path hashes collide', async () => {
    const names = ['icons/ttlngfdixb.svg', 'icons/kmupjcrfbj.svg'];
    const zip = zipSync({
      [names[0]]: strToU8('<svg>first</svg>'),
      [names[1]]: strToU8('<svg>second</svg>'),
    });
    const directory = await ZipDirectory.open(zip);
    expect(await directory.read(names[0])).toBe('<svg>first</svg>');
    expect(await directory.read(names[1])).toBe('<svg>second</svg>');
  });

  it('indexes ranges without retaining or reading the whole archive', async () => {
    const files: Record<string, Uint8Array> = {};
    for (let i = 0; i < 20; i++)
      files[`icons/${i}.svg`] = strToU8(`<svg>${'x'.repeat(24000)}</svg>`);
    const zip = zipSync(files, { level: 0 });
    const ranges: { offset: number; length: number }[] = [];
    const directory = await ZipDirectory.openReader({
      size: zip.length,
      read: async (offset, length) => {
        ranges.push({ offset, length });
        return zip.slice(offset, offset + length);
      },
    });
    expect(directory.entryCount).toBe(20);
    expect(directory.residentBytes).toBe(20 * 28 + 32 * 4);
    expect(
      ranges.reduce((total, range) => total + range.length, 0),
    ).toBeLessThan(zip.length / 2);
    const previousReads = ranges.length;
    expect(await directory.read('icons/0.svg')).toBe(
      `<svg>${'x'.repeat(24000)}</svg>`,
    );
    expect(ranges.length - previousReads).toBe(3);
    const beforeMiss = ranges.length;
    expect(await directory.read('missing.svg')).toBeNull();
    expect(ranges.length).toBe(beforeMiss);
  });

  it('handles central records crossing a bounded read window', async () => {
    const files: Record<string, Uint8Array> = {};
    for (let i = 0; i < 9000; i++)
      files[`icons/${i.toString().padStart(5, '0')}-heart.svg`] =
        strToU8('<svg/>');
    const zip = zipSync(files, { level: 0 });
    const directory = await ZipDirectory.openReader({
      size: zip.length,
      read: async (offset, length) => zip.slice(offset, offset + length),
    });
    expect(directory.entryCount).toBe(9000);
    expect(await directory.read('icons/08999-heart.svg')).toBe('<svg/>');
  });

  it('rejects an incorrect directory entry count without filling the hash table', async () => {
    const zip = zipSync({
      'one.svg': strToU8('<svg/>'),
      'two.svg': strToU8('<svg/>'),
    });
    new DataView(zip.buffer).setUint16(zip.length - 22 + 10, 1, true);
    await expect(ZipDirectory.open(zip)).rejects.toThrow('entry count');
  });
});
