import { describe, expect, it, vi } from 'vitest';
import type IconizePlugin from '@app/main';
import type { App } from 'obsidian';

const modals = vi.hoisted(() => ({
  pickers: [] as MockPicker[],
  colors: [] as MockColor[],
}));
interface MockPicker {
  initialQuery: string;
  onColor?: (color: string | undefined, query: string) => void;
  onDraftSelect?: (id: string, query: string) => void;
  onSelect?: (id: string) => void;
  open(): void;
}
interface MockColor {
  options: {
    color?: string;
    iconId?: string;
    editIcon(color: string | undefined): void;
    save(color: string | undefined, signal: AbortSignal): Promise<void>;
    afterSave?: () => void;
  };
  open(): void;
}
vi.mock('./icons-picker-modal', () => ({
  default: class {
    initialQuery = '';
    constructor() {
      modals.pickers.push(this);
    }
    open() {}
  },
}));
vi.mock('./change-color-modal', () => ({
  default: class {
    constructor(
      _app: unknown,
      _plugin: unknown,
      _path: unknown,
      public options: MockColor['options'],
    ) {
      modals.colors.push(this);
    }
    open() {}
  },
}));
vi.mock('@app/lib/icon', () => ({ default: { getByPath: () => 'Old' } }));
vi.mock('@app/lib/folder-note', () => ({
  getFolderNoteInheritedIcon: () => undefined,
}));
vi.mock('@app/emoji', () => ({ default: { isEmoji: () => true } }));
vi.mock('@app/lib/util/dom', () => ({ default: { createIconNode: vi.fn() } }));
vi.mock('@app/util', () => ({ saveIconToIconPack: vi.fn() }));
import { IconEditSession } from './icon-edit-session';

function fixture() {
  modals.colors.length = 0;
  modals.pickers.length = 0;
  const selectIcon = vi.fn(async () => {});
  const changeIconColor = vi.fn(async () => {});
  const plugin = {
    getIconColor: () => '#112233',
    selectIcon,
    changeIconColor,
    notifyPlugins: vi.fn(),
  } as unknown as IconizePlugin;
  return {
    session: new IconEditSession({} as App, plugin, 'a.md'),
    selectIcon,
    changeIconColor,
    notifyPlugins: plugin.notifyPlugins,
  };
}

describe('icon editing draft', () => {
  it('preserves unsaved color and query across switches, committing only on save', async () => {
    const f = fixture();
    f.session.openColor();
    modals.colors[0].options.editIcon('#ff0000');
    modals.pickers[0].onDraftSelect?.('New', 'moon');
    expect(f.selectIcon).not.toHaveBeenCalled();
    expect(f.changeIconColor).not.toHaveBeenCalled();
    expect(modals.colors[1].options).toMatchObject({
      color: '#ff0000',
      iconId: 'New',
    });
    modals.colors[1].options.editIcon('#00ff00');
    expect(modals.pickers[1].initialQuery).toBe('moon');
    modals.pickers[1].onDraftSelect?.('New', 'moon');
    await modals.colors[2].options.save(
      '#00ff00',
      new AbortController().signal,
    );
    expect(f.selectIcon).toHaveBeenCalledWith('a.md', 'New', '#00ff00');
    expect(f.changeIconColor).not.toHaveBeenCalled();
  });

  it('keeps picker color changes as a draft and returns to the same query', async () => {
    const f = fixture();
    f.session.openPicker();
    modals.pickers[0].onColor?.('#112233', 'star');
    await modals.colors[0].options.save(
      undefined,
      new AbortController().signal,
    );
    expect(f.selectIcon).not.toHaveBeenCalled();
    expect(f.changeIconColor).not.toHaveBeenCalled();
    modals.colors[0].options.afterSave?.();
    expect(modals.pickers[1].initialQuery).toBe('star');
  });

  it('does not run late selection callbacks when the saving modal was dismissed', async () => {
    const f = fixture();
    const onSelect = vi.fn();
    f.session.onSelect = onSelect;
    let finish!: () => void;
    f.selectIcon.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    f.session.openColor();
    modals.colors[0].options.editIcon('#ff0000');
    modals.pickers[0].onDraftSelect?.('New', 'moon');
    const lifetime = new AbortController();
    const saving = modals.colors[1].options.save('#ff0000', lifetime.signal);
    lifetime.abort();
    finish();
    await saving;
    expect(onSelect).not.toHaveBeenCalled();
    expect(f.notifyPlugins).not.toHaveBeenCalled();
  });
});
