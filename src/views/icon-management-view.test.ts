import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { App, WorkspaceLeaf } from 'obsidian';
import type IconizePlugin from '@app/main';
import type { IconPack } from '@app/icon-pack-manager/icon-pack';

const state = vi.hoisted(() => ({
  notices: [] as string[],
  modals: [] as { contentEl: HTMLElement; close(): void }[],
  readFile: vi.fn(async (_file: File) => '<svg></svg>'),
  indexPack: vi.fn(async () => 1),
}));
vi.mock('obsidian', () => {
  class ItemView {
    contentEl = document.createElement('div');
    app: App;
    constructor(leaf: WorkspaceLeaf & { app: App }) {
      this.app = leaf.app;
      document.body.append(this.contentEl);
    }
  }
  class Modal {
    contentEl = document.createElement('div');
    titleEl = document.createElement('h2');
    open() {
      document.body.append(this.contentEl);
      state.modals.push(this);
      this.onOpen();
    }
    close() {
      this.onClose();
      this.contentEl.remove();
    }
    onOpen() {}
    onClose() {}
  }
  class Button {
    buttonEl: HTMLButtonElement;
    constructor(parent: HTMLElement) {
      this.buttonEl = parent.createEl('button');
    }
    setButtonText(value: string) {
      this.buttonEl.textContent = value;
      return this;
    }
    setTooltip() {
      return this;
    }
    setWarning() {
      return this;
    }
    setDisabled(value: boolean) {
      this.buttonEl.disabled = value;
      return this;
    }
    onClick(callback: () => void) {
      this.buttonEl.addEventListener('click', callback);
      return this;
    }
  }
  class Input {
    inputEl: HTMLInputElement;
    constructor(parent: HTMLElement) {
      this.inputEl = parent.createEl('input');
    }
    setPlaceholder(value: string) {
      this.inputEl.placeholder = value;
      return this;
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
  class Dropdown {
    selectEl: HTMLSelectElement;
    constructor(parent: HTMLElement) {
      this.selectEl = parent.createEl('select');
    }
    addOptions(options: Record<string, string>) {
      for (const [value, text] of Object.entries(options))
        this.selectEl.createEl('option', { text, value });
      return this;
    }
    setValue(value: string) {
      this.selectEl.value = value;
      return this;
    }
    setDisabled(value: boolean) {
      this.selectEl.disabled = value;
      return this;
    }
    onChange(callback: (value: string) => void) {
      this.selectEl.addEventListener('change', () =>
        callback(this.selectEl.value),
      );
      return this;
    }
  }
  class Setting {
    settingEl: HTMLElement;
    constructor(parent: HTMLElement) {
      this.settingEl = parent.createDiv();
    }
    setName(value: string) {
      this.settingEl.createSpan({ text: value });
      return this;
    }
    setDesc(value: string) {
      this.settingEl.createSpan({ text: value });
      return this;
    }
    setHeading() {
      return this;
    }
    addButton(callback: (button: Button) => void) {
      callback(new Button(this.settingEl));
      return this;
    }
    addText(callback: (input: Input) => void) {
      callback(new Input(this.settingEl));
      return this;
    }
    addSearch(callback: (input: Input) => void) {
      callback(new Input(this.settingEl));
      return this;
    }
    addDropdown(callback: (input: Dropdown) => void) {
      callback(new Dropdown(this.settingEl));
      return this;
    }
  }
  return {
    ItemView,
    Modal,
    Setting,
    Notice: class {
      message: string;
      constructor(message: string, _timeout?: number) {
        this.message = message;
        state.notices.push(message);
      }
      setMessage(message: string) {
        this.message = message;
        state.notices.push(message);
      }
      hide() {}
    },
  };
});
vi.mock('@app/icon-pack-manager/lucide', () => ({
  LUCIDE_ICON_PACK_NAME: 'lucide-icons',
}));
vi.mock('@app/ui/icon-pack-browser-modal', () => ({ default: class {} }));
vi.mock('@app/util', () => ({ readFileSync: state.readFile }));
vi.mock('@app/lib/icon', () => ({
  default: { checkMissingIcons: vi.fn(async () => {}) },
}));
vi.mock('@app/lib/logger', () => ({ logger: { error: vi.fn() } }));
vi.mock('@app/lib/lazy-loading-integration', () => ({
  indexAndRegisterPack: state.indexPack,
}));
import { IconManagementView } from './icon-management-view';

beforeAll(() => {
  HTMLElement.prototype.addClass = function (...classes) {
    this.classList.add(...classes);
  };
  HTMLElement.prototype.empty = function () {
    this.replaceChildren();
  };
});
beforeEach(() => {
  document.body.replaceChildren();
  state.notices.length = 0;
  state.modals.length = 0;
});

function pack(name: string, custom = false): IconPack {
  return {
    getName: () => name,
    getPrefix: () => name,
    size: 2,
    getSource: () => undefined,
    isCustomPack: () => custom,
  } as unknown as IconPack;
}
async function fixture(packs: IconPack[] = []) {
  const listeners = new Set<() => void>();
  const views: IconManagementView[] = [];
  const settings = { lucideIconPackType: 'native' };
  const lucide = {
    addCustom: vi.fn(async () => {}),
    removeCustom: vi.fn(async () => {}),
    init: vi.fn(() =>
      settings.lucideIconPackType === 'native'
        ? pack('lucide-icons')
        : undefined,
    ),
  };
  const createFile = vi.fn(async () => {});
  const manager = {
    getIconPacks: () => packs,
    getIconPackByName: (name: string) =>
      packs.find((item) => item.getName() === name),
    registerIconPack: vi.fn(async () => {}),
    importIconPackFromFiles: vi.fn(async () => ({
      name: 'new',
      format: 'svg-archive',
      label: 'SVG 图标包',
      iconCount: 2,
      skipped: 0,
      warnings: [],
      suggestedName: 'new',
    })),
    getFileManager: () => ({ createFile }),
    getPath: () => 'icons',
    removeIconPack: vi.fn(async (selected: IconPack) => {
      packs.splice(packs.indexOf(selected), 1);
    }),
    getLucideIconPack: () => lucide,
  };
  const app = {
    vault: {
      adapter: {
        exists: vi.fn(async () => false),
        rename: vi.fn(async () => {}),
        remove: vi.fn(async () => {}),
        rmdir: vi.fn(async () => {}),
      },
    },
    workspace: { getLeavesOfType: () => views.map((view) => ({ view })) },
  } as unknown as App;
  const plugin = {
    app,
    getIconPackManager: () => manager,
    getSettings: () => settings,
    getData: () => ({}),
    saveIconFolderData: vi.fn(async () => {}),
    isIconLoadingComplete: () => true,
    iconResolver: {},
    getEventEmitter: () => ({
      on: (_event: string, callback: () => void) => listeners.add(callback),
      off: (_event: string, callback: () => void) => listeners.delete(callback),
    }),
    trackModal: vi.fn(),
    releaseModal: vi.fn(),
  } as unknown as IconizePlugin;
  const view = new IconManagementView(
    { app } as unknown as WorkspaceLeaf,
    plugin,
  );
  views.push(view);
  await view.onOpen();
  return {
    view,
    plugin,
    manager,
    settings,
    lucide,
    createFile,
    emit: () => listeners.forEach((callback) => callback()),
  };
}
function button(root: HTMLElement, text: string): HTMLButtonElement {
  return Array.from(root.querySelectorAll('button')).find(
    (el) => el.textContent === text,
  )!;
}
function type(
  root: HTMLElement,
  placeholder: string,
  value: string,
): HTMLInputElement {
  const input = root.querySelector<HTMLInputElement>(
    `input[placeholder="${placeholder}"]`,
  )!;
  input.value = value;
  input.dispatchEvent(new Event('input'));
  return input;
}
function selectFile(root: HTMLElement, label: string, file: File): void {
  const click = vi
    .spyOn(HTMLInputElement.prototype, 'click')
    .mockImplementation(() => {});
  button(root, label).click();
  const selected = click.mock.instances[0] as HTMLInputElement;
  click.mockRestore();
  Object.defineProperty(selected, 'files', { value: [file] });
  selected.dispatchEvent(new Event('change'));
}
async function flush() {
  for (let i = 0; i < 24; i++) await Promise.resolve();
}

describe('icon pack management view', () => {
  it('pages by 50 and preserves inputs, focus and scroll through metadata refresh', async () => {
    const f = await fixture(
      Array.from({ length: 125 }, (_, index) => pack(`pack-${index}`)),
    );
    const root = f.view.contentEl;
    expect(root.querySelectorAll('.iconize-pack-row')).toHaveLength(50);
    button(root, '加载更多').click();
    expect(root.querySelectorAll('.iconize-pack-row')).toHaveLength(100);
    button(root, '加载更多').click();
    expect(root.querySelectorAll('.iconize-pack-row')).toHaveLength(125);
    const name = type(root, '图标包名称', 'unsaved-name');
    const search = type(root, '搜索图标包', 'pack-12');
    search.focus();
    root.scrollTop = 180;
    f.emit();
    expect(root.querySelector('input[placeholder="图标包名称"]')).toBe(name);
    expect(name.value).toBe('unsaved-name');
    expect(document.activeElement).toBe(search);
    expect(root.scrollTop).toBe(180);
    expect(root.querySelectorAll('.iconize-pack-row')).toHaveLength(6);
  });

  it('does not commit ZIP bytes after closing while file reading is pending', async () => {
    const f = await fixture();
    let finish!: (bytes: ArrayBuffer) => void;
    const file = new File([], 'new.zip');
    file.arrayBuffer = () =>
      new Promise<ArrayBuffer>((resolve) => {
        finish = resolve;
      });
    selectFile(f.view.contentEl, '导入', file);
    await f.view.onClose();
    finish(new ArrayBuffer(0));
    await flush();
    expect(f.manager.importIconPackFromFiles).not.toHaveBeenCalled();
    expect(state.notices).toEqual([]);
  });

  it('imports any supported file through the normalizer entry point', async () => {
    const f = await fixture();
    const bytes = new Uint8Array([1, 2, 3]);
    const file = new File([bytes], 'lucide.zip');
    file.arrayBuffer = async () => bytes.buffer;
    selectFile(f.view.contentEl, '导入', file);
    await flush();
    expect(f.manager.importIconPackFromFiles).toHaveBeenCalledTimes(1);
    const [inputs] = f.manager.importIconPackFromFiles.mock.calls[0];
    expect(inputs).toEqual([{ fileName: 'lucide.zip', bytes }]);
    expect(state.notices.some((notice) => notice.includes('已导入 new'))).toBe(
      true,
    );
  });

  it('locks SVG import against deletion and stops after the selected pack was replaced', async () => {
    const selected = pack('custom', true);
    const packs = [selected];
    const f = await fixture(packs);
    let finish!: (svg: string) => void;
    state.readFile.mockImplementationOnce(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    selectFile(f.view.contentEl, '添加 SVG', new File([], 'moon.svg'));
    expect(button(f.view.contentEl, '添加 SVG').disabled).toBe(true);
    expect(button(f.view.contentEl, '删除').disabled).toBe(true);
    packs[0] = pack('custom', true);
    finish('<svg></svg>');
    await flush();
    expect(f.createFile).not.toHaveBeenCalled();
    expect(state.indexPack).not.toHaveBeenCalled();
  });

  it('refuses a stale delete confirmation and deletes only the chosen current pack', async () => {
    const packs = [pack('a'), pack('b'), pack('c')];
    const f = await fixture(packs);
    const deletes = () =>
      Array.from(f.view.contentEl.querySelectorAll('button')).filter(
        (el) => el.textContent === '删除',
      );
    deletes()[1].click();
    const stale = state.modals[0];
    packs[1] = pack('b');
    button(stale.contentEl, '删除').click();
    expect(f.manager.removeIconPack).not.toHaveBeenCalled();
    deletes()[1].click();
    button(state.modals[1].contentEl, '删除').click();
    await flush();
    expect(packs.map((item) => item.getName())).toEqual(['a', 'c']);
  });

  it('rolls Lucide settings back if downloading the custom pack fails', async () => {
    const f = await fixture();
    f.lucide.addCustom.mockRejectedValueOnce(new Error('offline'));
    const select = f.view.contentEl.querySelector('select')!;
    select.value = 'custom';
    select.dispatchEvent(new Event('change'));
    await flush();
    expect(f.settings.lucideIconPackType).toBe('native');
    expect(f.plugin.saveIconFolderData).not.toHaveBeenCalled();
    expect(select.disabled).toBe(false);
    expect(select.value).toBe('native');
  });

  it('switches native to none and back without removing an absent pack', async () => {
    const original = pack('lucide-icons');
    const f = await fixture([original]);
    const select = f.view.contentEl.querySelector('select')!;
    select.value = 'none';
    select.dispatchEvent(new Event('change'));
    await flush();
    expect(f.manager.getIconPackByName('lucide-icons')).toBeUndefined();
    expect(f.manager.removeIconPack).toHaveBeenCalledTimes(1);
    select.value = 'native';
    select.dispatchEvent(new Event('change'));
    await flush();
    expect(f.manager.getIconPackByName('lucide-icons')).toBeDefined();
    expect(f.manager.removeIconPack).toHaveBeenCalledTimes(1);
  });

  it('restores the original Lucide pack and resources if persisting a switch fails', async () => {
    const original = pack('lucide-icons');
    const f = await fixture([original]);
    const adapter = f.plugin.app.vault.adapter;
    vi.mocked(adapter.exists)
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    vi.mocked(f.plugin.saveIconFolderData).mockRejectedValueOnce(
      new Error('disk full'),
    );
    const select = f.view.contentEl.querySelector('select')!;
    select.value = 'none';
    select.dispatchEvent(new Event('change'));
    await flush();
    expect(f.settings.lucideIconPackType).toBe('native');
    expect(f.manager.getIconPackByName('lucide-icons')).toBe(original);
    expect(adapter.rename).toHaveBeenCalledTimes(2);
    expect(vi.mocked(adapter.rename).mock.calls[1][1]).toBe(
      'icons/lucide-icons.zip',
    );
    expect(adapter.remove).not.toHaveBeenCalled();
  });
});
