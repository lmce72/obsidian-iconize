import { logger } from '@app/lib/logger';
import {
  Editor,
  MarkdownView,
  Notice,
  TFile,
  normalizePath,
  sanitizeHTMLToDom,
} from 'obsidian';
import type IconizePlugin from '@app/main';
import icon from './icon';
import { findIconTags, replaceIconTags, IconTag } from './icon-tags';

/** 共用解析与转换管道，手动和自动入口保持一致。 / Shared pipeline for manual and automatic conversion. */
export class IconConversion {
  private timers = new Map<Editor, number>();
  private stopped = false;
  private batchRunning = false;

  constructor(private plugin: IconizePlugin) {}

  async getSvg(id: string, color?: string): Promise<string | undefined> {
    const found =
      icon.getIconByName(this.plugin, id) ??
      (await this.plugin.iconResolver?.resolve(id, { persist: false }));
    if (!found?.svgElement) return undefined;
    // 使用 Obsidian 清理器，拒绝脚本、外链和非 SVG 内容。 / Sanitize markup and remove active/external content.
    const fragment = sanitizeHTMLToDom(found.svgElement);
    const root = fragment.querySelector('svg');
    if (!root) return undefined;
    root
      .querySelectorAll(
        'script, foreignObject, image, use, a, style, animate, animateTransform, set',
      )
      .forEach((el) => el.remove());
    for (const el of [root, ...Array.from(root.querySelectorAll('*'))]) {
      for (const attr of Array.from(el.attributes)) {
        if (
          /^on|href$|^style$/i.test(attr.name) ||
          /url\s*\(/i.test(attr.value)
        )
          el.removeAttribute(attr.name);
      }
      if (color) {
        for (const paint of ['fill', 'stroke']) {
          if (el.hasAttribute(paint) && el.getAttribute(paint) !== 'none')
            el.setAttribute(paint, color);
        }
      }
    }
    root.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    root.setAttribute('width', '1em');
    root.setAttribute('height', '1em');
    root.setAttribute('aria-label', id);
    return root.outerHTML;
  }

  async replacements(
    text: string,
    asSvg: boolean,
    only?: IconTag,
    color?: string,
  ): Promise<{ tags: IconTag[]; values: Map<string, string> }> {
    const tags = only
      ? [only]
      : findIconTags(text, this.plugin.getSettings().iconIdentifier);
    const values = new Map<string, string>();
    for (const id of new Set(tags.map((tag) => tag.id))) {
      if (this.stopped) break;
      const markup = await this.getSvg(id, color);
      if (!markup) continue;
      if (asSvg || this.plugin.getSettings().iconEmbedFormat === 'svg') {
        values.set(id, markup);
      } else if (this.plugin.getSettings().iconEmbedFormat !== 'file') {
        // 自包含图片无需插件或附件，部分平台会限制 data URI。 / Self-contained image; some platforms restrict data URIs.
        const bytes = new TextEncoder().encode(
          markup.replace(/currentColor/g, '#808080'),
        );
        let binary = '';
        for (const byte of bytes) binary += String.fromCharCode(byte);
        values.set(
          id,
          `![${id}](data:image/svg+xml;base64,${window.btoa(binary)})`,
        );
      } else {
        // 文件名来自规范 id；已有资源相同则复用，内容变化时另存，绝不覆盖用户文件。
        // Reuse identical assets; version changed content without overwriting user files.
        const folder = 'Iconize SVG';
        if (!this.plugin.app.vault.getAbstractFileByPath(folder))
          await this.plugin.app.vault.createFolder(folder);
        let version = 0;
        let path: string;
        const portable = markup.replace(/currentColor/g, '#808080');
        while (true) {
          path = normalizePath(
            `${folder}/${id}${version ? `-${version}` : ''}.svg`,
          );
          const existing = this.plugin.app.vault.getAbstractFileByPath(path);
          if (!existing) {
            await this.plugin.app.vault.create(path, portable);
            break;
          }
          if (
            existing instanceof TFile &&
            (await this.plugin.app.vault.read(existing)) === portable
          )
            break;
          version++;
        }
        values.set(id, `![${id}](<${path}>)`);
      }
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
    }
    return { tags, values };
  }

  async convertEditor(
    editor: Editor,
    only?: IconTag,
    quiet = false,
  ): Promise<number | null> {
    const source = editor.getValue();
    if (
      only &&
      !findIconTags(source, this.plugin.getSettings().iconIdentifier).some(
        (tag) =>
          tag.from === only.from && tag.to === only.to && tag.id === only.id,
      )
    ) {
      if (!quiet) new Notice('Iconize：目标标签已变化，请重新打开菜单。');
      return null;
    }
    const view = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
    const path = view?.editor === editor ? view.file?.path : undefined;
    try {
      const { tags, values } = await this.replacements(source, false, only);
      if (
        this.stopped ||
        editor.getValue() !== source ||
        (path !== undefined &&
          (view.file?.path !== path || view.editor !== editor))
      ) {
        if (!quiet) new Notice('Iconize：文档已变化，请重试转换。');
        return null;
      }
      const changes = tags
        .filter((tag) => values.has(tag.id))
        .map((tag) => ({
          from: editor.offsetToPos(tag.from),
          to: editor.offsetToPos(tag.to),
          text: values.get(tag.id)!,
        }));
      if (changes.length) editor.transaction({ changes });
      if (!quiet)
        new Notice(
          `Iconize：已转换 ${changes.length} 个图标，${tags.length - changes.length} 个未找到。`,
        );
      return changes.length;
    } catch (error) {
      logger.error('[Iconize] Icon conversion failed:', undefined, error);
      new Notice(
        'Iconize：转换失败，原标签已保留。请检查图标包和资源目录权限。',
      );
      return null;
    }
  }

  schedule(editor: Editor): void {
    const previous = this.timers.get(editor);
    if (previous !== undefined) window.clearTimeout(previous);
    this.timers.delete(editor);
    if (this.stopped || !this.plugin.getSettings().autoConvertIcons) return;
    const seconds = this.plugin.getSettings().autoConvertDelay;
    const timer = window.setTimeout(
      () => {
        this.timers.delete(editor);
        const view =
          this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
        if (
          view?.editor === editor &&
          !view.contentEl.querySelector('.cm-editor.cm-composing')
        )
          void this.convertEditor(editor, undefined, true);
      },
      (Number.isFinite(seconds) ? Math.max(1, seconds) : 10) * 1000,
    );
    this.timers.set(editor, timer);
  }

  cancelPending(): void {
    for (const timer of this.timers.values()) window.clearTimeout(timer);
    this.timers.clear();
  }

  dispose(): void {
    this.stopped = true;
    this.cancelPending();
  }

  async convertVault(): Promise<void> {
    if (this.batchRunning) return;
    this.batchRunning = true;
    let changed = 0;
    let failures = 0;
    let unresolved = 0;
    const progress = new Notice('Iconize：正在转换文档…', 0);
    try {
      for (const file of this.plugin.app.vault.getMarkdownFiles()) {
        if (this.stopped) break;
        try {
          const source = await this.plugin.app.vault.read(file);
          const { tags, values } = await this.replacements(source, false);
          unresolved += tags.filter((tag) => !values.has(tag.id)).length;
          if (!values.size) continue;
          // 打开的文档走 Editor，后台文档用原子 process 防止覆盖同时编辑。 / Editor for open notes, guarded process for background notes.
          let openEditor: Editor | undefined;
          this.plugin.app.workspace.iterateAllLeaves((leaf) => {
            if (
              leaf.view instanceof MarkdownView &&
              leaf.view.file?.path === file.path
            )
              openEditor = leaf.view.editor;
          });
          if (openEditor) {
            const count = await this.convertEditor(openEditor, undefined, true);
            if (count === null) {
              failures++;
              continue;
            }
            if (count === 0) continue;
          } else {
            await this.plugin.app.vault.process(file, (current) => {
              if (this.stopped || current !== source)
                throw new Error('Document changed during conversion');
              return replaceIconTags(current, tags, values);
            });
          }
          changed++;
        } catch (error) {
          failures++;
          logger.error(
            '[Iconize] Document conversion failed:',
            undefined,
            error,
          );
        }
        progress.setMessage(`Iconize：已处理 ${changed} 篇文档…`);
        await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      }
    } finally {
      this.batchRunning = false;
      progress.hide();
      new Notice(
        `Iconize：已处理 ${changed} 篇文档，失败 ${failures} 篇，未找到 ${unresolved} 个图标标签。`,
      );
    }
  }
}
