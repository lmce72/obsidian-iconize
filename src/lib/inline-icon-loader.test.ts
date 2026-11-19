import { afterEach, describe, expect, it, vi } from 'vitest';
import type IconizePlugin from '@app/main';
import { InlineIconLoader } from './inline-icon-loader';
import { yieldToMain } from './task-scheduler';

vi.mock('./task-scheduler', () => ({ yieldToMain: vi.fn(() => Promise.resolve()) }));
vi.mock('obsidian', () => ({
  MarkdownView: class {},
  sanitizeHTMLToDom: vi.fn((markup: string) => {
    const fragment = document.createDocumentFragment();
    const parsed = new DOMParser().parseFromString(markup, 'text/html');
    fragment.append(...Array.from(parsed.body.childNodes));
    return fragment;
  }),
}));

const MARKUP = '<svg width="16px" height="16px"><path d="M0 0L16 16"/></svg>';
const loaders: InlineIconLoader[] = [];

function gate<T>() {
  let finish!: (value: T) => void;
  const promise = new Promise<T>((resolve) => { finish = resolve; });
  return { promise, finish };
}

async function settle() {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

function fixture() {
  const current = { editor: { cm: { dispatch: vi.fn() } }, previewMode: { rerender: vi.fn() } };
  const other = { editor: { cm: { dispatch: vi.fn() } }, previewMode: { rerender: vi.fn() } };
  const resolve = vi.fn(async (_id: string) => ({ svgElement: MARKUP }));
  const find = vi.fn((query: string) => {
    const name = query.replace(/^pa/i, '');
    return name === 'missing' ? undefined : { entry: { id: `Pa${name.toLowerCase()}` } };
  });
  const plugin = {
    iconResolver: { find, peek: vi.fn(() => undefined), resolve },
    app: { workspace: { getActiveViewOfType: vi.fn(() => current), getLeavesOfType: vi.fn(() => [current, other]) } },
    releaseIconSources: vi.fn(),
  } as unknown as IconizePlugin;
  const loader = new InlineIconLoader(plugin);
  loaders.push(loader);
  const node = () => {
    const element = document.createElement('span');
    element.textContent = ':placeholder:';
    document.body.append(element);
    return element;
  };
  return { loader, plugin, resolve, current, other, node };
}

afterEach(() => {
  for (const loader of loaders.splice(0)) loader.dispose();
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('inline icon loading', () => {
  it('fills duplicate aliases in place with no editor dispatch or reading-view rerender', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const first = f.node();
    const second = f.node();
    f.loader.fillElement(first, 'One');
    f.loader.fillElement(second, 'PAONE', { fontSize: 24 });
    await vi.advanceTimersByTimeAsync(24);
    expect(f.resolve).toHaveBeenCalledTimes(1);
    expect(first.querySelector('svg')?.getAttribute('width')).toBe('1em');
    expect(second.querySelector('svg')?.getAttribute('width')).toBe('24px');
    expect(first.textContent).not.toContain('placeholder');
    expect(f.current.editor.cm.dispatch).not.toHaveBeenCalled();
    expect(f.current.previewMode.rerender).not.toHaveBeenCalled();
    expect(f.other.editor.cm.dispatch).not.toHaveBeenCalled();
    expect(f.plugin.releaseIconSources).not.toHaveBeenCalled();
  });

  it('fills a cold icon before its asynchronously rendered section is mounted', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const section = document.createElement('div');
    const element = document.createElement('span');
    section.append(element);
    f.loader.fillElement(element, 'One');

    // 后处理器可以在未挂载的章节中运行，慢渲染使挂载晚于解析完成。
    // Post-processors may run in detached sections whose mounting follows resolution.
    await vi.advanceTimersByTimeAsync(100);
    expect(f.resolve).toHaveBeenCalledTimes(1);
    document.body.append(section);
    expect(element.querySelector('svg')).not.toBeNull();
    expect(f.current.previewMode.rerender).not.toHaveBeenCalled();
    expect(f.current.editor.cm.dispatch).not.toHaveBeenCalled();
    expect(f.loader.getStats()).toEqual({ pending: 0, failed: 0, inFlight: false });
  });

  it('does not fill a detached widget explicitly released during its source read', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const read = gate<{ svgElement: string }>();
    f.resolve.mockReturnValueOnce(read.promise);
    const element = document.createElement('span');
    f.loader.fillElement(element, 'One');
    await vi.advanceTimersByTimeAsync(24);
    f.loader.releaseElement(element, 'One');
    read.finish({ svgElement: MARKUP });
    await settle();
    document.body.append(element);
    expect(element.querySelector('svg')).toBeNull();
    expect(f.loader.getStats()).toEqual({ pending: 0, failed: 0, inFlight: false });
  });

  it('refreshes only the editor that requested a legacy repaint', async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.loader.requestIcon('One');
    await vi.advanceTimersByTimeAsync(24);
    expect(f.current.editor.cm.dispatch).toHaveBeenCalledTimes(1);
    expect(f.current.previewMode.rerender).not.toHaveBeenCalled();
    expect(f.other.editor.cm.dispatch).not.toHaveBeenCalled();
    expect(f.plugin.app.workspace.getLeavesOfType).not.toHaveBeenCalled();
  });

  it('cancels destroyed placeholders before scheduling a source read', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const element = f.node();
    f.loader.fillElement(element, 'One');
    f.loader.releaseElement(element, 'PAONE');
    element.remove();
    await vi.advanceTimersByTimeAsync(100);
    expect(f.resolve).not.toHaveBeenCalled();
    expect(f.loader.getStats().pending).toBe(0);
  });

  it('does not fill a released placeholder reconnected while a batch yields', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const pause = gate<void>();
    vi.mocked(yieldToMain).mockReturnValueOnce(pause.promise);
    let time = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => (time += 5));
    const first = f.node();
    const released = f.node();
    f.loader.fillElement(first, 'One');
    f.loader.fillElement(released, 'One');
    await vi.advanceTimersByTimeAsync(24);
    expect(first.querySelector('svg')).not.toBeNull();
    expect(released.querySelector('svg')).toBeNull();
    f.loader.releaseElement(released, 'One');
    released.remove();
    document.body.append(released);
    pause.finish();
    await settle();
    expect(released.querySelector('svg')).toBeNull();
  });

  it('does not apply an old generation after reset and waits for its running I/O lease', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const oldRead = gate<{ svgElement: string }>();
    f.resolve.mockReturnValueOnce(oldRead.promise);
    const oldNode = f.node();
    f.loader.fillElement(oldNode, 'One');
    await vi.advanceTimersByTimeAsync(24);
    f.loader.reset();
    const newNode = f.node();
    f.loader.fillElement(newNode, 'One');
    await vi.advanceTimersByTimeAsync(100);
    expect(f.resolve).toHaveBeenCalledTimes(1);
    oldRead.finish({ svgElement: '<svg data-old="yes"/>' });
    await settle();
    expect(oldNode.querySelector('svg')).toBeNull();
    expect(newNode.querySelector('svg')).toBeNull();
    await vi.advanceTimersByTimeAsync(24);
    expect(newNode.querySelector('svg')).not.toBeNull();
    expect(newNode.querySelector('[data-old]')).toBeNull();
  });

  it('does not fill or reschedule work after dispose', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const read = gate<{ svgElement: string }>();
    f.resolve.mockReturnValue(read.promise);
    const element = f.node();
    f.loader.fillElement(element, 'One');
    await vi.advanceTimersByTimeAsync(24);
    f.loader.dispose();
    f.loader.fillElement(element, 'Two');
    read.finish({ svgElement: MARKUP });
    await vi.advanceTimersByTimeAsync(100);
    expect(element.querySelector('svg')).toBeNull();
    expect(f.resolve).toHaveBeenCalledTimes(1);
    expect(f.loader.getStats()).toEqual({ pending: 0, failed: 0, inFlight: false });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('uses bounded concurrent batches and yields while filling many visible nodes', async () => {
    vi.useFakeTimers();
    const f = fixture();
    const read = gate<{ svgElement: string }>();
    let active = 0;
    let peak = 0;
    f.resolve.mockImplementation(async () => {
      peak = Math.max(peak, ++active);
      const icon = await read.promise;
      active--;
      return icon;
    });
    let time = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => time++);
    const nodes = Array.from({ length: 100 }, (_, index) => {
      const element = f.node();
      f.loader.fillElement(element, `Icon${index}`);
      return element;
    });
    await vi.advanceTimersByTimeAsync(24);
    expect(f.resolve).toHaveBeenCalledTimes(2);
    read.finish({ svgElement: MARKUP });
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.resolve).toHaveBeenCalledTimes(100);
    expect(peak).toBe(2);
    expect(nodes.every((node) => node.querySelector('svg'))).toBe(true);
    expect(yieldToMain).toHaveBeenCalledWith('user-visible');
    expect(f.current.editor.cm.dispatch).not.toHaveBeenCalled();
  });
});
