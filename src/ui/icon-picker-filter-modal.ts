import { App, Modal, Setting } from 'obsidian';

/** 可选的图标家族 / A selectable icon family. */
export interface PickerFamily {
  name: string;
  prefix: string;
  size: number;
}

/** 选择器过滤状态 / Picker filter state. */
export interface PickerFilterState {
  /** 选中的图标包名；空集合表示全部。 / Selected pack names; empty means all. */
  packs: Set<string>;
  fuzzy: boolean;
  sortByRelevance: boolean;
}

/**
 * 图标家族与搜索过滤 / Icon family and search filters.
 *
 * 「Emoji」作为伪家族存在：选中它才显示 emoji 结果；不选任何家族时显示全部。
 * 「Emoji」is a pseudo-family: emoji results appear only when it is selected; selecting
 * no family means everything.
 */
export default class IconPickerFilterModal extends Modal {
  private selected: Set<string>;
  private fuzzy: boolean;
  private relevance: boolean;
  private query = '';
  private listEl!: HTMLElement;
  private countEl!: HTMLElement;
  private settled = false;

  constructor(
    app: App,
    private families: PickerFamily[],
    state: PickerFilterState,
    private resolve: (state: PickerFilterState | null) => void,
  ) {
    super(app);
    this.selected = new Set(state.packs);
    this.fuzzy = state.fuzzy;
    this.relevance = state.sortByRelevance;
    this.setTitle('图标过滤器 / Icon filters');
  }

  onOpen(): void {
    this.contentEl.createEl('p', {
      text: '多选要显示的图标家族；不选表示全部。Emoji 需要单独勾选才显示。',
    });
    new Setting(this.contentEl)
      .setName('搜索家族 / Search families')
      .addSearch((search) =>
        search.setPlaceholder('按名称或前缀筛选').onChange((value) => {
          this.query = value.trim().toLowerCase();
          this.renderList();
        }),
      );
    this.countEl = this.contentEl.createEl('p', {
      cls: 'iconize-picker-family-count',
    });
    this.listEl = this.contentEl.createDiv({
      cls: 'iconize-picker-family-list',
    });
    this.renderList();

    new Setting(this.contentEl)
      .setName('模糊搜索 / Fuzzy search')
      .setDesc('允许字符不连续匹配，例如 hrt 也能找到 Heart。')
      .addToggle((toggle) =>
        toggle.setValue(this.fuzzy).onChange((value) => {
          this.fuzzy = value;
        }),
      );
    new Setting(this.contentEl)
      .setName('按相关性排序 / Sort by relevance')
      .setDesc('精确名称优先，其次是前缀、包含和模糊匹配；关闭后保持索引顺序。')
      .addToggle((toggle) =>
        toggle.setValue(this.relevance).onChange((value) => {
          this.relevance = value;
        }),
      );
    new Setting(this.contentEl)
      .addButton((button) =>
        button.setButtonText('清空选择 / Clear').onClick(() => {
          this.selected.clear();
          this.renderList();
        }),
      )
      .addButton((button) =>
        button.setButtonText('取消 / Cancel').onClick(() => this.settle(null)),
      )
      .addButton((button) =>
        button
          .setButtonText('应用 / Apply')
          .setCta()
          .onClick(() =>
            this.settle({
              packs: new Set(this.selected),
              fuzzy: this.fuzzy,
              sortByRelevance: this.relevance,
            }),
          ),
      )
      .settingEl.addClass('iconize-modal-footer');
  }

  private renderList(): void {
    this.listEl.empty();
    const matches = this.families.filter((family) => {
      if (!this.query) return true;
      return (
        family.name.toLowerCase().includes(this.query) ||
        family.prefix.toLowerCase().includes(this.query)
      );
    });
    for (const family of matches) {
      const row = this.listEl.createEl('label', {
        cls: 'iconize-picker-family-row',
      });
      const checkbox = row.createEl('input', { type: 'checkbox' });
      checkbox.checked = this.selected.has(family.name);
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) this.selected.add(family.name);
        else this.selected.delete(family.name);
        this.updateCount();
      });
      row.createSpan({
        cls: 'iconize-picker-family-name',
        text: family.name,
      });
      row.createSpan({
        cls: 'iconize-picker-family-prefix',
        text: family.prefix,
      });
      if (family.size)
        row.createSpan({
          cls: 'iconize-picker-family-size',
          text: `${family.size}`,
        });
    }
    if (!matches.length)
      this.listEl.createEl('p', { text: '没有匹配的图标家族。' });
    this.updateCount();
  }

  private updateCount(): void {
    this.countEl.setText(
      `已选 ${this.selected.size} / ${this.families.length} 个家族；不选表示全部`,
    );
  }

  private settle(state: PickerFilterState | null): void {
    if (this.settled) return;
    this.settled = true;
    this.resolve(state);
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
