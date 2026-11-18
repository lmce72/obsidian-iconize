import { App } from 'obsidian';
import type IconizePlugin from '@app/main';
import emoji from '@app/emoji';
import icon from '@app/lib/icon';
import { getFolderNoteInheritedIcon } from '@app/lib/folder-note';
import dom from '@app/lib/util/dom';
import { saveIconToIconPack } from '@app/util';
import ChangeColorModal from './change-color-modal';
import IconsPickerModal from './icons-picker-modal';

/** 在两个弹窗间保存未提交草稿。 / Preserve the uncommitted draft between dialogs. */
export class IconEditSession {
  private color?: string;
  private iconId?: string;
  private iconChanged = false;
  private query = '';
  private origin: 'picker' | 'color' = 'picker';
  onSelect?: (iconName: string) => void;

  constructor(
    private app: App,
    private plugin: IconizePlugin,
    private path: string,
  ) {
    this.color = plugin.getIconColor(path);
    this.iconId =
      icon.getByPath(plugin, path) || getFolderNoteInheritedIcon(plugin, path);
  }

  openPicker(): void {
    this.origin = 'picker';
    this.showPicker();
  }

  openColor(): void {
    this.origin = 'color';
    this.showColor();
  }

  private showPicker(): void {
    const picker = new IconsPickerModal(
      this.app,
      this.plugin,
      this.path,
      this.color,
      true,
    );
    picker.initialQuery = this.query;
    picker.onSelect = (id) => this.onSelect?.(id);
    picker.onColor = (color, query) => {
      this.color = color;
      this.query = query;
      this.showColor();
    };
    if (this.origin === 'color') {
      picker.onDraftSelect = (id, query) => {
        this.iconId = id;
        this.iconChanged = true;
        this.query = query;
        this.showColor();
      };
    }
    picker.open();
  }

  private showColor(): void {
    const modal = new ChangeColorModal(this.app, this.plugin, this.path, {
      color: this.color,
      iconId: this.iconId,
      editIcon: (color) => {
        this.color = color;
        this.showPicker();
      },
      save: async (color, signal) => {
        this.color = color;
        if (this.origin === 'picker') return;
        if (this.iconChanged && this.iconId) {
          await this.plugin.selectIcon(this.path, this.iconId, color);
          if (signal.aborted) return;
          dom.createIconNode(this.plugin, this.path, this.iconId);
          this.onSelect?.(this.iconId);
          if (!emoji.isEmoji(this.iconId))
            saveIconToIconPack(this.plugin, this.iconId);
          this.plugin.notifyPlugins();
        } else await this.plugin.changeIconColor(this.path, color);
      },
      notifySave: this.origin === 'color',
      afterSave: this.origin === 'picker' ? () => this.showPicker() : undefined,
    });
    modal.open();
  }
}
