import { MarkdownRenderer, Modal, Setting } from 'obsidian';
import type IconizePlugin from '@app/main';
import type { Icon } from '@app/icon-pack-manager';
import emoji from '@app/emoji';
import { formatIconEmbed } from '@app/lib/icon-conversion';
import dom from '@app/lib/util/dom';

/**
 * 图标详情与可复制形式 / Icon details and copyable forms.
 *
 * 从「浏览图标」模式打开：显示图标本身、原生 ID、Iconize 标签、SVG、Base64 和
 * 文件引用。每种形式用 Markdown 代码块渲染，借助 Obsidian 自带的复制按钮一键复制。
 * 「返回搜索器」只关闭本弹窗；「关闭」同时关闭底下的搜索器。
 *
 * Opened from the browse mode: shows the icon, native ID, Iconize tag, SVG, Base64 and
 * file reference. Each form is rendered as a Markdown code block so Obsidian's built-in
 * copy button works. "Back" closes this dialog only; "Close" also closes the picker below.
 */
export default class IconDetailsModal extends Modal {
  constructor(
    private plugin: IconizePlugin,
    private item: Icon,
    private callbacks: {
      /** 详情关闭后让搜索器恢复可关闭状态。 / Restore the picker's closable state. */
      onClosed: () => void;
      /** 「关闭」同时关闭底下的搜索器。 / Also close the picker below. */
      closeSearch: () => void;
    },
  ) {
    super(plugin.app);
    plugin.trackModal(this);
    this.setTitle('图标详情 / Icon details');
  }

  onOpen(): void {
    void this.render();
  }

  private async render(): Promise<void> {
    const isEmoji =
      this.item.prefix === 'Emoji' || emoji.isEmoji(this.item.displayName);
    const id = isEmoji
      ? this.item.name
      : `${this.item.prefix}${this.item.name}`;
    const identifier = this.plugin.getSettings().iconIdentifier;
    const tag = `${identifier}${id}${identifier}`;

    const preview = this.contentEl.createDiv({
      cls: 'iconize-icon-detail-preview',
    });
    if (isEmoji) preview.setText(this.item.displayName);
    else
      dom.setIconForNode(this.plugin, id, preview, {
        shouldApplyAllStyles: false,
        persist: false,
      });
    this.contentEl.createEl('p', {
      cls: 'iconize-icon-detail-id',
      text: id,
    });

    const forms: Array<{
      label: string;
      language: string;
      text: string;
    }> = [
      { label: '原生 ID / Native ID', language: 'text', text: this.item.name },
      { label: 'Iconize 标签 / Iconize tag', language: 'text', text: tag },
      { label: '完整 ID / Full ID', language: 'text', text: id },
    ];
    if (isEmoji) {
      forms.push({
        label: 'Emoji',
        language: 'text',
        text: this.item.displayName,
      });
    } else {
      const markup = await this.plugin.conversion.getSvg(id);
      if (markup) {
        forms.push(
          {
            label: 'SVG 元素 / SVG element',
            language: 'html',
            text: markup,
          },
          {
            label: 'Base64 图片 / Base64 image',
            language: 'html',
            text: formatIconEmbed(id, markup, 'data'),
          },
          {
            label: '文件引用 / File reference',
            language: 'markdown',
            text: formatIconEmbed(id, markup, 'file'),
          },
        );
      } else {
        this.contentEl.createEl('p', {
          text: '该图标无法解析；请确认所属图标包仍然安装。',
        });
      }
    }

    for (const form of forms) {
      this.contentEl.createEl('h4', { text: form.label });
      const block = this.contentEl.createDiv({
        cls: 'iconize-icon-detail-code',
      });
      await MarkdownRenderer.render(
        this.app,
        `\`\`\`${form.language}\n${form.text}\n\`\`\``,
        block,
        '',
        this.plugin,
      );
    }

    new Setting(this.contentEl)
      .addButton((button) =>
        button
          .setButtonText('返回搜索器 / Back')
          .setCta()
          .onClick(() => this.close()),
      )
      .addButton((button) =>
        button.setButtonText('关闭 / Close').onClick(() => {
          this.close();
          this.callbacks.closeSearch();
        }),
      )
      .settingEl.addClass('iconize-modal-footer');
  }

  onClose(): void {
    this.plugin.releaseModal(this);
    this.contentEl.empty();
    this.callbacks.onClosed();
  }
}
