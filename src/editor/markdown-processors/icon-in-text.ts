// TODO: Optimize the code to reduce the number of iterations and improve the
// performance.

import svg from '@app/lib/util/svg';
import icon from '@app/lib/icon';
import {
  HTMLHeader,
  calculateFontTextSize,
  calculateHeaderSize,
  isHeader,
} from '@app/lib/util/text';
import IconizePlugin from '@app/main';
import emoji from '@app/emoji';

export const createIconShortcodeRegex = (plugin: IconizePlugin): RegExp => {
  return new RegExp(
    `(${
      plugin.getSettings().iconIdentifier
    })((\\w{1,64}:\\d{17,18})|(\\w{1,64}))(${
      plugin.getSettings().iconIdentifier
    })`,
    'g',
  );
};

const createTreeWalker = (
  plugin: IconizePlugin,
  root: HTMLElement,
): TreeWalker => {
  return document.createTreeWalker(root, NodeFilter.SHOW_ALL, {
    acceptNode: function (node) {
      if (node.nodeName === 'CODE') {
        return NodeFilter.FILTER_REJECT;
      } else if (node.nodeName === '#text') {
        if (
          node.nodeValue &&
          (emoji.getRegex().test(node.nodeValue) ||
            createIconShortcodeRegex(plugin).test(node.nodeValue))
        ) {
          return NodeFilter.FILTER_ACCEPT;
        } else {
          return NodeFilter.FILTER_REJECT;
        }
      }
      return NodeFilter.FILTER_SKIP;
    },
  });
};

const checkForTextNodes = (
  treeWalker: TreeWalker,
  match: RegExp,
  cb: (text: Text, code: { text: string; index: number }) => void,
): void => {
  let currentNode = treeWalker.currentNode;
  while (currentNode) {
    if (currentNode.nodeType === Node.TEXT_NODE) {
      const text = currentNode as Text;
      const textNodes = [...Array.from(text.parentElement!.childNodes)].filter(
        (n): n is Text => n instanceof Text,
      );
      for (const text of textNodes) {
        for (const code of [...text.wholeText.matchAll(match)]
          .sort((a, b) => b.index - a.index)
          .map((arr) => ({ text: arr[0], index: arr.index! }))) {
          if (!text.textContent) {
            continue;
          }

          cb(text, code);
        }
      }
    }
    currentNode = treeWalker.nextNode();
  }
};

export const processIconInTextMarkdown = (
  plugin: IconizePlugin,
  element: HTMLElement,
) => {
  // Ignore if codeblock
  const codeElement = element.querySelector('pre > code');
  const callOut = element.querySelector('.callout');
  if (codeElement && !callOut) {
    return;
  }

  const iconTreeWalker = createTreeWalker(plugin, element);

  const iconShortcodeRegex = createIconShortcodeRegex(plugin);
  const iconIdentifierLength = plugin.getSettings().iconIdentifier.length;

  checkForTextNodes(iconTreeWalker, iconShortcodeRegex, (text, code) => {
    const shortcode = code.text;
    const iconName = shortcode.slice(
      iconIdentifierLength,
      shortcode.length - iconIdentifierLength,
    );

    const iconObject = icon.getIconByName(plugin, iconName);

    // 图标可能尚未解析（按需加载）。此时仍然把短代码换成占位元素，而不是把
    // `:LiView:` 留在原地——留着就要等某次重绘才能变成图标，而**链接悬停预览的浮层
    // 不是 markdown leaf、永远不会被重绘**，于是那里会一直显示文字。
    //
    // The icon may not be resolved yet. The shortcode is still replaced by a placeholder
    // rather than left as `:LiView:`: leaving it means waiting for a repaint, and the
    // page-preview popover is not a markdown leaf and is never repainted, so the text would
    // stay there.
    const isIndexed = !iconObject && !!plugin.iconResolver?.find(iconName);
    if (!iconObject && !isIndexed) {
      return;
    }

    const toReplace = text.splitText(code.index);
    const rootSpan = createSpan({
      cls: 'cm-iconize-icon',
      attr: {
        'aria-label': iconName,
        'data-icon': iconName,
        'aria-hidden': 'true',
      },
    });
    rootSpan.style.display = 'inline-flex';
    rootSpan.style.transform = 'translateY(13%)';

    const parentElement = toReplace.parentElement;
    const tagName = parentElement?.tagName?.toLowerCase() ?? '';
    let fontSize = calculateFontTextSize();

    if (isHeader(tagName)) {
      fontSize = calculateHeaderSize(tagName as HTMLHeader);
    }

    if (iconObject) {
      rootSpan.innerHTML = svg.setFontSize(iconObject.svgElement, fontSize);
    } else {
      // 交给加载器：解析完成后直接写入这个节点，不依赖重绘。
      // Hand it to the loader: the markup lands in this node once resolved, with no repaint.
      plugin.inlineIconLoader?.fillElement(rootSpan, iconName);
    }

    parentElement?.insertBefore(rootSpan, toReplace);
    toReplace.textContent = toReplace.wholeText.substring(code.text.length);

    // Set the font size to its parent font size if defined.
    // We do this after that to not freeze the insertion while iterating over the tree.
    // We are also updating the size after the animation because the styling won't be set
    // in the first place.
    requestAnimationFrame(() => {
      const parentFontSize = parseFloat(
        getComputedStyle(parentElement).fontSize,
      );
      if (!isNaN(parentFontSize)) {
        rootSpan.innerHTML = svg.setFontSize(
          rootSpan.innerHTML,
          parentFontSize,
        );
      }
    });
  });

  const emojiTreeWalker = createTreeWalker(plugin, element);
  checkForTextNodes(emojiTreeWalker, emoji.getRegex(), (text, code) => {
    if (!emoji.isEmoji(code.text)) {
      return;
    }

    if (plugin.getSettings().emojiStyle === 'twemoji') {
      const tagName = text.parentElement?.tagName?.toLowerCase() ?? ''; // "text" has the same parent as "toReplace"
      let fontSize = calculateFontTextSize();

      if (isHeader(tagName)) {
        fontSize = calculateHeaderSize(tagName as HTMLHeader);
      }

      // If emojiValue was an unparsed HTML img string, it will be skipped
      // by the treewalker, as img doesn't have any text node derived from it.
      // But, unfortunately, when passing certain character like "©" as the
      // second parameter of emoji.parseEmoji (before it was fixed), it will return
      // the string itself due to twemoji.parse perceive it as a normal character (non-emoji).
      // If it is the case, the string will be interpreted as a text node.
      const emojiValue = emoji.parseEmoji(
        plugin.getSettings().emojiStyle,
        code.text,
        fontSize,
      );
      if (!emojiValue) {
        return;
      }

      // Split the text node only after checking emojiValue.
      const toReplace = text.splitText(code.index);
      const emojiNode = createSpan();
      // emojiValue should not be interpreted as a text node or as an element
      // containing text node, otherwise it will cause endlessly loop
      // due to TreeWalker considering the first part as its current node,
      // not the second one (except you add another TreeWalker.nextNode() here).
      emojiNode.innerHTML = emojiValue;
      toReplace.parentElement?.insertBefore(emojiNode, toReplace);
      toReplace.textContent = toReplace.wholeText.substring(code.text.length);
    }
  });
};
