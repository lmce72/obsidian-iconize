import { logger } from '@app/lib/logger';
import { IconPack } from './icon-pack';
import svg from '@app/lib/util/svg';
import { Icon } from '.';
import IconizePlugin from '@app/main';

export function getNormalizedName(s: string): string {
  return s
    .split(/[ -]|[ _]/g)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');
}

export function nextIdentifier(iconName: string): number {
  return iconName.substring(1).search(/[(A-Z)|(0-9)]/) + 1;
}

export function getSvgFromLoadedIcon(
  plugin: IconizePlugin,
  iconPrefix: string,
  iconName: string,
): string {
  // 1) 内存层优先：按需加载已解析的图标在这里命中，渲染路径靠它保持同步。
  // Memory first: icons the lazy layer has resolved are found here, which is what keeps
  // the render path synchronous.
  const resolved = plugin.iconResolver?.peek(iconPrefix + iconName);
  if (resolved) {
    return resolved.svgElement;
  }

  // 2) 直接按前缀定位图标包，只查它一个。此前会遍历所有包并对每个包调用 `getIcons()`，
  //    而索引包会为此构建整份图标列表（数千条元数据），每次都发生，代价过高。
  //
  // 3) 索引包只提供元数据（`svgElement` 为空），返回空串表示应由调用方按需解析。
  //
  // Look the pack up by prefix and query only that one. Previously every pack was walked
  // and `getIcons()` called on each, which materializes thousands of metadata objects per
  // lookup for index-backed packs. An empty result means the caller should resolve.
  const pack = plugin.getIconPackManager().getIconPackByPrefix(iconPrefix);
  return pack?.getIcon(iconName)?.svgElement ?? '';
}

const validIconName = /^[(A-Z)|(0-9)]/;
const svgViewboxRegex = /viewBox="([^"]*)"/g;
const svgContentRegex = /<svg.*>(.*?)<\/svg>/g;
export function generateIcon(
  iconPack: IconPack,
  iconName: string,
  content: string,
): Icon | null {
  if (content.length === 0) {
    return;
  }

  content = content.replace(/(\r\n|\n|\r)/gm, '');
  content = content.replace(/>\s+</gm, '><');
  const normalizedName =
    iconName.charAt(0).toUpperCase() + iconName.substring(1);

  if (!validIconName.exec(normalizedName)) {
    logger.info(`Skipping icon with invalid name: ${iconName}`);
    return null;
  }

  const svgViewboxMatch = content.match(svgViewboxRegex);
  let svgViewbox = '';
  if (svgViewboxMatch && svgViewboxMatch.length !== 0) {
    svgViewbox = svgViewboxMatch[0];
  }

  const svgContentMatch = content.match(svgContentRegex);
  if (!svgContentMatch) {
    logger.info(`Skipping icon with invalid svg content: ${iconName}`);
    return null;
  }

  const svgContent = svgContentMatch.map((val) =>
    val.replace(/<\/?svg>/g, '').replace(/<svg.+?>/g, ''),
  )[0];

  const icon: Icon = {
    name: normalizedName.split('.svg')[0],
    prefix: iconPack.getPrefix(),
    iconPackName: iconPack.getName(),
    displayName: iconName,
    filename: iconName,
    svgContent,
    svgViewbox,
    svgElement: svg.extract(content),
  };

  return icon;
}
