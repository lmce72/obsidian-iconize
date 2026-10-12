import IconizePlugin from '@app/main';
import config from '@app/config';
import emoji from '@app/emoji';
import svg from './util/svg';
import { IconInTitlePosition } from '@app/settings/data';

const getTitleIcon = (leaf: HTMLElement): HTMLElement | null => {
  return leaf.querySelector(`.${config.TITLE_ICON_CLASS}`);
};

/**
 * 标题图标元素当前代表的请求序号 / Request sequence the title icon element stands for.
 *
 * 内联标题元素会被复用，异步解析结果晚到时必须能判断自己是否已经过期。登记之所以放在本模块，
 * 是因为「这个元素此刻代表谁」正是本模块的领域：任何一次写入（`add`）或移除（`remove` /
 * `hide`）都会自动作废在飞的旧结果，调用方无需记得去登记，也就不可能绕过这道闸门。
 *
 * The inline title element is reused, so a late async result must be able to tell whether it
 * has gone stale. The registry lives here because "who does this element stand for right now"
 * is this module's own domain: every write (`add`) and every removal (`remove` / `hide`)
 * invalidates in-flight results by itself, so no caller has to remember to register and none
 * can bypass the gate.
 */
const pendingRequests = new WeakMap<HTMLElement, number>();
let requestSequence = 0;

/**
 * 为一次异步解析领号 / Takes a ticket for an async resolve.
 *
 * 必须在 `await` 之前领号：解析期间发生的任何写入都会让这个号作废。
 * Must be called before awaiting: any write during the resolve invalidates the ticket.
 */
const beginRequest = (inlineTitleEl: HTMLElement): number => {
  const requestId = ++requestSequence;
  pendingRequests.set(inlineTitleEl, requestId);
  return requestId;
};

/**
 * 该号是否仍然最新 / Whether the ticket is still the latest one.
 *
 * 元素若已被代表另一个文件，则返回 false——晚到的结果必须丢弃，否则标题上显示的就是
 * 上一个文件的图标。
 * Returns false once the element stands for another file: the late result must be dropped, or
 * the title would show the previous file's icon.
 */
const isLatestRequest = (
  inlineTitleEl: HTMLElement,
  requestId: number,
): boolean => {
  return pendingRequests.get(inlineTitleEl) === requestId;
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
  // 先领号再渲染：即使下面因为元素已摘下而什么都没写，这次调用也宣告了「这个元素现在归我」，
  // 上一个文件在飞的解析结果因此作废，不会晚一步画到当前文件上。
  // Take the ticket before rendering: even if nothing is written below because the element is
  // detached, this call claims the element, so the previous file's in-flight resolve is
  // invalidated instead of painting itself onto the current file a moment later.
  beginRequest(inlineTitleEl);

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
  // 该属性只用于按标识查询图标节点，因此必须与本次渲染的图标同步。
  // The attribute exists to look icon nodes up by identifier, so it must track the icon
  // rendered by this very call.
  //
  // 元素跨文件复用，上一个文件的标识必须清掉：默认文件图标不代表任何配置，若留着旧标识，
  // 图标缺失检查会 `querySelectorAll('[data-icon="..."]')` 命中它，把它当成那个图标的容器
  // 并覆盖掉它的内容。
  // The element is reused across files, so the previous file's identifier must go: the
  // default file icon stands for no configuration, and a stale identifier makes the missing
  // -icon check (`querySelectorAll('[data-icon="..."]')`) match it, treat it as that icon's
  // container and overwrite its content.
  if (options?.iconName) {
    titleIcon.setAttribute(config.ICON_ATTRIBUTE_NAME, options.iconName);
  } else {
    titleIcon.removeAttribute(config.ICON_ATTRIBUTE_NAME);
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
 * 隐藏标题图标 / Hides the title icon.
 *
 * 已无生产调用者：文件没有图标时改为显示默认文件图标，关闭「图标显示在标题」设置时走 `remove`
 * 彻底移除，「保留节点但不显示」这条语义因此没有出口了。保留它是因为它仍是本模块的公开 API。
 * No production caller left: a file without an icon now shows the default file icon, and turning
 * the "icon in title" setting off goes through `remove` instead, so "keep the node but hide it"
 * no longer has an exit. It stays because it is still part of this module's public API.
 *
 * @param inlineTitleEl HTMLElement whose title icon will be hidden.
 */
const hide = (inlineTitleEl: HTMLElement): void => {
  // 隐藏同样是一次「这个元素不再展示旧图标」的宣告，在飞的解析结果必须作废。
  // Hiding also declares that the element no longer shows the old icon, so in-flight resolves
  // must be invalidated.
  beginRequest(inlineTitleEl);

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
  // 移除同样是一次宣告：晚到的解析结果不能把刚摘掉的图标又画回来。
  // Removing declares the same thing: a late resolve must not paint the icon back.
  beginRequest(inlineTitleEl);

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
  beginRequest,
  isLatestRequest,
};
