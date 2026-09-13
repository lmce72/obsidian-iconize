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
  titleIcon.setAttribute(config.ICON_ATTRIBUTE_NAME, options?.iconName ?? '');
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
