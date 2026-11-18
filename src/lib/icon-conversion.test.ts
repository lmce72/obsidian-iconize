import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Editor } from 'obsidian';
import type IconizePlugin from '@app/main';
import { IconConversion } from './icon-conversion';

vi.mock('obsidian', () => ({
  Notice: class {
    setMessage() {}
    hide() {}
  },
  MarkdownView: class {},
  TFile: class {},
  normalizePath: (path: string) => path,
  sanitizeHTMLToDom: (markup: string) => {
    const fragment = document.createDocumentFragment();
    const parsed = new DOMParser().parseFromString(markup, 'text/html');
    fragment.append(...Array.from(parsed.body.childNodes));
    return fragment;
  },
}));
vi.mock('./icon', () => ({
  default: {
    getIconByName: (_plugin: unknown, id: string) =>
      id === 'One'
        ? {
            svgElement:
              '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M0 0L24 24"/></svg>',
          }
        : null,
  },
}));

function fixture(format: 'data' | 'svg' = 'data') {
  const state = { text: ':One: and :Missing: `:One:`' };
  const editor = {
    getValue: () => state.text,
    offsetToPos: (offset: number) => ({ line: 0, ch: offset }),
    transaction: vi.fn(
      ({
        changes,
      }: {
        changes: Array<{
          from: { ch: number };
          to: { ch: number };
          text: string;
        }>;
      }) => {
        for (const change of changes.slice().reverse())
          state.text =
            state.text.slice(0, change.from.ch) +
            change.text +
            state.text.slice(change.to.ch);
      },
    ),
  } as unknown as Editor;
  const view = {
    editor,
    file: { path: 'Test.md' },
    contentEl: document.createElement('div'),
  };
  const settings = {
    iconIdentifier: ':',
    iconEmbedFormat: format,
    autoConvertIcons: false,
    autoConvertDelay: 10,
  };
  const plugin = {
    getSettings: () => settings,
    app: { workspace: { getActiveViewOfType: () => view } },
  } as unknown as IconizePlugin;
  const conversion = new IconConversion(plugin);
  return { state, editor, view, settings, conversion };
}
afterEach(() => vi.useRealTimers());

describe('icon conversion pipeline', () => {
  it('embeds self-contained Base64 and leaves missing icons and literal code intact', async () => {
    const f = fixture();
    await f.conversion.convertEditor(f.editor);
    expect(f.state.text).toMatch(/^!\[One\]\(data:image\/svg\+xml;base64,/);
    expect(f.state.text).toContain(':Missing: `:One:`');
    const encoded = /base64,([^)]*)/.exec(f.state.text)![1];
    expect(window.atob(encoded)).toContain(
      'xmlns="http://www.w3.org/2000/svg"',
    );
    expect(window.atob(encoded)).toContain('stroke="#808080"');
    expect(f.editor.transaction).toHaveBeenCalledTimes(1);
  });

  it('supports readable SVG output without Base64', async () => {
    const f = fixture('svg');
    await f.conversion.convertEditor(f.editor);
    expect(f.state.text).toMatch(/^<svg /);
    expect(f.state.text).not.toContain('base64');
  });

  it('does not overwrite edits or a different file after asynchronous resolution', async () => {
    const f = fixture();
    vi.spyOn(f.conversion, 'getSvg').mockImplementation(async () => {
      f.state.text = 'user edit';
      return '<svg/>';
    });
    await f.conversion.convertEditor(f.editor);
    expect(f.state.text).toBe('user edit');
    expect(f.editor.transaction).not.toHaveBeenCalled();
    const g = fixture();
    vi.spyOn(g.conversion, 'getSvg').mockImplementation(async () => {
      g.view.file.path = 'Other.md';
      return '<svg/>';
    });
    await g.conversion.convertEditor(g.editor);
    expect(g.editor.transaction).not.toHaveBeenCalled();
  });

  it('rejects an outdated single-tag position', async () => {
    const f = fixture();
    f.state.text = 'new text';
    await f.conversion.convertEditor(f.editor, { id: 'One', from: 0, to: 5 });
    expect(f.editor.transaction).not.toHaveBeenCalled();
  });

  it('debounces input for 10 seconds and cancels work on unload', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const convert = vi
      .spyOn(f.conversion, 'convertEditor')
      .mockResolvedValue(1);
    f.conversion.schedule(f.editor);
    await vi.advanceTimersByTimeAsync(11000);
    expect(convert).not.toHaveBeenCalled();
    f.settings.autoConvertIcons = true;
    f.conversion.schedule(f.editor);
    await vi.advanceTimersByTimeAsync(9000);
    f.conversion.schedule(f.editor);
    await vi.advanceTimersByTimeAsync(9999);
    expect(convert).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(convert).toHaveBeenCalledTimes(1);
    f.conversion.schedule(f.editor);
    f.conversion.dispose();
    await vi.advanceTimersByTimeAsync(10000);
    expect(convert).toHaveBeenCalledTimes(1);
  });

  it('removes active and external SVG content before export', async () => {
    const f = fixture();
    const { default: icons } = await import('./icon');
    vi.spyOn(icons, 'getIconByName').mockReturnValueOnce({
      svgElement:
        '<svg onload="alert(1)" stroke="red"><script>alert(1)</script><image href="https://example.com/x"/><path fill="url(https://example.com/y)" style="opacity:0"/></svg>',
    } as ReturnType<typeof icons.getIconByName>);
    const output = await f.conversion.getSvg('One', '#00ff00');
    expect(output).not.toMatch(/script|onload|https:|style=/);
    expect(output).toContain('stroke="#00ff00"');
  });
});
