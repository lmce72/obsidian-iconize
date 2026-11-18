import { getIcon, getIconIds } from 'obsidian';
import IconizePlugin from '@app/main';
import { IconPackManager } from '.';
import { getNormalizedName } from './util';
import { IconPack } from './icon-pack';
import { downloadZipFile } from '@app/zip-util';
import predefinedIconPacks from '@app/icon-packs';

export const LUCIDE_ICON_PACK_NAME = 'lucide-icons';

export class LucideIconPack {
  private iconPack: IconPack;

  constructor(
    private plugin: IconizePlugin,
    private iconPackManager: IconPackManager,
  ) {}

  public init(iconPack?: IconPack): IconPack {
    // Do not initialize Lucide icon pack when setting is `None`.
    if (
      !this.plugin.doesUseCustomLucideIconPack() &&
      !this.plugin.doesUseNativeLucideIconPack()
    ) {
      return;
    }

    this.iconPack =
      iconPack ?? new IconPack(this.plugin, LUCIDE_ICON_PACK_NAME, false);
    const icons = this.plugin.doesUseNativeLucideIconPack()
      ? getIconIds()
          .map((iconId) => iconId.replace(/^lucide-/, ''))
          .map((iconId) => {
            const iconEl = getIcon(iconId);
            iconEl.removeClass('svg-icon'); // Removes native `svg-icon` class.
            return {
              name: getNormalizedName(iconId),
              filename: iconId,
              prefix: 'Li',
              displayName: iconId,
              svgElement: iconEl?.outerHTML,
              svgContent: iconEl?.innerHTML,
              svgViewbox: '',
              iconPackName: LUCIDE_ICON_PACK_NAME,
            };
          })
      : [];
    this.iconPack.setIcons(icons);
    return this.iconPack;
  }

  public async addCustom(): Promise<void> {
    const arrayBuffer = await downloadZipFile(
      predefinedIconPacks['lucide'].downloadLink,
    );
    // 下载或校验失败时保留原包；替换事务由管理器统一负责。
    // Keep the old pack when downloading or validation fails; the manager owns replacement.
    await this.iconPackManager.registerIconPack(
      LUCIDE_ICON_PACK_NAME,
      arrayBuffer,
    );
    this.iconPack = this.iconPackManager.getIconPackByName(
      LUCIDE_ICON_PACK_NAME,
    );
  }

  public async removeCustom(): Promise<void> {
    await this.iconPackManager.removeIconPack(this.iconPack);
  }
}
