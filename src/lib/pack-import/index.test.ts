import { describe, expect, it, vi } from 'vitest';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { normalizeIconPack } from './index';
import { PACK_MANIFEST_NAME } from './types';

function file(fileName: string, content: string | Uint8Array) {
  return {
    fileName,
    bytes: typeof content === 'string' ? strToU8(content) : content,
  };
}

function manifestOf(archive: Uint8Array): Record<string, unknown> {
  const entries = unzipSync(archive);
  expect(entries[PACK_MANIFEST_NAME]).toBeDefined();
  return JSON.parse(strFromU8(entries[PACK_MANIFEST_NAME]));
}

describe('normalizeIconPack', () => {
  it('turns an Iconify set into an SVG zip with a manifest', async () => {
    const result = await normalizeIconPack([
      file(
        'iconify-mdi.json',
        JSON.stringify({
          prefix: 'mdi',
          width: 24,
          height: 24,
          icons: {
            home: { body: '<path d="M0 0h24v24H0z"/>' },
            'delete.fill': { body: '<path d="M1 1h1v1H1z"/>' },
            '1password': { body: '<path d="M2 2h2v2H2z"/>' },
          },
          aliases: { house: { parent: 'home', hFlip: true } },
        }),
      ),
    ]);

    expect(result.format).toBe('iconify-json');
    expect(result.iconCount).toBe(4);
    expect(result.suggestedName).toBe('mdi');
    const entries = unzipSync(result.archive);
    expect(Object.keys(entries).sort()).toEqual([
      '1password.svg',
      'delete-fill.svg',
      'home.svg',
      'house.svg',
      PACK_MANIFEST_NAME,
    ]);
    expect(strFromU8(entries['home.svg'])).toContain('viewBox="0 0 24 24"');
    expect(strFromU8(entries['house.svg'])).toContain('scale(-1 1)');
    expect(manifestOf(result.archive)).toMatchObject({
      format: 'iconify-json',
      iconCount: 4,
    });
  });

  it('keeps only the icon root of a repository archive', async () => {
    const zip = zipSync({
      'repo/README.md': strToU8('# readme'),
      'repo/docs/screenshot.svg': strToU8(
        '<svg viewBox="0 0 8 8"><rect width="8" height="8"/></svg>',
      ),
      'repo/icons/home.svg': strToU8(
        '<svg viewBox="0 0 16 16"><path d="M0 0h16v16z"/></svg>',
      ),
      'repo/icons/user.svg': strToU8(
        '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="8"/></svg>',
      ),
    });
    const result = await normalizeIconPack([file('icons-main.zip', zip)]);
    expect(result.format).toBe('svg-archive');
    expect(result.iconCount).toBe(2);
    const entries = unzipSync(result.archive);
    expect(Object.keys(entries).sort()).toEqual([
      'home.svg',
      'iconize-pack.json',
      'user.svg',
    ]);
    expect(Object.keys(entries)).not.toContain('screenshot.svg');
  });

  it('preserves folders so equal basenames stay addressable', async () => {
    const zip = zipSync({
      'repo/icons/line/home.svg': strToU8(
        '<svg viewBox="0 0 16 16"><path d="M0 0h8"/></svg>',
      ),
      'repo/icons/fill/home.svg': strToU8(
        '<svg viewBox="0 0 16 16"><rect width="8" height="8"/></svg>',
      ),
    });
    const result = await normalizeIconPack([file('pack.zip', zip)]);
    expect(result.iconCount).toBe(2);
    expect(Object.keys(unzipSync(result.archive)).sort()).toEqual([
      'fill/home.svg',
      'iconize-pack.json',
      'line/home.svg',
    ]);
  });

  it('splits a sprite file into symbols', async () => {
    const result = await normalizeIconPack([
      file(
        'disarto.svg',
        '<svg xmlns="http://www.w3.org/2000/svg"><symbol id="one" viewBox="0 0 10 10"><path d="M0 0h10"/></symbol><symbol id="two" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></symbol></svg>',
      ),
    ]);
    expect(result.format).toBe('svg-sprite');
    expect(result.iconCount).toBe(2);
    expect(Object.keys(unzipSync(result.archive)).sort()).toEqual([
      'iconize-pack.json',
      'one.svg',
      'two.svg',
    ]);
  });

  it('imports a single SVG file', async () => {
    const result = await normalizeIconPack([
      file(
        'account.svg',
        '<svg viewBox="0 0 24 24"><path d="M12 2a10 10 0 1 0 0 20a10 10 0 0 0 0-20"/></svg>',
      ),
    ]);
    expect(result.format).toBe('svg-file');
    expect(result.iconCount).toBe(1);
    expect(unzipSync(result.archive)['account.svg']).toBeDefined();
  });

  it('strips scripts, event handlers and external references', async () => {
    const result = await normalizeIconPack([
      file(
        'evil.svg',
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10" onload="alert(1)"><script>alert(2)</script><a href="https://example.com"><path d="M0 0h10" fill="url(https://example.com/x)"/></a><rect width="10" height="10" style="fill:red"/></svg>',
      ),
    ]);
    const svg = strFromU8(unzipSync(result.archive)['evil.svg']);
    expect(svg).not.toContain('<script');
    expect(svg).not.toContain('onload');
    expect(svg).not.toContain('example.com');
    expect(svg).not.toContain('style=');
    expect(svg).toContain('<rect');
  });

  it('rejects WOFF2 fonts with actionable guidance', async () => {
    const woff2 = new Uint8Array([0x77, 0x4f, 0x46, 0x32, 0, 0, 0, 0]);
    await expect(
      normalizeIconPack([file('fa-solid-900.woff2', woff2)]),
    ).rejects.toThrow(/WOFF2/);
  });

  it('rejects unknown formats', async () => {
    await expect(
      normalizeIconPack([file('notes.txt', 'hello')]),
    ).rejects.toThrow(/无法识别|Unrecognized/);
  });

  it('imports only the selected sets from an Iconify icon-sets archive', async () => {
    const zip = zipSync({
      'repo/json/aa.json': strToU8(
        JSON.stringify({
          prefix: 'aa',
          width: 16,
          height: 16,
          icons: { home: { body: '<path d="M0 0h1v1H0z"/>' } },
        }),
      ),
      'repo/json/bb.json': strToU8(
        JSON.stringify({
          prefix: 'bb',
          width: 16,
          height: 16,
          icons: {
            home: { body: '<path d="M1 1h1v1H1z"/>' },
            star: { body: '<path d="M2 2h2"/>' },
          },
        }),
      ),
      'repo/collections.json': strToU8('{"aa":{"name":"A"}}'),
      'repo/.build/generate.js': strToU8('module.exports = 1;'),
    });
    const offered: string[] = [];
    const result = await normalizeIconPack([file('iconify.zip', zip)], {
      selectIconifySets: async (sets) => {
        offered.push(...sets.map((set) => set.prefix));
        return [sets.find((set) => set.prefix === 'bb')!.path];
      },
    });

    expect(result.format).toBe('iconify-archive');
    expect(result.suggestedName).toBe('bb');
    expect(result.iconCount).toBe(2);
    expect(offered.sort()).toEqual(['aa', 'bb']);
    expect(Object.keys(unzipSync(result.archive)).sort()).toEqual([
      'home.svg',
      'iconize-pack.json',
      'star.svg',
    ]);
  });

  it('uses each prefix as a folder when several sets are selected', async () => {
    const zip = zipSync({
      'repo/json/aa.json': strToU8(
        JSON.stringify({
          prefix: 'aa',
          icons: { home: { body: '<path d="M0 0h1v1H0z"/>' } },
        }),
      ),
      'repo/json/bb.json': strToU8(
        JSON.stringify({
          prefix: 'bb',
          icons: { home: { body: '<path d="M1 1h1v1H1z"/>' } },
        }),
      ),
    });
    const result = await normalizeIconPack([file('sets.zip', zip)], {
      selectIconifySets: async (sets) => sets.map((set) => set.path),
    });

    expect(result.iconCount).toBe(2);
    expect(result.suggestedName).toBe('iconify');
    expect(Object.keys(unzipSync(result.archive)).sort()).toEqual([
      'aa/home.svg',
      'bb/home.svg',
      'iconize-pack.json',
    ]);
  });

  it('cancels when no Iconify set is selected', async () => {
    const zip = zipSync({
      'repo/json/a.json': strToU8(
        JSON.stringify({
          prefix: 'a',
          icons: { home: { body: '<path d="M0 0h1v1H0z"/>' } },
        }),
      ),
      'repo/json/b.json': strToU8(
        JSON.stringify({
          prefix: 'b',
          icons: { home: { body: '<path d="M1 1h1v1H1z"/>' } },
        }),
      ),
    });
    await expect(
      normalizeIconPack([file('sets.zip', zip)], {
        selectIconifySets: async () => null,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('imports a single Iconify set inside a zip without asking', async () => {
    const zip = zipSync({
      'repo/only.json': strToU8(
        JSON.stringify({
          prefix: 'only',
          icons: { home: { body: '<path d="M0 0h1v1H0z"/>' } },
        }),
      ),
      'repo/package.json': strToU8('{"name":"set"}'),
    });
    const select = vi.fn(async () => null);
    const result = await normalizeIconPack([file('one.zip', zip)], {
      selectIconifySets: select,
    });

    expect(result.format).toBe('iconify-archive');
    expect(result.suggestedName).toBe('only');
    expect(result.iconCount).toBe(1);
    expect(select).not.toHaveBeenCalled();
  });
});
