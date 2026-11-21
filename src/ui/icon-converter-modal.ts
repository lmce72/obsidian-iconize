import { logger } from '@app/lib/logger';
import { Modal, Setting, Notice } from 'obsidian';
import type IconizePlugin from '@app/main';
import type { IconEmbedFormat } from '@app/settings/data';
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
    this.setTitle('图标标签 → 图标 / Icon tags to icons');
    const input = this.contentEl.createEl('textarea', {
      cls: 'iconize-converter-text',
      attr: { 'aria-label': '图标标签 / Icon tags', placeholder: ':LiHeart:' },
    });
    input.value = initial;
    input.spellcheck = false;
    input.setAttribute('autocapitalize', 'none');

    // 单次转换即可选择输出格式：审查或分享场景不必先改全局设置。
    // Pick the output format for this run, so review/share scenarios need no global change.
    let format: IconEmbedFormat = this.plugin.getSettings().iconEmbedFormat;
    new Setting(this.contentEl)
      .setName('嵌入格式 / Embed format')
      .setDesc(
        'Base64 使用运行时字符编码，插件会按设置写入文件；SVG 标签可读性最好；文件引用会在库根目录保存 Iconize SVG 资源。',
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOption('svg', 'SVG 标签 / SVG element')
          .addOption('data', 'Base64 图片 / Base64 image')
          .addOption('file', 'SVG 文件引用 / SVG file')
          .setValue(format)
          .onChange((value) => {
            format =
              value === 'data' ? 'data' : value === 'file' ? 'file' : 'svg';
          }),
      );

    const output = this.contentEl.createEl('textarea', {
      cls: 'iconize-converter-text',
      attr: { 'aria-label': '图标输出 / Icon output', readonly: '' },
    });
    const status = this.contentEl.createEl('p', { attr: { role: 'status' } });
    const setting = new Setting(this.contentEl);
    setting
      .addButton((button) => {
        const convert = () => {
          const source = input.value;
          button.setDisabled(true);
          void this.plugin.conversion
            .replacements(source, false, undefined, color, format)
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
              logger.error(
                '[Iconize] Icon converter failed:',
                undefined,
                error,
              );
              status.setText('转换失败，请检查图标包。');
            })
            .finally(() => button.setDisabled(false));
        };
        button.setButtonText('转换 / Convert').setCta().onClick(convert);
        if (initial) convert();
      })
      .addButton((button) =>
        button.setButtonText('复制 / Copy').onClick(() => {
          void navigator.clipboard
            .writeText(output.value)
            .then(() => new Notice('Iconize：已复制。'))
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
