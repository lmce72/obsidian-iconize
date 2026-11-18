import { describe, expect, it, vi } from 'vitest';
import type IconizePlugin from '@app/main';

vi.mock('obsidian', () => ({
  Component: class {},
  TAbstractFile: class {},
  TFile: class {},
  TFolder: class {},
  sanitizeHTMLToDom: (markup: string) => {
    const fragment = document.createDocumentFragment();
    const parsed = new DOMParser().parseFromString(markup, 'text/html');
    fragment.append(...Array.from(parsed.body.childNodes));
    return fragment;
  },
}));
vi.mock('@app/emoji', () => ({ default: { isEmoji: () => false } }));

import { TFile } from 'obsidian';
import NotebookNavigatorIntegration from './notebook-navigator';

describe('Navigator icon refresh', () => {
  it.each(['recover', 'still missing', 'initial success'] as const)(
    'retries once after refresh during resolution: %s',
    async (result) => {
      let finish!: (value: string | undefined) => void;
      const first = new Promise<string | undefined>((resolve) => {
        finish = resolve;
      });
      const getSvg = vi
        .fn()
        .mockReturnValueOnce(first)
        .mockResolvedValue(result === 'recover' ? '<svg></svg>' : undefined);
      const file = new TFile();
      const plugin = {
        conversion: { getSvg },
        app: { vault: { getAbstractFileByPath: () => file } },
      } as unknown as IconizePlugin;
      const integration = new NotebookNavigatorIntegration(plugin);
      const internal = integration as unknown as {
        roots: Map<HTMLElement, object>;
        sync(): void;
        schedule(root: object): void;
        render(root: object): void;
        appearance(file: TFile): { id: string };
        mount(row: HTMLElement, state: object): void;
      };
      vi.spyOn(internal, 'sync').mockImplementation(() => {});
      vi.spyOn(internal, 'appearance').mockReturnValue({ id: 'Icon' });
      vi.spyOn(internal, 'mount').mockImplementation(() => {});
      vi.spyOn(internal, 'schedule').mockImplementation((root) =>
        internal.render(root),
      );
      const element = document.createElement('div');
      element.innerHTML =
        '<div data-drag-type="file" data-drag-path="file.md"></div>';
      document.body.append(element);
      const root = {
        element,
        rows: new Map<HTMLElement, { element?: HTMLElement }>(),
        frame: null,
      };
      internal.roots.set(element, root);
      internal.render(root);
      expect(getSvg).toHaveBeenCalledTimes(1);
      integration.refresh();
      integration.refresh();
      finish(result === 'initial success' ? '<svg></svg>' : undefined);
      for (let i = 0; i < 20; i++) await Promise.resolve();
      const expectedCalls = result === 'initial success' ? 1 : 2;
      expect(getSvg).toHaveBeenCalledTimes(expectedCalls);
      expect(Boolean(root.rows.values().next().value?.element)).toBe(
        result !== 'still missing',
      );
      internal.render(root);
      for (let i = 0; i < 10; i++) await Promise.resolve();
      expect(getSvg).toHaveBeenCalledTimes(expectedCalls);
      element.remove();
    },
  );
});
