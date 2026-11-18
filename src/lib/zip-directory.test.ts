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
      expect(directory.entries.size).toBe(2);
      expect(directory.read('icons/heart.svg')).toBe('<svg>♥</svg>');
      expect(directory.read('图标/星.svg')).toBe('<svg>★</svg>');
      expect(directory.read('missing.svg')).toBeNull();
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
    expect((await ZipDirectory.open(bytes)).read('heart.svg')).toBe('<svg/>');
  });
});
