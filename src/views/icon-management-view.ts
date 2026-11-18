import { ItemView, Modal, Notice, Setting, WorkspaceLeaf } from 'obsidian';
import IconizePlugin, { FolderIconObject } from '@app/main';
import { IconPack } from '@app/icon-pack-manager/icon-pack';
import { LUCIDE_ICON_PACK_NAME } from '@app/icon-pack-manager/lucide';
import { LucideIconPackType } from '@app/settings/data';
import IconPackBrowserModal from '@app/ui/icon-pack-browser-modal';
import { readFileSync } from '@app/util';
import icon from '@app/lib/icon';
import { logger } from '@app/lib/logger';
import { indexAndRegisterPack } from '@app/lib/lazy-loading-integration';

export const ICON_MANAGEMENT_VIEW_TYPE = 'iconize-icon-management';
const PAGE_SIZE = 50;
const packOperations = new WeakMap<IconizePlugin, Set<string>>();

/** 跨管理窗口互斥同名包的写入。 / Serialize writes to the same pack across management windows. */
function operationLocks(plugin: IconizePlugin): Set<string> {
  let locks = packOperations.get(plugin);
  if (!locks) {
    locks = new Set();
    packOperations.set(plugin, locks);
  }
  return locks;
}

/** 在当前工作区打开或显示管理视图。 / Open or reveal the management view. */
export async function openIconManagementView(
  plugin: IconizePlugin,
): Promise<void> {
  // 从设置页进入时设置是一层覆盖窗口，不关掉它，新标签页只会被压在下面。
  // Settings is a full-window overlay; without closing it the new tab opens behind it.
  (plugin.app as unknown as { setting?: { close(): void } }).setting?.close();
  const workspace = plugin.app.workspace;
  const [existing] = workspace.getLeavesOfType(ICON_MANAGEMENT_VIEW_TYPE);
  if (existing?.view instanceof IconManagementView) {
    await workspace.revealLeaf(existing);
    return;
  }
  // 插件停用期间恢复的工作区会留下只有类型名的空视图，只 reveal 永远打不开。
  // A workspace restored while the plugin was disabled keeps a stub view that still
  // reports this type; revealing it never mounts the real view, so rebuild it.
  const leaf = existing ?? workspace.getLeaf('tab');
  await leaf.setViewState({ type: ICON_MANAGEMENT_VIEW_TYPE, active: true });
  await workspace.revealLeaf(leaf);
}

class RemovePackModal extends Modal {
  private active = false;
  private removing = false;
  constructor(
    private plugin: IconizePlugin,
    private pack: IconPack,
    private isCurrent: () => boolean,
    private done: () => void,
  ) {
    super(plugin.app);
    plugin.trackModal(this);
  }
  onOpen(): void {
    this.active = true;
    this.titleEl.setText('删除图标包？');
    this.contentEl.createEl('p', {
      text: `将删除图标包 ${this.pack.getName()} 及其文件。`,
    });
    new Setting(this.contentEl)
      .addButton((button) =>
        button.setButtonText('取消').onClick(() => this.close()),
      )
      .addButton((button) =>
        button
          .setButtonText('删除')
          .setWarning()
          .onClick(() => {
            if (!this.active || !this.isCurrent() || this.removing) return;
            const manager = this.plugin.getIconPackManager();
            const name = this.pack.getName();
            if (manager.getIconPackByName(name) !== this.pack) {
              new Notice('图标包已更新，请重新选择要删除的图标包。');
              this.close();
              this.done();
              return;
            }
            const locks = operationLocks(this.plugin);
            if (locks.has(name)) {
              new Notice('图标包正在处理中，请稍后重试。');
              return;
            }
            locks.add(name);
            this.removing = true;
            button.setDisabled(true);
            this.done();
            void manager
              .removeIconPack(this.pack)
              .then(() => {
                if (this.active && this.isCurrent()) {
                  this.close();
                  new Notice('图标包已删除。');
                }
              })
              .catch((error: unknown) => {
                logger.error('Could not remove icon pack', undefined, error);
                if (this.isCurrent() && this.active) {
                  new Notice('删除图标包失败。');
                  button.setDisabled(false);
                }
              })
              .finally(() => {
                locks.delete(name);
                this.removing = false;
                if (this.isCurrent()) this.done();
              });
          }),
      );
  }
  onClose(): void {
    this.active = false;
    this.contentEl.empty();
    this.plugin.releaseModal(this);
  }
}

export class IconManagementView extends ItemView {
  private alive = false;
  private generation = 0;
  private query = '';
  private newPackName = '';
  private ready = false;
  private listEl: HTMLElement;
  private moreEl: HTMLElement;
  private visibleCount = PAGE_SIZE;
  private importingZip = false;
  private readonly onIconsLoaded = () => {
    if (this.plugin.isIconLoadingComplete()) this.renderReady();
  };

  constructor(
    leaf: WorkspaceLeaf,
    private plugin: IconizePlugin,
  ) {
    super(leaf);
  }
  getViewType(): string {
    return ICON_MANAGEMENT_VIEW_TYPE;
  }
  getDisplayText(): string {
    return '图标包管理';
  }
  getIcon(): string {
    return 'package';
  }
  private current(generation: number): boolean {
    return this.alive && generation === this.generation;
  }

  async onOpen(): Promise<void> {
    this.alive = true;
    this.generation++;
    this.ready = false;
    this.plugin.getEventEmitter().on('allIconsLoaded', this.onIconsLoaded);
    this.contentEl.empty();
    this.contentEl.createEl('p', { text: '正在加载图标包…' });
    if (this.plugin.isIconLoadingComplete()) this.renderReady();
  }

  private renderReady(): void {
    if (!this.alive || !this.plugin.isIconLoadingComplete()) return;
    if (this.ready) {
      this.refresh();
      return;
    }
    const root = this.contentEl;
    root.empty();
    if (!this.plugin.getIconPackManager() || !this.plugin.iconResolver) {
      root.createEl('p', { text: '图标包初始化失败，请查看控制台了解详情。' });
      return;
    }
    root.addClass('iconize-pack-management');
    new Setting(root).setName('图标包管理').setHeading();
    new Setting(root)
      .setName('预定义图标包')
      .setDesc('浏览并安装支持的图标包。')
      .addButton((button) =>
        button.setButtonText('浏览').onClick(() => {
          const modal = new IconPackBrowserModal(this.app, this.plugin);
          modal.onAddedIconPack = () => this.refreshAll();
          modal.open();
        }),
      );
    new Setting(root)
      .setName('导入 ZIP 图标包')
      .setDesc('选择本地 ZIP 文件，文件名将作为图标包名称。')
      .addButton((button) =>
        button.setButtonText('导入 ZIP').onClick(() => {
          if (this.importingZip) return;
          const generation = this.generation;
          const input = root.ownerDocument.createElement('input');
          input.type = 'file';
          input.accept = '.zip,application/zip';
          input.onchange = () => {
            const file = input.files?.[0];
            if (!file || !this.current(generation) || this.importingZip) return;
            this.importingZip = true;
            button.setDisabled(true);
            void this.importZip(file, generation).finally(() => {
              this.importingZip = false;
              if (this.current(generation)) button.setDisabled(false);
            });
          };
          input.click();
        }),
      );
    new Setting(root)
      .setName('创建自定义图标包')
      .addText((text) =>
        text
          .setPlaceholder('图标包名称')
          .setValue(this.newPackName)
          .onChange((value) => {
            this.newPackName = value;
          }),
      )
      .addButton((button) =>
        button.setButtonText('创建').onClick(() => {
          const normalized = this.newPackName
            .trim()
            .toLowerCase()
            .replace(/\s+/g, '-');
          if (!/^[a-z0-9][a-z0-9_-]*$/.test(normalized)) {
            new Notice('图标包名称只能包含字母、数字、连字符或下划线。');
            return;
          }
          const generation = this.generation;
          button.setDisabled(true);
          void this.createPack(normalized, generation).finally(() => {
            if (this.current(generation)) button.setDisabled(false);
          });
        }),
      );
    new Setting(root)
      .setName('Lucide 来源')
      .setDesc('选择内置、自定义或禁用；更改后需重启 Obsidian。')
      .addDropdown((dropdown) =>
        dropdown
          .addOptions({ native: '内置', custom: '自定义', none: '禁用' })
          .setValue(this.plugin.getSettings().lucideIconPackType)
          .onChange((value: LucideIconPackType) => {
            const generation = this.generation;
            dropdown.setDisabled(true);
            void this.changeLucide(value, generation).finally(() => {
              if (this.current(generation)) {
                dropdown.setValue(this.plugin.getSettings().lucideIconPackType);
                dropdown.setDisabled(false);
              }
            });
          }),
      );
    new Setting(root)
      .setName('搜索图标包')
      .setDesc('按名称、前缀、来源或图标数量筛选。')
      .addSearch((search) =>
        search
          .setPlaceholder('搜索图标包')
          .setValue(this.query)
          .onChange((value) => {
            this.query = value.trim().toLowerCase();
            this.visibleCount = PAGE_SIZE;
            this.refresh();
          }),
      );
    this.listEl = root.createDiv('iconize-pack-list');
    this.moreEl = root.createDiv('iconize-pack-more');
    this.ready = true;
    this.refresh();
  }

  async onClose(): Promise<void> {
    this.alive = false;
    this.generation++;
    this.plugin.getEventEmitter().off('allIconsLoaded', this.onIconsLoaded);
    this.contentEl.empty();
  }

  private async importZip(file: File, generation: number): Promise<void> {
    const name = file.name.slice(0, -4);
    const locks = operationLocks(this.plugin);
    if (!this.current(generation)) return;
    if (locks.has(name)) {
      new Notice('图标包正在处理中，请稍后重试。');
      return;
    }
    locks.add(name);
    this.refreshAll();
    try {
      if (!file.name.toLowerCase().endsWith('.zip')) {
        if (this.current(generation)) new Notice('请选择 ZIP 文件。');
        return;
      }
      if (!name || name === '.' || name === '..' || /[\\/]/.test(name)) {
        if (this.current(generation)) new Notice('ZIP 文件名无效。');
        return;
      }
      const bytes = await file.arrayBuffer();
      if (!this.current(generation)) return;
      await this.plugin.getIconPackManager().registerIconPack(name, bytes);
      if (!this.current(generation)) return;
      this.refreshAll();
      if (this.current(generation)) new Notice(`图标包 ${name} 已导入。`);
    } catch (error) {
      logger.error('Could not import ZIP icon pack', undefined, error);
      if (this.current(generation))
        new Notice('导入 ZIP 图标包失败，请检查文件及控制台。');
    } finally {
      locks.delete(name);
      this.refreshAll();
    }
  }

  private async createPack(name: string, generation: number): Promise<void> {
    const locks = operationLocks(this.plugin);
    if (!this.current(generation)) return;
    if (locks.has(name)) {
      new Notice('图标包正在处理中，请稍后重试。');
      return;
    }
    locks.add(name);
    this.refreshAll();
    try {
      const manager = this.plugin.getIconPackManager();
      const exists = await manager.doesIconPackExist(name);
      if (!this.current(generation)) return;
      if (exists || manager.getIconPackByName(name)) {
        if (this.current(generation)) new Notice('图标包已存在。');
        return;
      }
      await manager.createCustomIconPackDirectory(name);
      if (!this.current(generation)) return;
      this.refreshAll();
      if (this.current(generation)) new Notice('图标包已创建。');
    } catch (error) {
      logger.error('Could not create icon pack', undefined, error);
      if (this.current(generation)) new Notice('创建图标包失败。');
    } finally {
      locks.delete(name);
      this.refreshAll();
    }
  }

  /** 同步已打开的视图，不缓存窗口实例。 / Refresh open views without caching them. */
  private refreshAll(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(
      ICON_MANAGEMENT_VIEW_TYPE,
    )) {
      if (leaf.view instanceof IconManagementView) leaf.view.refresh();
    }
  }

  private refresh(): void {
    if (!this.alive || !this.listEl || !this.moreEl) return;
    const top = this.contentEl.scrollTop;
    this.listEl.empty();
    this.moreEl.empty();
    const packs = [...this.plugin.getIconPackManager().getIconPacks()].sort(
      (a, b) => a.getName().localeCompare(b.getName()),
    );
    let count = 0;
    for (const pack of packs) {
      const source =
        pack.getSource()?.type ??
        (pack.getName() === LUCIDE_ICON_PACK_NAME ? 'native' : 'folder');
      const sourceLabel =
        source === 'zip' ? 'ZIP 归档' : source === 'native' ? '内置' : '文件夹';
      const description = `${sourceLabel} · ${pack.size} 个图标`;
      if (
        !`${pack.getName()} ${pack.getPrefix()} ${source} ${description}`
          .toLowerCase()
          .includes(this.query)
      )
        continue;
      count++;
      if (count > this.visibleCount) continue;
      const row = new Setting(this.listEl)
        .setName(`${pack.getName()} (${pack.getPrefix()})`)
        .setDesc(description);
      row.settingEl.addClass('iconize-pack-row');
      const busy = operationLocks(this.plugin).has(pack.getName());
      if (pack.getName() !== LUCIDE_ICON_PACK_NAME) {
        if (pack.isCustomPack() && pack.getSource()?.type !== 'zip') {
          row.addButton((button) =>
            button
              .setDisabled(busy)
              .setButtonText('添加 SVG')
              .setTooltip(`向 ${pack.getName()} 添加 SVG 图标`)
              .onClick(() => this.selectFiles(pack)),
          );
        }
        row.addButton((button) =>
          button
            .setDisabled(busy)
            .setButtonText('删除')
            .setTooltip(`删除 ${pack.getName()}`)
            .onClick(() => {
              const generation = this.generation;
              new RemovePackModal(
                this.plugin,
                pack,
                () => this.current(generation),
                () => this.refreshAll(),
              ).open();
            }),
        );
      }
    }
    if (!count)
      this.listEl.createEl('p', {
        text: this.query ? '没有匹配的图标包。' : '尚未安装图标包。',
      });
    if (count > this.visibleCount) {
      new Setting(this.moreEl)
        .setName(`已显示 ${this.visibleCount} / ${count} 个图标包`)
        .addButton((button) =>
          button.setButtonText('加载更多').onClick(() => {
            this.visibleCount += PAGE_SIZE;
            this.refresh();
          }),
        );
    }
    this.contentEl.scrollTop = top;
  }

  private selectFiles(pack: IconPack): void {
    const generation = this.generation;
    const input = this.contentEl.ownerDocument.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.accept = '.svg,image/svg+xml';
    input.onchange = () => {
      if (this.current(generation) && input.files)
        void this.importFiles(pack, Array.from(input.files), generation);
    };
    input.click();
  }

  private async importFiles(
    pack: IconPack,
    files: File[],
    generation: number,
  ): Promise<void> {
    const manager = this.plugin.getIconPackManager();
    const name = pack.getName();
    const current = () =>
      this.current(generation) && manager.getIconPackByName(name) === pack;
    if (!current()) return;
    const locks = operationLocks(this.plugin);
    if (locks.has(name)) {
      new Notice('图标包正在处理中，请稍后重试。');
      return;
    }
    locks.add(name);
    this.refreshAll();
    try {
      for (const file of files) {
        if (!current()) return;
        if (!file.name.toLowerCase().endsWith('.svg')) continue;
        const content = await readFileSync(file);
        if (!current()) return;
        await manager
          .getFileManager()
          .createFile(pack.getName(), manager.getPath(), file.name, content);
        if (!current()) return;
      }
      if (!current()) return;
      pack.getSource()?.dispose();
      await indexAndRegisterPack(this.plugin, pack);
      if (!current()) return;
      this.refreshAll();
      if (this.current(generation)) new Notice('图标已添加。');
    } catch (error) {
      logger.error('Could not import icons', undefined, error);
      if (this.current(generation)) new Notice('导入图标失败。');
    } finally {
      locks.delete(name);
      this.refreshAll();
    }
  }

  private async changeLucide(
    value: LucideIconPackType,
    generation: number,
  ): Promise<void> {
    const settings = this.plugin.getSettings();
    const previous = settings.lucideIconPackType;
    if (previous === value || !this.current(generation)) return;
    const locks = operationLocks(this.plugin);
    if (locks.has(LUCIDE_ICON_PACK_NAME)) {
      new Notice('Lucide 图标包正在处理中，请稍后重试。');
      return;
    }
    locks.add(LUCIDE_ICON_PACK_NAME);
    let committed = false;
    const manager = this.plugin.getIconPackManager();
    const previousPack = manager.getIconPackByName(LUCIDE_ICON_PACK_NAME);
    const adapter = this.app.vault.adapter;
    const backups: { path: string; backup: string; folder: boolean }[] = [];
    try {
      // 保留旧资源直到设置提交，失败时可原样恢复，不依赖再次下载。
      // Retain original resources until settings commit, so rollback never needs a download.
      for (const [suffix, folder] of [
        ['', true],
        ['.zip', false],
      ] as const) {
        const path = `${manager.getPath()}/${LUCIDE_ICON_PACK_NAME}${suffix}`;
        if (await adapter.exists(path)) {
          if (!this.current(generation))
            throw new Error('Lucide update cancelled');
          const backup = `${path}.iconize-backup-${Date.now()}-${Math.random().toString(36).slice(2)}`;
          await adapter.rename(path, backup);
          backups.push({ path, backup, folder });
        }
      }
      if (!this.current(generation)) throw new Error('Lucide update cancelled');
      settings.lucideIconPackType = value;
      const lucide = manager.getLucideIconPack();
      if (previousPack) await manager.removeIconPack(previousPack);
      if (!this.current(generation)) throw new Error('Lucide update cancelled');
      if (value === 'custom') {
        await lucide.addCustom();
        if (!this.current(generation))
          throw new Error('Lucide update cancelled');
        const entries = Object.entries(this.plugin.getData()).filter(
          (entry): entry is [string, string | FolderIconObject] =>
            typeof entry[1] === 'string' ||
            (typeof entry[1] === 'object' &&
              entry[1] !== null &&
              'iconName' in entry[1]),
        );
        await icon.checkMissingIcons(this.plugin, entries);
      } else {
        const native = lucide.init();
        if (native) manager.getIconPacks().push(native);
      }
      if (!this.current(generation)) throw new Error('Lucide update cancelled');
      await this.plugin.saveIconFolderData();
      committed = true;
      this.refreshAll();
      if (this.current(generation)) new Notice('请重启 Obsidian 以完成更改。');
    } catch (error) {
      settings.lucideIconPackType = previous;
      try {
        const installed = manager.getIconPackByName(LUCIDE_ICON_PACK_NAME);
        if (installed && installed !== previousPack)
          await manager.removeIconPack(installed);
        for (const { path, backup } of backups)
          await adapter.rename(backup, path);
        backups.length = 0;
        if (previousPack && !manager.getIconPackByName(LUCIDE_ICON_PACK_NAME))
          manager.getIconPacks().push(previousPack);
        if (previousPack?.getSource() && this.current(generation))
          await indexAndRegisterPack(this.plugin, previousPack);
      } catch (rollbackError) {
        logger.error(
          'Could not restore Lucide resources; backups retained',
          undefined,
          rollbackError,
        );
      }
      logger.error('Could not change Lucide pack', undefined, error);
      if (this.current(generation)) new Notice('更改 Lucide 图标包失败。');
    } finally {
      if (!committed) settings.lucideIconPackType = previous;
      if (committed)
        for (const { backup, folder } of backups) {
          try {
            if (folder) await adapter.rmdir(backup, true);
            else await adapter.remove(backup);
          } catch (error) {
            logger.error('Could not clean up Lucide backup', undefined, error);
          }
        }
      locks.delete(LUCIDE_ICON_PACK_NAME);
      this.refreshAll();
    }
  }
}
