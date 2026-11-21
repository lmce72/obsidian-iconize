import { App, Modal, Setting } from 'obsidian';
import {
  MAX_ICONIFY_JSON_BYTES,
  type IconifySetInfo,
} from '@app/lib/pack-import';

/**
 * 从归档中选择 Iconify 图标集 / Picks Iconify sets from an archive.
 *
 * Iconify 的 icon-sets 仓库包含数百个 JSON 图标集；一次导入全部会产生非常大的
 * 归档。这里只列出集合名，不提前解析每个 JSON，勾选后才读取。
 *
 * The Iconify icon-sets repository contains hundreds of JSON sets; importing all of them
 * at once produces a very large archive. Only names are listed here; a JSON is read only
 * after it is selected.
 */
export default class IconifySetPickerModal extends Modal {
  private selected = new Set<string>();
  private query = '';
  private listEl!: HTMLElement;
  private countEl!: HTMLElement;
  private statusEl!: HTMLElement;
  private settled = false;

  constructor(
    app: App,
    private sets: IconifySetInfo[],
    private resolve: (paths: string[] | null) => void,
  ) {
    super(app);
    this.setTitle('选择 Iconify 图标集 / Choose Iconify sets');
  }

  onOpen(): void {
    this.contentEl.createEl('p', {
      text: `归档包含 ${this.sets.length} 个 Iconify 图标集。勾选要导入的集合；选择多个时，每个集合的 prefix 会作为图标目录，避免同名冲突。全部导入可能包含数十万图标。`,
    });
    new Setting(this.contentEl).setName('搜索 / Search').addSearch((search) =>
      search.setPlaceholder('按 prefix 筛选').onChange((value) => {
        this.query = value.trim().toLowerCase();
        this.renderList();
      }),
    );
    new Setting(this.contentEl)
      .setName('已选 / Selected')
      .setDesc('只读取勾选的 JSON。')
      .addButton((button) =>
        button.setButtonText('全选 / All').onClick(() => {
          for (const set of this.sets)
            if ((set.size ?? 0) <= MAX_ICONIFY_JSON_BYTES)
              this.selected.add(set.path);
          this.renderList();
        }),
      )
      .addButton((button) =>
        button.setButtonText('清空 / Clear').onClick(() => {
          this.selected.clear();
          this.renderList();
        }),
      );
    this.countEl = this.contentEl.createEl('p', {
      cls: 'iconize-iconify-set-count',
    });
    this.listEl = this.contentEl.createDiv({
      cls: 'iconize-iconify-set-list',
    });
    this.statusEl = this.contentEl.createEl('p', { attr: { role: 'status' } });
    this.renderList();
    new Setting(this.contentEl)
      .addButton((button) =>
        button.setButtonText('取消 / Cancel').onClick(() => this.settle(null)),
      )
      .addButton((button) =>
        button
          .setButtonText('导入所选 / Import selected')
          .setCta()
          .onClick(() => {
            if (!this.selected.size) {
              this.statusEl.setText('请至少选择一个图标集。');
              return;
            }
            this.settle(
              this.sets
                .filter((set) => this.selected.has(set.path))
                .map((set) => set.path),
            );
          }),
      );
  }

  private renderList(): void {
    this.listEl.empty();
    const matches = this.sets.filter((set) => {
      if (!this.query) return true;
      return (
        set.prefix.toLowerCase().includes(this.query) ||
        set.path.toLowerCase().includes(this.query) ||
        (set.name ?? '').toLowerCase().includes(this.query)
      );
    });
    for (const set of matches) {
      const tooLarge = (set.size ?? 0) > MAX_ICONIFY_JSON_BYTES;
      const label = this.listEl.createEl('label', {
        cls: `iconize-iconify-set-row${tooLarge ? ' is-too-large' : ''}`,
      });
      const checkbox = label.createEl('input', { type: 'checkbox' });
      checkbox.checked = !tooLarge && this.selected.has(set.path);
      checkbox.disabled = tooLarge;
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) this.selected.add(set.path);
        else this.selected.delete(set.path);
        this.updateCount();
      });
      label.createSpan({
        cls: 'iconize-iconify-set-prefix',
        text: set.prefix,
      });
      if (set.size)
        label.createSpan({
          cls: 'iconize-iconify-set-size',
          text: `${(set.size / 1024 / 1024).toFixed(1)} MB${
            tooLarge ? ' · 过大' : ''
          }`,
        });
      label.createSpan({
        cls: 'iconize-iconify-set-path',
        text: set.path,
      });
      if (tooLarge)
        label.setAttribute(
          'title',
          `超过 ${Math.round(
            MAX_ICONIFY_JSON_BYTES / 1024 / 1024,
          )} MB，单包转换会耗尽内存，已禁用`,
        );
    }
    if (!matches.length)
      this.listEl.createEl('p', { text: '没有匹配的图标集。' });
    this.updateCount();
  }

  private updateCount(): void {
    this.countEl.setText(
      `已选 ${this.selected.size} / ${this.sets.length} 个图标集`,
    );
  }

  private settle(paths: string[] | null): void {
    if (this.settled) return;
    this.settled = true;
    this.resolve(paths);
    this.close();
  }

  onClose(): void {
    if (!this.settled) {
      this.settled = true;
      this.resolve(null);
    }
    this.contentEl.empty();
  }
}
