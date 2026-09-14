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

        const modal = new IconsPickerModal(this.app, this, file.path);
        modal.open();

        modal.onSelect = (iconName: string): void => {
          IconCache.getInstance().set(file.path, {
            iconNameWithPrefix: iconName,
          });

          // Update icon in tab when setting is enabled.
          if (this.getSettings().iconInTabsEnabled) {
            const tabLeaves = iconTabs.getTabLeavesOfFilePath(this, file.path);
            for (const tabLeaf of tabLeaves) {
              iconTabs.update(this, iconName, tabLeaf.tabHeaderInnerIconEl);
            }
          }

          // Update icon in title when setting is enabled.
          if (this.getSettings().iconInTitleEnabled) {
            this.addIconInTitle(iconName);
          }
        };
      },
    });

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
            const modal = new IconsPickerModal(this.app, this, file.path);
            modal.open();

            modal.onSelect = (iconName: string): void => {
              IconCache.getInstance().set(file.path, {
                iconNameWithPrefix: iconName,
              });

              // Update icon in tab when setting is enabled.
              if (this.getSettings().iconInTabsEnabled) {
                const tabLeaves = iconTabs.getTabLeavesOfFilePath(
                  this,
                  file.path,
                );
                for (const tabLeaf of tabLeaves) {
                  iconTabs.update(this, iconName, tabLeaf.tabHeaderInnerIconEl);
                }
              }

              // Update icon in title when setting is enabled.
              if (this.getSettings().iconInTitleEnabled) {
                this.addIconInTitle(iconName);
              }
            };
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
        this.removeFolderIcon(path);
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
      for (const openedFile of getAllOpenedFiles(this)) {
        if (this.getSettings().iconInTitleEnabled) {
          titleIcon.remove(
            (openedFile.leaf.view as InlineTitleView).inlineTitleEl,
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
              if (!iconNameWithPrefix) {
                titleIcon.hide(view.inlineTitleEl);
                return;
              }

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
            if (!iconNameWithPrefix) {
              titleIcon.hide(leaf.inlineTitleEl);
              return;
            }

            this.applyTitleIcon(
              leaf.inlineTitleEl,
              iconNameWithPrefix,
              file.path,
              true,
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
   * 把图标加到内联标题上；内存未命中时异步按需解析后再加。
   * Applies an icon to an inline title, resolving on demand when it is not in memory.
   *
   * 按需加载下图标可能只在索引中，因此同步查找失败并不代表图标不存在。
   */
  private applyTitleIcon(
    inlineTitleEl: HTMLElement,
    iconNameWithPrefix: string,
    path: string,
    hideWhenMissing = false,
  ): void {
    // 颜色与标签页图标使用同一来源，folder note 会回退到父文件夹的颜色。
    // Same color source as tab icons; folder notes fall back to their folder's color.
    const color = this.getEffectiveIconColor(path);

    if (emoji.isEmoji(iconNameWithPrefix)) {
      titleIcon.remove(inlineTitleEl);
      titleIcon.add(this, inlineTitleEl, iconNameWithPrefix, {
        fontSize: calculateInlineTitleSize(),
        color,
        iconName: iconNameWithPrefix,
      });
      return;
    }

    const foundIcon = icon.getIconByName(this, iconNameWithPrefix)?.svgElement;
    if (foundIcon) {
      titleIcon.remove(inlineTitleEl);
      titleIcon.add(this, inlineTitleEl, foundIcon, {
        fontSize: calculateInlineTitleSize(),
        color,
        iconName: iconNameWithPrefix,
      });
      return;
    }

    // 图标在索引中但尚未解析：异步取回后再加。
    if (this.iconResolver?.find(iconNameWithPrefix)) {
      this.iconResolver
        .resolveSvg(iconNameWithPrefix)
        .then((svgMarkup) => {
          if (!svgMarkup || !inlineTitleEl.isConnected) {
            return;
          }
          // 内联标题元素跨文件复用：若它此刻代表的是别的图标，说明用户已经切走，丢弃这次结果。
          // The inline title is reused across files; if it now stands for a different icon
          // the user has moved on, so drop this result.
          const current = inlineTitleEl.parentElement
            ? titleIcon.get(inlineTitleEl.parentElement)
            : null;
          const marker = current?.getAttribute(config.ICON_ATTRIBUTE_NAME);
          if (marker && marker !== iconNameWithPrefix) {
            return;
          }

          titleIcon.remove(inlineTitleEl);
          titleIcon.add(this, inlineTitleEl, svgMarkup, {
            fontSize: calculateInlineTitleSize(),
            color,
            iconName: iconNameWithPrefix,
          });
        })
        .catch((error) =>
          console.error('[Iconize] Failed to resolve title icon:', error),
        );
      return;
    }

    if (hideWhenMissing) {
      titleIcon.hide(inlineTitleEl);
    }
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
    if (!this.data[oldPath] || newPath === oldPath) {
      return;
    }

    Object.defineProperty(
      this.data,
      newPath,
      Object.getOwnPropertyDescriptor(this.data, oldPath),
    );
    delete this.data[oldPath];
    this.saveIconFolderData();
  }

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
      const dir = configPath.substring(0, configPath.lastIndexOf('/'));
      const dirExists = await this.app.vault.adapter.exists(dir);
      if (!dirExists) {
        await this.app.vault.adapter.mkdir(dir);
      }

      // 先写临时文件再改名：同步过程或其它进程可能恰好读到写入中途的文件，
      // 改名是原子的，因此读到的永远是完整内容。
      //
      // Write to a temporary file and rename: a sync pass or another process can read the
      // file mid-write, and a rename is atomic, so readers only ever see complete content.
      const tmpPath = `${configPath}.tmp`;
      await this.app.vault.adapter.write(
        tmpPath,
        JSON.stringify(this.data, null, 2),
      );
      try {
        await this.app.vault.adapter.rename(tmpPath, configPath);
      } catch (renameError) {
        // 某些适配器可能不支持改名：退回直接写入，并把临时文件清掉。
        // Some adapters may not support rename: fall back to a direct write and clean up.
        console.warn(
          '[iconize] Atomic rename unsupported, writing the config directly:',
          renameError,
        );
        await this.app.vault.adapter.write(
          configPath,
          JSON.stringify(this.data, null, 2),
        );
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
}
