import emoji from '@app/emoji';
import icon from '@app/lib/icon';
import svg from '@app/lib/util/svg';
import {
  HTMLHeader,
  calculateFontTextSize,
  calculateHeaderSize,
} from '@app/lib/util/text';
import IconizePlugin from '@app/main';
import { EditorView, WidgetType } from '@codemirror/view';
import { sanitizeHTMLToDom } from 'obsidian';

export class IconInTextWidget extends WidgetType {
  private start = -1;
  private end = -1;

  constructor(
    public plugin: IconizePlugin,
    public id: string,
  ) {
    super();
  }

  setPosition(start: number, end: number): void {
    this.start = start;
    this.end = end;
  }

  eq(other: IconInTextWidget) {
    return (
      other instanceof IconInTextWidget &&
      other.id === this.id &&
      other.start === this.start &&
      other.end === this.end
    );
  }

  private getSize(view: EditorView): number {
    let fontSize = calculateFontTextSize();

    const line = view.state.doc.lineAt(this.end);
    const headerMatch = line.text.match(/^#{1,6}\s/);
    if (headerMatch && headerMatch[0].trim()) {
      const mapping: Record<string, HTMLHeader> = {
        '#': 'h1',
        '##': 'h2',
        '###': 'h3',
        '####': 'h4',
        '#####': 'h5',
        '######': 'h6',
      };

      const header = mapping[headerMatch[0].trim()];
      fontSize = calculateHeaderSize(header);
    }

    return fontSize;
  }

  toDOM(view: EditorView) {
    const wrap = view.dom.ownerDocument.createElement('span');
    wrap.classList.add('cm-iconize-icon');
    wrap.setAttribute('aria-label', this.id);
    wrap.setAttribute('data-icon', this.id);
    wrap.setAttribute('data-iconize-from', String(this.start));
    wrap.setAttribute('aria-hidden', 'true');

    const foundIcon = icon.getIconByName(this.plugin, this.id);
    const fontSize = this.getSize(view);

    if (foundIcon) {
      const svgElement = svg.setFontSize(foundIcon.svgElement, fontSize);
      wrap.replaceChildren(sanitizeHTMLToDom(svgElement));
    } else if (emoji.isEmoji(this.id)) {
      wrap.replaceChildren(
        sanitizeHTMLToDom(
          emoji.parseEmoji(
            this.plugin.getSettings().emojiStyle,
            this.id,
            fontSize,
          ),
        ),
      );
    } else if (this.plugin.iconResolver?.find(this.id)) {
      this.plugin.inlineIconLoader?.fillElement(wrap, this.id, { fontSize });
    } else {
      wrap.append(
        `${this.plugin.getSettings().iconIdentifier}${this.id}${
          this.plugin.getSettings().iconIdentifier
        }`,
      );
    }

    return wrap;
  }

  destroy(dom: HTMLElement): void {
    this.plugin.inlineIconLoader?.releaseElement(dom, this.id);
  }

  ignoreEvent(): boolean {
    return false;
  }
}
