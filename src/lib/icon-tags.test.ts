import { describe, expect, it } from 'vitest';
import { findIconTags, replaceIconTags } from './icon-tags';

describe('portable icon tag parsing', () => {
  it('converts prose while preserving YAML, fenced/inline code, links, HTML attributes and escapes', () => {
    const source =
      '---\nicon: :LiHeart:\n---\n# :LiHeart:\n`literal :LiStar:`\n```md\n:LiStar:\n```\n[icon :LiStar:](https://a/:LiHeart:)\n[[note:LiHeart:]]\n<svg aria-label=":LiHeart:"><text>:LiHeart:</text></svg>\n\\:LiHeart:\n';
    const tags = findIconTags(source, ':');
    expect(tags.map((tag) => tag.id)).toEqual(['LiHeart', 'LiStar']);
    const result = replaceIconTags(
      source,
      tags,
      new Map([['LiHeart', '<svg/>']]),
    );
    expect(result).toContain('# <svg/>');
    expect(result).toContain('icon: :LiHeart:');
    expect(result).toContain('https://a/:LiHeart:');
    expect(result).toContain('\\:LiHeart:');
  });

  it('handles regex delimiters, repeated tags and missing icons without altering offsets', () => {
    const source = '.*LiHeart.* .*Unknown.* .*LiHeart.*';
    const tags = findIconTags(source, '.*');
    expect(replaceIconTags(source, tags, new Map([['LiHeart', '♥']]))).toBe(
      '♥ .*Unknown.* ♥',
    );
    expect(findIconTags(source, '')).toEqual([]);
  });

  it('protects unfinished fences and unclosed frontmatter', () => {
    expect(findIconTags('~~~\n:LiHeart:', ':')).toEqual([]);
    expect(findIconTags('---\nicon: :LiHeart:', ':')).toEqual([]);
  });

  it('preserves literal HTML code and bare URLs', () => {
    expect(
      findIconTags(
        '<code>:LiHeart:</code> https://example.com/:LiHeart: :LiStar:',
        ':',
      ).map((tag) => tag.id),
    ).toEqual(['LiStar']);
  });

  it('recognizes CRLF, hyphenated ids and indented code', () => {
    expect(
      findIconTags(
        '---\r\nx: :LiHeart:\r\n---\r\n:My-heart:\r\n    :LiStar:',
        ':',
      ).map((tag) => tag.id),
    ).toEqual(['My-heart']);
  });
});
