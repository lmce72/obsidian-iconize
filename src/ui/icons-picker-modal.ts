import { logger } from '@app/lib/logger';
import { App, SuggestModal, ColorComponent, Notice } from 'obsidian';
import type IconizePlugin from '@app/main';
import emoji from '@app/emoji';
import { type Icon } from '@app/icon-pack-manager';
import dom from '@app/lib/util/dom';
import { saveIconToIconPack } from '@app/util';

/** 分片搜索只返回有限结果，预览仅解析当前建议。 / Cooperative bounded search with on-demand previews. */
export default class IconsPickerModal extends SuggestModal<Icon> {
  private request = 0;
  private closed = false;
  private closedQuery = '';
  public selectedColor?: string;
  public onSelect?: (iconName: string) => void;
  public onColor?: (color: string | undefined, query: string) => void;
  public onDraftSelect?: (iconName: string, query: string) => void;
  public initialQuery = '';

  constructor(
    app: App,
    private plugin: IconizePlugin,
    private path: string,
    initialColor?: string,
    preserveUndefinedColor = false,
  ) {
    super(app);
    this.limit = 100;
    plugin.trackModal(this);
    this.setPlaceholder('搜索图标名称或图标包 / Search icon or pack');
    this.resultContainerEl.classList.add('iconize-modal');
    this.selectedColor = preserveUndefinedColor
      ? initialColor
      : (initialColor ??
        plugin.getIconColor(path) ??
        plugin.getSettings().iconColor ??
        undefined);
    const toolbar = this.inputEl.parentElement;
    if (toolbar) {
      toolbar.addClass('iconize-picker-search');
      // 保留 SDK 输入节点和行为，清除控件只通过原生 input 事件更新查询。
      // Keep the SDK-owned input; update its query through the native input event.
      const clear = toolbar.createEl('button', {
        cls: 'iconize-picker-clear',
        text: '×',
        attr: {
          type: 'button',
          'aria-label': '清除搜索 / Clear search',
          title: '清除搜索 / Clear search',
        },
      });
      const updateClear = () => {
        clear.hidden = this.inputEl.value.length === 0;
      };
      this.inputEl.addEventListener('input', updateClear);
      clear.addEventListener('click', () => {
        this.inputEl.value = '';
        this.inputEl.dispatchEvent(new Event('input', { bubbles: true }));
        this.inputEl.focus();
        updateClear();
      });
      updateClear();
      const colorContainer = toolbar.createDiv({ cls: 'iconize-picker-color' });
      new ColorComponent(colorContainer)
        .setValue(this.selectedColor ?? '#808080')
        .onChange((value) => {
          this.selectedColor = value;
          this.updatePreviewColor();
        });
      const colorInput = colorContainer.querySelector('input');
      colorInput?.setAttribute('aria-label', '设置图标颜色 / Set icon color');
      colorInput?.setAttribute('title', '设置图标颜色 / Set icon color');
      colorInput?.addEventListener('click', (event) => {
        if (!this.onColor) return;
        event.preventDefault();
        const query = this.inputEl.value;
        const color = this.selectedColor;
        this.close();
        this.onColor(color, query);
      });
    }
    this.updatePreviewColor();
  }

  private updatePreviewColor(): void {
    // undefined 表示继承默认值，不能把展示用的全局颜色保存成路径覆盖。
    // Undefined inherits the default; never persist its display color as a path override.
    const color = this.selectedColor ?? this.plugin.getSettings().iconColor;
    this.inputEl.parentElement?.setCssProps({
      '--iconize-picker-color': color ?? '#808080',
    });
    this.resultContainerEl.setCssProps({
      '--iconize-preview-color': color ?? 'var(--text-muted)',
    });
    this.resultContainerEl.toggleClass('iconize-preview-colored', !!color);
  }

  onOpen(): void {
    this.closed = false;
    super.onOpen();
    if (this.initialQuery) {
      this.inputEl.value = this.initialQuery;
      this.inputEl.dispatchEvent(new Event('input', { bubbles: true }));
    }
  }

  onClose(): void {
    this.closedQuery = this.inputEl.value;
    this.closed = true;
    this.request++;
    // ZIP 目录受全局预算与闲时释放控制，关闭后短暂保留以避免重新打开重复扫描。
    // Global byte/idle limits retain a short grace period instead of rescanning on every reopen.
    this.plugin.releaseModal(this);
    super.onClose();
  }

  async getSuggestions(query: string): Promise<Icon[]> {
    const request = ++this.request;
    // 让最新输入先到达，快速连续输入时旧查询无需遍历。 / Coalesce rapid input before scanning.
    await new Promise<void>((resolve) => window.setTimeout(resolve, 80));
    const cancelled = () => this.closed || request !== this.request;
    if (cancelled()) return [];
    const manager = this.plugin.getIconPackManager();
    const results: Icon[] = [];
    const emojiIcon = (unicode: string, name: string): Icon => ({
      name,
      prefix: 'Emoji',
      displayName: unicode,
      iconPackName: null,
      filename: '',
      svgContent: '',
      svgElement: '',
      svgViewbox: '',
    });
    if (!query.trim()) {
      for (const id of this.plugin.getSettings().recentlyUsedIcons) {
        if (emoji.isEmoji(id))
          results.push(emojiIcon(id, emoji.shortNames[id] ?? id));
        else {
          const found = manager
            .getIconPacks()
            .map((pack) =>
              pack.getIcon(
                id.startsWith(pack.getPrefix())
                  ? id.slice(pack.getPrefix().length)
                  : id,
              ),
            )
            .find(Boolean);
          if (found) results.push({ ...found, displayName: id });
        }
      }
    }
    results.push(
      ...(await manager.searchIcons(
        query,
        this.limit - results.length,
        cancelled,
      )),
    );
    if (cancelled()) return [];
    if (results.length < this.limit) {
      for (const [unicode, name] of Object.entries(emoji.shortNames)) {
        if ((name + unicode).toLowerCase().includes(query.toLowerCase()))
          results.push(emojiIcon(unicode, name));
        if (results.length >= this.limit) break;
      }
    }
    return [
      ...new Map(results.map((item) => [item.displayName, item])).values(),
    ];
  }

  onChooseSuggestion(item: Icon): void {
    if (this.onDraftSelect) {
      const query = this.closed ? this.closedQuery : this.inputEl.value;
      if (!this.closed) this.close();
      this.onDraftSelect(item.displayName, query);
      return;
    }
    this.onChooseItem(item);
  }

  onChooseItem(item: Icon | string): void {
    const id = typeof item === 'string' ? item : item.displayName;
    void this.plugin
      .selectIcon(this.path, id, this.selectedColor)
      .then(() => {
        dom.createIconNode(this.plugin, this.path, id);
        this.onSelect?.(id);
        if (!emoji.isEmoji(id)) saveIconToIconPack(this.plugin, id);
        this.plugin.notifyPlugins();
      })
      .catch((error: unknown) => {
        logger.error('[Iconize] Could not select icon:', undefined, error);
        new Notice('Iconize：图标保存失败，请打开配置诊断与恢复。');
      });
  }

  renderSuggestion(item: Icon, el: HTMLElement): void {
    el.createDiv({ text: item.name + ' (' + item.prefix + ')' });
    const preview = el.createDiv({ cls: 'iconize-icon-preview' });
    if (item.prefix === 'Emoji') preview.setText(item.displayName);
    else
      dom.setIconForNode(this.plugin, item.displayName, preview, {
        shouldApplyAllStyles: false,
        persist: false,
      });
  }
}
