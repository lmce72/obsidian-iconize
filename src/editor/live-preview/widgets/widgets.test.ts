import { describe, expect, it, vi } from 'vitest';
import { EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';
import type IconizePlugin from '@app/main';
import { buildPositionField } from '../state';
import { IconInTextWidget } from './icon-in-text';
import { IconInLinkWidget } from './icon-in-link';

vi.mock('obsidian', () => ({
  sanitizeHTMLToDom: (markup: string) => {
    const fragment = document.createDocumentFragment();
    fragment.append(
      ...Array.from(
        new DOMParser().parseFromString(markup, 'text/html').body.childNodes,
      ),
    );
    return fragment;
  },
}));
vi.mock('@codemirror/language', () => ({
  syntaxTree: () => ({ iterate() {} }),
  tokenClassNodeProp: {},
}));
vi.mock('@app/lib/icon', () => ({
  default: { getIconByName: vi.fn(() => null) },
}));
vi.mock('@app/emoji', () => ({
  default: { isEmoji: () => false, getRegex: () => /(?!) /g },
}));
vi.mock('@app/lib/util/text', () => ({
  calculateFontTextSize: () => 16,
  calculateHeaderSize: () => 24,
}));

function fixture() {
  const fillElement = vi.fn();
  const releaseElement = vi.fn();
  const requestIcon = vi.fn();
  const plugin = {
    getSettings: () => ({ iconIdentifier: ':', iconColor: undefined }),
    getIconColor: () => undefined,
    iconResolver: {
      find: (id: string) =>
        id.toLowerCase() === 'paone' ? { entry: { id: 'PaOne' } } : undefined,
    },
    inlineIconLoader: { fillElement, releaseElement, requestIcon },
    app: { workspace: { iterateAllLeaves: vi.fn() } },
  } as unknown as IconizePlugin;
  const view = {
    dom: document.createElement('div'),
    state: EditorState.create({ doc: 'heading\n:PaOne:\nend' }),
  } as unknown as EditorView;
  return { plugin, view, fillElement, releaseElement, requestIcon };
}

describe('lazy Live Preview widgets', () => {
  it('keeps indexed shortcodes in the position field before SVG resolution', () => {
    const f = fixture();
    const field = buildPositionField(f.plugin);
    const state = EditorState.create({
      doc: 'heading\n:PaOne:\nend',
      extensions: [field],
    });
    const positions: Array<[number, number, string]> = [];
    state.field(field).between(0, state.doc.length, (from, to, value) => {
      positions.push([from, to, value.iconId]);
    });
    expect(positions).toEqual([[8, 15, 'PaOne']]);
    expect(f.requestIcon).not.toHaveBeenCalled();
  });

  it('fills a text widget directly while retaining its exact right-click position', () => {
    const f = fixture();
    const widget = new IconInTextWidget(f.plugin, 'PaOne');
    widget.setPosition(8, 15);
    const element = widget.toDOM(f.view);
    expect(f.fillElement).toHaveBeenCalledWith(element, 'PaOne', {
      fontSize: 16,
    });
    expect(element.getAttribute('data-icon')).toBe('PaOne');
    expect(element.getAttribute('data-iconize-from')).toBe('8');
    expect(element.classList.contains('cm-iconize-icon')).toBe(true);
    expect(element.textContent).toBe('');
    widget.destroy(element);
    expect(f.releaseElement).toHaveBeenCalledWith(element, 'PaOne');
  });

  it('fills an indexed link icon directly and releases it when its decoration is destroyed', () => {
    const f = fixture();
    const widget = new IconInLinkWidget(f.plugin, 'PaOne', 'Target.md', null);
    const element = widget.toDOM(f.view);
    expect(f.fillElement).toHaveBeenCalledWith(element, 'PaOne', {
      fontSize: 16,
    });
    expect(element.classList.contains('iconize-icon-in-link')).toBe(true);
    expect(element.getAttribute('title')).toBe('PaOne');
    widget.destroy(element);
    expect(f.releaseElement).toHaveBeenCalledWith(element, 'PaOne');
  });
});
