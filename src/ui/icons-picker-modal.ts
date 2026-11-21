import { logger } from '@app/lib/logger';
import { App, SuggestModal, ColorComponent, Notice, setIcon } from 'obsidian';
import type IconizePlugin from '@app/main';
import emoji from '@app/emoji';
import { type Icon } from '@app/icon-pack-manager';
import dom from '@app/lib/util/dom';
import { saveIconToIconPack } from '@app/util';
import IconPickerFilterModal, {
  type PickerFilterState,
} from './icon-picker-filter-modal';

const FILTER_STORAGE_KEY = 'iconize:picker-filters';

/** 分片搜索只返回有限结果，预览仅解析当前建议。 / Cooperative bounded search with on-demand previews. */
export default class IconsPickerModal extends SuggestModal<Icon> {
  private request = 0;
  private closed = false;
  private closedQuery = '';
  /** 本轮查询已展示过的图标 / Icons already shown for the current query. */
  private seen = new Set<string>();
  private lastQuery = '';
  private lastResults: Icon[] = [];
  private refreshRequested = false;
  private familyFilter = new Set<string>();
  private fuzzySearch = false;
  private sortByRelevance = true;
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
    this.loadFilterPreferences();
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
      const filterButton = toolbar.createEl('button', {
        cls: 'iconize-picker-filter',
        attr: {
          type: 'button',
          'aria-label': '图标过滤器 / Icon filters',
          title: '图标过滤器 / Icon filters',
        },
      });
      setIcon(filterButton, 'filter');
      filterButton.toggleClass('is-active', this.familyFilter.size > 0);
      filterButton.addEventListener('click', () =>
        this.openFilterModal(filterButton),
      );
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
      const shuffle = toolbar.createEl('button', {
        cls: 'iconize-picker-shuffle',
        attr: {
          type: 'button',
          'aria-label': '换一批图标 / More icons',
          title: '换一批图标 / More icons',
        },
      });
      setIcon(shuffle, 'rotate-cw');
      shuffle.addEventListener('click', () => {
        // 同一查询下取下一批，跳过已经展示过的名称。
        // Fetch the next batch for the same query, skipping names already shown.
        this.refreshRequested = true;
        this.inputEl.dispatchEvent(new Event('input', { bubbles: true }));
        this.inputEl.focus();
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

  /**
   * 打开图标家族与搜索过滤 / Opens the icon-family and search filters.
   */
  private openFilterModal(button: HTMLElement): void {
    const manager = this.plugin.getIconPackManager();
    const families = manager.getIconPacks().map((pack) => ({
      name: pack.getName(),
      prefix: pack.getPrefix(),
      size: pack.size,
    }));
    families.push({ name: 'Emoji', prefix: 'Emoji', size: 0 });
    new IconPickerFilterModal(
      this.app,
      families,
      {
        packs: this.familyFilter,
        fuzzy: this.fuzzySearch,
        sortByRelevance: this.sortByRelevance,
      },
      (state: PickerFilterState | null) => {
        if (!state) return;
        this.familyFilter = state.packs;
        this.fuzzySearch = state.fuzzy;
        this.sortByRelevance = state.sortByRelevance;
        button.toggleClass('is-active', this.familyFilter.size > 0);
        this.saveFilterPreferences();
        // 过滤条件改变后重新从第一批开始，旧结果全部作废。
        // A filter change starts a fresh batch; previous results are obsolete.
        this.seen.clear();
        this.lastResults = [];
        this.lastQuery = '';
        this.refreshRequested = false;
        this.inputEl.dispatchEvent(new Event('input', { bubbles: true }));
        this.inputEl.focus();
      },
    ).open();
  }

  private loadFilterPreferences(): void {
    try {
      const raw = window.localStorage.getItem(FILTER_STORAGE_KEY);
      if (!raw) return;
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return;
      const value = parsed as Record<string, unknown>;
      if (Array.isArray(value.packs)) {
        this.familyFilter = new Set(
          value.packs.filter(
            (item): item is string => typeof item === 'string',
          ),
        );
      }
      if (typeof value.fuzzy === 'boolean') this.fuzzySearch = value.fuzzy;
      if (typeof value.relevance === 'boolean')
        this.sortByRelevance = value.relevance;
    } catch (error) {
      logger.warn(
        '[Iconize] Could not read picker filter preferences:',
        undefined,
        error,
      );
    }
  }

  private saveFilterPreferences(): void {
    try {
      window.localStorage.setItem(
        FILTER_STORAGE_KEY,
        JSON.stringify({
          packs: [...this.familyFilter],
          fuzzy: this.fuzzySearch,
          relevance: this.sortByRelevance,
        }),
      );
    } catch (error) {
      logger.warn(
        '[Iconize] Could not save picker filter preferences:',
        undefined,
        error,
      );
    }
  }

  async getSuggestions(query: string): Promise<Icon[]> {
    const request = ++this.request;
    // 让最新输入先到达，快速连续输入时旧查询无需遍历。 / Coalesce rapid input before scanning.
    await new Promise<void>((resolve) => window.setTimeout(resolve, 80));
    const cancelled = () => this.closed || request !== this.request;
    if (cancelled()) return [];

    if (query !== this.lastQuery) {
      this.lastQuery = query;
      this.seen.clear();
      this.lastResults = [];
      this.refreshRequested = false;
    }
    // 只有「换一批」才排除已展示项；普通输入从第一批开始。
    // Only the shuffle action excludes shown icons; ordinary input starts at the first batch.
    const refreshing = this.refreshRequested;
    const excluded = refreshing ? this.seen : null;
    const exclude = excluded ? (id: string) => excluded.has(id) : undefined;

    const manager = this.plugin.getIconPackManager();
    const allowEmoji =
      this.familyFilter.size === 0 || this.familyFilter.has('Emoji');
    const packFilter = new Set(
      [...this.familyFilter].filter((name) => name !== 'Emoji'),
    );
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
        let item: Icon | null = null;
        if (emoji.isEmoji(id)) {
          if (!allowEmoji) continue;
          item = emojiIcon(id, emoji.shortNames[id] ?? id);
        } else {
          const owner = manager
            .getIconPacks()
            .find((pack) => id.startsWith(pack.getPrefix()));
          if (packFilter.size && (!owner || !packFilter.has(owner.getName())))
            continue;
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
          if (found) item = { ...found, displayName: id };
        }
        if (item && !excluded?.has(item.displayName)) results.push(item);
      }
    }
    results.push(
      ...(await manager.searchIcons(
        query,
        this.limit - results.length,
        cancelled,
        exclude,
        {
          packs: packFilter.size ? packFilter : undefined,
          fuzzy: this.fuzzySearch,
          sortByRelevance: this.sortByRelevance,
        },
      )),
    );
    if (cancelled()) return [];
    if (results.length < this.limit && allowEmoji) {
      for (const [unicode, name] of Object.entries(emoji.shortNames)) {
        if (excluded?.has(name)) continue;
        if ((name + unicode).toLowerCase().includes(query.toLowerCase()))
          results.push(emojiIcon(unicode, name));
        if (results.length >= this.limit) break;
      }
    }
    const unique = [
      ...new Map(results.map((item) => [item.displayName, item])).values(),
    ];
    if (refreshing && !unique.length) {
      new Notice('没有更多图标了 / No more icons');
      this.refreshRequested = false;
      return this.lastResults;
    }
    if (refreshing) {
      for (const item of unique) this.seen.add(item.displayName);
    } else {
      this.seen = new Set(unique.map((item) => item.displayName));
    }
    this.lastResults = unique;
    this.refreshRequested = false;
    return unique;
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
