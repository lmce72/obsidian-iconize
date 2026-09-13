import config from '@app/config';
import IconizePlugin from '@app/main';
import { logger } from '@app/lib/logger';
import style from './style';
import svg from './svg';
import emoji from '@app/emoji';
import {
  getSvgFromLoadedIcon,
  nextIdentifier,
} from '@app/icon-pack-manager/util';

/**
 * Removes the `iconize-icon` icon node from the provided HTMLElement.
 * @param el HTMLElement from which the icon node will be removed.
 */
const removeIconInNode = (el: HTMLElement): void => {
  const iconNode = el.querySelector('.iconize-icon');
  if (!iconNode) {
    return;
  }

  iconNode.remove();
};

interface RemoveOptions {
  /**
   * The container that will be used to remove the icon. If not defined, it will try to
   * find the path within the `document`.
   */
  container?: HTMLElement;
}

/**
 * Removes the 'iconize-icon' icon node from the HTMLElement corresponding
 * to the specified file path.
 * @param path File path for which the icon node will be removed.
 */
const removeIconInPath = (path: string, options?: RemoveOptions): void => {
  const node =
    options?.container ?? document.querySelector(`[data-path="${path}"]`);
  if (!node) {
    logger.warn(`Element with data path not found (path: ${path})`);
    return;
  }

  removeIconInNode(node);
};

interface SetIconForNodeOptions {
  color?: string;
  shouldApplyAllStyles?: boolean;
  /**
   * 是否把解析结果写入磁盘缓存 / Whether the resolved icon is written to the disk cache.
   *
   * 浏览图标拾取器会触及上千个图标，其中绝大多数只是预览，不该逐个落盘。
   * Browsing the picker touches thousands of icons that are only ever previewed.
   */
  persist?: boolean;
}

/**
 * 把图标内容应用到节点上 / Applies icon content to a node.
 *
 * 同步与异步两条路径共用，避免样式逻辑散落成两份。
 * Shared by the synchronous and on-demand paths so the styling logic exists once.
 */
const applyIconContent = (
  plugin: IconizePlugin,
  content: string,
  node: HTMLElement,
  options: SetIconForNodeOptions,
  iconName: string,
): void => {
  let iconContent = options.shouldApplyAllStyles
    ? style.applyAll(plugin, content, node)
    : content;
  if (options.color) {
    node.style.color = options.color;
    iconContent = svg.colorize(iconContent, options.color);
  }
  node.innerHTML = iconContent;
  node.setAttribute('title', iconName);
};

/**
 * Sets an icon or emoji for an HTMLElement based on the specified icon name and color.
 * The function manipulates the specified node inline.
 *
 * 内存中没有该图标时会异步按需解析（磁盘缓存 → 图标包），解析完成后若节点仍挂在文档中则填充。
 * Icons missing from memory are resolved on demand; the node is filled once resolved,
 * provided it is still attached to the document.
 *
 * @param plugin Instance of the IconizePlugin.
 * @param iconName Name of the icon or emoji to add.
 * @param node HTMLElement to which the icon or emoji will be added.
 * @param options Options for adjusting settings while the icon is being set.
 */
const setIconForNode = (
  plugin: IconizePlugin,
  iconName: string,
  node: HTMLElement,
  options?: SetIconForNodeOptions,
): void => {
  options ??= {};
  options.shouldApplyAllStyles ??= true;

  // Gets the possible icon based on the icon name.
  const iconNextIdentifier = nextIdentifier(iconName);
  const possibleIcon = getSvgFromLoadedIcon(
    plugin,
    iconName.substring(0, iconNextIdentifier),
    iconName.substring(iconNextIdentifier),
  );

  if (possibleIcon) {
    applyIconContent(plugin, possibleIcon, node, options, iconName);
    return;
  }

  // 按需加载：图标在索引中但尚未解析时，异步取回后再填充。
  const resolver = plugin.iconResolver;
  if (resolver?.find(iconName)) {
    // 标记该节点当前代表哪个图标，作为异步回调的比对依据（预览节点没有这个属性）。
    // Mark what the node currently stands for, so the async callback can compare against it.
    if (!node.hasAttribute(config.ICON_ATTRIBUTE_NAME)) {
      node.setAttribute(config.ICON_ATTRIBUTE_NAME, iconName);
    }

    resolver
      .resolve(iconName, { persist: options.persist ?? true })
      .then((icon) => {
        if (!icon || !node.isConnected) {
          return;
        }
        // 节点可能已被复用去显示另一个图标——异步结果晚到时不能覆盖它。
        // The node may have been reused for a different icon; a late result must not
        // overwrite it.
        if (node.getAttribute(config.ICON_ATTRIBUTE_NAME) !== iconName) {
          return;
        }
        applyIconContent(plugin, icon.svgElement, node, options, iconName);
      })
      .catch((error) => {
        console.error(
          `[Iconize] Failed to resolve icon '${iconName}' on demand:`,
          error,
        );
      });
    return;
  }

  const parsedEmoji =
    emoji.parseEmoji(plugin.getSettings().emojiStyle, iconName) ?? iconName;
  applyIconContent(plugin, parsedEmoji, node, options, iconName);
};

interface CreateOptions {
  /**
   * The container that will be used to insert the icon. If not defined, it will try to
   * find the path within the `document`.
   */
  container?: HTMLElement;
  /**
   * The color that will be applied to the icon.
   */
  color?: string;
}

/**
 * Creates an icon node for the specified path and inserts it to the DOM.
 * @param plugin Instance of the IconizePlugin.
 * @param path Path for which the icon node will be created.
 * @param iconName Name of the icon or emoji to add.
 * @param color Optional color of the icon to add.
 */
const createIconNode = (
  plugin: IconizePlugin,
  path: string,
  iconName: string,
  options?: CreateOptions,
): void => {
  // Get the container from the provided options or try to find the node that has the
  // path from the document itself.
  const node =
    options?.container ?? document.querySelector(`[data-path="${path}"]`);
  if (!node) {
    logger.warn(`Element with data path not found (path: ${path})`);
    return;
  }

  // Get the folder or file title node.
  let titleNode = node.querySelector('.nav-folder-title-content');
  if (!titleNode) {
    titleNode = node.querySelector('.nav-file-title-content');

    if (!titleNode) {
      logger.warn(`Element with title node not found (path: ${path})`);
      return;
    }
  }

  let iconNode: HTMLDivElement = node.querySelector('.iconize-icon');
  // If the icon is already set in the path, we do not need to create a new div element.
  if (iconNode) {
    setIconForNode(plugin, iconName, iconNode, { color: options?.color });
  } else {
    // Creates a new icon node and inserts it to the DOM.
    iconNode = document.createElement('div');
    iconNode.setAttribute(config.ICON_ATTRIBUTE_NAME, iconName);
    iconNode.classList.add('iconize-icon');

    setIconForNode(plugin, iconName, iconNode, { color: options?.color });

    node.insertBefore(iconNode, titleNode);
  }
};

/**
 * Checks if the element has an icon node by checking if the element has a child with the
 * class `iconize-icon`.
 * @param element HTMLElement which will be checked if it has an icon.
 * @returns Boolean whether the element has an icon node or not.
 */
const doesElementHasIconNode = (element: HTMLElement): boolean => {
  return element.querySelector('.iconize-icon') !== null;
};

/**
 * Gets the icon name of the element if it has an icon node.
 * @param element HTMLElement parent which includes a node with the icon.
 * @returns String with the icon name if the element has an icon, `undefined` otherwise.
 */
const getIconFromElement = (element: HTMLElement): string | undefined => {
  const iconNode = element.querySelector('.iconize-icon');
  const existingIcon = iconNode?.getAttribute(config.ICON_ATTRIBUTE_NAME);
  return existingIcon;
};

const getIconNodeFromPath = (path: string): HTMLElement | undefined => {
  return document
    .querySelector(`[data-path="${path}"]`)
    ?.querySelector('[data-icon]');
};

export default {
  setIconForNode,
  createIconNode,
  doesElementHasIconNode,
  getIconFromElement,
  getIconNodeFromPath,
  removeIconInNode,
  removeIconInPath,
};
