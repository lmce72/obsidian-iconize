import { logger } from '@app/lib/logger';
import { App, Modal, ColorComponent, ButtonComponent, Notice } from 'obsidian';
import IconizePlugin from '@app/main';

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

export default class ChangeColorModal extends Modal {
  private plugin: IconizePlugin;
  private path: string;

  private usedColor?: string;
  private colorButtons: HTMLButtonElement[] = [];

  constructor(app: App, plugin: IconizePlugin, path: string) {
    super(app);
    this.plugin = plugin;
    plugin.trackModal(this);
    this.path = path;

    this.usedColor = this.plugin.getIconColor(this.path);

    this.contentEl.addClass('iconize-color-content');
    this.modalEl.classList.add('iconize-custom-modal');
    this.titleEl.setText('Change color');

    this.contentEl.createEl('p', {
      text: 'Select a color for this icon',
      cls: 'setting-item-description',
    });

    const predefinedColorsContainer = this.contentEl.createDiv({
      cls: 'iconize-color-palette',
    });

    PREDEFINED_COLORS.forEach((color) => {
      const colorButton = predefinedColorsContainer.createEl('button');
      colorButton.type = 'button';
      colorButton.setAttr('aria-label', `Select ${color} color`);
      colorButton.setAttr('title', color);
      colorButton.addClass('iconize-color-swatch');
      colorButton.setCssProps({ '--iconize-swatch-color': color });

      colorButton.addEventListener('click', () => {
        colorPicker.setValue(color);
        this.usedColor = color;
        this.updateSelectedColor();
      });

      this.colorButtons.push(colorButton);
    });

    this.updateSelectedColor();

    const colorContainer = this.contentEl.createDiv({
      cls: 'iconize-color-controls',
    });
    const colorPicker = new ColorComponent(colorContainer)
      .setValue(this.usedColor ?? '#000000')
      .onChange((value) => {
        this.usedColor = value;
        this.updateSelectedColor();
      });
    const defaultColorButton = new ButtonComponent(colorContainer);
    defaultColorButton.setTooltip('Set color to the default one');
    defaultColorButton.setButtonText('Reset');
    defaultColorButton.onClick(() => {
      colorPicker.setValue('#000000');
      this.usedColor = undefined;
      this.updateSelectedColor();
    });

    // Save button.
    const button = new ButtonComponent(this.contentEl);
    button.buttonEl.addClass('iconize-color-save');
    button.setButtonText('Save Changes');
    button.onClick(() => {
      button.setDisabled(true);
      void this.plugin
        .changeIconColor(this.path, this.usedColor)
        .then(() => {
          new Notice('Iconize：图标颜色已更新。');
          this.close();
        })
        .catch((error: unknown) => {
          logger.error('[Iconize] Color update failed:', undefined, error);
          new Notice('Iconize：颜色保存失败，请检查配置状态。');
        })
        .finally(() => button.setDisabled(false));
    });
  }

  private updateSelectedColor() {
    this.colorButtons.forEach((button, index) => {
      const color = PREDEFINED_COLORS[index];
      button.toggleClass('is-selected', this.usedColor === color);
      button.setAttribute('aria-pressed', String(this.usedColor === color));
    });
  }

  onOpen() {
    super.onOpen();
  }

  onClose() {
    this.plugin.releaseModal(this);
    const { contentEl } = this;
    contentEl.empty();
  }
}
