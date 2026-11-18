import {
  Plugin,
  MenuItem,
  TFile,
  WorkspaceLeaf,
  requireApiVersion,
  MarkdownView,
  Notice,
  Menu,
  Editor,
  Modal,
  TAbstractFile,
} from 'obsidian';
import {
  EditorWithEditorComponent,
  ExplorerView,
  InlineTitleView,
  TabHeaderLeaf,
} from './@types/obsidian';
import { IconEditSession } from './ui/icon-edit-session';
import {
  ICON_MANAGEMENT_VIEW_TYPE,
  IconManagementView,
} from './views/icon-management-view';
import { DEFAULT_SETTINGS, IconFolderSettings } from '@app/settings/data';
import { migrate } from '@app/migrations';
import IconFolderSettingsUI from './settings/ui';
import StarredInternalPlugin from './internal-plugins/starred';
import InternalPluginInjector from './@types/internal-plugin-injector';
import iconTabs from './lib/icon-tabs';
import dom from './lib/util/dom';
import customRule from './lib/custom-rule';
import icon from './lib/icon';
import BookmarkInternalPlugin from './internal-plugins/bookmark';
import OutlineInternalPlugin from './internal-plugins/outline';
import {
  DEFAULT_FILE_ICON,
  getAllOpenedFiles,
  getFileItemInnerTitleEl,
  getFileItemTitleEl,
  isHexadecimal,
  removeIconFromIconPack,
  stringToHex,
} from '@app/util';
import config from '@app/config';
import titleIcon from './lib/icon-title';
import SuggestionIcon from './editor/icons-suggestion';
import emoji from './emoji';
import { IconCache } from './lib/icon-cache';
import {
  cloneConfig,
  ConfigData,
  equalConfig,
  mergeConfig,
  parseConfig,
  stampConfigChanges,
  rebaseConfig,
} from './lib/config-merge';
import { stateRoot } from './lib/icon-layout';
import {
  buildIconInLinksPlugin,
  buildIconInTextPlugin,
} from './editor/live-preview';
import { PositionField, buildPositionField } from './editor/live-preview/state';
import { calculateInlineTitleSize } from './lib/util/text';
import {
  processIconInTextMarkdown,
  processIconInLinkMarkdown,
} from './editor/markdown-processors';
import { logger } from './lib/logger';
import { EventEmitter } from './lib/event/event';
import IconizeAPI, { getApi } from './lib/api';
import { Icon, IconPackManager } from './icon-pack-manager';
import { getNormalizedName } from './icon-pack-manager/util';
import { IconConversion } from './lib/icon-conversion';
import { findIconTags } from './lib/icon-tags';
import IconConverterModal from './ui/icon-converter-modal';
import ConfigRecoveryModal from './ui/config-recovery-modal';
import NotebookNavigatorIntegration from './integrations/notebook-navigator';
// ===== PATCHED: 按需加载系统 / Lazy loading system =====
import { IconResolver } from './lib/icon-resolver';
import { InlineIconLoader } from './lib/inline-icon-loader';
import {
  initializeLazyLoading,
  cleanupLazyLoading,
  LazyLoadingSystem,
} from './lib/lazy-loading-integration';
import {
  resolveFolderNotePath,
  getFolderNoteInheritedIcon,
  getFolderNoteParent,
} from './lib/folder-note';
// ===== END PATCH =====

export interface FolderIconObject {
  iconName: string | null;
  iconColor?: string;
}

export default class IconizePlugin extends Plugin {
  public conversion = new IconConversion(this);
  private iconLoadingAbort = new AbortController();
  private iconLoadingComplete = false;
  public isIconLoadingComplete(): boolean {
    return this.iconLoadingComplete;
  }
  private notebookNavigator?: NotebookNavigatorIntegration;
  private settingsUI?: IconFolderSettingsUI;
  private openModals = new Set<Modal>();
  public trackModal(modal: Modal): void {
    this.openModals.add(modal);
  }
  public releaseModal(modal: Modal): void {
    this.openModals.delete(modal);
  }
  private data: Record<
    string,
    boolean | string | IconFolderSettings | FolderIconObject
  >;
  private registeredFileExplorers = new Set<ExplorerView>();

  private modifiedInternalPlugins: InternalPluginInjector[] = [];

  public positionField: PositionField = buildPositionField(this);

  private eventEmitter = new EventEmitter();

  private iconPackManager: IconPackManager;

  public api: IconizeAPI;

  // ===== PATCHED: 按需加载 + 自定义配置 + Folder note 字段 =====
  public lazyLoadingSystem?: LazyLoadingSystem;
  public iconResolver?: IconResolver;
  public inlineIconLoader?: InlineIconLoader;
  private _saveDebounceTimer: number | null = null;
  private _savePending = false;
  private initializing = true;
  private unloading = false;
  private configBaseline: ConfigData = {};
  private configVersionBaseline: ConfigData = {};
  private saveWaiters: Array<() => void> = [];
  private configRefreshTimer: number | null = null;
  private configSessionId = Math.random().toString(36).slice(2);
  private configSaveTask: Promise<void> | null = null;
  private configSaveSucceeded = true;
  private configLastSaveError: {
    stage: string;
    message: string;
    at: string;
  } | null = null;
  private configHistorySequence = 0;
  private configRecoveryPending = false;
  private configPath = '.obsidian/plugins/obsidian-icon-folder/data.json';
  /**
   * 配置读取的结果 / Outcome of the last config read.
   *
   * `failed` 时禁止写回，避免用默认值覆盖用户真实的配置。
   * While `failed`, saving is refused so defaults never overwrite the user's config.
   */
  private configLoadState: 'ok' | 'missing' | 'failed' = 'missing';
  private configLoadError = '';
  private configMaintenance = false;
  private configMaintenanceEpoch = 0;
  // 标题图标的请求序号登记已下沉到 `lib/icon-title`（元素身份归那个模块管）：
  // 任何一次写入或移除都会自动作废在飞的旧结果，此处不再持有第二份状态。
  // The title-icon request registry now lives in `lib/icon-title`, which owns element
  // identity: every write and removal invalidates in-flight results there, so no second copy
  // of that state is kept here.
  /**
   * 上次写入配置的内容 / Content of the last config write.
   *
   * 用来跳过无变化的写入，避免让同步客户端反复上传同一个文件。
   * Used to skip no-op writes, so a sync client is not asked to re-upload an unchanged file.
   */
  private _lastSavedConfig: string | null = null;
  // ===== END PATCH =====

  public getUsedIcons(): Set<string> {
    // Used icons in paths.
    const usedIconsInPaths = icon
      .getAllWithPath(this)
      .map((value) => value.icon);

    // Used icons in rules.
    const customRules = customRule.getSortedRules(this);
    const usedIconsInCustomRules = customRules.map(
      (customRule) => customRule.icon,
    );

    return new Set([...usedIconsInPaths, ...usedIconsInCustomRules]);
  }

  /**
   * 插件入口 / Plugin entry point.
   *
   * 整体受保护：任何未预料的异常都会变成一条界面提示，而不是让 Obsidian 把插件判为
   * 「加载失败」并停用。移动端无法打开开发者工具，所以提示必须可见——否则用户只能看到
   * 一句「加载失败」，无从排查。
   *
   * Guarded as a whole: an unforeseen exception becomes a visible notice rather than making
   * Obsidian disable the plugin as "failed to load". Mobile has no developer tools, so the
   * message has to be on screen — otherwise the user is left with nothing to diagnose.
   */
  async onload() {
    this.registerView(
      ICON_MANAGEMENT_VIEW_TYPE,
      (leaf) => new IconManagementView(leaf, this),
    );
    this.addCommand({
      id: 'open-icon-manager',
      name: '打开图标包管理 / Open icon pack manager',
      callback: () => {
        try {
          this.settingsUI?.openManager();
        } catch (error) {
          logger.error('Could not open the icon pack manager', undefined, error);
          new Notice('Iconize：无法打开图标包管理。');
        }
      },
    });
    this.register(() => {
      for (const modal of this.openModals) modal.close();
      this.openModals.clear();
    });
    try {
      await this.initialize();
      this.finishConfigInitialization();
    } catch (error) {
      console.error(`[${config.PLUGIN_NAME}] Failed to load:`, error);
      new Notice(
        `[${config.PLUGIN_NAME}] Failed to load: ${
          error instanceof Error ? error.message : String(error)
        }`,
        0,
      );
    } finally {
      this.iconLoadingComplete = true;
      if (!this.unloading) this.eventEmitter.emit('allIconsLoaded');
    }
  }

  private finishConfigInitialization(): void {
    // Only an actual checkpoint merge needs writing; startup normalization is not an edit.
    if (!this.configRecoveryPending)
      this._lastSavedConfig = JSON.stringify(this.data, null, 2);
    this.configVersionBaseline = cloneConfig(this.data);
    this.initializing = false;
    if (this.configRecoveryPending) void this.saveIconFolderData();
  }

  private async initialize(): Promise<void> {
    console.log(`loading ${config.PLUGIN_NAME}`);

    await this.loadIconFolderData();

    // 重定向到配置文件中记录的路径 / Redirect to the path recorded in the config.
    //
    // 只有在目标确实存在时才切换：否则会退回默认设置并把它写回，
    // 从而抹掉原本的指向（指针与它所在文件互相依赖，必须保守处理）。
    // Only switch when the target really exists; otherwise the plugin falls back to
    // defaults and writes them back, erasing the pointer it depends on.
    const savedConfigPath = this.getSettings().configFilePath;
    if (savedConfigPath && savedConfigPath !== this.getConfigPath()) {
      // 这次探测同样必须受保护：移动端存储不可用时它会抛错，而此处位于加载早期，
      // 异常会直接导致 Obsidian 把插件判为「加载失败」。
      //
      // This probe must be guarded too: it throws when mobile storage is unavailable, and
      // sitting as early in load as it does, the exception makes Obsidian report the whole
      // plugin as failed to load.
      let targetExists = false;
      try {
        targetExists = await this.app.vault.adapter.exists(savedConfigPath);
      } catch (error) {
        console.warn(
          `[${config.PLUGIN_NAME}] Could not check config file '${savedConfigPath}':`,
          error,
        );
      }

      if (targetExists) {
        this.setConfigPath(savedConfigPath);
        await this.loadIconFolderData();
      } else {
        // Never fall back to an old bootstrap copy and later overwrite its pointer.
        this.setConfigPath(savedConfigPath);
        this.configLoadState = 'failed';
        console.warn(
          `[${config.PLUGIN_NAME}] Configured config file '${savedConfigPath}' is unavailable; saving is disabled`,
        );
        new Notice(
          `Iconize：配置文件 ${savedConfigPath} 暂不可用，已停止保存，避免退回旧配置。`,
          0,
        );
      }
    }

    await this.initializeConfigSafety();

    logger.toggleLogging(this.getSettings().debugMode);
    this.iconPackManager = new IconPackManager(
      this,
      this.getSettings().iconPacksPath,
    );

    this.api = getApi(this);

    if (this.getSettings().useInternalPlugins) {
      // Registers all modified internal plugins.
      // Only adds star plugin for obsidian under v0.12.6.
      if (!requireApiVersion('0.12.6')) {
        this.modifiedInternalPlugins.push(new StarredInternalPlugin(this));
      } else if (requireApiVersion('1.2.0')) {
        this.modifiedInternalPlugins.push(new BookmarkInternalPlugin(this));
      }

      this.modifiedInternalPlugins.push(new OutlineInternalPlugin(this));
    }

    // 这一段会读写文件系统，因此整体受保护：任何一步失败都不应让 Obsidian 把插件
    // 整个判为「加载失败」。移动端（尤其外置存储）无法建目录、无法列举是常见情况，
    // 正确结果是「暂时没有图标包」，而不是插件不可用。
    //
    // This section touches the file system, so it is guarded as a whole: no single step
    // may make Obsidian report the plugin as failed to load. On mobile — external storage
    // in particular — refusing to create or list a directory is common, and the honest
    // outcome is "no icon packs yet", not "plugin unusable".
    try {
      await this.iconPackManager.createDefaultDirectory();
      await this.checkRecentlyUsedIcons();

      await migrate(this);

      const usedIconNames = this.getUsedIcons();
      await this.iconPackManager.init();
      await this.initLazyLoading([...usedIconNames]);
    } catch (error) {
      console.error(`[${config.PLUGIN_NAME}] Initialisation failed:`, error);

      // 移动端无法打开开发者工具，因此错误必须显示在界面上，否则用户只能看到
      // Obsidian 的「加载失败」而无从排查。
      // Mobile has no developer tools, so the error has to be visible in the UI;
      // otherwise the user only sees Obsidian's "failed to load" with no way to diagnose.
      new Notice(
        `[${config.PLUGIN_NAME}] Failed to initialise: ${
          error instanceof Error ? error.message : String(error)
        }`,
        0,
      );
    }

    if (this.unloading) return;
    this.notebookNavigator = this.addChild(
      new NotebookNavigatorIntegration(this),
    );
    this.app.workspace.onLayoutReady(() => this.handleChangeLayout());

    this.addCommand({
      id: 'embed-icons-in-note',
      name: '将文档内的所有 Iconize 标签嵌入实际图标',
      editorCallback: (editor) => {
        void this.conversion.convertEditor(editor);
      },
    });
    this.addCommand({
      id: 'embed-icons-in-vault',
      name: '将所有带 Iconize 标签的文档嵌入实际图标',
      callback: () => {
        void this.conversion.convertVault();
      },
    });
    this.addCommand({
      id: 'convert-icon-tags-to-svg',
      name: '转换图标标签至 SVG 图标元素（转换器）',
      callback: () => new IconConverterModal(this).open(),
    });
    this.addCommand({
      id: 'recover-configuration',
      name: '配置诊断与恢复 / Diagnose and recover configuration',
      callback: () => new ConfigRecoveryModal(this).open(),
    });
    this.registerEvent(
      this.app.workspace.on('editor-change', (editor) =>
        this.conversion.schedule(editor),
      ),
    );
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', () =>
        this.conversion.cancelPending(),
      ),
    );
    this.registerEvent(
      this.app.workspace.on('editor-menu', (menu, editor) =>
        this.addInlineConversionMenu(menu, editor),
      ),
    );
    this.registerDomEvent(document, 'contextmenu', (event) => {
      const target = event.target as HTMLElement;
      const element = target.closest?.('.cm-iconize-icon[data-icon]');
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (!element || !view || !view.contentEl.contains(element)) return;
      event.preventDefault();
      event.stopPropagation();
      const id = element.getAttribute('data-icon');
      if (!id) return;
      const menu = new Menu();
      menu.addItem((item) =>
        item
          .setTitle('转换此图标 / Convert this icon')
          .setIcon('image')
          .onClick(() => {
            // 重复标签按文档中的渲染顺序对应，始终只替换一个。 / Match duplicate widgets by rendered occurrence.
            const tags = findIconTags(
              view.editor.getValue(),
              this.getSettings().iconIdentifier,
            ).filter((tag) => tag.id === id);
            const from = element.getAttribute('data-iconize-from');
            const tag =
              from !== null
                ? tags.find((tag) => tag.from === Number(from))
                : tags.length === 1
                  ? tags[0]
                  : undefined;
            if (tag) void this.conversion.convertEditor(view.editor, tag);
            else this.openIconOccurrenceMenu(view.editor, id, event);
          }),
      );
      menu.addItem((item) =>
        item
          .setTitle('获取 SVG 标签图标')
          .setIcon('code')
          .onClick(() =>
            new IconConverterModal(
              this,
              `${this.getSettings().iconIdentifier}${id}${this.getSettings().iconIdentifier}`,
            ).open(),
          ),
      );
      menu.showAtMouseEvent(event);
    });

    this.addCommand({
      id: 'iconize:save-config',
      name: '手动保存图标配置 / Save icon configuration now',
      callback: () => this.saveConfigurationNow(),
    });

    this.addCommand({
      id: 'iconize:set-icon-for-file',
      name: 'Set icon for file',
      hotkeys: [
        {
          modifiers: ['Mod', 'Shift'],
          key: 'j',
        },
      ],
      editorCallback: async (editor: EditorWithEditorComponent) => {
        const file = editor.editorComponent?.file;
        if (!file) {
          logger.warn(
            `'editor.editorComponent?.file' is undefined for file: ${file}`,
          );
          return;
        }

        this.openIconPicker(file.path);
      },
    });

    // ===== PATCHED: 标题图标诊断 / Title icon diagnostics =====
    /**
     * 把标题图标的实况写进仓库，随同步回传到桌面。
     * Writes what the title icon actually looks like into the vault, so it syncs back to a
     * machine where it can be read.
     *
     * 移动端没有开发者工具，而标题图标的问题只在那一边复现，因此让设备自己把现场记下来
     * 是唯一能拿到实证的办法。
     *
     * Mobile has no developer tools and the problem only reproduces there, so having the
     * device record the scene is the only way to get evidence.
     */
    this.addCommand({
      id: 'iconize:diagnose-title-icon',
      name: 'Diagnose title icon',
      callback: async () => {
        const report = await this.collectTitleIconDiagnostics();
        const path = `${this.getConfigPath()}.title-icon-diagnostic.json`;

        try {
          await this.app.vault.adapter.write(
            path,
            JSON.stringify(report, null, 2),
          );
          new Notice(`[${config.PLUGIN_NAME}] Diagnostic written to ${path}`);
        } catch (error) {
          console.error('[Iconize] Could not write the diagnostic:', error);
          new Notice(`[${config.PLUGIN_NAME}] Diagnostic failed: ${error}`);
        }
      },
    });
    // ===== END PATCH =====

    this.registerEvent(
      // Registering file menu event for listening to file pinning and unpinning.
      this.app.workspace.on('file-menu', (menu, file) => {
        // I've researched other ways of doing this. However, there is no other way to listen to file pinning and unpinning.
        menu.onHide(() => {
          const path = file.path;
          if (this.getSettings().iconInTabsEnabled) {
            for (const openedFile of getAllOpenedFiles(this)) {
              if (openedFile.path === path) {
                const possibleIcon = IconCache.getInstance().get(path);
                if (!possibleIcon) {
                  return;
                }
                const tabLeaves = iconTabs.getTabLeavesOfFilePath(
                  this,
                  file.path,
                );
                for (const tabLeaf of tabLeaves) {
                  // Add timeout to ensure that the default icon is already set.
                  setTimeout(() => {
                    iconTabs.add(this, file.path, tabLeaf.tabHeaderInnerIconEl);
                  }, 5);
                }
              }
            }
          }
        });
      }),
    );

    this.registerEvent(
      this.app.workspace.on('layout-change', () => this.handleChangeLayout()),
    );

    this.registerEvent(
      this.app.workspace.on('file-menu', (menu, file) =>
        this.addIconizeMenuItems((configure) => menu.addItem(configure), file),
      ),
    );

    this.registerIconPathEvents();

    if (this.getSettings().iconsInNotesEnabled) {
      this.registerMarkdownPostProcessor((el) =>
        processIconInTextMarkdown(this, el),
      );
      this.registerEditorSuggest(new SuggestionIcon(this.app, this));
      this.registerEditorExtension([
        this.positionField,
        buildIconInTextPlugin(this),
      ]);
    }

    if (this.getSettings().iconsInLinksEnabled) {
      this.registerMarkdownPostProcessor((el, ctx) =>
        processIconInLinkMarkdown(this, el, ctx),
      );
      this.registerEditorExtension([
        this.positionField,
        buildIconInLinksPlugin(this),
      ]);
    }

    // ===== PATCHED: 暴露插件实例供调试 / Expose plugin instance for debugging =====
    (window as unknown as { iconizePlugin?: IconizePlugin }).iconizePlugin =
      this;
    // ===== END PATCH =====

    this.settingsUI = new IconFolderSettingsUI(this.app, this);
    this.addSettingTab(this.settingsUI);
  }

  // ===== PATCHED: 按需加载初始化 / Lazy loading initialization =====
  /**
   * 初始化按需加载系统并预取已用图标。
   * Initializes the lazy loading system and prefetches the icons in use.
   *
   * 初始化失败时不再回退到旧的全量预载：那条路径读取的是外部 SVG 文件，而当前模型
   * 从不写出这类文件，回退只会让整个仓库无图标且毫无提示。这里明确报错。
   *
   * Failure no longer falls back to the old full preload: that path reads extracted SVG
   * files which this model never writes, so it would leave the vault iconless without
   * saying so. Report the failure instead.
   */
  private async initLazyLoading(usedIconNames: string[]): Promise<void> {
    const system = await initializeLazyLoading(
      this,
      usedIconNames,
      this.iconLoadingAbort.signal,
    );
    if (this.unloading || this.iconLoadingAbort.signal.aborted) {
      if (system) cleanupLazyLoading(system);
      return;
    }
    if (!system) {
      new Notice(
        `[${config.PLUGIN_NAME}] Icon loading could not be initialised. See the console for details.`,
        10000,
      );
      this.eventEmitter.emit('allIconsLoaded');
      return;
    }

    this.lazyLoadingSystem = system;
    this.iconResolver = system.resolver;
    this.inlineIconLoader = system.loader;
    this.eventEmitter.emit('allIconsLoaded');
  }
  // ===== END PATCH =====

  // ===== PATCHED: 图标选择器入口 / Entry point for the icon picker =====
  /**
   * 为指定路径打开图标选择器 / Opens the icon picker for a path.
   *
   * 命令、右键菜单与点击标题图标都走这里，避免同一段「打开 + 选中后更新标签页与标题」
   * 的逻辑散落三份。
   *
   * The command, the context menu and a click on the title icon all come through here, so
   * the "open, then update tabs and title on select" logic exists once.
   */
  public openIconPicker(path: string): void {
    const session = new IconEditSession(this.app, this, path);

    session.onSelect = (iconName: string): void => {
      IconCache.getInstance().set(path, { iconNameWithPrefix: iconName });

      // Update icon in tab when setting is enabled.
      if (this.getSettings().iconInTabsEnabled) {
        const tabLeaves = iconTabs.getTabLeavesOfFilePath(this, path);
        for (const tabLeaf of tabLeaves) {
          iconTabs.update(this, iconName, tabLeaf.tabHeaderInnerIconEl);
        }
      }

      // Update icon in title when setting is enabled.
      if (this.getSettings().iconInTitleEnabled) {
        this.addIconInTitle(iconName);
      }
    };
    session.openPicker();
  }
  // ===== END PATCH =====

  // ===== PATCHED: 标题图标诊断 / Title icon diagnostics =====
  /**
   * 收集标题图标的现场信息 / Collects what the title icon looks like right now.
   */
  private async collectTitleIconDiagnostics(): Promise<
    Record<string, unknown>
  > {
    const describe = (el: Element | null): Record<string, unknown> | null => {
      if (!el) {
        return null;
      }
      const style = getComputedStyle(el as HTMLElement);
      const rect = (el as HTMLElement).getBoundingClientRect();
      return {
        tag: el.tagName,
        cls: el.className,
        display: style.display,
        visibility: style.visibility,
        opacity: style.opacity,
        width: Math.round(rect.width),
        height: Math.round(rect.height),
        top: Math.round(rect.top),
        left: Math.round(rect.left),
        childCount: el.childElementCount,
        inlineDisplay: (el as HTMLElement).style.display,
        inlineWidth: (el as HTMLElement).style.width,
      };
    };

    const bodyStyle = getComputedStyle(document.body);

    // 强制走一次标题图标的完整链路，并记录事后状态——这样报告本身就能回答
    // 「机制到底能不能工作」，而不是只描述现状。
    // Force the whole title-icon path once and record the outcome, so the report answers
    // whether the mechanism works rather than only describing the status quo.
    const before = this.app.workspace.getLeavesOfType('markdown').length;
    for (const leaf of this.app.workspace.getLeavesOfType('markdown')) {
      const file = leaf.view.file;
      const iconName = file ? this.getIconNameFromPath(file.path) : undefined;
      if (file && iconName) {
        this.applyTitleIcon(
          (leaf.view as InlineTitleView).inlineTitleEl,
          iconName,
          file.path,
        );
      }
    }
    void before;
    await new Promise((resolve) => setTimeout(resolve, 600));

    return {
      at: new Date().toISOString(),
      platform: {
        bodyClasses: document.body.className,
        isMobile: document.body.classList.contains('is-mobile'),
        isTablet: document.body.classList.contains('is-tablet'),
        isPhone: document.body.classList.contains('is-phone'),
        isAndroid: document.body.classList.contains('is-android'),
        isIos: document.body.classList.contains('is-ios'),
        innerWidth: window.innerWidth,
        innerHeight: window.innerHeight,
      },
      settings: {
        iconInTitleEnabled: this.getSettings().iconInTitleEnabled,
        iconInTitlePosition: this.getSettings().iconInTitlePosition,
      },
      cssVariables: {
        lineWidth: bodyStyle.getPropertyValue('--line-width'),
        maxWidth: bodyStyle.getPropertyValue('--max-width'),
        contentMargin: bodyStyle.getPropertyValue('--content-margin'),
        inlineTitleSize: bodyStyle.getPropertyValue('--inline-title-size'),
      },
      // 配置到底读到了什么：区分「配置没同步过来」与「这个文件恰好没配图标」。
      // What the config actually holds: tells "the config has not synced" apart from "this
      // particular file has no icon".
      config: {
        path: this.getConfigPath(),
        entryCount: Object.keys(this.data).length,
        iconEntryCount: Object.entries(this.data).filter(
          ([key, value]) => key !== 'settings' && Boolean(value),
        ).length,
        loadState: this.configLoadState,
        sample: Object.entries(this.data)
          .filter(([key]) => key !== 'settings')
          .slice(0, 5)
          .map(([key, value]) => ({
            key,
            value: typeof value === 'object' ? value : String(value),
          })),
      },
      leaves: this.app.workspace.getLeavesOfType('markdown').map((leaf) => {
        const view = leaf.view as InlineTitleView;
        const inlineTitleEl = view.inlineTitleEl ?? null;
        const parent = inlineTitleEl?.parentElement ?? null;
        const titleIcon = parent
          ? parent.querySelector(`.${config.TITLE_ICON_CLASS}`)
          : null;

        return {
          file: leaf.view.file?.path ?? null,
          iconName: leaf.view.file
            ? (this.getIconNameFromPath(leaf.view.file.path) ?? null)
            : null,
          inlineTitleExists: !!inlineTitleEl,
          inlineTitle: describe(inlineTitleEl),
          parent: describe(parent),
          wrapper: describe(
            parent?.querySelector('.iconize-inline-title-wrapper') ?? null,
          ),
          titleIcon: describe(titleIcon),
          titleIconSvg:
            titleIcon?.querySelector('svg')?.outerHTML.slice(0, 200) ?? null,
        };
      }),
    };
  }
  // ===== END PATCH =====

  public notifyPlugins(): void {
    this.notebookNavigator?.refresh();
    this.modifiedInternalPlugins.forEach((internalPlugin) => {
      if (internalPlugin.enabled) {
        internalPlugin.onMount();
      }
    });
  }

  private async removeSingleIcon(
    file: TAbstractFile,
    persist = true,
  ): Promise<void> {
    if (
      persist &&
      file instanceof TFile &&
      this.getFrontmatterIcon(file.path)
    ) {
      await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
        delete frontmatter[this.getSettings().iconInFrontmatterFieldName];
        delete frontmatter[this.getSettings().iconColorInFrontmatterFieldName];
      });
      this.refreshFrontmatterIcon(file);
      this.notifyPlugins();
      return;
    }
    this.removeFolderIcon(file.path, persist);
    dom.removeIconInPath(file.path);
    IconCache.getInstance().invalidate(file.path);
    this.notifyPlugins();

    let didUpdate = false;

    // Refreshes the icon tab and title icon for custom rules.
    for (const rule of customRule.getSortedRules(this)) {
      const applicable = await customRule.isApplicable(this, rule, file.path);
      if (applicable) {
        customRule.add(this, rule, file);
        this.addIconInTitle(rule.icon);
        const tabLeaves = iconTabs.getTabLeavesOfFilePath(this, file.path);
        for (const tabLeaf of tabLeaves) {
          iconTabs.add(this, file.path, tabLeaf.tabHeaderInnerIconEl, {
            iconName: rule.icon,
          });
        }
        didUpdate = true;
        break;
      }
    }

    // Only remove icon above titles and icon in tabs if no custom rule was found.
    if (!didUpdate) {
      // Refreshes icons above title and icons in tabs.
      //
      // 只刷新图标真正变了的那个文件：这次调用只动了 `file.path`（见上面的
      // `dom.removeIconInPath`），而原实现在**每个**已打开文件上都执行了一遍，于是删掉一个
      // 文件的图标会连带清空其它笔记的标题图标、并把它们的标签页图标换成默认图标。
      // Refresh only the file whose icon actually changed: this call only touched
      // `file.path` (see `dom.removeIconInPath` above), while the original loop ran on
      // *every* opened file — so removing one file's icon wiped the title icons of the other
      // notes and replaced their tab icons with the default one as well.
      for (const openedFile of getAllOpenedFiles(this)) {
        if (openedFile.path !== file.path) {
          continue;
        }

        if (this.getSettings().iconInTitleEnabled) {
          // 图标被删除后回落为默认文件图标，而不是什么都不留——这样仍有一个可点击的入口
          // 可以把图标加回来。
          // Removing an icon falls back to the default file icon instead of leaving nothing,
          // so there is still a click target to add one back.
          this.applyTitleIcon(
            (openedFile.leaf.view as InlineTitleView).inlineTitleEl,
            undefined,
            file.path,
          );
        }
        if (this.getSettings().iconInTabsEnabled) {
          const leaf = openedFile.leaf as TabHeaderLeaf;
          iconTabs.remove(leaf.tabHeaderInnerIconEl, {
            replaceWithDefaultIcon: true,
          });
        }
      }
    }
  }

  private handleChangeLayout(): void {
    this.notebookNavigator?.refresh();
    // Transform data that are objects to single strings.
    const data = Object.entries(this.data) as [
      string,
      string | FolderIconObject,
    ][];

    this.modifiedInternalPlugins.forEach((internalPlugin) => {
      if (internalPlugin.enabled) {
        internalPlugin.onMount();
        internalPlugin.register();
      }
    });

    icon.addAll(this, data, this.registeredFileExplorers, () => {
      // 图标包在启动时已建好索引，此处只需处理缺失图标的后台检查。
      // Packs are already indexed at start-up; only the background check is left here.
      void (async () => {
        try {
          if (this.getSettings().iconsBackgroundCheckEnabled) {
            const data = Object.entries(this.data) as [
              string,
              string | FolderIconObject,
            ][];
            await icon.checkMissingIcons(this, data);
          }
        } catch (error) {
          console.error('[Iconize] Background icon check failed:', error);
        }

        this.eventEmitter.emit('allIconsLoaded');
      })();

      // Adds the title icon to the active leaf view.
      if (this.getSettings().iconInTitleEnabled) {
        for (const openedFile of getAllOpenedFiles(this)) {
          // ===== PATCHED: folder note 继承父文件夹图标 =====
          const iconName =
            icon.getByPath(this, openedFile.path) ||
            getFolderNoteInheritedIcon(this, openedFile.path);
          // ===== END PATCH =====
          const activeView = openedFile.leaf.view as InlineTitleView;
          if (activeView instanceof MarkdownView && iconName) {
            // 与其余标题图标路径共用同一处理：按需解析 + 颜色 + emoji 判定。
            // Shares the one title-icon path: on-demand resolve, color, emoji handling.
            this.applyTitleIcon(
              activeView.inlineTitleEl,
              iconName,
              openedFile.path,
            );
          }
        }
      }

      // Register rename event for adding icons with custom rules to the DOM
      // when file was moved to another directory.
      this.registerEvent(
        this.app.vault.on('rename', async (file, oldPath) => {
          const sortedRules = customRule.getSortedRules(this);

          // Removes possible icons from the renamed file.
          sortedRules.forEach((rule) => {
            if (customRule.doesMatchPath(rule, oldPath)) {
              dom.removeIconInPath(file.path);
            }
          });

          // Adds possible icons to the renamed file.
          sortedRules.forEach((rule) => {
            if (customRule.doesMatchPath(rule, oldPath)) {
              return;
            }

            customRule.add(this, rule, file, undefined);
          });

          // Updates icon tabs for the renamed file.
          for (const rule of customRule.getSortedRules(this)) {
            const applicable = await customRule.isApplicable(
              this,
              rule,
              file.path,
            );
            if (!applicable) {
              continue;
            }

            const openedFiles = getAllOpenedFiles(this);
            const openedFile = openedFiles.find(
              (openedFile) => openedFile.path === file.path,
            );
            if (openedFile) {
              const leaf = openedFile.leaf as TabHeaderLeaf;
              iconTabs.update(this, rule.icon, leaf.tabHeaderInnerIconEl);
            }
            break;
          }
        }),
      );

      // Register `layout-change` event for adding icons to tabs when moving a pane or
      // enabling reading mode.
      this.registerEvent(
        this.app.workspace.on('layout-change', () => {
          if (this.getSettings().iconInTitleEnabled) {
            const activeView =
              this.app.workspace.getActiveViewOfType(MarkdownView);
            if (activeView) {
              const file = activeView.file;
              const view = activeView as unknown as InlineTitleView;
              // ===== PATCHED: folder note 继承父文件夹图标 =====
              const iconNameWithPrefix =
                icon.getByPath(this, file.path) ||
                getFolderNoteInheritedIcon(this, file.path);
              // ===== END PATCH =====
              // 没有标识也照常往下走：`applyTitleIcon` 会回落到默认文件图标。
              // A missing identifier still goes through: `applyTitleIcon` falls back to the
              // default file icon.
              //
              // 这里原本是 `hide()` + return。那个 return 会连下面的标签页图标补丁一起跳过。
              // This used to be `hide()` + return, and that return skipped the tab-icon patch
              // below along with it.

              // Removes the node because the editor markdown content is being rerendered
              // when the content mode changes back to editing.
              this.applyTitleIcon(
                view.inlineTitleEl,
                iconNameWithPrefix,
                file.path,
              );
            }
          }

          if (!this.getSettings().iconInTabsEnabled) {
            return;
          }

          for (const openedFile of getAllOpenedFiles(this)) {
            const leaf = openedFile.leaf as TabHeaderLeaf;
            const iconColor = this.getIconColor(leaf.view.file.path);
            iconTabs.add(this, openedFile.path, leaf.tabHeaderInnerIconEl, {
              iconColor,
            });
          }
        }),
      );

      // Register `file-open` event for adding icon to title.
      this.registerEvent(
        this.app.workspace.on('file-open', (file) => {
          if (!this.getSettings().iconInTitleEnabled) {
            return;
          }

          for (const openedFile of getAllOpenedFiles(this)) {
            if (!file || !openedFile || openedFile.path !== file.path) {
              continue;
            }

            const leaf = openedFile.leaf.view as InlineTitleView;
            // ===== PATCHED: folder note 继承父文件夹图标 =====
            const iconNameWithPrefix =
              icon.getByPath(this, file.path) ||
              getFolderNoteInheritedIcon(this, file.path);
            // ===== END PATCH =====
            // 没有标识也照常往下走：`applyTitleIcon` 会回落到默认文件图标。这里原本是
            // `hide()` + return，而那个 return 在 for 循环内部，会中止同一批里后续叶子的处理。
            // A missing identifier still goes through: `applyTitleIcon` falls back to the
            // default file icon. This used to be `hide()` + return, and that return sat inside
            // the for loop, aborting the leaves that followed in the same batch.
            this.applyTitleIcon(
              leaf.inlineTitleEl,
              iconNameWithPrefix,
              file.path,
            );
          }
        }),
      );

      // Register event for frontmatter icon registration.
      this.registerEvent(
        this.app.metadataCache.on('changed', (file) => {
          if (!this.getSettings().iconInFrontmatterEnabled) return;
          this.refreshFrontmatterIcon(file);
        }),
      );

      // Register active leaf change event for adding icon of file to tab.
      this.registerEvent(
        this.app.workspace.on('active-leaf-change', (leaf: WorkspaceLeaf) => {
          if (!this.getSettings().iconInTabsEnabled) {
            return;
          }

          // TODO: Maybe change in the future to a more optimal solution.
          // Fixes a problem when the file was clicked twice in the same tab.
          // See https://github.com/FlorianWoelki/obsidian-iconize/issues/208.
          if (leaf.view.getViewType() === 'file-explorer') {
            for (const openedFile of getAllOpenedFiles(this)) {
              const leaf = openedFile.leaf as TabHeaderLeaf;
              const iconColor = this.getIconColor(leaf.view.file.path);
              iconTabs.add(this, openedFile.path, leaf.tabHeaderInnerIconEl, {
                iconColor,
              });
            }
            return;
          }

          if (leaf.view.getViewType() !== 'markdown') {
            return;
          }

          const tabHeaderLeaf = leaf as TabHeaderLeaf;
          if (tabHeaderLeaf.view.file) {
            const iconColor = this.getIconColor(tabHeaderLeaf.view.file.path);
            iconTabs.add(
              this,
              tabHeaderLeaf.view.file.path,
              tabHeaderLeaf.tabHeaderInnerIconEl,
              {
                iconColor,
              },
            );
          }
        }),
      );

      this.registerEvent(
        this.app.workspace.on('css-change', () => {
          for (const openedFile of getAllOpenedFiles(this)) {
            const activeView = openedFile.leaf.view as InlineTitleView;
            if (activeView instanceof MarkdownView) {
              titleIcon.updateStyle(activeView.inlineTitleEl, {
                fontSize: calculateInlineTitleSize(),
              });
            }
          }
        }),
      );
    });
  }

  // ===== PATCHED: 标题图标按需解析 / Resolve title icons on demand =====
  /**
   * 应用 Obsidian 默认文件图标 / Applies the Obsidian default file icon.
   *
   * 文件没有任何图标时用它占位。所有「无图标出口」共用这一处，点击行为与颜色因此一致。
   * Stands in when a file has no icon at all; every no-icon exit shares it, so the click
   * behaviour and the colour stay identical.
   *
   * 不传 `color`：`DEFAULT_FILE_ICON` 用 `stroke="currentColor"` 绘制，让它继承内联标题的
   * 文字色，也避免 folder note 的父文件夹颜色漏到占位图标上。
   * No `color`: it paints with `stroke="currentColor"`, so it inherits the inline title's text
   * colour, and a folder note's parent colour cannot leak onto the placeholder.
   *
   * 不传 `iconName`：默认图标不代表任何配置，写入 `data-icon` 会让按该属性查询的逻辑
   *（图标缺失检查）把它误认为某个真图标并覆盖它的内容。
   * No `iconName`: it stands for no configuration, and writing `data-icon` would make
   * `[data-icon=...]` queries mistake it for a real icon and overwrite its content.
   */
  public applyDefaultTitleIcon(inlineTitleEl: HTMLElement, path: string): void {
    titleIcon.add(this, inlineTitleEl, DEFAULT_FILE_ICON, {
      fontSize: calculateInlineTitleSize(),
      // 点击默认图标即可为这个文件设置图标。
      // Clicking the default icon sets an icon for this file.
      path,
      onClick: (clickedPath, event) =>
        this.openTitleIconMenu(clickedPath, event),
    });
  }

  /**
   * 标题图标的写入管道 / The write pipeline for title icons.
   *
   * 所有把图标写到内联标题上的地方都走这里，由它一次补齐标题图标应有的全部属性：颜色
   *（该文件的有效颜色）、字号、emoji 风格、path 标识、点击改图标，以及作废在飞的旧请求。
   * 调用方只需要回答「哪个元素、哪个文件、哪个图标」。
   * Every place that writes an icon onto an inline title goes through here, which fills in
   * the whole attribute set a title icon should carry — colour (the file's effective one),
   * font size, emoji style, path identity, click-to-change — and invalidates stale in-flight
   * requests. Callers only answer which element, which file, which icon.
   *
   * 按需加载下图标可能只在索引中，因此同步查找失败并不代表图标不存在，会在异步解析完成后再写。
   *
   * 名字为空、或名字存在却解析不出（图标包被移除、规则指向已删除的图标）时，都回落到默认
   * 文件图标：标题处的位置始终存在，用户也就始终有一个可点击的入口。
   * An empty name, and a name that cannot be resolved (pack removed, rule pointing at a
   * deleted icon), both fall back to the default file icon: the slot on the title always
   * exists, so the user always has a click target.
   */
  public applyTitleIcon(
    inlineTitleEl: HTMLElement,
    iconNameWithPrefix: string | undefined,
    path: string,
  ): void {
    // 该文件没有任何图标：用默认文件图标占位。
    // No icon for this file: stand in the default file icon.
    if (!iconNameWithPrefix) {
      this.applyDefaultTitleIcon(inlineTitleEl, path);
      return;
    }

    // 颜色与标签页图标使用同一来源，folder note 会回退到父文件夹的颜色。
    // Same color source as tab icons; folder notes fall back to their folder's color.
    const color = this.getEffectiveIconColor(path);

    if (emoji.isEmoji(iconNameWithPrefix)) {
      this.writeTitleIcon(
        inlineTitleEl,
        iconNameWithPrefix,
        path,
        color,
        iconNameWithPrefix,
      );
      return;
    }

    const foundIcon = icon.getIconByName(this, iconNameWithPrefix)?.svgElement;
    if (foundIcon) {
      this.writeTitleIcon(
        inlineTitleEl,
        foundIcon,
        path,
        color,
        iconNameWithPrefix,
      );
      return;
    }

    // 图标在索引中但尚未解析：异步取回后再加。
    if (this.iconResolver?.find(iconNameWithPrefix)) {
      // 领号必须在 await 之前：解析期间发生的任何一次写入都会让这个号作废，晚到的结果于是被
      // 丢弃，标题上就不会画出上一个文件的图标。登记由 `icon-title` 模块持有，任何写入路径
      //（包括设置页那两处）都不可能绕过它。
      // Take the ticket before awaiting: any write during the resolve invalidates it, so a
      // late result is dropped and the previous file's icon never lands on the title. The
      // registry lives in `icon-title`, so no write path — the settings ones included — can
      // bypass it.
      const requestId = titleIcon.beginRequest(inlineTitleEl);

      this.iconResolver
        .resolveSvg(iconNameWithPrefix)
        .then((svgMarkup) => {
          if (!svgMarkup || !inlineTitleEl.isConnected) {
            return;
          }
          // 已被更新的请求取代（用户切到了别的文件）：丢弃这次结果。
          // Superseded by a newer request (the user moved to another file): drop it.
          if (!titleIcon.isLatestRequest(inlineTitleEl, requestId)) {
            return;
          }

          this.writeTitleIcon(
            inlineTitleEl,
            svgMarkup,
            path,
            color,
            iconNameWithPrefix,
          );
        })
        .catch((error) =>
          console.error('[Iconize] Failed to resolve title icon:', error),
        );
      return;
    }

    // 名字存在却解析不出来（图标包被移除、规则指向已删除的图标）：与「没有图标」一样回落到
    // 默认图标，否则复用元素上会一直留着上一个文件的图标。
    // Named but unresolvable (pack removed, rule pointing at a deleted icon): falls back like
    // "no icon", or the previous file's icon would linger on the reused element.
    this.applyDefaultTitleIcon(inlineTitleEl, path);
  }

  /**
   * 管道本体：把图标源连同它应有的全部属性一次写进标题元素。
   * The pipeline itself: writes an icon source plus the whole attribute set it should carry.
   *
   * 三条写入分支（emoji / 内存命中 / 异步解析回来）原本各自拼一遍同样的选项对象，任何一处漏写
   * 都会表现为「标题上的图标与别处不一致」。选项只在这里定义一次，分支只负责给出图标源。
   * The three write branches (emoji, memory hit, late resolve) each used to assemble the same
   * option object, and any omission showed up as a title icon that disagreed with every other
   * place. The options are defined once here; branches only supply the source.
   *
   * `remove` 在前是因为元素会被复用：旧图标必须先摘掉，否则失败路径会把它留在原地。
   * `remove` comes first because the element is reused: the old icon must go, or a failing
   * path would leave it behind.
   *
   * @param source 图标标记或 emoji / Icon markup or emoji.
   * @param iconName 数据标识；emoji 与默认图标之外的真实图标才有。
   *   Data identifier; only real icons have one, emoji and the default icon do not.
   */
  private writeTitleIcon(
    inlineTitleEl: HTMLElement,
    source: string,
    path: string,
    color: string | undefined,
    iconName?: string,
  ): void {
    titleIcon.remove(inlineTitleEl);
    titleIcon.add(this, inlineTitleEl, source, {
      fontSize: calculateInlineTitleSize(),
      color,
      iconName,
      // 点击标题图标即可更改它的图标。
      // Clicking the title icon changes its icon.
      path,
      onClick: (clickedPath, event) =>
        this.openTitleIconMenu(clickedPath, event),
    });
  }

  /**
   * 取路径的有效图标颜色：优先自身，其次 folder note 的父文件夹。
   * Effective icon color for a path: its own, else the folder note's parent folder.
   */
  private getEffectiveIconColor(path: string): string | undefined {
    const own = this.getIconColor(path);
    if (own) {
      return own;
    }

    const parentFolder = getFolderNoteParent(this, path);
    return parentFolder ? this.getIconColor(parentFolder) : undefined;
  }
  // ===== END PATCH =====

  addIconInTitle(iconName: string): void {
    for (const openedFile of getAllOpenedFiles(this)) {
      const activeView = openedFile.leaf.view as InlineTitleView;
      if (activeView instanceof MarkdownView) {
        this.applyTitleIcon(
          activeView.inlineTitleEl,
          iconName,
          openedFile.path,
        );
      }
    }
  }

  onunload() {
    this.iconLoadingAbort.abort();
    this.notebookNavigator?.unload();
    this.notebookNavigator = undefined;
    this.conversion.dispose();
    console.log('unloading obsidian-icon-folder');
    this.unloading = true;
    if (this.configRefreshTimer !== null) clearTimeout(this.configRefreshTimer);
    if (this.saveWaiters.length) void this.flushConfigSave();

    // ===== PATCHED: 清理按需加载系统 / Cleanup lazy loading =====
    if (this.lazyLoadingSystem) {
      cleanupLazyLoading(this.lazyLoadingSystem);
      this.lazyLoadingSystem = undefined;
      this.iconResolver = undefined;
      this.inlineIconLoader = undefined;
    }

    // 释放每个源持有的已解析归档，并撤掉调试用全局引用——它会连同整个插件实例
    // （以及所有归档）一起把内存留住，禁用插件而不重载时尤其明显。
    //
    // Release every parsed archive and drop the debug global: it keeps the whole plugin
    // instance (and its archives) alive, which matters when disabling without a reload.
    for (const pack of this.iconPackManager?.getIconPacks() ?? []) {
      pack.getSource()?.cancel?.();
      pack.getSource()?.dispose();
    }
    const globalScope = window as unknown as { iconizePlugin?: IconizePlugin };
    if (globalScope.iconizePlugin === this) {
      delete globalScope.iconizePlugin;
    }
    // ===== END PATCH =====
  }

  private registerIconPathEvents(): void {
    // A sync replacement can appear as delete/create. Retain icon assignments
    // until the user explicitly removes them; temporary absence is not deletion intent.
    this.registerEvent(
      this.app.vault.on('delete', (file) => {
        IconCache.getInstance().invalidate(file.path);
      }),
    );

    const refreshConfigFile = (file: { path: string }) => {
      if (file.path === this.getConfigPath()) this.scheduleConfigRefresh();
    };
    this.registerEvent(this.app.vault.on('modify', refreshConfigFile));
    this.registerEvent(
      this.app.vault.on('create', (file) => {
        refreshConfigFile(file);
        if (!this.initializing && this.data[file.path] !== undefined) {
          window.setTimeout(() => {
            if (!this.unloading) this._refreshFileExplorerIcon(file.path);
          }, 0);
        }
      }),
    );

    // renaming event
    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
        if (
          file.path === this.getConfigPath() ||
          oldPath === this.getConfigPath()
        ) {
          this.scheduleConfigRefresh();
          return;
        }
        // Check if the file was moved and had an icon before.
        const dataPoint = this.data[oldPath];
        if (dataPoint && oldPath !== 'settings') {
          const iconNameWithPrefix =
            typeof dataPoint === 'object'
              ? (dataPoint as FolderIconObject).iconName
              : (dataPoint as string);
          dom.createIconNode(this, file.path, iconNameWithPrefix);
        }

        this.renameFolder(file.path, oldPath);
      }),
    );
  }

  renameFolder(newPath: string, oldPath: string): void {
    if (newPath === oldPath) {
      return;
    }

    let changed = false;

    // 被改名的路径自身。父键不在时也要继续搬子键——否则「父目录没设过图标、
    // 子目录设过」的场景会在改名时把子键全丢掉。
    //
    // The renamed path itself. Keep going even when the parent has no key: otherwise
    // a parent without an icon that has iconed children loses every child key on rename.
    if (this.data[oldPath] !== undefined) {
      this.recordIconRemoval(oldPath);
      delete this.getSettings().configRemovals?.[newPath];
      Object.defineProperty(
        this.data,
        newPath,
        Object.getOwnPropertyDescriptor(this.data, oldPath),
      );
      delete this.data[oldPath];
      changed = true;
    }

    // 子路径：Obsidian 对文件夹改名 / 移动只发一条 rename 事件，子文件夹与
    // folder note 的键必须跟着前缀一起改写，否则全部变成指向旧路径的死键。
    //
    // Descendants: Obsidian emits a single rename event for a folder, so every child
    // folder and folder-note key has to follow the prefix or it becomes a dead key.
    const oldPrefix = oldPath + '/';
    const newPrefix = newPath + '/';
    for (const key of Object.keys(this.data)) {
      if (key === 'settings') {
        continue;
      }
      if (!key.startsWith(oldPrefix)) {
        continue;
      }
      const successor = newPrefix + key.slice(oldPrefix.length);
      this.recordIconRemoval(key);
      delete this.getSettings().configRemovals?.[successor];
      if (this.data[successor] !== undefined) {
        // 目标位置已经有图标（改名后被手动重设过）：保留新值，丢掉陈旧源键。
        //
        // The target already has an icon (reassigned after the move): keep the newer
        // value and drop the stale source key.
        delete this.data[key];
      } else {
        Object.defineProperty(
          this.data,
          successor,
          Object.getOwnPropertyDescriptor(this.data, key),
        );
        delete this.data[key];
      }
      changed = true;
    }

    if (changed) {
      this.saveIconFolderData();
    }
  }

  addIconColor(path: string, iconColor: string, persist = true): void {
    const pathData = this.getData()[path];

    if (!iconColor && typeof pathData === 'string') return;

    if (typeof pathData === 'string') {
      this.getData()[path] = {
        iconName: pathData,
        iconColor,
      };
    } else if (pathData && typeof pathData === 'object') {
      (pathData as FolderIconObject).iconColor = iconColor;
    } else {
      this.getData()[path] = {
        iconName:
          icon.getByPath(this, path) ||
          getFolderNoteInheritedIcon(this, path) ||
          null,
        iconColor,
      };
    }

    if (persist) this.saveIconFolderData();
  }

  /** Frontmatter is a display override, never a mutation of saved folder icons. */
  public getFrontmatterIcon(path: string): FolderIconObject | undefined {
    if (!this.getSettings().iconInFrontmatterEnabled) return undefined;
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return undefined;
    const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
    const name = frontmatter?.[this.getSettings().iconInFrontmatterFieldName];
    if (typeof name !== 'string' || !name.trim()) return undefined;
    const color =
      frontmatter?.[this.getSettings().iconColorInFrontmatterFieldName];
    return {
      iconName: name,
      iconColor:
        typeof color === 'string'
          ? isHexadecimal(color)
            ? stringToHex(color)
            : color
          : undefined,
    };
  }

  private refreshFrontmatterIcon(file: TFile): void {
    this.notebookNavigator?.refresh();
    IconCache.getInstance().invalidate(file.path);
    this._refreshFileExplorerIcon(file.path);
    for (const opened of getAllOpenedFiles(this)) {
      if (opened.path !== file.path) continue;
      if (this.getSettings().iconInTabsEnabled) {
        const container = (opened.leaf as TabHeaderLeaf).tabHeaderInnerIconEl;
        if (icon.getByPath(this, file.path)) {
          iconTabs.add(this, file.path, container, {
            iconColor: this.getIconColor(file.path),
          });
        } else {
          iconTabs.remove(container, { replaceWithDefaultIcon: true });
        }
      }
      if (this.getSettings().iconInTitleEnabled) {
        this.applyTitleIcon(
          (opened.leaf.view as InlineTitleView).inlineTitleEl,
          icon.getByPath(this, file.path) ||
            getFolderNoteInheritedIcon(this, file.path),
          file.path,
        );
      }
    }
  }

  getIconColor(path: string): string | undefined {
    const frontmatter = this.getFrontmatterIcon(path);
    if (frontmatter) return frontmatter.iconColor;
    const pathData = this.getData()[path];

    if (!pathData) {
      return undefined;
    }

    if (typeof pathData === 'string') {
      return undefined;
    }

    return (pathData as FolderIconObject).iconColor;
  }

  removeIconColor(path: string): void {
    const pathData = this.getData()[path];

    if (!pathData || typeof pathData !== 'object') {
      return;
    }

    const currentValue = pathData as FolderIconObject;
    this.getData()[path] = currentValue.iconName;

    this.saveIconFolderData();
  }

  /** 颜色保存后统一刷新标题、标签页和文件树。 / Refresh every icon surface after a color change. */
  public async changeIconColor(path: string, color?: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile && this.getFrontmatterIcon(path)) {
      await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
        const key = this.getSettings().iconColorInFrontmatterFieldName;
        if (color) frontmatter[key] = color;
        else delete frontmatter[key];
      });
    } else {
      if (color) this.addIconColor(path, color);
      else this.removeIconColor(path);
    }
    IconCache.getInstance().clear();
    this._refreshFileExplorerIcon(path);
    for (const opened of getAllOpenedFiles(this)) {
      const openedFile = this.app.vault.getAbstractFileByPath(opened.path);
      if (openedFile instanceof TFile) this.refreshFrontmatterIcon(openedFile);
    }
    this.notebookNavigator?.refresh();
  }

  /** 图标和颜色作为一次选择保存，兼容 frontmatter 覆盖。 / Save icon and color together, including frontmatter overrides. */
  public async selectIcon(
    path: string,
    id: string,
    color?: string,
  ): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile && this.getFrontmatterIcon(path)) {
      await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
        frontmatter[this.getSettings().iconInFrontmatterFieldName] = id;
        const key = this.getSettings().iconColorInFrontmatterFieldName;
        if (color) frontmatter[key] = color;
        else delete frontmatter[key];
      });
      this.refreshFrontmatterIcon(file);
    } else {
      this.addFolderIcon(path, id);
      if (color) this.addIconColor(path, color);
      await this.changeIconColor(path, color);
    }
  }

  removeFolderIcon(path: string, persist = true): void {
    if (!this.data[path]) {
      return;
    }

    // 删掉一条图标配置是不可逆的，而触发它的路径有多条（右键菜单、文件删除、
    // frontmatter 监听、设置项）。调试模式下记录调用栈，出问题时可以直接定位来源。
    //
    // Removing an icon config is irreversible and several paths reach here (the context
    // menu, a file deletion, the frontmatter listener, a settings action). Logging the stack
    // in debug mode makes the source identifiable when something goes wrong.
    if (this.getSettings().debugMode) {
      logger.warn(
        `Removing icon config for '${path}'\n${new Error('stack').stack ?? ''}`,
      );
    }

    // Saves the icon name with prefix to remove it from the icon pack directory later.
    const iconData = this.data[path];

    if (persist) this.recordIconRemoval(path);
    delete this.data[path];

    // Removes the icon from the icon pack directory if it is not used as an icon somewhere
    // else.
    if (iconData) {
      let iconNameWithPrefix = iconData as string | FolderIconObject;
      if (typeof iconData === 'object') {
        iconNameWithPrefix = (iconData as FolderIconObject).iconName;
      } else {
        iconNameWithPrefix = iconData as string;
      }

      if (persist && !emoji.isEmoji(iconNameWithPrefix)) {
        removeIconFromIconPack(this, iconNameWithPrefix);
      }
    }

    // ===== PATCHED: 双向清理：同步删除对端记录 =====
    if (
      this.getSettings().inheritFolderNoteIconEnabled &&
      this.getSettings().bidirectionalFolderNoteIconSyncEnabled
    ) {
      this._removeSyncedFolderNoteIcon(path, persist);
    }
    // ===== END PATCH =====

    //this.addIconsToSearch();
    if (persist) this.saveIconFolderData();
  }

  // ===== PATCHED: 双向清理：删除对端（folder note 或 folder）的 data.json 记录 =====
  private _removeSyncedFolderNoteIcon(path: string, persist = true): void {
    if (path.endsWith('.md')) {
      // folder note → 清理父 folder 的记录
      const parentFolder = path.substring(0, path.lastIndexOf('/'));
      if (!parentFolder) {
        return;
      }
      const expectedBase = resolveFolderNotePath(this, parentFolder);
      if (path !== `${expectedBase}.md`) {
        return;
      }
      if (this.data[parentFolder]) {
        if (persist) this.recordIconRemoval(parentFolder);
        delete this.data[parentFolder];
        this._refreshFileExplorerIcon(parentFolder);
      }
    } else {
      // folder → 清理 folder note 的记录
      const folderNotePath = `${resolveFolderNotePath(this, path)}.md`;
      if (this.data[folderNotePath]) {
        if (persist) this.recordIconRemoval(folderNotePath);
        delete this.data[folderNotePath];
        this._refreshFileExplorerIcon(folderNotePath);
      }
    }
  }

  // ===== PATCHED: 刷新文件列表中指定路径的图标显示 =====
  private _refreshFileExplorerIcon(path: string): void {
    const fileExplorers = this.app.workspace.getLeavesOfType('file-explorer');
    for (const fileExplorer of fileExplorers) {
      const fileItem = fileExplorer.view.fileItems[path];
      if (fileItem) {
        const titleEl = getFileItemTitleEl(fileItem);
        const titleInnerEl = getFileItemInnerTitleEl(fileItem);
        const existingIcon = titleEl.querySelector('.iconize-icon');
        if (existingIcon) {
          existingIcon.remove();
        }
        const iconName =
          icon.getByPath(this, path) || getFolderNoteInheritedIcon(this, path);
        if (iconName) {
          const iconColor = this.getEffectiveIconColor(path);
          const iconNode = titleEl.createDiv();
          iconNode.setAttribute(config.ICON_ATTRIBUTE_NAME, iconName);
          iconNode.classList.add('iconize-icon');
          IconCache.getInstance().set(path, { iconNameWithPrefix: iconName });
          dom.setIconForNode(this, iconName, iconNode, { color: iconColor });
          titleEl.insertBefore(iconNode, titleInnerEl);
        }
      }
    }
  }

  // ===== PATCHED: 双向同步 folder ↔ folder note 图标到 data.json =====
  private _syncFolderNoteIcon(
    path: string,
    iconName: string,
    persist = true,
  ): void {
    const stillCurrent = () => {
      const value = this.data[path];
      return (
        !this.unloading &&
        (typeof value === 'string'
          ? value
          : (value as FolderIconObject)?.iconName) === iconName
      );
    };
    this.app.vault.adapter
      .stat(path)
      .then((stat) => {
        if (!stillCurrent()) return;
        if (stat && stat.type === 'folder') {
          // folder → folder note：同步 iconName + iconColor
          const folderNotePath = `${resolveFolderNotePath(this, path)}.md`;
          this.app.vault.adapter
            .exists(folderNotePath)
            .then((exists) => {
              if (!stillCurrent()) return;
              if (exists) {
                const folderData = this.data[path];
                const folderColor =
                  typeof folderData === 'object' && folderData !== null
                    ? (folderData as FolderIconObject).iconColor
                    : undefined;
                const existing = this.data[folderNotePath];
                if (folderColor) {
                  this.data[folderNotePath] =
                    typeof existing === 'object' && existing !== null
                      ? { ...existing, iconName, iconColor: folderColor }
                      : { iconName, iconColor: folderColor };
                } else {
                  this.data[folderNotePath] =
                    typeof existing === 'object' && existing !== null
                      ? { ...existing, iconName }
                      : iconName;
                }
                if (persist) {
                  delete this.getSettings().configRemovals?.[folderNotePath];
                  this.saveIconFolderData();
                }
                this._refreshFileExplorerIcon(folderNotePath);
              }
            })
            .catch((e) =>
              console.error(
                '[_syncFolderNoteIcon] folder note exists 失败:',
                e,
              ),
            );
        } else if (path.endsWith('.md')) {
          // folder note → folder（反向）：同步 iconName + iconColor
          const parentFolder = path.substring(0, path.lastIndexOf('/'));
          if (!parentFolder) {
            return;
          }
          const expectedBase = resolveFolderNotePath(this, parentFolder);
          if (path !== `${expectedBase}.md`) {
            return;
          }
          const folderNoteData = this.data[path];
          const folderNoteColor =
            typeof folderNoteData === 'object' && folderNoteData !== null
              ? (folderNoteData as FolderIconObject).iconColor
              : undefined;
          const existing = this.data[parentFolder];
          if (folderNoteColor) {
            this.data[parentFolder] =
              typeof existing === 'object' && existing !== null
                ? { ...existing, iconName, iconColor: folderNoteColor }
                : { iconName, iconColor: folderNoteColor };
          } else {
            this.data[parentFolder] =
              typeof existing === 'object' && existing !== null
                ? { ...existing, iconName }
                : iconName;
          }
          if (persist) {
            delete this.getSettings().configRemovals?.[parentFolder];
            this.saveIconFolderData();
          }
          this._refreshFileExplorerIcon(parentFolder);
        }
      })
      .catch((e) => console.error('[_syncFolderNoteIcon] stat 失败:', e));
  }
  // ===== END PATCH =====

  addFolderIcon(path: string, icon: Icon | string, persist = true): void {
    const iconName = getNormalizedName(
      typeof icon === 'object' ? icon.displayName : icon,
    );

    this.data[path] = iconName;
    if (persist) delete this.getSettings().configRemovals?.[path];

    // Update recently used icons.
    if (persist && !this.getSettings().recentlyUsedIcons.includes(iconName)) {
      if (
        this.getSettings().recentlyUsedIcons.length >=
        this.getSettings().recentlyUsedIconsSize
      ) {
        this.getSettings().recentlyUsedIcons =
          this.getSettings().recentlyUsedIcons.slice(
            0,
            this.getSettings().recentlyUsedIconsSize - 1,
          );
      }

      this.getSettings().recentlyUsedIcons.unshift(iconName);
      if (persist) this.checkRecentlyUsedIcons();
    }

    //this.addIconsToSearch();
    // ===== PATCHED: 双向同步 folder ↔ folder note =====
    if (
      this.getSettings().inheritFolderNoteIconEnabled &&
      this.getSettings().bidirectionalFolderNoteIconSyncEnabled
    ) {
      this._syncFolderNoteIcon(path, iconName, persist);
    }
    // ===== END PATCH =====
    if (persist) this.saveIconFolderData();
  }

  public getSettings(): IconFolderSettings {
    return this.data.settings as IconFolderSettings;
  }

  /** 两种文件浏览器共用操作，始终只更改明确点击的项目。 / Shared actions target the clicked entry in either explorer. */
  public addIconizeMenuItems(
    addItem: (configure: (item: MenuItem) => void) => void,
    file: TAbstractFile,
  ): void {
    addItem((item) =>
      item
        .setTitle('更改此项目的 Iconize 图标')
        .setIcon('image')
        .onClick(() => this.openIconPicker(file.path)),
    );
    const id =
      icon.getByPath(this, file.path) ||
      getFolderNoteInheritedIcon(this, file.path);
    if (id && !emoji.isEmoji(id)) {
      addItem((item) =>
        item
          .setTitle('更改此项目的 Iconize 图标颜色')
          .setIcon('palette')
          .onClick(() =>
            new IconEditSession(this.app, this, file.path).openColor(),
          ),
      );
    }
    const own = this.getData()[file.path];
    const hasOwn =
      typeof own === 'string' ||
      (own &&
        typeof own === 'object' &&
        'iconName' in own &&
        typeof own.iconName === 'string');
    if (hasOwn || this.getFrontmatterIcon(file.path)) {
      addItem((item) =>
        item
          .setTitle('移除此项目的 Iconize 图标')
          .setIcon('trash')
          .onClick(() => {
            void this.removeSingleIcon(file).catch((error: unknown) => {
              logger.error(
                '[Iconize] Could not remove icon:',
                undefined,
                error,
              );
              new Notice('Iconize：移除失败，请检查配置状态。');
            });
          }),
      );
    }
  }

  /** 标题与编辑器使用原生菜单，避免额外 DOM 耦合。 / Native menus keep UI modules decoupled. */
  public openTitleIconMenu(path: string, event?: MouseEvent): void {
    const menu = new Menu();
    menu.addItem((item) =>
      item
        .setTitle('更改图标 / Change icon')
        .setIcon('image')
        .onClick(() => this.openIconPicker(path)),
    );
    menu.addItem((item) =>
      item
        .setTitle('更改图标颜色 / Change icon color')
        .setIcon('palette')
        .onClick(() => new IconEditSession(this.app, this, path).openColor()),
    );
    menu.addItem((item) =>
      item
        .setTitle('获取 SVG 标签图标 / Get SVG icon')
        .setIcon('code')
        .onClick(() => {
          const id =
            icon.getByPath(this, path) ||
            getFolderNoteInheritedIcon(this, path);
          if (!id) {
            new Notice('Iconize：请先选择图标。');
            return;
          }
          new IconConverterModal(
            this,
            `${this.getSettings().iconIdentifier}${id}${this.getSettings().iconIdentifier}`,
            this.getEffectiveIconColor(path),
          ).open();
        }),
    );
    if (event) menu.showAtMouseEvent(event);
    else menu.showAtPosition({ x: 100, y: 100 });
  }

  private addInlineConversionMenu(menu: Menu, editor: Editor): void {
    const offset = editor.posToOffset(editor.getCursor());
    const tag = findIconTags(
      editor.getValue(),
      this.getSettings().iconIdentifier,
    ).find((tag) => tag.from <= offset && tag.to >= offset);
    if (!tag) return;
    menu.addItem((item) =>
      item
        .setTitle('转换此 Iconize 图标 / Convert icon')
        .setIcon('image')
        .onClick(() => {
          void this.conversion.convertEditor(editor, tag);
        }),
    );
  }

  private openIconOccurrenceMenu(
    editor: Editor,
    id: string,
    event: MouseEvent,
  ): void {
    const menu = new Menu();
    const tags = findIconTags(
      editor.getValue(),
      this.getSettings().iconIdentifier,
    ).filter((tag) => tag.id === id);
    for (const tag of tags) {
      const line = editor.offsetToPos(tag.from).line;
      menu.addItem((item) =>
        item
          .setTitle(`第 ${line + 1} 行：${editor.getLine(line).slice(0, 80)}`)
          .onClick(() => {
            void this.conversion.convertEditor(editor, tag);
          }),
      );
    }
    menu.showAtMouseEvent(event);
  }

  public getConfigurationStatus(): string {
    const state =
      this.configLoadState === 'failed'
        ? '读取失败，已保护原文件并停止保存'
        : this.configLoadState === 'missing'
          ? '配置文件尚未创建'
          : '配置读取正常';
    return `${state}。路径：${this.getConfigPath()}${this.configLoadError ? `；原因：${this.configLoadError}` : ''}${this.configLastSaveError ? `；最近保存失败：${this.configLastSaveError.message}` : ''}`;
  }

  public async retryConfiguration(): Promise<void> {
    // 重试前保留尚未保存的内存状态。 / Preserve unsaved in-memory edits before retrying.
    await this.withConfigurationMaintenance('before-manual-retry', () =>
      this.loadIconFolderData(),
    );
    if (this.configLoadState === 'ok') {
      IconCache.getInstance().clear();
      this.handleChangeLayout();
      new Notice('Iconize：配置已重新读取，请重新加载插件以应用全部设置。');
    }
  }

  public async getConfigurationBackups(): Promise<string[]> {
    const adapter = this.app.vault.adapter;
    const paths: string[] = [];
    if (await adapter.exists(`${this.getConfigPath()}.bak`))
      paths.push(`${this.getConfigPath()}.bak`);
    const dir = `${stateRoot(this)}/config-history`;
    if (await adapter.exists(dir)) {
      const timestamp = (path: string) =>
        Number(/-(\d{13})-\d+\.json$/.exec(path)?.[1] ?? 0);
      paths.push(
        ...(await adapter.list(dir)).files
          .filter((path) => path.endsWith('.json'))
          .sort((a, b) => timestamp(b) - timestamp(a)),
      );
    }
    return paths;
  }

  private async readConfigurationBackup(path: string): Promise<ConfigData> {
    if (!(await this.getConfigurationBackups()).includes(path))
      throw new Error('请选择当前插件提供的备份。');
    const raw = await this.app.vault.adapter.read(path);
    if (path === `${this.getConfigPath()}.bak`) return parseConfig(raw);
    const snapshot: unknown = JSON.parse(raw);
    if (
      !snapshot ||
      typeof snapshot !== 'object' ||
      !('configPath' in snapshot) ||
      snapshot.configPath !== this.getConfigPath() ||
      !('config' in snapshot)
    )
      throw new Error('备份对应的配置路径不同，无法恢复。');
    return parseConfig(JSON.stringify(snapshot.config));
  }

  public async previewConfigurationBackup(path: string): Promise<string> {
    const data = await this.readConfigurationBackup(path);
    return `备份可读，含 ${Object.keys(data).filter((key) => key !== 'settings').length} 条图标配置。点击恢复前将保全当前版本。`;
  }

  public async restoreConfiguration(path: string): Promise<void> {
    const data = await this.readConfigurationBackup(path);
    await this.withConfigurationMaintenance(
      'before-manual-restore',
      async (history) => {
        const adapter = this.app.vault.adapter;
        const target = this.getConfigPath();
        const original = (await adapter.exists(target))
          ? await adapter.read(target)
          : null;
        if (original !== null)
          await adapter.write(`${history}.original`, original);
        const next = JSON.stringify(
          {
            ...data,
            settings: {
              ...(data.settings as ConfigData),
              configFilePath: target,
            },
          },
          null,
          2,
        );
        // 原子比较，避免恢复过程中覆盖同步客户端的新版本。 / Compare atomically against concurrent sync edits.
        if (original !== null)
          await adapter.process(target, (current) => {
            if (current !== original)
              throw new Error('配置已变化，请重新选择备份后重试。');
            return next;
          });
        else {
          const slash = target.lastIndexOf('/');
          if (slash > 0)
            await this.ensureConfigDirectory(target.slice(0, slash));
          if (await adapter.exists(target))
            throw new Error('配置已出现新版本，请重新读取后重试。');
          await adapter.write(target, next);
        }
        await this.loadIconFolderData();
        await this.updateConfigCheckpoint(this.data);
        IconCache.getInstance().clear();
        this.handleChangeLayout();
      },
    );
  }

  /** 暂停保存与同步重读，避免恢复操作与后台写入互相覆盖。 / Serialize recovery against background saves and refreshes. */
  private async withConfigurationMaintenance(
    reason: string,
    action: (history: string) => Promise<void>,
  ): Promise<void> {
    if (this.configMaintenance) throw new Error('配置恢复正在进行，请稍候。');
    this.configMaintenance = true;
    this.configMaintenanceEpoch = (this.configMaintenanceEpoch ?? 0) + 1;
    try {
      if (this._saveDebounceTimer !== null) {
        clearTimeout(this._saveDebounceTimer);
        this._saveDebounceTimer = null;
      }
      if (this.configRefreshTimer !== null) {
        clearTimeout(this.configRefreshTimer);
        this.configRefreshTimer = null;
      }
      if (this.configSaveTask) await this.configSaveTask;
      const history = await this.preserveConfigHistory(reason);
      await action(history);
    } finally {
      this.configMaintenance = false;
      for (const resolve of this.saveWaiters.splice(0)) resolve();
    }
  }

  // ===== PATCHED: 自定义配置文件路径 / Custom config file path =====
  public getConfigPath(): string {
    return this.configPath;
  }

  public setConfigPath(newPath: string): void {
    if (newPath !== this.configPath) {
      this.configBaseline = {};
      this.configLoadState = 'missing';
      this._lastSavedConfig = null;
      this.configRecoveryPending = false;
    }
    this.configPath = newPath;
  }
  // ===== END PATCH =====

  // ===== PATCHED: 使用自定义配置文件路径读写配置 / Read/write config from custom path =====
  private recordIconRemoval(path: string): void {
    const value = this.data[path];
    if (value === undefined || path === 'settings') return;
    const removals = (this.getSettings().configRemovals ??= {});
    Object.defineProperty(removals, path, {
      value: cloneConfig(value),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }

  private getConfigCheckpointKey(): string {
    return `iconize:config-checkpoint:${this.app.vault.getName()}`;
  }

  /** Unique files cannot overwrite an older recovery version during later saves. */
  private async preserveConfigHistory(
    reason: string,
    incoming?: ConfigData,
    committed?: ConfigData,
  ): Promise<string> {
    const dir = `${stateRoot(this)}/config-history`;
    await this.ensureConfigDirectory(dir);
    this.configHistorySequence = (this.configHistorySequence ?? 0) + 1;
    const path = `${dir}/${this.configSessionId}-${Date.now()}-${this.configHistorySequence}.json`;
    await this.app.vault.adapter.write(
      path,
      JSON.stringify(
        {
          schema: 1,
          createdAt: new Date().toISOString(),
          configPath: this.getConfigPath(),
          reason,
          config: committed ?? this.configBaseline,
          local: this.data,
          incoming,
        },
        null,
        2,
      ),
    );
    return path;
  }

  private async updateConfigCheckpoint(data: ConfigData): Promise<void> {
    try {
      const path = await this.preserveConfigHistory(
        'checkpoint',
        undefined,
        data,
      );
      // The pointer is device-local; synchronizing another device's files cannot advance it.
      window.localStorage.setItem(this.getConfigCheckpointKey(), path);
    } catch (error) {
      console.error('[Iconize] Could not update config checkpoint:', error);
      new Notice(
        'Iconize：无法更新本机恢复检查点，请检查存储权限。历史快照仍保留在 .iconize/config-history。',
        10000,
      );
    }
  }

  private async initializeConfigSafety(): Promise<void> {
    if (this.configLoadState !== 'ok') return;
    try {
      const path = window.localStorage.getItem(this.getConfigCheckpointKey());
      if (path?.startsWith(`${stateRoot(this)}/config-history/`)) {
        // A missing or partial checkpoint must not silently advance the local pointer.
        const checkpoint = JSON.parse(await this.app.vault.adapter.read(path));
        if (checkpoint.configPath === this.getConfigPath()) {
          const trusted = parseConfig(JSON.stringify(checkpoint.config));
          const merged = mergeConfig(trusted, trusted, this.data);
          if (!equalConfig(merged, this.data)) {
            await this.preserveConfigHistory(
              'startup-missing-icons',
              this.configBaseline,
            );
            this.data = merged as typeof this.data;
            this.configRecoveryPending = true;
            new Notice(
              'Iconize：已与本机检查点取并集合并，逐条保留较新配置，即将自动保存。',
              0,
            );
          }
          if (equalConfig(trusted, this.data)) return;
        }
      }
      await this.updateConfigCheckpoint(this.data);
    } catch (error) {
      console.error('[Iconize] Could not read local config checkpoint:', error);
      new Notice(
        'Iconize：本机恢复检查点暂不可读，已保留原指针。请检查 .iconize/config-history 中的历史快照。',
        10000,
      );
    }
  }

  async loadIconFolderData(): Promise<void> {
    try {
      const configPath = this.getConfigPath();
      const exists = await this.app.vault.adapter.exists(configPath);
      let data: Record<string, unknown> | null = null;
      if (exists) {
        const raw = await this.app.vault.adapter.read(configPath);
        data = parseConfig(raw);
        this.configLoadState = 'ok';
      } else {
        this.configLoadState = 'missing';
      }
      this.configBaseline = cloneConfig(data ?? {});
      if (data) {
        Object.entries(DEFAULT_SETTINGS).forEach(([k, v]) => {
          if (
            (data as { settings?: Record<string, unknown> }).settings?.[k] ===
            undefined
          ) {
            (data as { settings: Record<string, unknown> }).settings[k] =
              cloneConfig(v);
          }
        });
      }
      this.data = Object.assign(
        { settings: cloneConfig(DEFAULT_SETTINGS) },
        {},
        data ?? {},
      ) as Record<
        string,
        string | boolean | IconFolderSettings | FolderIconObject
      >;
      this._lastSavedConfig = JSON.stringify(this.data, null, 2);
      this.configLoadError = '';
      this.configVersionBaseline = cloneConfig(this.data);
    } catch (error) {
      console.error(
        '[iconize] Failed to load config from',
        this.getConfigPath(),
        error,
      );
      // 标记读取失败。此时内存里是默认值，一旦写回就会把用户真实的配置整个抹掉——
      // 同步正在写入、移动端存储抖动、JSON 写到一半，都可能触发。
      //
      // Record the failure. The in-memory data is defaults at this point, and writing it
      // back would erase the user's real config — a sync write in flight, a storage hiccup
      // on mobile, or a half-written JSON file are all enough to trigger it.
      this.configLoadState = 'failed';
      this.configLoadError =
        error instanceof Error ? error.message : 'Unknown configuration error';
      this.data = { settings: cloneConfig(DEFAULT_SETTINGS) };
      new Notice(
        `Iconize：配置读取失败（${this.configLoadError}）。已停止保存。请在设置中打开“配置诊断与恢复”，或运行同名命令。`,
        0,
      );
    }
  }

  async saveIconFolderData(): Promise<void> {
    this.notebookNavigator?.refresh();
    if (
      this.initializing ||
      this.unloading ||
      this.configMaintenance ||
      this.configLoadState === 'failed'
    )
      return;
    this.stampLocalConfigChanges();
    if (JSON.stringify(this.data, null, 2) === this._lastSavedConfig) return;
    const finished = new Promise<void>((resolve) =>
      this.saveWaiters.push(resolve),
    );
    this.scheduleConfigSave();
    return finished;
  }

  private scheduleConfigSave(): void {
    if (this._savePending) return;
    if (this.unloading) {
      void this.flushConfigSave();
      return;
    }
    if (this._saveDebounceTimer !== null) clearTimeout(this._saveDebounceTimer);
    this._saveDebounceTimer = window.setTimeout(() => {
      this._saveDebounceTimer = null;
      void this.flushConfigSave();
    }, 800);
  }

  private async readCurrentConfig(): Promise<{
    raw: string | null;
    data: ConfigData;
  }> {
    const adapter = this.app.vault.adapter;
    const path = this.getConfigPath();
    if (!(await adapter.exists(path))) {
      // A previously present file disappearing can be an in-progress sync replace.
      if (this.configLoadState === 'ok')
        throw new Error('Config temporarily missing; saving deferred');
      return { raw: null, data: {} };
    }
    const raw = await adapter.read(path);
    return { raw, data: parseConfig(raw) };
  }

  private flushConfigSave(): Promise<void> {
    if (this.configSaveTask) return this.configSaveTask;
    const task = this.writeConfigSnapshot();
    this.configSaveTask = task;
    void task.finally(() => {
      this.configSaveTask = null;
      if (this.saveWaiters.length) this.scheduleConfigSave();
    });
    return task;
  }

  private stampLocalConfigChanges(): void {
    const stamped = stampConfigChanges(
      this.configVersionBaseline,
      this.data,
      this.configSessionId,
    );
    const metadata = (stamped.settings as IconFolderSettings)
      .configItemVersions;
    if (metadata) this.getSettings().configItemVersions = metadata;
    this.configVersionBaseline = cloneConfig(this.data);
  }

  public async saveConfigurationNow(): Promise<void> {
    if (
      this.initializing ||
      this.unloading ||
      this.configLoadState === 'failed'
    ) {
      new Notice(
        'Iconize：配置尚未成功加载，无法保存。请检查配置文件后重新加载 Iconize。',
        8000,
      );
      return;
    }
    // A manual save also waits for a write already in flight, then flushes later edits.
    if (this.configSaveTask) await this.configSaveTask;
    try {
      const disk = await this.readCurrentConfig();
      if (!equalConfig(disk.data, this.configBaseline)) {
        this._lastSavedConfig = null;
      }
    } catch (error) {
      console.error(
        '[Iconize] Manual config save could not read current config:',
        error,
      );
      new Notice(
        'Iconize：当前配置暂不可读，已停止保存并保留内存中的图标。',
        8000,
      );
      return;
    }
    const changed =
      JSON.stringify(this.data, null, 2) !== this._lastSavedConfig;
    await this.flushConfigSave();
    if (this.configSaveSucceeded) {
      new Notice(
        changed
          ? `Iconize：图标配置已保存到 ${this.getConfigPath()}`
          : `Iconize：没有待保存的图标配置改动（${this.getConfigPath()}）`,
      );
    }
  }

  private async writeConfigSnapshot(): Promise<void> {
    if (this._saveDebounceTimer !== null) {
      clearTimeout(this._saveDebounceTimer);
      this._saveDebounceTimer = null;
    }
    const waiters = this.saveWaiters.splice(0);
    this._savePending = true;
    this.configSaveSucceeded = false;
    let local: ConfigData | undefined;
    let stage = '准备配置';
    try {
      if (
        this.initializing ||
        this.configMaintenance ||
        this.configLoadState === 'failed'
      )
        return;
      this.stampLocalConfigChanges();
      if (JSON.stringify(this.data, null, 2) === this._lastSavedConfig) {
        this.configSaveSucceeded = true;
        this.configLastSaveError = null;
        return;
      }
      local = cloneConfig(this.data);
      stage = '读取配置';
      const disk = await this.readCurrentConfig();
      stage = '保存历史快照';
      await this.preserveConfigHistory('before-save', disk.data);
      const merged = mergeConfig(this.configBaseline, local, disk.data);
      const serialized = JSON.stringify(merged, null, 2);
      if (!equalConfig(merged, disk.data)) {
        const adapter = this.app.vault.adapter;
        const path = this.getConfigPath();
        const dir = path.substring(0, path.lastIndexOf('/'));
        if (dir && !(await adapter.exists(dir))) await adapter.mkdir(dir);
        // Stage outside the visible vault: staging must not trigger file rename/delete
        // handlers or create extra mtime changes in the synchronized config directory.
        const stagingDir = stateRoot(this);
        await this.ensureConfigDirectory(stagingDir);
        const tmpPath = `${stagingDir}/config-pending-${this.configSessionId}.json`;
        stage = '暂存配置';
        await adapter.write(tmpPath, serialized);
        const latest = await this.readCurrentConfig();
        if (latest.raw !== disk.raw)
          throw new Error('Config changed during save; keeping local recovery');
        stage = '保存备份';
        // DataAdapter.copy refuses an existing destination. Write the validated
        // snapshot instead; immutable history already preserves older backups.
        if (disk.raw !== null) await adapter.write(`${path}.bak`, disk.raw);
        // Check again after the asynchronous backup; never fall back to a blind write.
        if ((await this.readCurrentConfig()).raw !== disk.raw) {
          throw new Error(
            'Config changed during backup; keeping local recovery',
          );
        }
        stage = '提交配置';
        // DataAdapter.rename also refuses to replace an existing destination.
        // process serializes the read/check/write against Obsidian's adapter queue.
        if (disk.raw !== null) {
          await adapter.process(path, (current) => {
            if (current !== disk.raw)
              throw new Error(
                'Config changed before commit; keeping local recovery',
              );
            return serialized;
          });
        } else {
          await adapter.write(path, serialized);
        }
        try {
          await adapter.remove(tmpPath);
        } catch (cleanupError) {
          console.warn(
            '[Iconize] Saved config; could not remove staging file:',
            cleanupError,
          );
        }
      }
      // Incorporate remote changes without losing edits arriving while I/O was in flight.
      this.data = rebaseConfig(
        local,
        cloneConfig(this.data),
        merged,
      ) as typeof this.data;
      this.configVersionBaseline = cloneConfig(this.data);
      this.configBaseline = cloneConfig(merged);
      this.configLoadState = 'ok';
      this._lastSavedConfig = serialized;
      this.configSaveSucceeded = true;
      this.configLastSaveError = null;
      this.configRecoveryPending = false;
      await this.updateConfigCheckpoint(merged);
      this.refreshConfiguredIcons(local);
    } catch (error) {
      console.error('[Iconize] Config save stopped:', error);
      this.configLastSaveError = {
        stage,
        message: error instanceof Error ? error.message : String(error),
        at: new Date().toISOString(),
      };
      // Keep both versions recoverable even after the app closes. This is only written
      // on a real failed edit, never during startup or idle synchronization.
      if (local) {
        try {
          const dir = stateRoot(this);
          await this.ensureConfigDirectory(dir);
          await this.app.vault.adapter.write(
            `${dir}/config-local-recovery-${this.configSessionId}.json`,
            JSON.stringify(
              {
                configPath: this.getConfigPath(),
                failure: this.configLastSaveError,
                baseline: this.configBaseline,
                local: this.data,
              },
              null,
              2,
            ),
          );
        } catch (recoveryError) {
          console.error(
            '[Iconize] Could not preserve local recovery:',
            recoveryError,
          );
          new Notice(
            'Iconize: config and recovery could not be saved. Keep Obsidian open and retry.',
            0,
          );
          return;
        }
      }
      new Notice(
        `Iconize：${stage}失败：${this.configLastSaveError.message}。本机改动已保留在 ${stateRoot(this)}/config-local-recovery-${this.configSessionId}.json。`,
        0,
      );
    } finally {
      this._savePending = false;
      waiters.forEach((resolve) => resolve());
    }
  }

  private async ensureConfigDirectory(path: string): Promise<void> {
    let current = '';
    for (const part of path.split('/')) {
      current = current ? `${current}/${part}` : part;
      if (!(await this.app.vault.adapter.exists(current)))
        await this.app.vault.adapter.mkdir(current);
    }
  }

  private scheduleConfigRefresh(): void {
    if (this.initializing || this.unloading || this.configMaintenance) return;
    if (this.configRefreshTimer !== null) clearTimeout(this.configRefreshTimer);
    this.configRefreshTimer = window.setTimeout(() => {
      this.configRefreshTimer = null;
      void this.refreshExternalConfig();
    }, 1000);
  }

  async onExternalSettingsChange(): Promise<void> {
    // The default data.json is hidden from Vault events.
    this.scheduleConfigRefresh();
  }

  private async refreshExternalConfig(): Promise<void> {
    const epoch = this.configMaintenanceEpoch ?? 0;
    if (
      this.initializing ||
      this.unloading ||
      this.configMaintenance ||
      this.configLoadState === 'failed'
    )
      return;
    if (this._savePending) {
      // Defer an actual file notification while a local write is in progress.
      this.scheduleConfigRefresh();
      return;
    }
    try {
      const disk = await this.readCurrentConfig();
      if (equalConfig(disk.data, this.configBaseline)) return;
      await this.preserveConfigHistory('external-change', disk.data);
      if (
        this.configMaintenance ||
        (this.configMaintenanceEpoch ?? 0) !== epoch
      )
        return;
      const local = cloneConfig(this.data);
      const merged = mergeConfig(this.configBaseline, local, disk.data);
      const wasClean =
        JSON.stringify(this.data, null, 2) === this._lastSavedConfig;
      this.data = merged as typeof this.data;
      this.configVersionBaseline = cloneConfig(this.data);
      this.configBaseline = cloneConfig(disk.data);
      if (wasClean) this._lastSavedConfig = JSON.stringify(disk.data, null, 2);
      this.refreshConfiguredIcons(local);
      await this.updateConfigCheckpoint(merged);
      if (!equalConfig(merged, disk.data)) void this.saveIconFolderData();
    } catch (error) {
      // A partial sync write is not an empty config. Leave data and baselines intact.
      console.warn('[Iconize] External config not applied:', error);
    }
  }

  private refreshConfiguredIcons(previous: ConfigData = {}): void {
    if (this.unloading) return;
    this.notebookNavigator?.refresh();
    IconCache.getInstance().clear();
    const paths = new Set([
      ...Object.keys(previous),
      ...Object.keys(this.data),
    ]);
    const settingsChanged = !equalConfig(previous.settings, this.data.settings);
    for (const path of paths) {
      if (
        path !== 'settings' &&
        (settingsChanged || !equalConfig(previous[path], this.data[path]))
      ) {
        this._refreshFileExplorerIcon(path);
      }
    }
    for (const opened of getAllOpenedFiles(this)) {
      if (this.getSettings().iconInTabsEnabled) {
        iconTabs.add(
          this,
          opened.path,
          (opened.leaf as TabHeaderLeaf).tabHeaderInnerIconEl,
        );
      }
      if (this.getSettings().iconInTitleEnabled) {
        this.applyTitleIcon(
          (opened.leaf.view as InlineTitleView).inlineTitleEl,
          icon.getByPath(this, opened.path) ||
            getFolderNoteInheritedIcon(this, opened.path),
          opened.path,
        );
      }
    }
  }
  // ===== END PATCH =====

  async checkRecentlyUsedIcons(): Promise<void> {
    if (
      this.getSettings().recentlyUsedIcons.length >
      this.getSettings().recentlyUsedIconsSize
    ) {
      this.getSettings().recentlyUsedIcons =
        this.getSettings().recentlyUsedIcons.slice(
          0,
          this.getSettings().recentlyUsedIconsSize,
        );
      await this.saveIconFolderData();
    }
  }

  getEventEmitter(): EventEmitter {
    return this.eventEmitter;
  }

  getData(): Record<
    string,
    boolean | string | IconFolderSettings | FolderIconObject
  > {
    return this.data;
  }

  getIconNameFromPath(path: string): string | undefined {
    const frontmatter = this.getFrontmatterIcon(path);
    if (frontmatter) return frontmatter.iconName;
    if (typeof this.getData()[path] === 'object') {
      return (this.getData()[path] as FolderIconObject).iconName;
    }

    return this.getData()[path] as string;
  }

  getRegisteredFileExplorers(): Set<ExplorerView> {
    return this.registeredFileExplorers;
  }

  doesUseCustomLucideIconPack(): boolean {
    return this.getSettings().lucideIconPackType === 'custom';
  }

  doesUseNativeLucideIconPack(): boolean {
    return this.getSettings().lucideIconPackType === 'native';
  }

  /**
   * Returns a possible data path by the given value. This function checks for
   * direct icon and custom rules.
   * @param value String that will be used to find the data path.
   * @returns String that is the data path or `undefined` if no data path was found.
   */
  getDataPathByValue(value: string): string | undefined {
    return Object.entries(this.data).find(([k, v]) => {
      if (typeof v === 'string') {
        if (value === v) {
          return k;
        }
      } else if (typeof v === 'object') {
        // Check for custom rules.
        if (k === 'settings') {
          // `rules` are defined in the settings object.
          const rules = (v as IconFolderSettings).rules;
          return rules.find((rule) => rule.icon === value);
        }

        v = v as FolderIconObject;
        if (value === v.iconName) {
          return k;
        }
      }
    }) as unknown as string;
  }

  public getIconPackManager(): IconPackManager {
    return this.iconPackManager;
  }

  // ===== PATCHED: 释放已解析的归档 / Release parsed archives =====
  /**
   * 释放所有图标包已读入的归档字节。
   * Releases every pack's loaded archive bytes.
   *
   * 启动时的预取结束后会释放一次，但之后的按需解析会重新打开归档并一直持有——大包的
   * 原始字节可达 10 MB，几个包叠加就抵消了按需加载省下的内存。批次处理结束后释放即可，
   * 需要时 `readEntry` 会透明地重新打开。
   *
   * Archives are released once prefetch finishes at start-up, but a later on-demand resolve
   * reopens one and keeps it — a large pack's raw bytes reach 10 MB, and a few of those
   * cancel out what lazy loading saves. Releasing after a batch is enough; `readEntry`
   * reopens transparently when needed.
   */
  public releaseIconSources(): void {
    for (const pack of this.iconPackManager?.getIconPacks() ?? []) {
      pack.getSource()?.dispose();
    }
  }
  // ===== END PATCH =====
}
