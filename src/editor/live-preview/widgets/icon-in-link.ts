import emoji from '@app/emoji';
import { Icon } from '@app/icon-pack-manager';
import {
  calculateFontTextSize,
  calculateHeaderSize,
  HeaderToken,
} from '@app/lib/util/text';
import svg from '@app/lib/util/svg';
import IconizePlugin from '@app/main';
import { EditorView, WidgetType } from '@codemirror/view';
import { sanitizeHTMLToDom } from 'obsidian';

export class IconInLinkWidget extends WidgetType {
  constructor(
    private plugin: IconizePlugin,
    private iconData: Icon | string,
    private path: string,
    private headerType: HeaderToken | null,
  ) {
    super();
  }

  toDOM(view: EditorView) {
    const iconNode = view.dom.ownerDocument.createElement('span');
    const iconName =
      typeof this.iconData === 'string'
        ? this.iconData
        : this.iconData.prefix + this.iconData.name;
    const color =
      this.plugin.getIconColor(this.path) ??
      this.plugin.getSettings().iconColor;
    if (color) iconNode.setCssStyles({ color });
    iconNode.setAttribute('title', iconName);
    iconNode.classList.add('iconize-icon-in-link');

    let innerHTML =
      typeof this.iconData === 'string'
        ? this.iconData
        : this.iconData.svgElement;

    let fontSize = calculateFontTextSize();
    if (this.headerType) {
      fontSize = calculateHeaderSize(this.headerType);
    }

    if (typeof this.iconData === 'string' && !emoji.isEmoji(this.iconData)) {
      this.plugin.inlineIconLoader?.fillElement(iconNode, this.iconData, {
        fontSize,
      });
      return iconNode;
    }

    if (emoji.isEmoji(innerHTML)) {
      iconNode.setCssStyles({ transform: 'translateY(0)' });
      innerHTML = emoji.parseEmoji(
        this.plugin.getSettings().emojiStyle,
        innerHTML,
        fontSize,
      );
    } else {
      innerHTML = svg.setFontSize(innerHTML, fontSize);
    }

    iconNode.replaceChildren(sanitizeHTMLToDom(innerHTML));
    return iconNode;
  }

  destroy(dom: HTMLElement): void {
    if (typeof this.iconData === 'string' && !emoji.isEmoji(this.iconData))
      this.plugin.inlineIconLoader?.releaseElement(dom, this.iconData);
  }

  ignoreEvent(): boolean {
    return true;
  }
}
