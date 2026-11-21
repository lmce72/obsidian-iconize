import { describe, expect, it } from 'vitest';
import { gzipSync, strToU8, zipSync } from 'fflate';
import { openArchive, sniffArchive } from './archive';

function tarHeader(name: string, size: number): Uint8Array {
  const header = new Uint8Array(512);
  header.set(strToU8(name).subarray(0, 100), 0);
  header.set(strToU8('0000644\0'), 100);
  header.set(strToU8('0000000\0'), 108);
  header.set(strToU8('0000000\0'), 116);
  header.set(strToU8(size.toString(8).padStart(11, '0')), 124);
  header[135] = 0;
  header.set(strToU8('00000000000\0'), 136);
  header[156] = '0'.charCodeAt(0);
  header.set(strToU8('ustar\0'), 257);
  header.set(strToU8('00'), 263);
  return header;
}

function makeTar(files: Record<string, string>): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const [name, content] of Object.entries(files)) {
    const bytes = strToU8(content);
    parts.push(tarHeader(name, bytes.length));
    const padded = new Uint8Array(Math.ceil(bytes.length / 512) * 512);
    padded.set(bytes);
    parts.push(padded);
  }
  // Two empty blocks terminate the archive.
  parts.push(new Uint8Array(1024));
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const tar = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    tar.set(part, offset);
    offset += part.length;
  }
  return tar;
}

describe('archive sniffing', () => {
  it('recognizes zip, gzip and uncompressed tar', () => {
    expect(sniffArchive(zipSync({ 'a.txt': strToU8('a') }))).toBe('zip');
    expect(sniffArchive(gzipSync(strToU8('a')))).toBe('tar');
    expect(sniffArchive(makeTar({ 'a.txt': 'a' }))).toBe('tar');
    expect(sniffArchive(strToU8('not an archive'))).toBeNull();
  });
});

describe('tar reader', () => {
  it('lists files and reads their bytes from a gzip stream', async () => {
    const tar = makeTar({
      'package/a.svg': '<svg/>',
      'package/nested/b.txt': 'hello',
    });
    const reader = await openArchive(gzipSync(tar));
    expect(reader).not.toBeNull();
    expect(reader!.kind).toBe('tar');
    expect(reader!.names).toEqual(['package/a.svg', 'package/nested/b.txt']);
    expect(await reader!.readText('package/a.svg')).toBe('<svg/>');
    expect(await reader!.readText('package/nested/b.txt')).toBe('hello');
    expect(await reader!.readBytes('missing.txt')).toBeNull();
  });

  it('reads an uncompressed tar as well', async () => {
    const reader = await openArchive(makeTar({ 'icon.svg': '<svg/>' }));
    expect(reader!.kind).toBe('tar');
    expect(await reader!.readText('icon.svg')).toBe('<svg/>');
  });

  it('rejects a truncated entry instead of returning partial bytes', async () => {
    const tar = makeTar({ 'a.txt': 'x'.repeat(700) });
    await expect(openArchive(tar.slice(0, 600))).rejects.toThrow(
      'Truncated tar entry',
    );
  });
});

describe('zip reader', () => {
  it('reads entries by name and skips directories', async () => {
    const reader = await openArchive(
      zipSync({
        'icons/': new Uint8Array(0),
        'icons/home.svg': strToU8('<svg/>'),
      }),
    );
    expect(reader!.kind).toBe('zip');
    expect(reader!.names).toEqual(['icons/home.svg']);
    expect(await reader!.readText('icons/home.svg')).toBe('<svg/>');
    expect(await reader!.readText('icons/missing.svg')).toBeNull();
  });

  it('applies a caller-provided size limit instead of the SVG limit', async () => {
    const content = 'x'.repeat(100);
    const reader = await openArchive(zipSync({ 'set.json': strToU8(content) }));
    expect(await reader!.sizeOf('set.json')).toBe(100);
    await expect(reader!.readText('set.json', 10)).rejects.toThrow(/limit/);
    expect(await reader!.readText('set.json', 1000)).toBe(content);
    expect(await reader!.sizeOf('missing.json')).toBeNull();
  });
});
