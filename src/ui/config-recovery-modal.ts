import { logger } from '@app/lib/logger';
import { Modal, Notice, Setting } from 'obsidian';
import type IconizePlugin from '@app/main';
import ReloadRequiredModal from './reload-required-modal';

/** 各同步工具排除插件运行状态的规则 / Sync exclusions for Iconize runtime state. */
export const SYNC_EXCLUSION_RULES = `# Syncthing (.stignore)
(?d).obsidian/plugins/obsidian-icon-folder/.iconize

# Git (.gitignore)
.obsidian/plugins/obsidian-icon-folder/.iconize/

# Obsidian Sync（排除的文件夹 / Excluded folders）
.obsidian/plugins/obsidian-icon-folder/.iconize

# Remotely Save（排除模式，每行一条 / exclude patterns）
.obsidian/plugins/obsidian-icon-folder/.iconize/**`;

/**
 * 配置诊断与恢复 / Configuration diagnosis and recovery.
 *
 * 缺失配置是正常状态（新装插件），不是错误；损坏配置先备份再保留可用记录。
 * 恢复入口提供：重试读取、立即创建/保存、改用默认路径、历史快照恢复、同步排除规则。
 *
 * A missing config is normal (fresh install), not an error; damaged content is backed up
 * and usable records are kept. Actions: retry, create/save now, use the default path,
 * restore a snapshot, and copy sync-exclusion rules.
 */
export default class ConfigRecoveryModal extends Modal {
  constructor(private plugin: IconizePlugin) {
    super(plugin.app);
    plugin.trackModal(this);
    this.setTitle('配置诊断与恢复 / Configuration recovery');
  }

  onOpen(): void {
    this.contentEl.createEl('p', {
      cls: 'iconize-config-status',
      attr: { role: 'status' },
      text: this.plugin.getConfigurationStatus(),
    });

    new Setting(this.contentEl)
      .setName('重试读取配置 / Retry loading')
      .setDesc(
        '文件暂时不可读（同步占用、权限）时重试；不会覆盖原文件。缺失或损坏时会重新读取并保留可用内容。',
      )
      .addButton((button) =>
        button.setButtonText('重试 / Retry').onClick((event) => {
          event.stopPropagation();
          this.runAfterClose(
            '重试读取',
            () => this.plugin.retryConfiguration(),
            '配置已重新读取；如设置未生效请重新加载插件。',
          );
        }),
      );

    new Setting(this.contentEl)
      .setName('立即创建/保存配置 / Create or save now')
      .setDesc(
        '用于配置文件尚未创建，或已从损坏内容中恢复：把当前设置和可用图标写入配置文件。损坏原文若已备份会保留。',
      )
      .addButton((button) =>
        button
          .setButtonText('保存配置 / Save')
          .setCta()
          .onClick((event) => {
            event.stopPropagation();
            this.runAfterClose(
              '保存配置',
              async () => {
                if (!(await this.plugin.createOrSaveConfig()))
                  throw new Error('配置未能写入，请检查文件权限或同步状态');
              },
              '配置已保存。',
            );
          }),
      );

    if (this.plugin.getConfigPath() !== this.plugin.getDefaultConfigPath())
      new Setting(this.contentEl)
        .setName('改用默认配置路径 / Use default path')
        .setDesc(
          `当前路径来自另一个库或旧设置。改用默认路径 ${this.plugin.getDefaultConfigPath()}，不会删除旧文件。`,
        )
        .addButton((button) =>
          button.setButtonText('改用默认路径 / Reset path').onClick((event) => {
            event.stopPropagation();
            this.runAfterClose(
              '改用默认路径',
              () => this.plugin.resetConfigPathToDefault(),
              '已改用默认配置路径。',
              true,
            );
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
          summary.setText('未找到历史备份。');
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
            .onClick((event) => {
              event.stopPropagation();
              if (!selected) {
                summary.setText('请先选择备份。');
                return;
              }
              this.runAfterClose(
                '恢复备份',
                () => this.plugin.restoreConfiguration(selected),
                '已恢复并保全原文件。',
                true,
              );
            }),
        );
      })
      .catch((error: unknown) => {
        logger.error('[Iconize] Could not list backups:', undefined, error);
        summary.setText('无法列出备份，请检查存储权限。');
      });

    this.renderSyncExclusions();
  }

  /**
   * 关闭弹窗后再执行恢复动作 / Runs a recovery action after the modal is closed.
   *
   * 恢复动作会读写配置文件并触发重新渲染；在弹窗内异步更新 DOM 曾导致渲染进程
   * 卡死。先关闭弹窗，再用 Notice 报告结果，界面状态可在重新打开诊断页时查看。
   *
   * Recovery actions read/write the config and trigger re-renders. Updating the modal's
   * DOM after they resolved previously left the renderer spinning. Close first, then
   * report through a Notice; the fresh status is visible when the dialog is reopened.
   */
  private runAfterClose(
    label: string,
    action: () => Promise<unknown>,
    success: string,
    reloadRequired = false,
  ): void {
    this.close();
    window.setTimeout(() => {
      void action()
        .then(() => {
          new Notice(
            `Iconize：${success} ${this.plugin.getConfigurationStatus()}`,
            10000,
          );
          if (reloadRequired)
            new ReloadRequiredModal(this.plugin, success).open();
        })
        .catch((error: unknown) => {
          logger.error(`[Iconize] ${label} failed:`, undefined, error);
          new Notice(
            `Iconize：${label}失败：${
              error instanceof Error ? error.message : String(error)
            }`,
            10000,
          );
        });
    }, 0);
  }

  /**
   * 同步排除规则 / Sync exclusion rules.
   *
   * `.iconize` 是本机索引、缓存与恢复快照，跨设备同步会带来旧索引和重复历史；
   * 规则以代码块展示并支持一键复制。
   *
   * `.iconize` holds local indexes, caches and recovery snapshots; syncing it across
   * devices brings stale indexes and duplicated history. The rules are shown in a code
   * block with one-click copy.
   */
  private renderSyncExclusions(): void {
    const section = this.contentEl.createEl('details', {
      cls: 'iconize-sync-exclusions',
    });
    section.createEl('summary', {
      text: '同步排除规则 / Sync exclusions',
    });
    section.createEl('p', {
      text: '把下列规则加入同步工具，排除插件的索引、缓存和恢复历史；设置文件 data.json 仍应同步。',
    });
    const pre = section.createEl('pre', { cls: 'iconize-sync-rules' });
    pre.createEl('code', { text: SYNC_EXCLUSION_RULES });
    const status = section.createEl('p', { attr: { role: 'status' } });
    new Setting(section).addButton((button) =>
      button.setButtonText('复制规则 / Copy').onClick(() => {
        void navigator.clipboard
          .writeText(SYNC_EXCLUSION_RULES)
          .then(() => status.setText('已复制同步排除规则。'))
          .catch((error: unknown) => {
            logger.error(
              '[Iconize] Could not copy sync rules:',
              undefined,
              error,
            );
            status.setText('无法访问剪贴板，请手动选择代码块复制。');
          });
      }),
    );
  }

  onClose(): void {
    this.plugin.releaseModal(this);
    this.contentEl.empty();
  }
}
