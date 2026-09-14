import IconizePlugin from '@app/main';
import config from '@app/config';
import emoji from '@app/emoji';
import svg from './util/svg';
import { IconInTitlePosition } from '@app/settings/data';

const getTitleIcon = (leaf: HTMLElement): HTMLElement | null => {
  return leaf.querySelector(`.${config.TITLE_ICON_CLASS}`);
};

interface Options {
  fontSize?: number;
  /**
   * 图标颜色 / Color of the icon.
   *
   * 与标签页图标一致：同时设置容器颜色与 SVG 的绘制属性，
   * 这样 `currentColor` 与显式 fill/stroke 两种图标都能着色。
   * Mirrors the tab icon: both the container color and the SVG paint attribute are
   * set, so `currentColor` and explicit fill/stroke icons are both colored.
   */
  color?: string;
  /**
   * 该标题图标对应的标识 / Identifier this title icon stands for.
   *
   * 内联标题元素会跨文件复用，异步解析晚到时需要据此判断结果是否仍然适用。
   * The inline title element is reused across files, so a late async result needs this to
   * tell whether it still applies.
   */
  iconName?: string;
  /**
   * 该标题图标对应的文件路径 / Path of the file this title icon belongs to.
   *
   * 点击时由此得知要更改哪个文件的图标；元素会被复用，因此每次都要更新。
   * Tells a click which file's icon to change; the element is reused, so it is refreshed on
   * every call.
   */
  path?: string;
  /**
   * 点击标题图标时调用，参数是该元素当前代表的路径。
   * Invoked when the title icon is clicked, with the path the element currently stands for.
   *
   * 以回调而非在此直接打开选择器：那会让本模块依赖 UI 层，并与 main 形成循环引用。
   * A callback rather than opening the picker here: that would make this module depend on
   * the UI layer and form a cycle with main.
   */
  onClick?: (path: string) => void;
}

const add = (
  plugin: IconizePlugin,
  inlineTitleEl: HTMLElement,
  svgElement: string,
  options?: Options,
): void => {
  if (!inlineTitleEl.parentElement) {
    return;
  }

  if (options?.fontSize) {
    svgElement = svg.setFontSize(svgElement, options.fontSize);
  }

  let titleIcon = getTitleIcon(inlineTitleEl.parentElement);
  if (!titleIcon) {
    titleIcon = document.createElement('div');
  }

  const isInline =
    plugin.getSettings().iconInTitlePosition === IconInTitlePosition.Inline;

  if (isInline) {
    titleIcon.style.display = 'inline-block';
    titleIcon.style.removeProperty('margin-inline');
    titleIcon.style.removeProperty('width');
  } else {
    titleIcon.style.display = 'block';
    titleIcon.style.width = 'var(--line-width)';
    titleIcon.style.marginInline = '0';
  }

  titleIcon.classList.add(config.TITLE_ICON_CLASS);
  // 仅在调用方提供了标识时写入该属性；它只用于异步结果的比对，无标识时不必留下空属性。
  // Only written when the caller supplies an identifier: it exists to compare async
  // results against, and an empty attribute would be noise.
  if (options?.iconName) {
    titleIcon.setAttribute(config.ICON_ATTRIBUTE_NAME, options.iconName);
  }

  // 让标题图标可点击以更改图标。/ Make the title icon clickable to change the icon.
  //
  // 元素会被复用（切换文件时不重建），因此只绑定一次监听，并每次刷新它读取的路径——
  // 否则重复绑定会让监听器叠加，或让点击作用到上一个文件。
  //
  // The element is reused across files, so the listener is bound once and the path it reads
  // is refreshed on each call; binding again would stack listeners, and a captured path
  // would point at the previous file.
  if (options?.path) {
    titleIcon.dataset.iconizePath = options.path;
  }
  if (options?.onClick) {
    titleIcon.style.cursor = 'pointer';
    if (titleIcon.dataset.iconizeClickBound !== '1') {
      titleIcon.dataset.iconizeClickBound = '1';
      titleIcon.addEventListener('click', (event) => {
        // 阻止冒泡，避免点击被内联标题或编辑器接走（那会把光标移进标题）。
        // Stop propagation so the inline title or editor does not take the click and move
        // the caret into the title.
        event.preventDefault();
        event.stopPropagation();
        const path = titleIcon.dataset.iconizePath;
        if (path) {
          options.onClick?.(path);
        }
      });
    }
  }
  // Checks if the passed element is an emoji.
  if (emoji.isEmoji(svgElement) && options.fontSize) {
    svgElement =
      emoji.parseEmoji(
        plugin.getSettings().emojiStyle,
        svgElement,
        options.fontSize,
      ) ?? svgElement;
    titleIcon.style.fontSize = `${options.fontSize}px`;
  }

  // 应用颜色：显式设置的颜色覆盖主题色，未设置时清除残留，避免切换文件后沿用上一个图标颜色。
  // Applies the color, clearing any previous one so switching files cannot inherit it.
  if (options?.color) {
    titleIcon.style.color = options.color;
    if (!emoji.isEmoji(svgElement)) {
      svgElement = svg.colorize(svgElement, options.color);
    }
  } else {
    titleIcon.style.removeProperty('color');
  }

  titleIcon.innerHTML = svgElement;

  let wrapperElement = inlineTitleEl.parentElement;
  // Checks the parent and selects the correct wrapper element.
  // This should only happen in the beginning.
  if (
    wrapperElement &&
    !wrapperElement.classList.contains(config.INLINE_TITLE_WRAPPER_CLASS)
  ) {
    wrapperElement = wrapperElement.querySelector(
      `.${config.INLINE_TITLE_WRAPPER_CLASS}`,
    );
  }

  // Whenever there is no correct wrapper element, we create one.
  if (!wrapperElement) {
    wrapperElement = inlineTitleEl.parentElement.createDiv();
    wrapperElement.classList.add(config.INLINE_TITLE_WRAPPER_CLASS);
  }

  // Avoiding adding the same nodes together when changing the title.
  if (wrapperElement !== inlineTitleEl.parentElement) {
    inlineTitleEl.parentElement.prepend(wrapperElement);
  }

  if (isInline) {
    wrapperElement.style.display = 'flex';
    wrapperElement.style.alignItems = 'flex-start';
    const inlineTitlePaddingTop = getComputedStyle(
      inlineTitleEl,
      null,
    ).getPropertyValue('padding-top');
    titleIcon.style.paddingTop = inlineTitlePaddingTop;

    if (emoji.isEmoji(svgElement)) {
      titleIcon.style.transform = 'translateY(-9%)';
    } else {
      titleIcon.style.transform = 'translateY(9%)';
    }
  } else {
    wrapperElement.style.display = 'block';
    titleIcon.style.transform = 'translateY(9%)';
  }

  wrapperElement.append(titleIcon);
  wrapperElement.append(inlineTitleEl);
};

const updateStyle = (inlineTitleEl: HTMLElement, options: Options): void => {
  if (!inlineTitleEl.parentElement) {
    return;
  }

  const titleIcon = getTitleIcon(inlineTitleEl.parentElement);
  if (!titleIcon) {
    return;
  }

  if (options.fontSize) {
    if (!emoji.isEmoji(titleIcon.innerHTML)) {
      titleIcon.innerHTML = svg.setFontSize(
        titleIcon.innerHTML,
        options.fontSize,
      );
    } else {
      titleIcon.style.fontSize = `${options.fontSize}px`;
    }
  }
};

/**
 * Hides the title icon from the provided HTMLElement.
 * @param contentEl HTMLElement to hide the title icon from.
 */
const hide = (inlineTitleEl: HTMLElement): void => {
  if (!inlineTitleEl.parentElement) {
    return;
  }

  const titleIconContainer = getTitleIcon(inlineTitleEl.parentElement);
  if (!titleIconContainer) {
    return;
  }

  titleIconContainer.style.display = 'none';
};

const remove = (inlineTitleEl: HTMLElement): void => {
  if (!inlineTitleEl.parentElement) {
    return;
  }

  const titleIconContainer = getTitleIcon(inlineTitleEl.parentElement);
  if (!titleIconContainer) {
    return;
  }

  titleIconContainer.remove();
};

export default {
  add,
  updateStyle,
  hide,
  remove,
  get: getTitleIcon,
};
