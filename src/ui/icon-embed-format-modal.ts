import { Modal, Setting } from 'obsidian';
import type IconizePlugin from '@app/main';
import type { IconEmbedFormat } from '@app/settings/data';

/** 每种嵌入格式的使用场景与限制 / Use cases and limits of each embed format. */
export interface EmbedFormatOption {
  value: IconEmbedFormat;
  label: string;
  scenario: string;
  limit: string;
}

/**
 * 格式对照表 / Format comparison table.
 *
 * 同时用于弹窗和文档，避免帮助文字与实际行为脱节。
 * Shared by the modal and the docs so the help text cannot drift from the behavior.
 */
export const EMBED_FORMAT_OPTIONS: EmbedFormatOption[] = [
  {
    value: 'svg',
    label: 'SVG 标签 / SVG element',
    scenario:
      '留在 Obsidian 里阅读，或导出 PDF、打印；图标会跟随文字颜色，标记可以直接查看和修改。',
    limit:
      'GitHub、部分博客和邮件会过滤内联 SVG，发布后可能只剩空白；笔记体积也最大。',
  },
  {
    value: 'data',
    label: 'Base64 图片 / Base64 image',
    scenario:
      '需要把一篇笔记单独发出去、不想带附件，而且目标平台允许 Markdown 中的 data: 图片时最省事。',
    limit:
      'GitHub、部分博客或邮件会过滤 data: 图片，图标可能变空白；笔记体积约增加三分之一，内容也不方便人工阅读。',
  },
  {
    value: 'file',
    label: 'SVG 文件引用 / SVG file',
    scenario:
      '笔记要放进 GitHub 仓库或个人博客，愿意把 Iconize SVG 文件夹一起发布；笔记最轻，同一图标可以在多篇笔记复用。',
    limit:
      '只发 Markdown 会显示破图；必须带上 Iconize SVG 文件夹，并按发布位置改写图片路径。',
  },
];

export interface EmbedFormatModalOptions {
  title: string;
  description: string;
  confirmText: string;
  /** 额外提示，例如整个 Vault 转换的风险。 / Extra warning, e.g. vault-wide risk. */
  warning?: string;
  onConfirm: (format: IconEmbedFormat, remember: boolean) => void;
}

/**
 * 文档图标嵌入格式选择 / Embed format picker for document conversion.
 *
 * 命令执行前先选格式；表格是选择依据，不是事后文档。若控制台出现 srcdoc/CSP
 * 安全错误，用户可以直接改用 SVG 标签或文件引用并重新执行命令。
 *
 * The command asks for a format first, and the table is the decision aid rather than
 * after-the-fact documentation. If the console reports an srcdoc/CSP security error the
 * user can switch to the SVG element or file reference and rerun immediately.
 */
export default class IconEmbedFormatModal extends Modal {
  private format: IconEmbedFormat;
  private remember = false;
  private resolved = false;

  constructor(
    private plugin: IconizePlugin,
    private options: EmbedFormatModalOptions,
  ) {
    super(plugin.app);
    plugin.trackModal(this);
    this.format = plugin.getSettings().iconEmbedFormat;
  }

  onOpen(): void {
    this.titleEl.setText(this.options.title);
    this.contentEl.createEl('p', { text: this.options.description });
    if (this.options.warning)
      this.contentEl.createEl('p', {
        cls: 'iconize-embed-warning',
        text: this.options.warning,
      });

    const table = this.contentEl.createEl('table', {
      cls: 'iconize-embed-formats',
    });
    const head = table.createEl('thead').createEl('tr');
    for (const label of [
      '格式 / Format',
      '适合用在哪 / Best for',
      '换到别处会怎样 / Elsewhere',
    ])
      head.createEl('th', { text: label });
    const body = table.createEl('tbody');
    for (const option of EMBED_FORMAT_OPTIONS) {
      const row = body.createEl('tr');
      row.createEl('th', { text: option.label });
      row.createEl('td', { text: option.scenario });
      row.createEl('td', { text: option.limit });
    }

    this.contentEl.createEl('p', {
      cls: 'iconize-embed-hint',
      text: '发布后图标空白、控制台出现安全错误，通常是目标平台过滤了内联 SVG 或 Base64 图片；请改用文件引用，或先在该平台预览后再发布。',
    });

    new Setting(this.contentEl)
      .setName('嵌入格式 / Embed format')
      .setDesc('只影响本次转换；未勾选“设为默认”时不改动设置。')
      .addDropdown((dropdown) => {
        const labels: Record<string, string> = {};
        for (const option of EMBED_FORMAT_OPTIONS)
          labels[option.value] = option.label;
        dropdown
          .addOptions(labels)
          .setValue(this.format)
          .onChange((value) => {
            this.format =
              value === 'data' ? 'data' : value === 'file' ? 'file' : 'svg';
          });
      });

    new Setting(this.contentEl)
      .setName('设为默认格式 / Set as default')
      .setDesc('下次自动转换直接使用该格式，不再弹出选择。')
      .addToggle((toggle) =>
        toggle.setValue(false).onChange((value) => {
          this.remember = value;
        }),
      );

    new Setting(this.contentEl)
      .addButton((button) =>
        button.setButtonText('取消 / Cancel').onClick(() => this.close()),
      )
      .addButton((button) =>
        button
          .setButtonText(this.options.confirmText)
          .setCta()
          .onClick(() => this.confirm()),
      )
      .settingEl.addClass('iconize-modal-footer');
  }

  private confirm(): void {
    if (this.resolved) return;
    this.resolved = true;
    this.options.onConfirm(this.format, this.remember);
    this.close();
  }

  onClose(): void {
    this.plugin.releaseModal(this);
    this.contentEl.empty();
  }
}
