import { it, expect } from 'vitest';
import { getExtraPath } from './icon-packs';

it('should return the correct extra path for an icon pack', () => {
  const iconPackName = 'simple-icons';
  // 与 `icon-packs.ts` 中声明的版本及下载链接保持一致（当前为 16.15.0）。
  // Kept in step with the version declared in `icon-packs.ts` and its download link.
  const expectedPath = 'simple-icons-16.15.0/icons/';

  const path = getExtraPath(iconPackName);

  expect(path).toEqual(expectedPath);
});

it('should return `undefined` for an icon pack that does not exist', () => {
  const iconPackName = 'non-existent-icon-pack';

  const path = getExtraPath(iconPackName);

  expect(path).toBeUndefined();
});
