import { Modal, Notice, Setting } from 'obsidian';
import type IconizePlugin from '@app/main';

/**
 * 需要重载 Obsidian 的提示 / Explains that Obsidian must be reloaded.
 *
 * 配置路径和图标设置无法在插件内部热替换；这里给出重新加载入口，同时允许稍后
 * 手动重启。按钮只调用 Obsidian 自己的 reload 命令，不尝试原地热重载插件。
 *
 * Config paths and icon settings cannot be hot-swapped inside the plugin. This dialog
 * offers Obsidian's own reload command and a "later" path; it never attempts an in-place
 * plugin hot reload.
 */
export default class ReloadRequiredModal extends Modal {
  constructor(
    private plugin: IconizePlugin,
    private reason: string,
  ) {
    super(plugin.app);
    plugin.trackModal(this);
    this.setTitle('需要重新加载 Obsidian / Reload required');
  }

  onOpen(): void {
    this.contentEl.createEl('p', { text: this.reason });
    this.contentEl.createEl('p', {
      text: '配置路径、图标包来源和部分设置需要重新加载 Obsidian 后才会全部生效。请先保存当前编辑；重新加载界面或退出后重新打开 Obsidian 都可以，未保存的编辑可能丢失。',
    });
    new Setting(this.contentEl)
      .addButton((button) =>
        button.setButtonText('稍后 / Later').onClick(() => this.close()),
      )
      .addButton((button) =>
        button
          .setButtonText('重新加载 Obsidian / Reload')
          .setCta()
          .onClick(() => {
            const executed = this.app.commands.executeCommandById('app:reload');
            if (!executed) {
              new Notice(
                'Iconize：无法调用重新加载命令，请手动退出并重新打开 Obsidian。',
                10000,
              );
              return;
            }
            this.close();
          }),
      );
  }

  onClose(): void {
    this.plugin.releaseModal(this);
    this.contentEl.empty();
  }
}
