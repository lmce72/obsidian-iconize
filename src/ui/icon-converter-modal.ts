import { logger } from '@app/lib/logger';
import { Modal, Setting, Notice } from 'obsidian';
import type IconizePlugin from '@app/main';
import { replaceIconTags } from '@app/lib/icon-tags';

/** 可独立使用的标签转换器。 / Standalone shortcode converter. */
export default class IconConverterModal extends Modal {
  constructor(
    private plugin: IconizePlugin,
    initial = '',
    color?: string,
  ) {
    super(plugin.app);
    plugin.trackModal(this);
    this.setTitle('图标标签 → SVG / Icon tags to SVG');
    const input = this.contentEl.createEl('textarea', {
      cls: 'iconize-converter-text',
      attr: { 'aria-label': '图标标签 / Icon tags', placeholder: ':LiHeart:' },
    });
    input.value = initial;
    input.spellcheck = false;
    input.setAttribute('autocapitalize', 'none');
    const output = this.contentEl.createEl('textarea', {
      cls: 'iconize-converter-text',
      attr: { 'aria-label': 'SVG 输出 / SVG output', readonly: '' },
    });
    const status = this.contentEl.createEl('p', { attr: { role: 'status' } });
    const setting = new Setting(this.contentEl);
    setting
      .addButton((button) => {
        const convert = () => {
          const source = input.value;
          button.setDisabled(true);
          void this.plugin.conversion
            .replacements(source, true, undefined, color)
            .then(({ tags, values }) => {
              if (input.value !== source) {
                status.setText('输入已变化，请重新转换。');
                return;
              }
              output.value = replaceIconTags(source, tags, values);
              status.setText(
                `已转换 ${tags.filter((tag) => values.has(tag.id)).length} 个图标；未找到的标签保持原样。`,
              );
            })
            .catch((error: unknown) => {
              logger.error('[Iconize] SVG converter failed:', undefined, error);
              status.setText('转换失败，请检查图标包。');
            })
            .finally(() => button.setDisabled(false));
        };
        button.setButtonText('转换 / Convert').setCta().onClick(convert);
        if (initial) convert();
      })
      .addButton((button) =>
        button.setButtonText('复制 SVG / Copy SVG').onClick(() => {
          void navigator.clipboard
            .writeText(output.value)
            .then(() => new Notice('Iconize：已复制 SVG。'))
            .catch((error: unknown) => {
              logger.error('[Iconize] Clipboard failed:', undefined, error);
              output.focus();
              output.select();
              status.setText('无法访问剪贴板，请手动复制已选中的输出。');
            });
        }),
      );
  }

  onClose(): void {
    this.plugin.releaseModal(this);
    this.contentEl.empty();
  }
}
