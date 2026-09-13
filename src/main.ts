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

  private frontmatterCache = new Set<string>();
  private eventEmitter = new EventEmitter();

  private iconPackManager: IconPackManager;

  public api: IconizeAPI;

  // ===== PATCHED: 按需加载 + 自定义配置 + Folder note 字段 =====
  public lazyLoadingSystem?: LazyLoadingSystem;
  public iconResolver?: IconResolver;
  public inlineIconLoader?: InlineIconLoader;
  private _iconsReady = false;
  private _saveDebounceTimer: number | null = null;
  private _savePending = false;
  private _eventListenerRefs: Array<() => void> = [];
  private _tabIconObservers = new Map<string, MutationObserver>();
  private configPath = '.obsidian/plugins/obsidian-icon-folder/data.json';
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

  async onload() {
    console.log(`loading ${config.PLUGIN_NAME}`);

    await this.loadIconFolderData();

    // 立即设置正确的 configPath，并使用新路径重新加载完整配置。
    const savedConfigPath = this.getSettings().configFilePath;
    if (savedConfigPath) {
      this.setConfigPath(savedConfigPath);
      await this.loadIconFolderData();
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

    await this.iconPackManager.createDefaultDirectory();
    await this.checkRecentlyUsedIcons();

    await migrate(this);

    const usedIconNames = this.getUsedIcons();
    // if (!this.doesUseCustomLucideIconPack()) {
    await this.iconPackManager.init();
    // }
    // TODO: Check if needed
    // [LEGACY] 旧方法：全量预载已用图标，被 initLazyLoading（按需加载）取代，日后可移除。
    // await this.iconPackManager.loadUsedIcons([...usedIconNames]);
    await this.initLazyLoading([...usedIconNames]);

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
   * 初始化按需加载系统并预取已用图标；失败时回退到 legacy 全量加载。
   */
  private async initLazyLoading(usedIconNames: string[]): Promise<void> {
    const system = await initializeLazyLoading(this, usedIconNames);
    if (!system) {
      // [LEGACY] 回退到旧的全量预载逻辑，日后可移除。
      await this.iconPackManager.loadUsedIcons(usedIconNames);
      this._iconsReady = true;
      this.eventEmitter.emit('allIconsLoaded');
      return;
    }

    this.lazyLoadingSystem = system;
    this.iconResolver = system.resolver;
    this.inlineIconLoader = system.loader;
    this._iconsReady = true;
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
      // After initialization of the icon packs, checks the vault for missing icons and
      // adds them.
      this.iconPackManager.loadAll().then(async () => {
        if (this.getSettings().iconsBackgroundCheckEnabled) {
          const data = Object.entries(this.data) as [
            string,
            string | FolderIconObject,
          ][];
          await icon.checkMissingIcons(this, data);
          // TODO: Check if needed
          // resetPreloadedIcons();
        }

        this.eventEmitter.emit('allIconsLoaded');
      });

      if (this.getSettings().iconInFrontmatterEnabled) {
        const activeFile = this.app.workspace.getActiveFile();
        if (activeFile) {
          this.frontmatterCache.add(activeFile.path);
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

            this.frontmatterCache.add(file.path);
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
      });
      return;
    }

    const foundIcon = icon.getIconByName(this, iconNameWithPrefix)?.svgElement;
    if (foundIcon) {
      titleIcon.remove(inlineTitleEl);
      titleIcon.add(this, inlineTitleEl, foundIcon, {
        fontSize: calculateInlineTitleSize(),
        color,
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
          titleIcon.remove(inlineTitleEl);
          titleIcon.add(this, inlineTitleEl, svgMarkup, {
            fontSize: calculateInlineTitleSize(),
            color,
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
    // ===== END PATCH =====

    // ===== PATCHED: 清理 folder note 相关资源 / Cleanup folder note resources =====
    for (const unsubscribe of this._eventListenerRefs) {
      try {
        unsubscribe();
      } catch (error) {
        console.warn('[Iconize] Failed to unsubscribe event:', error);
      }
    }
    this._eventListenerRefs = [];

    for (const observer of this._tabIconObservers.values()) {
      observer.disconnect();
    }
    this._tabIconObservers.clear();
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
      this.data = { settings: { ...DEFAULT_SETTINGS } };
      new Notice('Icon folder config load failed, using defaults');
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

    this._savePending = true;
    try {
      const configPath = this.getConfigPath();
      const dir = configPath.substring(0, configPath.lastIndexOf('/'));
      const dirExists = await this.app.vault.adapter.exists(dir);
      if (!dirExists) {
        await this.app.vault.adapter.mkdir(dir);
      }
      await this.app.vault.adapter.write(
        configPath,
        JSON.stringify(this.data, null, 2),
      );
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
