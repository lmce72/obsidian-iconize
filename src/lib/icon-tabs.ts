import IconizePlugin, { FolderIconObject } from '@app/main';
import { DEFAULT_FILE_ICON, getAllOpenedFiles } from '@app/util';
import { TabHeaderLeaf } from '@app/@types/obsidian';
import customRule from './custom-rule';
import dom from './util/dom';

/**
 * Gets the tab leaves of a specific file path by looping through all opened files and
 * checking if the file path matches.
 * @param plugin IconizePlugin instance.
 * @param path String of the file path to get the tab leaf of.
 * @returns TabHeaderLeaf array that includes all tab leaves of the file path.
 */
const getTabLeavesOfFilePath = (
  plugin: IconizePlugin,
  path: string,
): TabHeaderLeaf[] => {
  const openedFiles = getAllOpenedFiles(plugin);
  const openedFile = openedFiles.filter(
    (openedFile) => openedFile.path === path,
  );
  const leaves = openedFile.map((openedFile) => openedFile.leaf);
  return leaves as TabHeaderLeaf[];
};

interface AddOptions {
  /**
   * Name of the icon to add to the tab.
   * @default undefined
   */
  iconName?: string;
  /**
   * Color of the icon to add to the tab.
   * @default undefined
   */
  iconColor?: string;
}

/**
 * Adds an icon to the tab and its container. This function respects the
 * custom rules and individually icon set.
 * @param plugin IconizePlugin instance.
 * @param filePath String file path to add the icon to.
 * @param iconContainer HTMLElement where the icon will be added to.
 * @param options AddOptions for the add function which can optionally be used.
 */
const add = async (
  plugin: IconizePlugin,
  filePath: string,
  iconContainer: HTMLElement,
  options?: AddOptions,
): Promise<void> => {
  const iconColor = options?.iconColor ?? plugin.getSettings().iconColor;
  const data = Object.entries(plugin.getData());

  // Removes the `display: none` from the obsidian styling.
  iconContainer.style.display = 'flex';

  // Only add the icon name manually when it is defined in the options.
  if (options?.iconName) {
    dom.setIconForNode(plugin, options.iconName, iconContainer, {
      color: iconColor,
    });
    // TODO: Refactor to include option to `insertIconToNode` function.
    iconContainer.style.margin = null;
    return;
  }

  // Add icons to tabs if a custom rule is applicable.
  //
  // 命中规则时它会成为这个标签页的图标，下面「该路径没有图标」的出口因此不能清身份。
  // A matching rule becomes this tab's icon, so the no-icon exits below must not clear the
  // identity in that case.
  let appliedByRule = false;
  for (const rule of customRule.getSortedRules(plugin)) {
    const isApplicable = await customRule.isApplicable(plugin, rule, filePath);
    if (isApplicable) {
      dom.setIconForNode(plugin, rule.icon, iconContainer, {
        color: rule.color,
      });
      // TODO: Refactor to include option to `insertIconToNode` function.
      iconContainer.style.margin = null;
      appliedByRule = true;
      break;
    }
  }

  // 该路径没有任何 Iconize 图标时，标签页显示的是 Obsidian 自带的图标（或规则图标），
  // 节点上的身份必须撤掉：标签页节点会被复用去显示另一个文件，留着上一个文件的身份，
  // 图标缺失检查就会按它把上一个文件的图标画到这个标签页上。
  // With no Iconize icon for this path the tab shows Obsidian's own icon (or the rule's), so
  // the identity must go: the tab node is reused for another file, and keeping the previous
  // file's identity lets the missing-icon check paint that icon back onto this tab.
  const clearIdentity = (): void => {
    if (!appliedByRule) {
      dom.clearIconIdentity(iconContainer);
    }
  };

  // Add icons to tabs if there is an icon set.
  const iconData = data.find(([dataPath]) => dataPath === filePath);
  if (!iconData) {
    clearIdentity();
    return;
  }

  const value = iconData[1];
  if (typeof value !== 'string' && typeof value !== 'object') {
    clearIdentity();
    return;
  }

  let iconName;
  if (typeof value === 'object') {
    const v = value as FolderIconObject;
    if (v.iconName === null) {
      clearIdentity();
      return;
    }
    iconName = v.iconName;
  } else {
    iconName = value;
  }

  dom.setIconForNode(plugin, iconName, iconContainer, {
    color: iconColor,
    shouldApplyAllStyles: true,
  });
  // TODO: Refactor to include option to `insertIconToNode` function.
  iconContainer.style.margin = null;
};

/**
 * Updates the icon in the tab and container by setting calling the `setIconForNode`
 * function and removing the margin from the icon container.
 * @param plugin IconizePlugin instance.
 * @param iconName String of the icon name to update to.
 * @param iconContainer HTMLElement where the icon is located and will be updated.
 */
const update = (
  plugin: IconizePlugin,
  iconName: string,
  iconContainer: HTMLElement,
) => {
  dom.setIconForNode(plugin, iconName, iconContainer);
  // TODO: Refactor to include option to `insertIconToNode` function.
  iconContainer.style.margin = null;
};

interface RemoveOptions {
  /**
   * Replaces the icon in the tab with the default obsidian icon.
   * @default false
   */
  replaceWithDefaultIcon?: boolean;
}

/**
 * Removes the icon from the tab and container by setting the `display` style property
 * to `none`. Optionally, the icon can be replaced with the default obsidian icon.
 * @param iconContainer HTMLElement where the icon is located and will be removed from.
 * @param options RemoveOptions for the remove function which can optionally be used.
 */
const remove = (iconContainer: HTMLElement, options?: RemoveOptions) => {
  // 无论隐藏还是换成默认图标，节点都已不再代表原来那个图标；身份与悬停提示必须一起撤掉。
  // 留着的话，按该属性查询的逻辑（图标缺失检查、自定义规则清理）会把这个节点当成那个图标的
  // 容器并把它覆盖回来——显示的就不是当前文件该有的东西了。
  // Hidden or replaced by the default icon, the node no longer stands for that icon, and both
  // the identity and the tooltip must go with it. Left behind, `[data-icon=...]` queries (the
  // missing-icon check, custom-rule cleanup) treat this node as that icon's container and
  // overwrite it back — showing something other than what the current file should have.
  dom.clearIconIdentity(iconContainer);

  if (!options?.replaceWithDefaultIcon) {
    // Removes the display of the icon container to remove the icons from the tabs.
    iconContainer.style.display = 'none';
  } else {
    iconContainer.innerHTML = DEFAULT_FILE_ICON;
  }
};

export default {
  add,
  update,
  remove,
  getTabLeavesOfFilePath,
};
