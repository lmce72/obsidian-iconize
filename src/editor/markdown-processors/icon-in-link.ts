import emoji from '@app/emoji';
import svg from '@app/lib/util/svg';
import icon from '@app/lib/icon';
import { logger } from '@app/lib/logger';
import {
  calculateFontTextSize,
  calculateHeaderSize,
  HTMLHeader,
  isHeader,
} from '@app/lib/util/text';
import IconizePlugin from '@app/main';
import { MarkdownPostProcessorContext } from 'obsidian';

export const processIconInLinkMarkdown = (
  plugin: IconizePlugin,
  element: HTMLElement,
  ctx: MarkdownPostProcessorContext,
) => {
  const linkElements = element.querySelectorAll('a');
  if (!linkElements || linkElements.length === 0) {
    return;
  }

  linkElements.forEach((linkElement) => {
    // Skip if the link element e.g., is a tag.
    if (!linkElement.hasAttribute('data-href')) {
      return;
    }

    const linkHref = linkElement.getAttribute('href');
    if (!linkHref) {
      logger.warn('Link element does not have an `href` attribute');
      return;
    }

    const file = plugin.app.metadataCache.getFirstLinkpathDest(
      linkHref,
      ctx.sourcePath,
    );
    if (!file) {
      // 链接无法解析到文件是正常状态：要么指向不存在的文件（未解析链接），要么是外部地址。
      // 两种情况都没有图标可加，无需告警——此处过去会为每个未解析链接输出一条 WARN。
      //
      // A link that resolves to no file is normal: either it points at a missing file or
      // it is an external address. Neither has an icon to add, so this stays silent; it
      // used to emit a WARN for every unresolved link.
      return;
    }

    const path = file.path;
    const iconValue = icon.getIconByPath(plugin, path);
    if (!iconValue) {
      return;
    }

    let fontSize = calculateFontTextSize();
    const tagName = linkElement.parentElement?.tagName?.toLowerCase() ?? '';
    if (isHeader(tagName)) {
      fontSize = calculateHeaderSize(tagName as HTMLHeader);
    }

    const iconName =
      typeof iconValue === 'string'
        ? iconValue
        : iconValue.prefix + iconValue.name;

    const rootSpan = createSpan({
      cls: 'iconize-icon-in-link',
      attr: {
        title: iconName,
        'aria-label': iconName,
        'data-icon': iconName,
        'aria-hidden': 'true',
      },
    });
    rootSpan.style.color =
      plugin.getIconColor(path) ?? plugin.getSettings().iconColor;

    if (emoji.isEmoji(iconName)) {
      const parsedEmoji =
        emoji.parseEmoji(plugin.getSettings().emojiStyle, iconName, fontSize) ??
        iconName;
      rootSpan.style.transform = 'translateY(0)';
      rootSpan.innerHTML = parsedEmoji;
    } else {
      // `getIconByName` 在只拿到元数据（索引包尚未解析）时返回 null，这里必须容忍，
      // 否则会抛 TypeError 中断整个后处理器。
      // `getIconByName` returns null for metadata-only entries, which must be tolerated
      // or the whole post-processor throws.
      const svgEl = svg.setFontSize(
        icon.getIconByName(plugin, iconName)?.svgElement ?? '',
        fontSize,
      );
      if (svgEl) {
        rootSpan.style.transform = 'translateY(20%)';
        rootSpan.innerHTML = svgEl;
      }
    }

    linkElement.prepend(rootSpan);
  });
};
