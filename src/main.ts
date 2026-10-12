import {
  Plugin,
  MenuItem,
  TFile,
  WorkspaceLeaf,
  requireApiVersion,
  MarkdownView,
  Notice,
} from 'obsidian';
import {
  EditorWithEditorComponent,
  ExplorerView,
  InlineTitleView,
  TabHeaderLeaf,
} from './@types/obsidian';
import IconsPickerModal from './ui/icons-picker-modal';
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
  saveIconToIconPack,
  stringToHex,
} from '@app/util';
import config from '@app/config';
import titleIcon from './lib/icon-title';
import SuggestionIcon from './editor/icons-suggestion';
import emoji from './emoji';
import { IconCache } from './lib/icon-cache';
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
import ChangeColorModal from './ui/change-color-modal';
import { logger } from './lib/logger';
import { EventEmitter } from './lib/event/event';
import IconizeAPI, { getApi } from './lib/api';
import { Icon, IconPackManager } from './icon-pack-manager';
import { getNormalizedName } from './icon-pack-manager/util';
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
  private data: Record<
    string,
    boolean | string | IconFolderSettings | FolderIconObject
  >;
  private registeredFileExplorers = new Set<ExplorerView>();

  private modifiedInternalPlugins: InternalPluginInjector[] = [];

  public positionField: PositionField = buildPositionField(this);

  /**
   * 记录「图标来自 frontmatter」的路径及其图标名。
   * Paths whose icon came from frontmatter, mapped to the icon name seen there.
   *
   * 只有真正从 frontmatter 取过图标的路径才会被记录。仅凭「文件曾经是活动文件」就记录，
   * 会让一个从未用过 `icon` 属性的文件在 frontmatter 解析时被误判为「图标已被移除」，
   * 进而删掉它在 data 里正常配置的图标。
   *
   * Only paths that actually supplied an icon from frontmatter are recorded. Recording
   * a path merely because it was the active file makes the resolver treat a file that
   * never used the `icon` property as "icon removed" and drop its configured icon.
   */
  private frontmatterCache = new Map<string, string>();
  private eventEmitter = new EventEmitter();

  private iconPackManager: IconPackManager;

  public api: IconizeAPI;

  // ===== PATCHED: 按需加载 + 自定义配置 + Folder note 字段 =====
  public lazyLoadingSystem?: LazyLoadingSystem;
  public iconResolver?: IconResolver;
  public inlineIconLoader?: InlineIconLoader;
  private _saveDebounceTimer: number | null = null;
  private _savePending = false;
  private configPath = '.obsidian/plugins/obsidian-icon-folder/data.json';
  /**
   * 配置读取的结果 / Outcome of the last config read.
   *
   * `failed` 时禁止写回，避免用默认值覆盖用户真实的配置。
   * While `failed`, saving is refused so defaults never overwrite the user's config.
   */
  private configLoadState: 'ok' | 'missing' | 'failed' = 'missing';
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
    try {
      await this.initialize();
    } catch (error) {
      console.error(`[${config.PLUGIN_NAME}] Failed to load:`, error);
      new Notice(
        `[${config.PLUGIN_NAME}] Failed to load: ${
          error instanceof Error ? error.message : String(error)
        }`,
        0,
      );
    }
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
        console.warn(
          `[${config.PLUGIN_NAME}] Configured config file '${savedConfigPath}' does not exist; keeping '${this.getConfigPath()}'`,
        );
      }
    }

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

    this.app.workspace.onLayoutReady(() => this.handleChangeLayout());

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
      this.app.workspace.on('file-menu', (menu, file: TFile) => {
        const addIconMenuItem = (item: MenuItem) => {
          item.setTitle('Change icon');
          item.setIcon('hashtag');
          item.onClick(() => {
            this.openIconPicker(file.path);
          });
        };

        const removeIconMenuItem = (item: MenuItem) => {
          item.setTitle('Remove icon');
          item.setIcon('trash');
          item.onClick(async () => {
            await this.removeSingleIcon(file);
          });
        };

        const changeColorOfIcon = (item: MenuItem) => {
          item.setTitle('Change color of icon');
          item.setIcon('palette');
          item.onClick(() => {
            const modal = new ChangeColorModal(this.app, this, file.path);
            modal.open();
          });
        };

        menu.addItem(addIconMenuItem);

        const filePathData = this.getData()[file.path];
        const hasNestedIcon =
          typeof filePathData === 'object' &&
          (filePathData as FolderIconObject).iconName !== null;
        // Only add remove icon menu item when the file path exists in the data.
        // We do not want to show this menu item for e.g. custom rules.
        if (
          filePathData &&
          (typeof filePathData === 'string' || hasNestedIcon)
        ) {
          const icon =
            typeof filePathData === 'string'
              ? filePathData
              : (filePathData as FolderIconObject).iconName;
          if (!emoji.isEmoji(icon)) {
            menu.addItem(changeColorOfIcon);
          }

          menu.addItem(removeIconMenuItem);
        }
      }),
    );

    // deleting event
    this.registerEvent(
      this.app.vault.on('delete', (file) => {
        const path = file.path;
        // 先走原有的单键删除（folder note 双向清理、图标包回收都挂在它身上），
        // 再连带清掉剩下的子键。顺序不能反：removeFolderIcon 见到键已不在就提前
        // 返回，那些清理会整个被跳过。
        //
        // Single-key removal first (folder-note twin cleanup and icon-pack recycle both
        // hang off it), then cascade the remaining child keys. Order matters: once the
        // key is gone removeFolderIcon returns early and those cleanups are skipped.
        this.removeFolderIcon(path);
        this.removeIconSubtree(path);
        this.pruneDeadIconKeys();
        this.saveIconFolderData();
      }),
    );

    // renaming event
    this.registerEvent(
      this.app.vault.on('rename', (file, oldPath) => {
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
        // 改名后对账：搬完子键仍可能有指向旧位置的残留，直接丢弃。
        //
        // Reconcile after the rename: a leftover key pointing at the old location is
        // dead weight, drop it.
        this.pruneDeadIconKeys();
        this.saveIconFolderData();
      }),
    );

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

    this.addSettingTab(new IconFolderSettingsUI(this.app, this));
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
    const system = await initializeLazyLoading(this, usedIconNames);
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
    const modal = new IconsPickerModal(this.app, this, path);
    modal.open();

    modal.onSelect = (iconName: string): void => {
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
    this.modifiedInternalPlugins.forEach((internalPlugin) => {
      if (internalPlugin.enabled) {
        internalPlugin.onMount();
      }
    });
  }

  private async removeSingleIcon(file: TFile): Promise<void> {
    this.removeFolderIcon(file.path);
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

      if (this.getSettings().iconInFrontmatterEnabled) {
        const activeFile = this.app.workspace.getActiveFile();
        // 只在该文件确实通过 frontmatter 指定了图标时记录，避免误判为「图标已移除」。
        const frontmatterIcon = activeFile
          ? this.app.metadataCache.getFileCache(activeFile)?.frontmatter?.[
              this.getSettings().iconInFrontmatterFieldName
            ]
          : undefined;
        if (activeFile && typeof frontmatterIcon === 'string') {
          this.frontmatterCache.set(activeFile.path, frontmatterIcon);
        }
      }

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
              const view = (activeView.leaf.view as any).currentMode
                .view as InlineTitleView;
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
        this.app.metadataCache.on('resolve', async (file) => {
          if (!this.getSettings().iconInFrontmatterEnabled) {
            return;
          }

          const fileCache = this.app.metadataCache.getFileCache(file);
          const iconFrontmatterName =
            this.getSettings().iconInFrontmatterFieldName;
          const iconColorFrontmatterName =
            this.getSettings().iconColorInFrontmatterFieldName;
          if (fileCache?.frontmatter) {
            const {
              [iconFrontmatterName]: newIconName,
              [iconColorFrontmatterName]: newIconColor,
            } = fileCache.frontmatter;
            // If `icon` property is empty, we will remove it from the data and remove the icon.
            if (!newIconName) {
              // 只有当这个文件此前确实从 frontmatter 取过图标时才移除；
              // 否则一个从未用过 `icon` 属性的文件会被误删已配置的图标。
              // Only remove when this file previously supplied an icon from frontmatter.
              if (this.frontmatterCache.has(file.path)) {
                await this.removeSingleIcon(file);
                this.frontmatterCache.delete(file.path);
              }
              return;
            }

            if (typeof newIconName !== 'string') {
              new Notice(
                `[${config.PLUGIN_NAME}] Frontmatter property type \`icon\` has to be of type \`text\`.`,
              );
              return;
            }

            if (newIconColor && typeof newIconColor !== 'string') {
              new Notice(
                `[${config.PLUGIN_NAME}] Frontmatter property type \`iconColor\` has to be of type \`text\`.`,
              );
              return;
            }

            let iconColor = newIconColor;
            if (isHexadecimal(iconColor)) {
              iconColor = stringToHex(iconColor);
            }

            const cachedIcon = IconCache.getInstance().get(file.path);
            if (
              newIconName === cachedIcon?.iconNameWithPrefix &&
              iconColor === cachedIcon?.iconColor
            ) {
              return;
            }

            this.frontmatterCache.set(file.path, newIconName);
            try {
              if (!emoji.isEmoji(newIconName)) {
                saveIconToIconPack(this, newIconName);
              }
            } catch (e) {
              logger.warn(
                `Something went wrong while saving icon to icon pack (error: ${e})`,
              );
              new Notice(e.message);
              return;
            }

            dom.createIconNode(this, file.path, newIconName, {
              color: iconColor,
            });
            this.addFolderIcon(file.path, newIconName);
            this.addIconColor(file.path, iconColor);
            IconCache.getInstance().set(file.path, {
              iconNameWithPrefix: newIconName,
              iconColor,
            });

            // Update icon in tab when setting is enabled.
            if (this.getSettings().iconInTabsEnabled) {
              const tabLeaves = iconTabs.getTabLeavesOfFilePath(
                this,
                file.path,
              );
              for (const tabLeaf of tabLeaves) {
                iconTabs.update(
                  this,
                  newIconName,
                  tabLeaf.tabHeaderInnerIconEl,
                );
              }
            }

            // Update icon in title when setting is enabled.
            if (this.getSettings().iconInTitleEnabled) {
              this.addIconInTitle(newIconName);
            }
          }
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
      onClick: (clickedPath: string) => this.openIconPicker(clickedPath),
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
      onClick: (clickedPath: string) => this.openIconPicker(clickedPath),
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
    console.log('unloading obsidian-icon-folder');

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
      pack.getSource()?.dispose();
    }
    const globalScope = window as unknown as { iconizePlugin?: IconizePlugin };
    if (globalScope.iconizePlugin === this) {
      delete globalScope.iconizePlugin;
    }
    // ===== END PATCH =====
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

  // ===== PATCHED: 文件夹改动后的三层对账 / Three-layer reconciliation after folder changes =====
  /**
   * 删除连带：清掉 `path` 及其所有子键。
   * Obsidian 删文件夹只发一条 delete 事件，只清单键会留下一串孤儿索引。
   *
   * Delete cascade: drop `path` and every key under it. Obsidian emits a single delete
   * event for a folder, so removing only the folder key would orphan the whole subtree.
   */
  private removeIconSubtree(path: string): void {
    const prefix = path + '/';
    for (const key of Object.keys(this.data)) {
      if (key === 'settings') {
        continue;
      }
      if (key === path || key.startsWith(prefix)) {
        delete this.data[key];
      }
    }
  }

  /**
   * 对账：丢掉指向不存在路径的索引（找不到的索引直接删）。
   * 挂在文件夹改动之后而不是启动时全量扫描，避免冷启动 / 移动端去 stat 全库。
   * 用同步的 `getAbstractFileByPath` 判存在性，不走可能抛错的 adapter 异步探测。
   *
   * Reconcile: drop index entries whose paths no longer exist. Runs after folder
   * changes rather than as a full scan at startup, so cold start / mobile never has
   * to stat the whole vault. Uses the synchronous `getAbstractFileByPath` so it never
   * hits the adapter probe that can throw on mobile storage.
   */
  private pruneDeadIconKeys(): void {
    const deadKeys: string[] = [];
    for (const key of Object.keys(this.data)) {
      if (key === 'settings') {
        continue;
      }
      if (!this.app.vault.getAbstractFileByPath(key)) {
        deadKeys.push(key);
        delete this.data[key];
      }
    }
    // 调试开关下才输出，避免静默行为无法定位。
    // Only log with the debug switch on, so silent behaviour stays locatable.
    if (deadKeys.length > 0 && this.getSettings().debugMode) {
      logger.warn(
        `[iconize] Dropped ${deadKeys.length} icon key(s) pointing at missing paths:\n` +
          deadKeys.join('\n'),
      );
    }
  }
  // ===== END PATCH =====

  addIconColor(path: string, iconColor: string): void {
    const pathData = this.getData()[path];

    if (typeof pathData === 'string') {
      this.getData()[path] = {
        iconName: pathData,
        iconColor,
      };
    } else {
      (pathData as FolderIconObject).iconColor = iconColor;
    }

    this.saveIconFolderData();
  }

  getIconColor(path: string): string | undefined {
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

    if (typeof pathData === 'string') {
      return;
    }

    const currentValue = pathData as FolderIconObject;
    this.getData()[path] = currentValue.iconName;

    this.saveIconFolderData();
  }

  removeFolderIcon(path: string): void {
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

      if (!emoji.isEmoji(iconNameWithPrefix)) {
        removeIconFromIconPack(this, iconNameWithPrefix);
      }
    }

    // ===== PATCHED: 双向清理：同步删除对端记录 =====
    if (
      this.getSettings().inheritFolderNoteIconEnabled &&
      this.getSettings().bidirectionalFolderNoteIconSyncEnabled
    ) {
      this._removeSyncedFolderNoteIcon(path);
    }
    // ===== END PATCH =====

    //this.addIconsToSearch();
    this.saveIconFolderData();
  }

  // ===== PATCHED: 双向清理：删除对端（folder note 或 folder）的 data.json 记录 =====
  private _removeSyncedFolderNoteIcon(path: string): void {
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
        delete this.data[parentFolder];
        this._refreshFileExplorerIcon(parentFolder);
      }
    } else {
      // folder → 清理 folder note 的记录
      const folderNotePath = `${resolveFolderNotePath(this, path)}.md`;
      if (this.data[folderNotePath]) {
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
        const value = this.data[path];
        const iconName =
          typeof value === 'string'
            ? value
            : value && typeof value === 'object'
              ? (value as FolderIconObject).iconName
              : null;
        if (iconName) {
          const iconColor =
            typeof value === 'string'
              ? undefined
              : (value as FolderIconObject).iconColor;
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
  private _syncFolderNoteIcon(path: string, iconName: string): void {
    this.app.vault.adapter
      .stat(path)
      .then((stat) => {
        if (stat && stat.type === 'folder') {
          // folder → folder note：同步 iconName + iconColor
          const folderNotePath = `${resolveFolderNotePath(this, path)}.md`;
          this.app.vault.adapter
            .exists(folderNotePath)
            .then((exists) => {
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
                this.saveIconFolderData();
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
          this.saveIconFolderData();
          this._refreshFileExplorerIcon(parentFolder);
        }
      })
      .catch((e) => console.error('[_syncFolderNoteIcon] stat 失败:', e));
  }
  // ===== END PATCH =====

  addFolderIcon(path: string, icon: Icon | string): void {
    const iconName = getNormalizedName(
      typeof icon === 'object' ? icon.displayName : icon,
    );

    this.data[path] = iconName;

    // Update recently used icons.
    if (!this.getSettings().recentlyUsedIcons.includes(iconName)) {
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
      this.checkRecentlyUsedIcons();
    }

    //this.addIconsToSearch();
    // ===== PATCHED: 双向同步 folder ↔ folder note =====
    if (
      this.getSettings().inheritFolderNoteIconEnabled &&
      this.getSettings().bidirectionalFolderNoteIconSyncEnabled
    ) {
      this._syncFolderNoteIcon(path, iconName);
    }
    // ===== END PATCH =====
    this.saveIconFolderData();
  }

  public getSettings(): IconFolderSettings {
    return this.data.settings as IconFolderSettings;
  }

  // ===== PATCHED: 自定义配置文件路径 / Custom config file path =====
  public getConfigPath(): string {
    return this.configPath;
  }

  public setConfigPath(newPath: string): void {
    this.configPath = newPath;
  }
  // ===== END PATCH =====

  // ===== PATCHED: 使用自定义配置文件路径读写配置 / Read/write config from custom path =====
  async loadIconFolderData(): Promise<void> {
    try {
      const configPath = this.getConfigPath();
      const exists = await this.app.vault.adapter.exists(configPath);
      let data: Record<string, unknown> | null = null;
      if (exists) {
        const raw = await this.app.vault.adapter.read(configPath);
        data = JSON.parse(raw);
        this.configLoadState = 'ok';
      } else {
        this.configLoadState = 'missing';
      }
      if (data) {
        Object.entries(DEFAULT_SETTINGS).forEach(([k, v]) => {
          if (
            (data as { settings?: Record<string, unknown> }).settings?.[k] ===
            undefined
          ) {
            (data as { settings: Record<string, unknown> }).settings[k] = v;
          }
        });
      }
      this.data = Object.assign(
        { settings: { ...DEFAULT_SETTINGS } },
        {},
        data ?? {},
      ) as Record<
        string,
        string | boolean | IconFolderSettings | FolderIconObject
      >;
      this._lastSavedConfig = JSON.stringify(this.data, null, 2);
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
      this.data = { settings: { ...DEFAULT_SETTINGS } };
      new Notice(
        'Icon folder config could not be read. Saving is disabled for this session so the file is not overwritten.',
        0,
      );
    }
  }

  async saveIconFolderData(): Promise<void> {
    // 清除现有定时器。
    if (this._saveDebounceTimer) {
      clearTimeout(this._saveDebounceTimer);
    }
    // 如果正在保存，延迟后重试。
    if (this._savePending) {
      return new Promise((resolve) => {
        this._saveDebounceTimer = window.setTimeout(() => {
          this.saveIconFolderData().then(resolve);
        }, 100);
      });
    }

    // 配置没能读出来时拒绝保存：内存里是默认值，写下去等于清空用户配置。
    // Refuse to save when the config could not be read: the in-memory data is defaults and
    // writing it would clear the user's configuration.
    if (this.configLoadState === 'failed') {
      console.error(
        '[iconize] Refusing to save the config: it could not be read, so the in-memory data is not the user data.',
      );
      return;
    }

    this._savePending = true;
    try {
      const configPath = this.getConfigPath();

      // 内容没变就不写。图标相关的事件很密集，而每一次写都会让同步客户端重新上传，
      // 在同步仓库里这才是冲突与延迟的主要来源。
      //
      // Skip the write when nothing changed. Icon events are frequent, and every write makes
      // a sync client re-upload the file — which is what actually causes conflicts and lag in
      // a synced vault.
      const serialized = JSON.stringify(this.data, null, 2);
      if (serialized === this._lastSavedConfig) {
        return;
      }

      const dir = configPath.substring(0, configPath.lastIndexOf('/'));
      const dirExists = await this.app.vault.adapter.exists(dir);
      if (!dirExists) {
        await this.app.vault.adapter.mkdir(dir);
      }

      // 写前留一代备份：配置里是用户逐条设置的图标，一旦被误操作清空就无法凭记忆还原。
      // 只保留一代，因此不会无限堆积。
      //
      // Keep one generation of backup: the config holds icons the user set one by one, and a
      // mistaken action that clears them cannot be reconstructed from memory. Only one
      // generation is kept, so it cannot pile up.
      const backupPath = `${configPath}.bak`;
      try {
        if (await this.app.vault.adapter.exists(configPath)) {
          await this.app.vault.adapter.copy(configPath, backupPath);
        }
      } catch (error) {
        console.warn(
          `[${config.PLUGIN_NAME}] Could not back up the config before writing:`,
          error,
        );
      }

      // 先写临时文件再改名：同步过程或其它进程可能恰好读到写入中途的文件，
      // 改名是原子的，因此读到的永远是完整内容。
      //
      // Write to a temporary file and rename: a sync pass or another process can read the
      // file mid-write, and a rename is atomic, so readers only ever see complete content.
      const tmpPath = `${configPath}.tmp`;
      await this.app.vault.adapter.write(tmpPath, serialized);
      this._lastSavedConfig = serialized;
      try {
        await this.app.vault.adapter.rename(tmpPath, configPath);
      } catch (renameError) {
        // 某些适配器可能不支持改名：退回直接写入，并把临时文件清掉。
        // Some adapters may not support rename: fall back to a direct write and clean up.
        console.warn(
          '[iconize] Atomic rename unsupported, writing the config directly:',
          renameError,
        );
        await this.app.vault.adapter.write(configPath, serialized);
        this._lastSavedConfig = serialized;
        try {
          await this.app.vault.adapter.remove(tmpPath);
        } catch {
          // 清理失败无关紧要。
        }
      }
    } catch (error) {
      console.error(
        '[iconize] Failed to save config to',
        this.getConfigPath(),
        error,
      );
      new Notice('Icon folder config save failed');
    } finally {
      this._savePending = false;
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
