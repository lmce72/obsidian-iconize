import { Setting, TextComponent } from 'obsidian';
import IconFolderSetting from './iconFolderSetting';
import { Notice } from 'obsidian';
import config from '@app/config';
import { isHexadecimal, stringToHex } from '@app/util';
import { logger } from '@app/lib/logger';

export default class FrontmatterOptions extends IconFolderSetting {
  private iconFieldNameTextComp: TextComponent;
  private iconColorFieldNameTextComp: TextComponent;

  public display(): void {
    new Setting(this.containerEl)
      .setName('Use icon in frontmatter')
      .setDesc(
        'Toggles whether to set the icon based on the frontmatter property `icon`.',
      )
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.getSettings().iconInFrontmatterEnabled)
          .onChange(async (enabled) => {
            this.plugin.getSettings().iconInFrontmatterEnabled = enabled;
            await this.plugin.saveIconFolderData();
          });
      });

    new Setting(this.containerEl)
      .setName('Frontmatter icon field name')
      .setDesc(
        'Sets the name of the frontmatter field which contains the icon.',
      )
      .addText((text) => {
        this.iconFieldNameTextComp = text;
        text.setValue(this.plugin.getSettings().iconInFrontmatterFieldName);
      })
      .addButton((button) => {
        button.setButtonText('Save');
        button.onClick(async () => {
          const newValue = this.iconFieldNameTextComp.getValue();
          const oldValue = this.plugin.getSettings().iconInFrontmatterFieldName;

          if (newValue === oldValue) {
            return;
          }

          this.plugin.getSettings().iconInFrontmatterFieldName = newValue;
          await this.plugin.saveIconFolderData();
          new Notice('...saved successfully');
        });
      });

    new Setting(this.containerEl)
      .setName('Frontmatter icon color field name')
      .setDesc(
        'Sets the name of the frontmatter field which contains the icon color.',
      )
      .addText((text) => {
        this.iconColorFieldNameTextComp = text;
        text.setValue(
          this.plugin.getSettings().iconColorInFrontmatterFieldName,
        );
      })
      .addButton((button) => {
        button.setButtonText('Save');
        button.onClick(async () => {
          const newValue = this.iconColorFieldNameTextComp.getValue();
          const oldValue =
            this.plugin.getSettings().iconColorInFrontmatterFieldName;

          if (newValue === oldValue) {
            return;
          }

          this.plugin.getSettings().iconColorInFrontmatterFieldName = newValue;
          await this.plugin.saveIconFolderData();
          new Notice('...saved successfully');
        });
      });

    new Setting(this.containerEl)
      .setName('Refresh icons from frontmatter')
      .setDesc(
        'Sets the icon and color for each note in the vault based on the frontmatter properties. WARNING: This will change any manually set icons to the one defined in the frontmatter. Notes without an `icon` property are left untouched. Please restart Obsidian after this completes to see the changes.',
      )
      .addButton((btn) => {
        btn.setButtonText('Refresh').onClick(async () => {
          if (!this.plugin.getSettings().iconInFrontmatterEnabled) {
            new Notice(
              `[${config.PLUGIN_NAME}] Please enable "Use icon in frontmatter".`,
            );
            return;
          }

          new Notice(
            `[${config.PLUGIN_NAME}] Refreshing icons from frontmatter, please wait...`,
          );

          const files = this.plugin.app.vault.getMarkdownFiles();

          for (const file of files) {
            const fileCache = this.plugin.app.metadataCache.getFileCache(file);

            const frontmatterIconKey =
              this.plugin.getSettings().iconInFrontmatterFieldName;
            const frontmatterIconColorKey =
              this.plugin.getSettings().iconColorInFrontmatterFieldName;

            const iconName = fileCache.frontmatter?.[frontmatterIconKey];
            let iconColor = fileCache.frontmatter?.[frontmatterIconColorKey];

            if (!iconName) {
              // 跳过没有 `icon` frontmatter 的文件，而不是删掉它们的图标配置。
              //
              // 这个按钮名叫「Refresh」：它应当把 frontmatter 里写的图标同步过来，
              // 而不是把没写 frontmatter 的文件的图标清空。原先的删除行为会波及仓库里
              // 绝大多数笔记——它们本来就不使用 frontmatter 图标。而「用户清空了某篇
              // 笔记的 icon 属性」这一场景，已由 metadataCache 的实时监听处理。
              //
              // Skip files without an `icon` frontmatter property rather than deleting their
              // icon config. The button is named "Refresh": it should bring the icons
              // written in frontmatter across, not clear the icons of files that never used
              // frontmatter — which is most of a vault. The case it was covering, a note
              // whose `icon` property was cleared, is already handled by the live
              // metadataCache listener.
              continue;
            }

            if (typeof iconName !== 'string') {
              const message = `${file.path}\nFrontmatter property type \`${frontmatterIconKey}\` has to be of type \`text\`.`;
              logger.warn(message);
              new Notice(`[${config.PLUGIN_NAME}]\n${message}`);
              continue;
            }

            this.plugin.addFolderIcon(file.path, iconName);

            if (!iconColor) {
              await this.plugin.removeIconColor(file.path);
              continue;
            }

            if (typeof iconColor !== 'string') {
              const message = `${file.path}\nFrontmatter property type \`${frontmatterIconColorKey}\` has to be of type \`text\`.`;
              logger.warn(message);
              new Notice(`[${config.PLUGIN_NAME}]\n${message}`);
              continue;
            }

            iconColor = isHexadecimal(iconColor)
              ? stringToHex(iconColor)
              : iconColor;

            this.plugin.addIconColor(file.path, iconColor);
          }
          new Notice(
            `[${config.PLUGIN_NAME}] Refreshed icons from frontmatter. Please restart Obsidian to see the changes.`,
          );
        });
      });
  }
}
