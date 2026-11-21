import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { App } from 'obsidian';
import type IconizePlugin from '@app/main';
import type { Icon } from '@app/icon-pack-manager';

const state = vi.hoisted(() => ({ notices: [] as string[] }));
vi.mock('obsidian', () => {
  class Modal {
    modalEl = document.createElement('div');
    contentEl = document.createElement('div');
    constructor() {
      this.modalEl.appendChild(this.contentEl);
    }
    setTitle() {}
    open() {
      document.body.appendChild(this.modalEl);
      this.onOpen();
    }
    close() {
      this.onClose();
      this.modalEl.remove();
    }
    onOpen() {}
    onClose() {}
  }
  class SuggestModal extends Modal {
    inputEl = document.createElement('input');
    resultContainerEl = document.createElement('div');
    limit = 100;
    constructor() {
      super();
      const toolbar = document.createElement('div');
      toolbar.appendChild(this.inputEl);
      this.contentEl.append(toolbar, this.resultContainerEl);
    }
    setPlaceholder() {}
    onClose() {
      this.inputEl.value = '';
    }
  }
  class ColorComponent {
    inputEl: HTMLInputElement;
    constructor(parent: HTMLElement) {
      this.inputEl = parent.createEl('input', { type: 'color' });
    }
    setValue(value: string) {
      this.inputEl.value = value;
      return this;
    }
    onChange(callback: (value: string) => void) {
      this.inputEl.addEventListener('input', () =>
        callback(this.inputEl.value),
      );
      return this;
    }
  }
  class ButtonComponent {
    buttonEl: HTMLButtonElement;
    constructor(parent: HTMLElement) {
      this.buttonEl = parent.createEl('button');
    }
    setButtonText(text: string) {
      this.buttonEl.textContent = text;
      return this;
    }
    setTooltip() {
      return this;
    }
    setCta() {
      return this;
    }
    setDisabled(disabled: boolean) {
      this.buttonEl.disabled = disabled;
      return this;
    }
    onClick(callback: () => void) {
      this.buttonEl.addEventListener('click', callback);
      return this;
    }
  }
  return {
    Modal,
    SuggestModal,
    ColorComponent,
    ButtonComponent,
    Notice: class {
      constructor(message: string) {
        state.notices.push(message);
      }
    },
    setIcon: (element: HTMLElement, id: string) => {
      element.textContent = id;
    },
    sanitizeHTMLToDom: (markup: string) => {
      const fragment = document.createDocumentFragment();
      const parsed = new DOMParser().parseFromString(markup, 'text/html');
      fragment.append(...Array.from(parsed.body.childNodes));
      return fragment;
    },
  };
});
vi.mock('@app/lib/logger', () => ({
  logger: { error: vi.fn(), warn: vi.fn() },
}));
vi.mock('@app/lib/icon', () => ({ default: { getByPath: () => undefined } }));
vi.mock('@app/lib/folder-note', () => ({
  getFolderNoteInheritedIcon: () => undefined,
}));
vi.mock('@app/lib/util/dom', () => ({
  default: { createIconNode: vi.fn(), setIconForNode: vi.fn() },
}));
vi.mock('@app/util', () => ({ saveIconToIconPack: vi.fn() }));

import ChangeColorModal from './change-color-modal';
import IconsPickerModal from './icons-picker-modal';

beforeAll(() => {
  HTMLElement.prototype.addClass = function (...classes) {
    this.classList.add(...classes);
  };
  HTMLElement.prototype.removeClass = function (...classes) {
    this.classList.remove(...classes);
  };
  HTMLElement.prototype.toggleClass = function (name, enabled) {
    this.classList.toggle(name, enabled);
  };
  HTMLElement.prototype.setAttr = function (name, value) {
    this.setAttribute(name, String(value));
  };
  HTMLElement.prototype.empty = function () {
    this.replaceChildren();
  };
  HTMLElement.prototype.setCssProps = function (props) {
    for (const [name, value] of Object.entries(props))
      this.style.setProperty(name, value);
  };
});
beforeEach(() => {
  state.notices.length = 0;
  document.body.replaceChildren();
});

function fixture() {
  return {
    getSettings: () => ({ iconColor: '#aabbcc', emojiStyle: 'native' }),
    getIconColor: () => undefined,
    trackModal: vi.fn(),
    releaseModal: vi.fn(),
    conversion: { getSvg: vi.fn(async () => '<svg></svg>') },
    changeIconColor: vi.fn(async () => {}),
  } as unknown as IconizePlugin;
}
function button(modal: ChangeColorModal, text: string): HTMLButtonElement {
  return Array.from(modal.contentEl.querySelectorAll('button')).find(
    (el) => el.textContent === text,
  )!;
}
const flushSave = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('color editor lifecycle', () => {
  it('locks edits and double-save while pending; closing suppresses late notices and navigation', async () => {
    let finish!: () => void;
    const save = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const editIcon = vi.fn();
    const afterSave = vi.fn();
    const modal = new ChangeColorModal({} as App, fixture(), 'a.md', {
      save,
      editIcon,
      afterSave,
    });
    modal.open();
    const saveButton = button(modal, '保存');
    const preview = modal.contentEl.querySelector<HTMLButtonElement>(
      '.iconize-color-preview-frame',
    )!;
    saveButton.click();
    saveButton.click();
    preview.click();
    expect(save).toHaveBeenCalledTimes(1);
    expect(preview.disabled).toBe(true);
    expect(editIcon).not.toHaveBeenCalled();
    button(modal, '取消').click();
    finish();
    await flushSave();
    expect(afterSave).not.toHaveBeenCalled();
    expect(state.notices).toEqual([]);
  });

  it('shows a hint under the preview block that names the click action', () => {
    const modal = new ChangeColorModal({} as App, fixture(), 'a.md');
    modal.open();
    const previewIcon = modal.contentEl.querySelector(
      '.iconize-color-preview-icon',
    )!;
    expect(previewIcon.querySelector('.iconize-color-preview-frame')).not.toBe(
      null,
    );
    expect(
      previewIcon.querySelector('.iconize-color-preview-hint')?.textContent,
    ).toBe('点击更改图标');
    modal.close();
  });

  it('keeps the draft and unlocks controls when saving fails synchronously', async () => {
    const save = vi
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('write failed');
      })
      .mockResolvedValue(undefined);
    const modal = new ChangeColorModal({} as App, fixture(), 'a.md', {
      color: '#112233',
      save,
    });
    modal.open();
    const saveButton = button(modal, '保存');
    saveButton.click();
    await flushSave();
    expect(saveButton.disabled).toBe(false);
    expect(
      modal.contentEl.querySelector('.iconize-color-value')?.textContent,
    ).toBe('#112233');
    expect(state.notices).toHaveLength(1);
    saveButton.click();
    await flushSave();
    expect(save).toHaveBeenLastCalledWith('#112233', expect.any(AbortSignal));
  });

  it('renders emoji as emoji and saves explicit reset as undefined', async () => {
    const plugin = fixture();
    const save = vi.fn(async () => {});
    const modal = new ChangeColorModal({} as App, plugin, 'a.md', {
      iconId: '🌙',
      color: '#112233',
      save,
    });
    modal.open();
    expect(
      modal.contentEl.querySelector('.iconize-icon-preview')?.textContent,
    ).toBe('🌙');
    expect(plugin.conversion.getSvg).not.toHaveBeenCalled();
    expect(
      modal.contentEl.querySelector('.iconize-preview-colored'),
    ).toBeNull();
    button(modal, '恢复默认').click();
    expect(
      modal.contentEl.style.getPropertyValue('--iconize-picker-color'),
    ).toBe('#aabbcc');
    button(modal, '保存').click();
    await flushSave();
    expect(save).toHaveBeenCalledWith(undefined, expect.any(AbortSignal));
  });
});

describe('picker draft', () => {
  it('shows global default without turning it into a saved override', () => {
    const picker = new IconsPickerModal(
      {} as App,
      fixture(),
      'a.md',
      undefined,
      true,
    );
    expect(picker.selectedColor).toBeUndefined();
    expect(
      picker.resultContainerEl.style.getPropertyValue(
        '--iconize-preview-color',
      ),
    ).toBe('#aabbcc');
    expect(
      picker.resultContainerEl.classList.contains('iconize-preview-colored'),
    ).toBe(true);
  });

  it('preserves the query when SDK closes and clears the input before choosing', () => {
    const picker = new IconsPickerModal({} as App, fixture(), 'a.md');
    const select = vi.fn();
    picker.onDraftSelect = select;
    picker.inputEl.value = 'moon';
    picker.close();
    expect(picker.inputEl.value).toBe('');
    picker.onChooseSuggestion({ displayName: 'LuMoon' } as Icon);
    expect(select).toHaveBeenCalledWith('LuMoon', 'moon');
  });
});
