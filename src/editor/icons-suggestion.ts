import {
  App,
  Editor,
  EditorPosition,
  EditorSuggest,
  EditorSuggestContext,
  EditorSuggestTriggerInfo,
} from 'obsidian';
import icon from '@app/lib/icon';
import emoji from '@app/emoji';
import dom from '@app/lib/util/dom';
import { saveIconToIconPack } from '@app/util';
import IconizePlugin from '@app/main';

export default class SuggestionIcon extends EditorSuggest<string> {
  constructor(
    app: App,
    public plugin: IconizePlugin,
  ) {
    super(app);
  }

  onTrigger(cursor: EditorPosition, editor: Editor): EditorSuggestTriggerInfo {
    // Isolate shortcode starting position closest to the cursor.
    const shortcodeStart = editor
      .getLine(cursor.line)
      .substring(0, cursor.ch)
      .lastIndexOf(this.plugin.getSettings().iconIdentifier);

    // `onTrigger` needs to return `null` as soon as possible to save processing performance.
    if (shortcodeStart === -1) {
      return null;
    }

    // Regex for checking if the shortcode is not done yet.
    const regex = new RegExp(
      `^(${this.plugin.getSettings().iconIdentifier})\\w+$`,
      'g',
    );
    const regexOngoingShortcode = editor
      .getLine(cursor.line)
      .substring(shortcodeStart, cursor.ch)
      .match(regex);

    if (regexOngoingShortcode === null) {
      return null;
    }

    const startingIndex = editor
      .getLine(cursor.line)
      .indexOf(regexOngoingShortcode[0]);

    return {
      start: {
        line: cursor.line,
        ch: startingIndex,
      },
      end: {
        line: cursor.line,
        ch: startingIndex + regexOngoingShortcode[0].length,
      },
      query: regexOngoingShortcode[0],
    };
  }

  getSuggestions(context: EditorSuggestContext): string[] {
    const queryLowerCase = context.query
      .substring(this.plugin.getSettings().iconIdentifier.length)
      .toLowerCase();

    // Store all icons corresponding to the current query.
    const iconsNameArray = this.plugin
      .getIconPackManager()
      .allLoadedIconNames.filter((iconObject) => {
        const name =
          iconObject.prefix.toLowerCase() + iconObject.name.toLowerCase();
        return name.toLowerCase().includes(queryLowerCase);
      })
      .map((iconObject) => iconObject.prefix + iconObject.name);

    // Store all emojis correspoding to the current query - parsing whitespaces and
    // colons for shortcodes compatibility.
    const emojisNameArray = Object.keys(emoji.shortNames).filter((e) =>
      emoji.getShortcode(e)?.includes(queryLowerCase),
    );

    return [...iconsNameArray, ...emojisNameArray];
  }

  renderSuggestion(value: string, el: HTMLElement): void {
    el.style.display = 'flex';
    el.style.alignItems = 'center';
    el.style.gap = '0.25rem';

    // 图标可能在索引中但尚未解析（按需加载），此时交给 dom.setIconForNode 异步补齐。
    // The icon may be indexed but not yet resolved; dom.setIconForNode fills it in.
    if (
      icon.getIconByName(this.plugin, value) ||
      this.plugin.iconResolver?.find(value)
    ) {
      const iconEl = el.createSpan();
      dom.setIconForNode(this.plugin, value, iconEl, {
        shouldApplyAllStyles: false,
      });
      el.createSpan({ text: value });
      return;
    }

    // Suggest an emoji - display its shortcode version.
    el.createSpan({ text: value });
    const shortcode = emoji.getShortcode(value);
    if (shortcode) {
      el.createSpan({ text: shortcode });
    }
  }

  selectSuggestion(value: string): void {
    const isEmoji = emoji.isEmoji(value.replace(/_/g, ' '));
    if (!isEmoji) {
      saveIconToIconPack(this.plugin, value);
    }

    // Replace query with iconNameWithPrefix or emoji unicode directly.
    const updatedValue = isEmoji
      ? value
      : `${this.plugin.getSettings().iconIdentifier}${value}${
          this.plugin.getSettings().iconIdentifier
        }`;
    this.context.editor.replaceRange(
      updatedValue,
      this.context.start,
      this.context.end,
    );
  }
}
