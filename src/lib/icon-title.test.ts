import { beforeEach, describe, expect, it, vi } from 'vitest';
import titleIcon from './icon-title';
import config from '@app/config';
import svg from './util/svg';
import type IconizePlugin from '@app/main';

describe('title icon menu interaction', () => {
  it('uses the current path and handler for click, context menu and keyboard after node reuse', () => {
    const plugin = {
      getSettings: () => ({ iconInTitlePosition: 'above' }),
    } as unknown as IconizePlugin;
    const parent = document.createElement('div');
    const title = document.createElement('div');
    parent.append(title);
    const oldHandler = vi.fn(),
      handler = vi.fn();
    titleIcon.add(plugin, title, '<svg/>', {
      path: 'Old.md',
      onClick: oldHandler,
    });
    titleIcon.add(plugin, title, '<svg/>', {
      path: 'New.md',
      onClick: handler,
    });
    const button = parent.querySelector('.iconize-title-icon')!;
    button.dispatchEvent(new MouseEvent('click'));
    button.dispatchEvent(new MouseEvent('contextmenu'));
    button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    expect(oldHandler).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledTimes(3);
    expect(handler.mock.calls.every(([path]) => path === 'New.md')).toBe(true);
    expect(button.getAttribute('tabindex')).toBe('0');
  });
});

describe('add', () => {
  let plugin: any;

  beforeEach(() => {
    plugin = {
      getSettings: (): any => {
        return {
          iconInTitlePosition: 'above',
          emojiStyle: 'native',
        };
      },
    };

    const originalCreateElement = document.createElement;
    document.createElement = vi.fn().mockImplementation((tagName) => {
      const actual = originalCreateElement.call(document, tagName);
      actual.createDiv = vi.fn(() => document.createElement('div'));
      return actual;
    });
  });

  it('should create a title icon', () => {
    const parentEl = document.createElement('div');
    const inlineTitleEl = document.createElement('div');
    parentEl.appendChild(inlineTitleEl);

    titleIcon.add(plugin, inlineTitleEl, '<svg></svg>');
    expect(parentEl).toMatchInlineSnapshot(`<div>
  <div
    class="iconize-inline-title-wrapper"
    style="display: block;"
  >
    <div
      class="iconize-title-icon"
      style="display: block; width: var(--line-width); transform: translateY(9%);"
    >
      <svg />
    </div>
    <div />
  </div>
</div>`);
  });

  it('should create a title icon with a font size when the passed in element is not an svg element', () => {
    const parentEl = document.createElement('div');
    const inlineTitleEl = document.createElement('div');
    parentEl.appendChild(inlineTitleEl);

    titleIcon.add(plugin, inlineTitleEl, '👍', { fontSize: 10 });
    expect(parentEl).toMatchInlineSnapshot(`<div>
  <div
    class="iconize-inline-title-wrapper"
    style="display: block;"
  >
    <div
      class="iconize-title-icon"
      style="display: block; width: var(--line-width); font-size: 10px; transform: translateY(9%);"
    >
      👍
    </div>
    <div />
  </div>
</div>`);
  });

  it('should update the title icon when the title icon already exist', () => {
    const parentEl = document.createElement('div');
    const inlineTitleEl = document.createElement('div');
    const titleIconEl = document.createElement('div');
    titleIconEl.classList.add(config.TITLE_ICON_CLASS);
    parentEl.appendChild(titleIconEl);
    parentEl.appendChild(inlineTitleEl);

    titleIcon.add(plugin, inlineTitleEl, '<svg></svg>');
    expect(parentEl).toMatchInlineSnapshot(`<div>
  <div
    class="iconize-inline-title-wrapper"
    style="display: block;"
  >
    <div
      class="iconize-title-icon"
      style="display: block; width: var(--line-width); transform: translateY(9%);"
    >
      <svg />
    </div>
    <div />
  </div>
</div>`);
  });

  it('should call `svg.setFontSize if the `fontSize` option is provided', () => {
    const setFontSize = vi.spyOn(svg, 'setFontSize');
    setFontSize.mockImplementationOnce(() => '<svg></svg>');

    const parentEl = document.createElement('div');
    const inlineTitleEl = document.createElement('div');
    parentEl.appendChild(inlineTitleEl);

    titleIcon.add(plugin, inlineTitleEl, '<svg></svg>', { fontSize: 10 });
    expect(setFontSize).toBeCalledTimes(1);
    expect(setFontSize).toHaveBeenCalledWith('<svg></svg>', 10);

    setFontSize.mockRestore();
  });
});

describe('updateStyle', () => {
  it('should update width and height of the title icon element', () => {
    const setFontSize = vi.spyOn(svg, 'setFontSize');
    const parentEl = document.createElement('div');
    const inlineTitleEl = document.createElement('div');
    inlineTitleEl.innerHTML = '<svg></svg>';
    inlineTitleEl.classList.add(config.TITLE_ICON_CLASS);
    parentEl.appendChild(inlineTitleEl);

    titleIcon.updateStyle(inlineTitleEl, { fontSize: 10 });
    expect(setFontSize).toBeCalledTimes(1);
    expect(setFontSize).toHaveBeenCalledWith('<svg></svg>', 10);
  });

  it('should update font size of the title icon element when it is an emoji', () => {
    const parentEl = document.createElement('div');
    const inlineTitleEl = document.createElement('div');
    inlineTitleEl.innerHTML = '👍';
    inlineTitleEl.classList.add(config.TITLE_ICON_CLASS);
    parentEl.appendChild(inlineTitleEl);

    titleIcon.updateStyle(inlineTitleEl, { fontSize: 10 });
    expect(inlineTitleEl.style.fontSize).toEqual('10px');
  });
});

describe('hide', () => {
  it('should set the `display` style to `none`, if the title icon element exists', () => {
    const parentEl = document.createElement('div');
    const titleIconEl = document.createElement('div');
    titleIconEl.classList.add(config.TITLE_ICON_CLASS);
    const inlineTitleEl = document.createElement('div');
    parentEl.appendChild(titleIconEl);
    parentEl.appendChild(inlineTitleEl);
    titleIcon.hide(inlineTitleEl);
    expect((parentEl.children[0] as HTMLElement).style.display).toEqual('none');
  });

  it('should not set the `display` style to `none`, if the title icon container does not exist', () => {
    const parentEl = document.createElement('div');
    const inlineTitleEl = document.createElement('div');
    parentEl.appendChild(inlineTitleEl);
    inlineTitleEl.innerHTML = '<div></div>';
    titleIcon.hide(inlineTitleEl);
    expect(inlineTitleEl.innerHTML).toEqual('<div></div>');
  });

  it('should not set the `display` style to `none`, if the parent container does not exist', () => {
    const inlineTitleEl = document.createElement('div');
    inlineTitleEl.innerHTML = '<div></div>';
    titleIcon.hide(inlineTitleEl);
    expect(inlineTitleEl.innerHTML).toEqual('<div></div>');
  });
});

describe('remove', () => {
  it('should remove the title icon element, if the title icon element exists', () => {
    const parentEl = document.createElement('div');
    const titleIconEl = document.createElement('div');
    titleIconEl.classList.add(config.TITLE_ICON_CLASS);
    const inlineTitleEl = document.createElement('div');
    parentEl.appendChild(titleIconEl);
    parentEl.appendChild(inlineTitleEl);
    titleIcon.remove(inlineTitleEl);
    expect(parentEl.children.length).toEqual(1);
  });

  it('should not remove the title icon element, if the title icon element does not exist', () => {
    const parentEl = document.createElement('div');
    const inlineTitleEl = document.createElement('div');
    parentEl.appendChild(inlineTitleEl);
    inlineTitleEl.innerHTML = '<div></div>';
    titleIcon.remove(inlineTitleEl);
    expect(inlineTitleEl.innerHTML).toEqual('<div></div>');
  });

  it('should not remove the title icon element, if the parent container does not exist', () => {
    const inlineTitleEl = document.createElement('div');
    inlineTitleEl.innerHTML = '<div></div>';
    titleIcon.remove(inlineTitleEl);
    expect(inlineTitleEl.innerHTML).toEqual('<div></div>');
  });
});
