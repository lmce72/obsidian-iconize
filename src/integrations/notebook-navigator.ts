import {
  Component,
  MenuItem,
  TAbstractFile,
  TFile,
  TFolder,
  sanitizeHTMLToDom,
} from 'obsidian';
import type IconizePlugin from '@app/main';
import emoji from '@app/emoji';
import customRule from '@app/lib/custom-rule';
import {
  getFolderNoteInheritedIcon,
  getFolderNoteParent,
} from '@app/lib/folder-note';
import { logger } from '@app/lib/logger';

type AddMenuItem = (configure: (item: MenuItem) => void) => void;

/** 只声明使用的公开契约；不依赖 Navigator 私有控制器。 / Minimal public API contract, without private controllers. */
interface NavigatorApi {
  menus: {
    registerFileMenu(
      callback: (context: { addItem: AddMenuItem; file: TFile }) => void,
    ): () => void;
    registerFolderMenu(
      callback: (context: { addItem: AddMenuItem; folder: TFolder }) => void,
    ): () => void;
  };
}

interface Appearance {
  id: string;
  color?: string;
}
interface RowIcon {
  path: string;
  key: string;
  element?: HTMLElement;
  host?: HTMLElement;
  pending: boolean;
  retryAfterPending?: boolean;
}
interface NavigatorRoot {
  element: HTMLElement;
  observer: MutationObserver;
  win: Window;
  frame: number | null;
  rows: Map<HTMLElement, RowIcon>;
}

const ROW_SELECTOR =
  '[data-drag-type="file"][data-drag-path], [data-drag-type="folder"][data-drag-path]';
const OWN_ICON = 'iconize-navigator-icon';

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function navigatorApi(value: unknown): NavigatorApi | undefined {
  if (!record(value) || !record(value.api) || !record(value.api.menus)) return;
  const menus = value.api.menus;
  if (
    typeof menus.registerFileMenu === 'function' &&
    typeof menus.registerFolderMenu === 'function'
  )
    return value.api as unknown as NavigatorApi;
}

/** 官方菜单扩展 + 可撤销的可见行图标层。 / Public menu hooks and reversible visible-row decoration. */
export default class NotebookNavigatorIntegration extends Component {
  private api?: NavigatorApi;
  private menuDisposers: Array<() => void> = [];
  private roots = new Map<HTMLElement, NavigatorRoot>();
  private pendingSvg = new Map<string, Promise<string | undefined>>();
  private closed = false;

  constructor(private plugin: IconizePlugin) {
    super();
  }

  onload(): void {
    this.registerEvent(
      this.plugin.app.workspace.on('layout-change', () => this.sync()),
    );
    this.registerEvent(
      this.plugin.app.workspace.on('active-leaf-change', () => this.sync()),
    );
    this.registerEvent(
      this.plugin.app.metadataCache.on('changed', () => this.refresh()),
    );
    this.registerEvent(
      this.plugin.app.vault.on('rename', () => this.refresh()),
    );
    this.registerEvent(
      this.plugin.app.vault.on('delete', () => this.refresh()),
    );
    // 仅检查插件 API 身份，兼容任意启用顺序与热重载；不定时扫描图标或文档。
    // Poll only API identity for load order/hot reload, never the icon library or vault.
    this.registerInterval(window.setInterval(() => this.sync(), 2000));
    const loaded = () => this.refresh();
    this.plugin.getEventEmitter().on('allIconsLoaded', loaded);
    this.register(() =>
      this.plugin.getEventEmitter().off('allIconsLoaded', loaded),
    );
    this.plugin.app.workspace.onLayoutReady(() => this.sync());
    this.sync();
  }

  refresh(): void {
    if (this.closed) return;
    this.sync();
    for (const root of this.roots.values()) {
      for (const [row, state] of root.rows) {
        if (!state.element && state.pending) state.retryAfterPending = true;
        else if (!state.element) root.rows.delete(row);
      }
      this.schedule(root);
    }
  }

  private sync(): void {
    if (this.closed) return;
    const installed: unknown = (
      this.plugin.app.plugins.plugins as Record<string, unknown>
    )['notebook-navigator'];
    const next = this.plugin.getSettings().notebookNavigatorEnabled
      ? navigatorApi(installed)
      : undefined;
    if (next !== this.api) {
      this.detach();
      this.api = next;
      if (next) {
        try {
          this.menuDisposers.push(
            next.menus.registerFileMenu(({ addItem, file }) =>
              this.addMenu(addItem, file),
            ),
          );
          this.menuDisposers.push(
            next.menus.registerFolderMenu(({ addItem, folder }) =>
              this.addMenu(addItem, folder),
            ),
          );
        } catch (error) {
          this.detach();
          logger.error(
            '[Iconize] Notebook Navigator menu registration failed:',
            undefined,
            error,
          );
          return;
        }
      }
    }
    if (!this.api) return;
    const current = new Set<HTMLElement>();
    this.plugin.app.workspace.iterateAllLeaves((leaf) => {
      if (leaf.view.getViewType() !== 'notebook-navigator') return;
      const element = leaf.view.containerEl;
      current.add(element);
      if (!this.roots.has(element)) this.attachRoot(element);
    });
    for (const [element, root] of this.roots) {
      if (!current.has(element)) {
        this.detachRoot(root);
        this.roots.delete(element);
      }
    }
  }

  private addMenu(addItem: AddMenuItem, file: TAbstractFile): void {
    // 当前点击项始终是明确目标，即使 Navigator 中同时选择了多篇笔记。
    // The clicked item remains the explicit target even during multi-selection.
    this.plugin.addIconizeMenuItems(addItem, file);
  }

  private attachRoot(element: HTMLElement): void {
    const win = element.ownerDocument.defaultView;
    if (!win) return;
    const observer = new win.MutationObserver((changes) => {
      // 忽略自身新增内容，避免观察器反复触发重绘。 / Ignore owned mutations to avoid redraw loops.
      const relevant = changes.some((change) => {
        const target =
          change.target.nodeType === 1
            ? (change.target as Element)
            : change.target.parentElement;
        if (target?.closest(`.${OWN_ICON}`)) return false;
        if (change.type === 'attributes') {
          if (change.attributeName !== 'class') return true;
          const before = (change.oldValue ?? '')
            .split(/\s+/)
            .filter((name) => name !== 'iconize-navigator-host')
            .join(' ');
          const after = Array.from(target?.classList ?? [])
            .filter((name) => name !== 'iconize-navigator-host')
            .join(' ');
          return (
            before !== after ||
            (!!target?.querySelector(`:scope > .${OWN_ICON}`) &&
              !target.classList.contains('iconize-navigator-host'))
          );
        }
        const nodes = [
          ...Array.from(change.addedNodes),
          ...Array.from(change.removedNodes),
        ];
        return nodes.some(
          (node) =>
            node.nodeType !== 1 ||
            !(node as Element).classList.contains(OWN_ICON),
        );
      });
      const root = this.roots.get(element);
      if (relevant && root) this.schedule(root);
    });
    const root: NavigatorRoot = {
      element,
      observer,
      win,
      frame: null,
      rows: new Map(),
    };
    this.roots.set(element, root);
    observer.observe(element, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeOldValue: true,
      attributeFilter: [
        'class',
        'data-path',
        'data-drag-path',
        'data-drag-type',
      ],
    });
    this.schedule(root);
  }

  private schedule(root: NavigatorRoot): void {
    if (root.frame !== null || this.closed) return;
    root.frame = root.win.requestAnimationFrame(() => {
      root.frame = null;
      if (!this.closed && this.roots.get(root.element) === root)
        this.render(root);
    });
  }

  private appearance(file: TAbstractFile): Appearance | undefined {
    const path = file.path;
    const settings = this.plugin.getSettings();
    const own =
      this.plugin.getFrontmatterIcon(path) ?? this.plugin.getData()[path];
    const direct =
      typeof own === 'string'
        ? own
        : record(own) && typeof own.iconName === 'string'
          ? own.iconName
          : undefined;
    let id = direct;
    let color = this.plugin.getIconColor(path);
    if (!id) {
      const rule = settings.rules
        .slice()
        .sort((a, b) => a.order - b.order)
        .find(
          (rule) =>
            customRule.doesMatchFileType(
              rule,
              file instanceof TFolder ? 'folder' : 'file',
            ) && customRule.doesMatchPath(rule, path),
        );
      id = rule?.icon;
      color ??= rule?.color;
    }
    if (!id) {
      id = getFolderNoteInheritedIcon(this.plugin, path);
      const parent = getFolderNoteParent(this.plugin, path);
      if (parent) color ??= this.plugin.getIconColor(parent);
    }
    return id
      ? { id, color: color ?? settings.iconColor ?? undefined }
      : undefined;
  }

  private render(root: NavigatorRoot): void {
    // Navigator 自带虚拟列表；只处理已挂载行，不遍历全 Vault 或全部图标。
    // Navigator virtualizes rows; process mounted rows only, not the vault/icon library.
    const visible = new Set(
      Array.from(root.element.querySelectorAll<HTMLElement>(ROW_SELECTOR)),
    );
    for (const [row, state] of root.rows) {
      if (!visible.has(row)) {
        this.clearRow(state);
        root.rows.delete(row);
      }
    }
    for (const row of visible) {
      const path = row.getAttribute('data-drag-path');
      const file = path
        ? this.plugin.app.vault.getAbstractFileByPath(path)
        : null;
      const appearance =
        file instanceof TFile || file instanceof TFolder
          ? this.appearance(file)
          : undefined;
      const previous = root.rows.get(row);
      if (!appearance) {
        if (previous) {
          this.clearRow(previous);
          root.rows.delete(row);
        }
        continue;
      }
      const key = JSON.stringify([path, appearance.id, appearance.color]);
      if (previous?.key === key) {
        const native = row.querySelector<HTMLElement>(
          '.nn-file-icon, .nn-navitem-icon',
        );
        if (
          previous.element &&
          (!row.contains(previous.element) ||
            native !== (previous.host ?? null) ||
            (native && !native.hasClass('iconize-navigator-host')))
        )
          this.mount(row, previous);
        continue;
      }
      if (previous) this.clearRow(previous);
      const state: RowIcon = { path, key, pending: true };
      root.rows.set(row, state);
      void this.resolveRow(root, row, state, appearance);
    }
  }

  private async resolveRow(
    root: NavigatorRoot,
    row: HTMLElement,
    state: RowIcon,
    appearance: Appearance,
  ): Promise<void> {
    try {
      const isEmoji = emoji.isEmoji(appearance.id);
      let markup: string | undefined;
      if (!isEmoji) {
        const key = JSON.stringify([appearance.id, appearance.color]);
        let pending = this.pendingSvg.get(key);
        if (!pending) {
          pending = this.plugin.conversion
            .getSvg(appearance.id, appearance.color)
            .catch((error): string | undefined => {
              logger.error(
                '[Iconize] Notebook Navigator SVG resolution failed:',
                undefined,
                error,
              );
              return undefined;
            });
          this.pendingSvg.set(key, pending);
          void pending.then(() => {
            if (this.pendingSvg.get(key) === pending)
              this.pendingSvg.delete(key);
          });
        }
        markup = await pending;
        if (!markup) return;
      }
      // 虚拟行可能已被另一条路径复用，晚到的异步结果必须丢弃。
      // Recycled virtual rows must never receive stale asynchronous results.
      if (
        this.closed ||
        this.roots.get(root.element) !== root ||
        root.rows.get(row) !== state ||
        row.getAttribute('data-drag-path') !== state.path ||
        !row.isConnected
      )
        return;
      const currentFile = this.plugin.app.vault.getAbstractFileByPath(
        state.path,
      );
      const current = currentFile ? this.appearance(currentFile) : undefined;
      if (
        !current ||
        JSON.stringify([state.path, current.id, current.color]) !== state.key
      )
        return;
      const element = row.ownerDocument.createElement('span');
      element.className = OWN_ICON;
      element.setAttribute('aria-hidden', 'true');
      element.setAttribute('data-iconize-icon', appearance.id);
      if (appearance.color)
        element.setCssProps({ '--iconize-navigator-color': appearance.color });
      if (isEmoji) element.setText(appearance.id);
      else element.replaceChildren(sanitizeHTMLToDom(markup));
      state.element = element;
      this.mount(row, state);
    } catch (error) {
      logger.error(
        '[Iconize] Notebook Navigator icon rendering failed:',
        undefined,
        error,
      );
    } finally {
      state.pending = false;
      // 解析中收到的刷新只在失败后兑现一次，避免无结果时无限重试。
      // Honor a refresh received during resolution once, without retrying indefinitely.
      if (
        state.retryAfterPending &&
        !state.element &&
        !this.closed &&
        this.roots.get(root.element) === root &&
        root.rows.get(row) === state
      ) {
        root.rows.delete(row);
        this.schedule(root);
      }
    }
  }

  private mount(row: HTMLElement, state: RowIcon): void {
    if (!state.element) return;
    state.host?.removeClass('iconize-navigator-host');
    const native = row.querySelector<HTMLElement>(
      '.nn-file-icon, .nn-navitem-icon',
    );
    if (native) {
      native.append(state.element);
      native.addClass('iconize-navigator-host');
      state.host = native;
      state.element.removeClass('iconize-navigator-fallback');
    } else {
      const anchor = row.querySelector('.nn-file-name-label, .nn-navitem-name');
      if (!anchor) return;
      anchor.before(state.element);
      state.element.addClass('iconize-navigator-fallback');
      state.host = undefined;
    }
  }

  private clearRow(state: RowIcon): void {
    state.element?.remove();
    state.host?.removeClass('iconize-navigator-host');
  }

  private detachRoot(root: NavigatorRoot): void {
    root.observer.disconnect();
    if (root.frame !== null) root.win.cancelAnimationFrame(root.frame);
    for (const state of root.rows.values()) this.clearRow(state);
    root.rows.clear();
  }

  private detach(): void {
    for (const dispose of this.menuDisposers.splice(0)) dispose();
    for (const root of this.roots.values()) this.detachRoot(root);
    this.roots.clear();
    this.api = undefined;
  }

  onunload(): void {
    this.closed = true;
    this.detach();
    this.pendingSvg.clear();
  }
}
