import { describe, expect, it } from 'vitest';
import { strToU8 } from 'fflate';
import { ZipDirectory } from '../zip-directory';
import { writeZip } from './zip-writer';

describe('writeZip', () => {
  it('writes a ZIP64 archive above 65,535 entries', async () => {
    const files: Record<string, Uint8Array> = {};
    for (let index = 0; index < 70_000; index++)
      files[`dir${index % 100}/icon-${index}.svg`] = strToU8('<svg/>');

    const archive = writeZip(files);
    const directory = await ZipDirectory.open(archive, true);
    const names = await directory.listNames();

    expect(names).toHaveLength(70_000);
    expect(await directory.read('dir0/icon-0.svg')).toBe('<svg/>');
    expect(await directory.read('dir99/icon-69999.svg')).toBe('<svg/>');
    expect(await directory.read('dir0/missing.svg')).toBeNull();
  }, 60_000);
});
