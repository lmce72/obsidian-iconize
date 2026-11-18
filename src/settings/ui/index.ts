import { App, Notice, PluginSettingTab } from 'obsidian';
import { logger } from '@app/lib/logger';
import IconizePlugin from '@app/main';
import { openIconManagementView } from '@app/views/icon-management-view';
import CustomIconRuleSetting from './customIconRule';
import EmojiStyleSetting from './emojiStyle';
import ExtraMarginSetting from './extraMargin';
import IconColorSetting from './iconColor';
import IconFontSizeSetting from './iconFontSize';
import IconPacksPathSetting from './iconPacksPath';
// ===== PATCHED: 自定义配置路径 + Folder note 继承设置 =====
import ConfigFilePathSetting from './configFilePath';
import InheritFolderNoteIconSetting from './inheritFolderNoteIcon';
// ===== END PATCH =====
import IconPacksBackgroundChecker from './iconPacksBackgroundChecker';
import RecentlyUsedIconsSetting from './recentlyUsedIcons';
import ToggleIconInTabs from './toggleIconInTabs';
import ToggleIconInTitle from './toggleIconInTitle';
import FrontmatterOptions from './frontmatterOptions';
import ToggleIconsInNotes from './toggleIconsInNotes';
import ToggleIconsInLinks from './toggleIconsInLinks';
import IconIdentifierSetting from './iconIdentifier';
import DebugMode from './debugMode';
import UseInternalPlugins from './useInternalPlugins';
import IconConversionSetting from './iconConversion';
import ConfigRecoveryModal from '@app/ui/config-recovery-modal';
import { Setting } from 'obsidian';

export default class IconFolderSettings extends PluginSettingTab {
  private plugin: IconizePlugin;

  constructor(app: App, plugin: IconizePlugin) {
    super(app, plugin);

    this.plugin = plugin;
  }

  display(): void {
    const { plugin, containerEl, app } = this;
    // 重建设置时保留各层滚动位置。 / Preserve scroll positions across settings rebuilds.
    const positions: Array<{ element: HTMLElement; top: number }> = [];
    for (
      let element: HTMLElement | null = containerEl;
      element;
      element = element.parentElement
    )
      positions.push({ element, top: element.scrollTop });
    containerEl.empty();

    containerEl.createEl('h1', { text: 'General' });
    new RecentlyUsedIconsSetting(plugin, containerEl).display();
    new IconPacksPathSetting(plugin, containerEl).display();
    new ConfigFilePathSetting(plugin, containerEl).display();
    new Setting(containerEl)
      .setName('配置诊断与恢复 / Configuration recovery')
      .setDesc(plugin.getConfigurationStatus())
      .addButton((button) =>
        button
          .setButtonText('诊断与恢复 / Diagnose and recover')
          .onClick(() => new ConfigRecoveryModal(plugin).open()),
      );
    new IconPacksBackgroundChecker(plugin, containerEl).display();
    new EmojiStyleSetting(plugin, containerEl).display();
    new IconIdentifierSetting(plugin, containerEl).display();
    new UseInternalPlugins(plugin, containerEl).display();
    new Setting(containerEl)
      .setName('兼容 Notebook Navigator')
      .setDesc(
        '在文件和文件夹右键菜单中设置 Iconize 图标，并在 Navigator 内显示其图标与颜色。更改仅作用于右键点击的项目。',
      )
      .addToggle((toggle) =>
        toggle
          .setValue(plugin.getSettings().notebookNavigatorEnabled)
          .onChange((enabled) => {
            plugin.getSettings().notebookNavigatorEnabled = enabled;
            void plugin.saveIconFolderData();
          }),
      );
    new DebugMode(plugin, containerEl).display();

    containerEl.createEl('h3', { text: 'Visibility of icons' });
    new ToggleIconInTabs(plugin, containerEl).display();
    new ToggleIconInTitle(plugin, containerEl).display();
    new InheritFolderNoteIconSetting(plugin, containerEl).display();
    new FrontmatterOptions(plugin, containerEl).display();
    new ToggleIconsInNotes(plugin, containerEl).display();
    new IconConversionSetting(plugin, containerEl).display();
    new ToggleIconsInLinks(plugin, containerEl).display();

    containerEl.createEl('h1', {
      text: 'Icon customization for files/folders',
    });
    new IconFontSizeSetting(plugin, containerEl).display();
    new IconColorSetting(plugin, containerEl).display();
    new ExtraMarginSetting(plugin, containerEl).display();

    containerEl.createEl('h1', { text: 'Custom icon rules' });
    new CustomIconRuleSetting(plugin, containerEl, app, () =>
      this.display(),
    ).display();

    containerEl.createEl('h1', { text: '图标包' });
    new Setting(containerEl)
      .setName('管理图标包')
      .setDesc('浏览、导入和管理已安装的图标包。')
      .addButton((button) =>
        button.setButtonText('打开管理视图').onClick(() => {
          void openIconManagementView(plugin).catch((error: unknown) => {
            logger.error(
              'Could not open icon pack management',
              undefined,
              error,
            );
            new Notice('无法打开图标包管理视图。');
          });
        }),
      );
    for (const { element, top } of positions) element.scrollTop = top;
  }
}
