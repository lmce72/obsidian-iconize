import { describe, expect, it, vi } from 'vitest';

vi.mock('obsidian', () => ({
  Modal: class {},
  Setting: class {},
}));

import { EMBED_FORMAT_OPTIONS } from './icon-embed-format-modal';

describe('embed format guidance', () => {
  it('documents every supported output format', () => {
    expect(EMBED_FORMAT_OPTIONS.map((option) => option.value)).toEqual([
      'svg',
      'data',
      'file',
    ]);
    for (const option of EMBED_FORMAT_OPTIONS) {
      expect(option.scenario.length).toBeGreaterThan(20);
      expect(option.limit.length).toBeGreaterThan(20);
    }
  });

  it('warns that publishing platforms may filter Base64 images', () => {
    const data = EMBED_FORMAT_OPTIONS.find((option) => option.value === 'data');
    expect(data).toBeDefined();
    if (!data) return;
    expect(data.limit).toMatch(/GitHub|博客|过滤/);
  });
});
