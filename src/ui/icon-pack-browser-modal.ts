import { App, FuzzyMatch, FuzzySuggestModal, Notice } from 'obsidian';
import predefinedIconPacks, { PredefinedIconPack } from '@app/icon-packs';
import IconizePlugin from '@app/main';
import { downloadZipFile } from '@app/zip-util';
import { IconPack } from '@app/icon-pack-manager/icon-pack';
import { logger } from '@app/lib/logger';

export default class IconPackBrowserModal extends FuzzySuggestModal<PredefinedIconPack> {
  private plugin: IconizePlugin;

  constructor(app: App, plugin: IconizePlugin) {
    super(app);
    this.plugin = plugin;

    this.resultContainerEl.classList.add('iconize-browse-modal');
    this.inputEl.placeholder = 'Select to download icon pack';
  }

  // eslint-disable-next-line
  onAddedIconPack(): void {}

  onOpen(): void {
    super.onOpen();
  }

  onClose(): void {
    this.contentEl.empty();
  }

  getItemText(item: PredefinedIconPack): string {
    // TODO: refactor this
    const tempIconPack = new IconPack(this.plugin, item.name, false);
    return `${item.displayName} (${tempIconPack.getPrefix()})`;
  }

  getItems(): PredefinedIconPack[] {
    const iconPacks = Object.values(predefinedIconPacks);
    const allIconPacks = this.plugin.getIconPackManager().getIconPacks();

    return iconPacks.filter(
      (iconPack) =>
        allIconPacks.find((ip) => iconPack.name === ip.getName()) === undefined,
    );
  }

  onChooseItem(
    item: PredefinedIconPack,
    _event: MouseEvent | KeyboardEvent,
  ): void {
    void this.importPack(item);
  }

  private async importPack(item: PredefinedIconPack): Promise<void> {
    new Notice(`Adding ${item.displayName}...`);
    try {
      const arrayBuffer = await downloadZipFile(item.downloadLink);
      // 统一由管理器暂存、校验与提交，不能在验证前先覆盖目标 ZIP。
      // The manager stages, validates and commits; never overwrite the destination first.
      await this.plugin
        .getIconPackManager()
        .registerIconPack(item.name, arrayBuffer);
      new Notice(`${item.displayName} added`);
      this.onAddedIconPack();
    } catch (error) {
      logger.error('Could not import the selected icon pack', undefined, error);
      new Notice(
        `Could not add ${item.displayName}. ${error instanceof Error ? error.message : 'Please try again.'}`,
      );
    }
  }

  renderSuggestion(
    item: FuzzyMatch<PredefinedIconPack>,
    el: HTMLElement,
  ): void {
    super.renderSuggestion(item, el);

    const children = Array.from(el.childNodes);
    el.createDiv().append(...children);
  }
}
