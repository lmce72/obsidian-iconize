import { describe, expect, it } from 'vitest';
import { normalizeSvgDocument, splitSprite } from './svg';

const NS = 'http://www.w3.org/2000/svg';

describe('splitSprite', () => {
  it('copies referenced definitions and sheet-level paint attributes', async () => {
    const markup = `<svg xmlns="${NS}" viewBox="0 0 24 24" fill="currentColor" stroke-width="2">
      <defs>
        <linearGradient id="gradient"><stop offset="0" stop-color="#000"/></linearGradient>
        <path id="shared" d="M0 0h9v9H0z"/>
      </defs>
      <symbol id="painted" viewBox="0 0 16 16"><path fill="url(#gradient)" d="M0 0h2v2H0z"/></symbol>
      <symbol id="reused" viewBox="0 0 16 16"><use href="#shared"/></symbol>
    </svg>`;

    const symbols = await splitSprite(markup);
    expect(symbols).not.toBeNull();
    const painted = symbols!.find((symbol) => symbol.name === 'painted')!;
    expect(painted.svg).toContain('linearGradient');
    expect(painted.svg).toContain('url(#gradient)');
    expect(painted.svg).toContain('fill="currentColor"');
    expect(painted.svg).toContain('stroke-width="2"');

    const reused = symbols!.find((symbol) => symbol.name === 'reused')!;
    expect(reused.svg).toContain('id="shared"');
    expect(reused.svg).toContain('<use href="#shared"');
  });

  it('falls back to the sheet viewBox when a symbol viewBox is invalid', async () => {
    const markup = `<svg xmlns="${NS}" viewBox="0 0 24 24"><symbol id="a" viewBox="nope"><path d="M0 0h1v1H0z"/></symbol></svg>`;

    const symbols = await splitSprite(markup);

    expect(symbols).toHaveLength(1);
    expect(symbols![0].svg).toContain('viewBox="0 0 24 24"');
  });

  it('ignores an orphan symbol that the HTML fallback parsed outside the SVG', async () => {
    const markup = `<svg xmlns="${NS}" viewBox="0 0 16 16"><path d="M0 0h1v1H0z"/></svg><symbol id="b"><path d="M0 0h1v1H0z"/></symbol>`;

    await expect(splitSprite(markup)).resolves.toBeNull();
  });

  it('returns null for a plain icon that is not a sprite', async () => {
    await expect(
      splitSprite(
        `<svg xmlns="${NS}" viewBox="0 0 16 16"><path d="M0 0h16"/></svg>`,
      ),
    ).resolves.toBeNull();
  });

  it('reports an empty array for a sprite without drawable symbols', async () => {
    const markup = `<svg xmlns="${NS}"><symbol id="empty" viewBox="0 0 16 16"></symbol></svg>`;
    await expect(splitSprite(markup)).resolves.toEqual([]);
  });
});

describe('normalizeSvgDocument', () => {
  it('keeps root presentation attributes used by outline icons', () => {
    const svg = normalizeSvgDocument(
      `<svg xmlns="${NS}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M4 4h16"/></svg>`,
    );
    expect(svg).toContain('fill="none"');
    expect(svg).toContain('stroke="currentColor"');
    expect(svg).toContain('stroke-width="1.5"');
  });

  it('rejects symbol-only sheets as standalone icons', () => {
    expect(
      normalizeSvgDocument(
        `<svg xmlns="${NS}"><symbol id="a"><path d="M0 0h1"/></symbol></svg>`,
      ),
    ).toBeNull();
  });
});
