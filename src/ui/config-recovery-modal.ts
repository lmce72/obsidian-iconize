import { logger } from '@app/lib/logger';
import { Modal, Setting } from 'obsidian';
import type IconizePlugin from '@app/main';

/** 故障状态和恢复动作集中在同一入口。 / Keep status and recovery actions together. */
export default class ConfigRecoveryModal extends Modal {
  constructor(private plugin: IconizePlugin) {
    super(plugin.app);
    plugin.trackModal(this);
    this.setTitle('配置诊断与恢复 / Configuration recovery');
  }

  onOpen(): void {
    const status = this.contentEl.createEl('p', { attr: { role: 'status' } });
    const update = () => status.setText(this.plugin.getConfigurationStatus());
    update();
    new Setting(this.contentEl)
      .setName('重试读取配置 / Retry loading')
      .setDesc(
        '修复 JSON 或恢复同步连接后重试；成功后重新加载插件以应用全部设置。',
      )
      .addButton((button) =>
        button.setButtonText('重试 / Retry').onClick(() => {
          button.setDisabled(true);
          void this.plugin
            .retryConfiguration()
            .then(update)
            .catch((error: unknown) => {
              logger.error('[Iconize] Config retry failed:', undefined, error);
              status.setText('重试失败，请检查文件权限。');
            })
            .finally(() => button.setDisabled(false));
        }),
      );
    let selected = '';
    const summary = this.contentEl.createEl('p', { attr: { role: 'status' } });
    const restore = new Setting(this.contentEl)
      .setName('恢复历史配置 / Restore snapshot')
      .setDesc(
        '恢复前会保全当前磁盘文件与内存配置。备份应与当前配置路径匹配；恢复后重新加载插件。',
      );
    void this.plugin
      .getConfigurationBackups()
      .then((paths) => {
        if (!paths.length) {
          summary.setText('未找到备份，请修复当前 JSON 后重试读取。');
          return;
        }
        restore.addDropdown((dropdown) => {
          dropdown.addOption('', '选择备份 / Select backup');
          for (const path of paths)
            dropdown.addOption(path, path.split('/').pop() ?? path);
          dropdown.onChange((path) => {
            selected = path;
            summary.setText('');
            if (path)
              void this.plugin
                .previewConfigurationBackup(path)
                .then((text) => {
                  if (selected === path) summary.setText(text);
                })
                .catch((error: unknown) => {
                  summary.setText(
                    error instanceof Error ? error.message : '备份不可读',
                  );
                });
          });
        });
        restore.addButton((button) =>
          button
            .setButtonText('恢复所选备份 / Restore selected')
            .onClick(() => {
              if (!selected) {
                summary.setText('请先选择备份。');
                return;
              }
              button.setDisabled(true);
              void this.plugin
                .restoreConfiguration(selected)
                .then(() => {
                  update();
                  summary.setText('已恢复并保全原文件，请重新加载插件。');
                })
                .catch((error: unknown) => {
                  logger.error(
                    '[Iconize] Config restore failed:',
                    undefined,
                    error,
                  );
                  summary.setText(
                    error instanceof Error
                      ? error.message
                      : '恢复失败，原文件仍保留。',
                  );
                })
                .finally(() => button.setDisabled(false));
            }),
        );
      })
      .catch((error: unknown) => {
        logger.error('[Iconize] Could not list backups:', undefined, error);
        summary.setText('无法列出备份，请检查存储权限。');
      });
  }

  onClose(): void {
    this.plugin.releaseModal(this);
    this.contentEl.empty();
  }
}
