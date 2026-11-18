/** 小时间片让出渲染线程，Safari/旧 Electron 使用计时器回退。
 * Yield small slices to rendering, with a timer fallback for Safari/older Electron. */
type Priority = 'background' | 'user-visible';
interface TaskScheduler {
  yield?: () => Promise<void>;
  postTask?: (
    callback: () => void,
    options: { priority: Priority },
  ) => Promise<void>;
}

export function yieldToMain(
  priority: Priority = 'user-visible',
): Promise<void> {
  const scheduler = (window as unknown as { scheduler?: TaskScheduler })
    .scheduler;
  if (priority === 'background' && typeof scheduler?.postTask === 'function')
    return scheduler.postTask(() => {}, { priority });
  if (typeof scheduler?.yield === 'function') return scheduler.yield();
  return new Promise<void>((resolve) => window.setTimeout(resolve, 0));
}

/** 初始化取消是可识别的正常退出。 / Make cancelled initialization a recognizable exit. */
export function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  const error = new Error('Icon loading cancelled');
  error.name = 'AbortError';
  throw error;
}
