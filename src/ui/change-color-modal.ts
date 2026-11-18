import { logger } from '@app/lib/logger';
import {
  App,
  Modal,
  ColorComponent,
  ButtonComponent,
  Notice,
  sanitizeHTMLToDom,
  setIcon,
} from 'obsidian';
import IconizePlugin from '@app/main';
import emoji from '@app/emoji';
import icon from '@app/lib/icon';
import { getFolderNoteInheritedIcon } from '@app/lib/folder-note';

const PREDEFINED_COLORS = [
  '#272727',
  '#FF393C',
  '#FF8D28',
  '#FFCC02',
  '#35C759',
  '#03C3CF',
  '#0088FF',
  '#6254F5',
  '#CB30E0',
  '#FF2C55',
  '#AC7F5E',
  '#8E8E94',
];

export interface ColorEditorOptions {
  color?: string;
  iconId?: string;
  editIcon?: (color: string | undefined) => void;
  save?: (color: string | undefined, signal: AbortSignal) => Promise<void>;
  afterSave?: () => void;
  notifySave?: boolean;
}

export default class ChangeColorModal extends Modal {
  private plugin: IconizePlugin;
  private path: string;

  private usedColor?: string;
  private colorButtons: HTMLButtonElement[] = [];
  private colorValue: HTMLElement;
  private preview: HTMLElement;
  private closed = false;
  private saving = false;
  private lifetime = new AbortController();

  constructor(
    app: App,
    plugin: IconizePlugin,
    path: string,
    private options?: ColorEditorOptions,
  ) {
    super(app);
    this.plugin = plugin;
    plugin.trackModal(this);
    this.path = path;

    this.usedColor = options
      ? options.color
      : this.plugin.getIconColor(this.path);

    this.contentEl.addClass('iconize-color-content');
    this.modalEl.classList.add('iconize-color-modal');
    this.setTitle('更改图标颜色');

    const previewRow = this.contentEl.createDiv({
      cls: 'iconize-color-preview',
    });
    // 预览方块与提示文字纵向排列，提示宽度锁定为方块宽度。 / Stack the block and its hint; keep the hint as wide as the block.
    const previewIcon = previewRow.createDiv({
      cls: 'iconize-color-preview-icon',
    });
    const previewFrame = previewIcon.createEl('button', {
      cls: 'iconize-color-preview-frame iconize-preview-colored',
      attr: {
        type: 'button',
        'aria-label': '更改图标 / Change icon',
        title: '更改图标 / Change icon',
      },
    });
    previewFrame.addEventListener('click', () => {
      if (this.closed || this.saving || !this.options?.editIcon) return;
      const editIcon = this.options.editIcon;
      const color = this.usedColor;
      this.close();
      editIcon(color);
    });
    this.preview = previewFrame.createDiv({ cls: 'iconize-icon-preview' });
    setIcon(this.preview, 'palette');
    // 按钮已有 aria-label，可见提示不重复播报。 / The button's aria-label already names the action, so the visible hint stays decorative.
    previewIcon.createDiv({
      cls: 'iconize-color-preview-hint',
      text: '点击更改图标',
      attr: { 'aria-hidden': 'true' },
    });
    // 文案与方块居中对齐，不受下方提示高度影响。 / Align the copy with the block, not with the taller column.
    const previewText = previewRow.createDiv({
      cls: 'iconize-color-preview-text',
    });
    previewText.createEl('div', {
      text: '颜色预览',
      cls: 'iconize-color-label',
    });
    this.colorValue = previewText.createEl('div', {
      cls: 'iconize-color-value',
      attr: { role: 'status' },
    });

    this.contentEl.createEl('div', {
      text: '预设颜色',
      cls: 'iconize-color-label',
    });

    const predefinedColorsContainer = this.contentEl.createDiv({
      cls: 'iconize-color-palette',
      attr: { role: 'group', 'aria-label': '预设颜色' },
    });

    PREDEFINED_COLORS.forEach((color) => {
      const colorButton = predefinedColorsContainer.createEl('button');
      colorButton.type = 'button';
      colorButton.setAttr('aria-label', `Select ${color} color`);
      colorButton.setAttr('title', color);
      colorButton.addClass('iconize-color-swatch');
      colorButton.setCssProps({ '--iconize-swatch-color': color });
      // 色彩放在独立元素内，避免主题覆盖通用按钮背景。 / Keep essential color separate from theme button backgrounds.
      const marker = colorButton
        .createSpan({
          cls: 'iconize-color-dot',
          attr: { 'aria-hidden': 'true' },
        })
        .createSpan({ cls: 'iconize-color-check' });
      setIcon(marker, 'pin');

      colorButton.addEventListener('click', () => {
        colorPicker.setValue(color);
        this.usedColor = color;
        this.updateSelectedColor();
      });

      this.colorButtons.push(colorButton);
    });

    const colorContainer = this.contentEl.createDiv({
      cls: 'iconize-color-controls',
    });
    colorContainer.createSpan({
      text: '自定义颜色',
      cls: 'iconize-color-label',
    });
    const customColor = colorContainer.createDiv({
      cls: 'iconize-picker-color',
    });
    const colorPicker = new ColorComponent(customColor)
      .setValue(this.usedColor ?? '#808080')
      .onChange((value) => {
        this.usedColor = value;
        this.updateSelectedColor();
      });
    customColor
      .querySelector('input')
      ?.setAttribute('aria-label', '选择自定义图标颜色');
    this.updateSelectedColor();

    const actions = this.contentEl.createDiv({ cls: 'iconize-color-actions' });
    const defaultColorButton = new ButtonComponent(actions);
    defaultColorButton.setTooltip('恢复继承或默认的图标颜色');
    defaultColorButton.setButtonText('恢复默认');
    defaultColorButton.onClick(() => {
      colorPicker.setValue('#808080');
      this.usedColor = undefined;
      this.updateSelectedColor();
    });

    const cancel = new ButtonComponent(actions)
      .setButtonText('取消')
      .onClick(() => this.close());
    const button = new ButtonComponent(actions);
    button.setButtonText('保存').setCta();
    button.onClick(() => {
      if (this.closed || this.saving) return;
      void this.saveColor(cancel.buttonEl);
    });
    void this.loadPreview();
  }

  private async saveColor(cancel: HTMLButtonElement): Promise<void> {
    this.saving = true;
    // 保存中锁定草稿，仍允许关闭；完成后不可重新打开已关闭的编辑器。
    // Freeze the draft while saving, but allow dismissal without reopening a closed editor.
    const controls = this.contentEl.querySelectorAll<
      HTMLButtonElement | HTMLInputElement
    >('button, input');
    controls.forEach((control) => {
      if (control !== cancel) control.disabled = true;
    });
    try {
      if (this.options?.save)
        await this.options.save(this.usedColor, this.lifetime.signal);
      else await this.plugin.changeIconColor(this.path, this.usedColor);
      if (this.closed) return;
      if (this.options?.notifySave !== false)
        new Notice('Iconize：图标颜色已更新。');
      this.close();
      this.options?.afterSave?.();
    } catch (error: unknown) {
      logger.error('[Iconize] Color update failed:', undefined, error);
      if (!this.closed) new Notice('Iconize：颜色保存失败，请检查配置状态。');
    } finally {
      this.saving = false;
      if (!this.closed)
        controls.forEach((control) => {
          control.disabled = false;
        });
    }
  }

  private updateSelectedColor() {
    const color =
      this.usedColor ??
      this.plugin.getSettings().iconColor ??
      'var(--text-muted)';
    this.preview.parentElement?.setCssProps({
      '--iconize-preview-color': color,
    });
    this.contentEl.setCssProps({ '--iconize-picker-color': color });
    this.colorValue.setText(this.usedColor?.toUpperCase() ?? '默认颜色');
    this.colorButtons.forEach((button, index) => {
      const color = PREDEFINED_COLORS[index];
      const selected = this.usedColor?.toLowerCase() === color.toLowerCase();
      button.toggleClass('is-selected', selected);
      button.setAttribute('aria-pressed', String(selected));
    });
  }

  private async loadPreview(): Promise<void> {
    const id =
      this.options?.iconId ||
      icon.getByPath(this.plugin, this.path) ||
      getFolderNoteInheritedIcon(this.plugin, this.path);
    if (!id) return;
    try {
      if (emoji.isEmoji(id)) {
        this.preview.parentElement?.removeClass('iconize-preview-colored');
        this.preview.replaceChildren(
          sanitizeHTMLToDom(
            emoji.parseEmoji(this.plugin.getSettings().emojiStyle, id, 28) ??
              id,
          ),
        );
        return;
      }
      const svg = await this.plugin.conversion.getSvg(id);
      if (svg && !this.closed)
        this.preview.replaceChildren(sanitizeHTMLToDom(svg));
    } catch (error) {
      logger.error('[Iconize] Color preview failed:', undefined, error);
    }
  }

  onClose() {
    this.closed = true;
    this.lifetime.abort();
    this.plugin.releaseModal(this);
    const { contentEl } = this;
    contentEl.empty();
  }
}
