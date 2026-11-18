import { App, PluginSettingTab, setIcon } from 'obsidian';
import IconizePlugin from '@app/main';
import { IconPackManagerPanel } from '@app/views/icon-management-view';
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
  private page: 'main' | 'manager' = 'main';
  private managerPanel: IconPackManagerPanel | null = null;

  constructor(app: App, plugin: IconizePlugin) {
    super(app, plugin);

    this.plugin = plugin;
  }

  /** 供命令面板直接从设置里打开管理页。 / Lets the command open the manager page directly. */
  openManager(): void {
    this.page = 'manager';
    const setting = (
      this.app as unknown as {
        setting?: { open(): void; openTabById(id: string): void };
      }
    ).setting;
    setting?.open();
    setting?.openTabById(this.plugin.manifest.id);
    this.display();
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
    this.managerPanel?.unmount();
    this.managerPanel = null;
    containerEl.empty();

    if (this.page === 'manager') {
      this.renderManagerPage(containerEl);
      for (const { element, top } of positions) element.scrollTop = top;
      return;
    }

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
    const navigate = new Setting(containerEl)
      .setName('图标包管理')
      .setDesc('浏览、导入和管理已安装的图标包。');
    navigate.settingEl.addClass('iconize-settings-nav');
    navigate.settingEl.setAttribute('role', 'button');
    navigate.settingEl.tabIndex = 0;
    setIcon(
      navigate.settingEl.createDiv({ cls: 'iconize-settings-nav-chevron' }),
      'chevron-right',
    );
    const openManager = () => {
      this.page = 'manager';
      this.display();
    };
    navigate.settingEl.addEventListener('click', openManager);
    navigate.settingEl.addEventListener('keydown', (event: KeyboardEvent) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      openManager();
    });
    for (const { element, top } of positions) element.scrollTop = top;
  }

  /** 设置子页：返回行 + 图标包管理内容。 / Settings subpage with a back row and the manager panel. */
  private renderManagerPage(containerEl: HTMLElement): void {
    const back = containerEl.createDiv({ cls: 'iconize-settings-back' });
    back.setAttribute('role', 'button');
    back.setAttribute('aria-label', '返回设置');
    back.tabIndex = 0;
    setIcon(
      back.createDiv({ cls: 'iconize-settings-back-icon' }),
      'chevron-left',
    );
    back.createDiv({ text: '图标包管理', cls: 'iconize-settings-back-title' });
    const goBack = () => {
      this.page = 'main';
      this.display();
    };
    back.addEventListener('click', goBack);
    back.addEventListener('keydown', (event: KeyboardEvent) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      goBack();
    });

    const body = containerEl.createDiv({ cls: 'iconize-settings-subpage' });
    this.managerPanel = new IconPackManagerPanel(this.app, this.plugin, body, {
      heading: false,
    });
    this.managerPanel.mount();
  }
}
