import { Notice, Setting, TextComponent } from 'obsidian';
import IconFolderSetting from './iconFolderSetting';

// ===== PATCHED: 自定义配置文件路径设置项 / Custom config file path setting =====
export default class ConfigFilePathSetting extends IconFolderSetting {
  private configPathTextComp: TextComponent;

  public display(): void {
    const configFilePathSetting = new Setting(this.containerEl)
      .setName('Config file path')
      .setDesc('Change the config file path (requires reload).');

    configFilePathSetting.addText((text) => {
      this.configPathTextComp = text;
      text.setValue(this.plugin.getSettings().configFilePath);
    });

    configFilePathSetting.addButton((btn) => {
      btn.setButtonText('Save');
      btn.onClick(async () => {
        const newPath = this.configPathTextComp.getValue();
        const oldPath = this.plugin.getSettings().configFilePath;

        if (oldPath === newPath) {
          return;
        }

        new Notice('Migrating config file...');
        try {
          this.plugin.getSettings().configFilePath = newPath;
          this.plugin.setConfigPath(newPath);
          await this.plugin.saveIconFolderData();
          new Notice('Config migrated successfully. Please reload Obsidian.');
        } catch (error) {
          console.error('[ConfigFilePathSetting] Migration failed:', error);
          new Notice('Config migration failed. Check console.');
        }
      });
    });
  }
}
// ===== END PATCH =====
