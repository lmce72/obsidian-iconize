/** 有界批处理只填充等待节点，不再重绘所有笔记。 / Bounded loading fills waiting nodes in place. */
import type IconizePlugin from '@app/main';
import { MarkdownView, sanitizeHTMLToDom } from 'obsidian';
import { logger } from './logger';
import { yieldToMain } from './task-scheduler';
import svg from './util/svg';

interface RenderOptions {
  fontSize?: number;
}

const BATCH_LIMIT = 64;
const CONCURRENCY = 2;
const SLICE_MS = 4;
const FAILED_LIMIT = 512;

export class InlineIconLoader {
  private readonly pending = new Set<string>();
  private readonly failed = new Set<string>();
  private readonly pendingElements = new Map<
    string,
    Map<HTMLElement, RenderOptions>
  >();
  private readonly pendingViews = new Map<string, Set<MarkdownView>>();
  private timer: number | null = null;
  private inFlight = false;
  private generation = 0;
  private disposed = false;

  constructor(private readonly plugin: IconizePlugin) {}

  fillElement(
    element: HTMLElement,
    iconId: string,
    options: RenderOptions = {},
  ): void {
    const resolver = this.plugin.iconResolver;
    if (this.disposed || !resolver || !iconId) return;
    const located = resolver.find(iconId);
    if (!located) return;
    const key = located.entry.id;
    const cached = resolver.peek(key);
    if (cached) {
      this.renderInto(element, cached.svgElement, options.fontSize);
      return;
    }
    if (this.failed.has(key)) return;
    let elements = this.pendingElements.get(key);
    if (!elements) {
      elements = new Map();
      this.pendingElements.set(key, elements);
    }
    elements.set(element, options);
    this.pending.add(key);
    this.schedule();
  }

  /** CodeMirror 销毁装饰时即可解除引用，不必等待慢盘。 / Release detached widgets before slow I/O finishes. */
  releaseElement(element: HTMLElement, iconId: string): void {
    const key = this.plugin.iconResolver?.find(iconId)?.entry.id ?? iconId;
    const elements = this.pendingElements.get(key);
    elements?.delete(element);
    if (elements?.size === 0) {
      this.pendingElements.delete(key);
      if (!this.pendingViews.has(key)) this.pending.delete(key);
    }
  }

  private renderInto(
    element: HTMLElement,
    markup: string,
    fontSize?: number,
  ): void {
    // 先清理 SVG 再用节点替换，避免 innerHTML 和跨窗口节点问题。
    // Sanitize first, then replace owned children without innerHTML.
    const fragment = sanitizeHTMLToDom(
      fontSize ? svg.setFontSize(markup, fontSize) : markup,
    );
    if (!fontSize) {
      const image = fragment.querySelector('svg');
      image?.setAttribute('width', '1em');
      image?.setAttribute('height', '1em');
    }
    element.replaceChildren(fragment);
  }

  private async flushPendingElements(
    iconId: string,
    markup: string,
    generation: number,
  ): Promise<void> {
    const elements = this.pendingElements.get(iconId);
    if (!elements) return;
    let deadline = performance.now() + SLICE_MS;
    for (const [element, options] of elements) {
      if (this.disposed || generation !== this.generation) return;
      // 保留登记直至处理该节点，使 yield 期间的释放仍能取消它。
      // Keep the registry live across yields so release can cancel unprocessed nodes.
      elements.delete(element);
      if (element.isConnected)
        this.renderInto(element, markup, options.fontSize);
      if (performance.now() >= deadline) {
        await yieldToMain('user-visible');
        deadline = performance.now() + SLICE_MS;
      }
    }
    if (this.pendingElements.get(iconId) === elements && elements.size === 0)
      this.pendingElements.delete(iconId);
  }

  /** 旧调用方可指定等待的视图；默认仅活动 Markdown 编辑器。 / Legacy callers refresh only their waiting editor. */
  requestIcon(iconId: string, waitingView?: MarkdownView): void {
    const resolver = this.plugin.iconResolver;
    if (this.disposed || !resolver || !iconId) return;
    const located = resolver.find(iconId);
    if (!located) return;
    const key = located.entry.id;
    if (this.failed.has(key) || resolver.peek(key)) return;
    const view =
      waitingView ??
      this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
    if (view) {
      let views = this.pendingViews.get(key);
      if (!views) {
        views = new Set();
        this.pendingViews.set(key, views);
      }
      views.add(view);
    }
    this.pending.add(key);
    this.schedule();
  }

  private schedule(): void {
    if (
      this.disposed ||
      this.timer !== null ||
      this.inFlight ||
      !this.pending.size
    )
      return;
    const generation = this.generation;
    this.timer = window.setTimeout(() => {
      this.timer = null;
      if (this.disposed || generation !== this.generation) return;
      void this.flush(generation).catch((error) => {
        logger.error('Failed to load inline icons', undefined, error);
      });
    }, 24);
  }

  private async flush(generation: number): Promise<void> {
    if (this.disposed || generation !== this.generation || !this.pending.size)
      return;
    const icons: string[] = [];
    for (const iconId of this.pending) {
      this.pending.delete(iconId);
      icons.push(iconId);
      if (icons.length === BATCH_LIMIT) break;
    }
    const repaint = new Set<MarkdownView>();
    let next = 0;
    this.inFlight = true;
    const worker = async () => {
      let deadline = performance.now() + SLICE_MS;
      while (
        !this.disposed &&
        generation === this.generation &&
        next < icons.length
      ) {
        const iconId = icons[next++];
        try {
          const icon = await this.plugin.iconResolver?.resolve(iconId, {
            persist: true,
          });
          if (this.disposed || generation !== this.generation) return;
          if (icon) {
            await this.flushPendingElements(
              iconId,
              icon.svgElement,
              generation,
            );
            if (this.disposed || generation !== this.generation) return;
            const views = this.pendingViews.get(iconId);
            if (views) for (const view of views) repaint.add(view);
          } else {
            this.failed.add(iconId);
            if (this.failed.size > FAILED_LIMIT) {
              const oldest = this.failed.values().next().value as
                | string
                | undefined;
              if (oldest !== undefined) this.failed.delete(oldest);
            }
            this.pendingElements.delete(iconId);
          }
          this.pendingViews.delete(iconId);
        } catch (error) {
          if (!this.disposed && generation === this.generation)
            logger.error('Failed to load an inline icon', undefined, error);
        }
        if (performance.now() >= deadline) {
          await yieldToMain('user-visible');
          deadline = performance.now() + SLICE_MS;
        }
      }
    };
    try {
      await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
      if (!this.disposed && generation === this.generation) {
        for (const view of repaint) {
          // 不触碰阅读视图或其它笔记的组件；新 widget 已使用节点原位填充。
          // No reading-view rerender: new widgets are populated directly.
          const cm = (
            view.editor as unknown as {
              cm?: { dispatch(transaction: object): void };
            }
          )?.cm;
          cm?.dispatch({});
        }
      }
    } finally {
      this.inFlight = false;
      this.schedule();
    }
  }

  reset(): void {
    this.generation++;
    this.pending.clear();
    this.failed.clear();
    this.pendingElements.clear();
    this.pendingViews.clear();
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = null;
    // 旧批次可能仍等待 I/O，保持 inFlight 直到其 finally，避免重置后重叠加载。
    // Keep the running lease until finally rather than overlapping old and new batches.
  }

  dispose(): void {
    this.disposed = true;
    this.reset();
  }

  getStats(): { pending: number; failed: number; inFlight: boolean } {
    return {
      pending: this.pending.size,
      failed: this.failed.size,
      inFlight: this.inFlight,
    };
  }

  clearFailedList(): void {
    this.failed.clear();
  }
}
