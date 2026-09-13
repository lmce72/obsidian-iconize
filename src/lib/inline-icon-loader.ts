/**
 * InlineIconLoader - 内联图标延迟加载器
 * Inline Icon Loader for deferred loading of :IconName: syntax in notes.
 *
 * 用于处理笔记中的 :IconName: 语法，采用批处理策略避免阻塞渲染。
 * Handles :IconName: syntax in notes with batching to avoid blocking render.
 */

import IconizePlugin from '@app/main';

export class InlineIconLoader {
  private plugin: IconizePlugin;

  // 待处理的图标请求队列 / Pending icon requests queue.
  private pending: Set<string>;

  // 加载失败的图标（避免重复尝试）/ Failed icons (avoid retries).
  private failed: Set<string>;

  // 批处理定时器 / Batch processing timer.
  private timer: number | null;

  // 是否正在处理 / Processing flag.
  private inFlight: boolean;

  // 批处理延迟（毫秒）/ Batch delay in milliseconds.
  private batchDelayMs: number;

  constructor(plugin: IconizePlugin) {
    this.plugin = plugin;
    this.pending = new Set();
    this.failed = new Set();
    this.timer = null;
    this.inFlight = false;
    this.batchDelayMs = 60;
  }

  /**
   * 请求加载图标（非阻塞）/ Request icon loading (non-blocking).
   */
  requestIcon(iconId: string): void {
    if (!iconId) {
      return;
    }

    if (this.failed.has(iconId) || this.pending.has(iconId)) {
      return;
    }

    // 检查是否已加载到内存 / Check if already loaded.
    if (this.plugin.iconResolver && this.plugin.iconResolver.peek(iconId)) {
      return;
    }

    this.pending.add(iconId);
    this.schedule();
  }

  /**
   * 调度批处理（使用防抖）/ Schedule batch processing (with debouncing).
   */
  private schedule(): void {
    if (this.timer !== null || this.inFlight) {
      return;
    }

    this.timer = window.setTimeout(() => {
      this.timer = null;
      this.flush().catch((error) => {
        console.error('[InlineIconLoader] Flush failed:', error);
      });
    }, this.batchDelayMs);
  }

  /**
   * 批量处理队列中的图标 / Batch process queued icons.
   */
  private async flush(): Promise<void> {
    if (this.pending.size === 0) {
      return;
    }

    const icons = [...this.pending];
    this.pending.clear();
    this.inFlight = true;

    let loaded = 0;
    const startTime = Date.now();

    try {
      for (const iconId of icons) {
        try {
          const icon = await this.plugin.iconResolver.resolve(iconId, {
            persist: true,
          });

          if (icon) {
            loaded++;
          } else {
            this.failed.add(iconId);
            console.warn(`[InlineIconLoader] Icon not found: ${iconId}`);
          }
        } catch (error) {
          console.error(`[InlineIconLoader] Failed to load ${iconId}:`, error);
          this.failed.add(iconId);
        }
      }
    } finally {
      this.inFlight = false;
    }

    const elapsedMs = Date.now() - startTime;
    console.log(
      `[InlineIconLoader] Batch complete: ${loaded}/${icons.length} loaded in ${elapsedMs}ms`,
    );

    // 重新渲染打开的笔记以显示新加载的图标 / Re-render open notes.
    if (loaded > 0) {
      this.repaintOpenNotes();
    }

    // 处理批处理期间新增的请求 / Handle requests that arrived during batch.
    if (this.pending.size > 0) {
      this.schedule();
    }
  }

  /**
   * 重新渲染打开的笔记 / Repaint open notes to show loaded icons.
   */
  private repaintOpenNotes(): void {
    try {
      const markdownLeaves =
        this.plugin.app.workspace.getLeavesOfType('markdown');

      for (const leaf of markdownLeaves) {
        const view = leaf.view;
        if (!view) {
          continue;
        }

        try {
          // 重新渲染预览模式 / Re-render preview mode.
          if (
            'previewMode' in view &&
            (view as { previewMode?: { rerender: (full?: boolean) => void } })
              .previewMode &&
            typeof (
              view as { previewMode: { rerender: (full?: boolean) => void } }
            ).previewMode.rerender === 'function'
          ) {
            (
              view as { previewMode: { rerender: (full?: boolean) => void } }
            ).previewMode.rerender(true);
          }

          // 触发实时预览模式的重绘 / Trigger live preview repaint.
          const editorView = (
            view as { editor?: { cm?: { dispatch: (tr: unknown) => void } } }
          ).editor?.cm;
          if (editorView && editorView.dispatch) {
            editorView.dispatch({});
          }
        } catch (error) {
          console.warn('[InlineIconLoader] Failed to repaint a note:', error);
        }
      }
    } catch (error) {
      console.error('[InlineIconLoader] Failed to repaint open notes:', error);
    }
  }

  /**
   * 重置加载器状态（用于重新加载图标包后）/ Reset loader state.
   */
  reset(): void {
    this.pending.clear();
    this.failed.clear();

    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }

    console.log('[InlineIconLoader] Reset complete');
  }

  /**
   * 获取加载器统计信息 / Get loader statistics.
   */
  getStats(): { pending: number; failed: number; inFlight: boolean } {
    return {
      pending: this.pending.size,
      failed: this.failed.size,
      inFlight: this.inFlight,
    };
  }

  /**
   * 清除失败记录（允许重试）/ Clear failed records (allow retries).
   */
  clearFailedList(): void {
    const count = this.failed.size;
    this.failed.clear();
    console.log(`[InlineIconLoader] Cleared ${count} failed icons`);
  }
}
