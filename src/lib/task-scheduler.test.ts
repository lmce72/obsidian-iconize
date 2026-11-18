import { afterEach, describe, expect, it, vi } from 'vitest';
import { throwIfAborted, yieldToMain } from './task-scheduler';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe('cooperative browser scheduling', () => {
  it('prefers background postTask and user-visible yield when independently available', async () => {
    const postTask = vi.fn(async (run: () => void) => run());
    const yieldTask = vi.fn(async () => {});
    vi.stubGlobal('scheduler', { postTask, yield: yieldTask });
    await yieldToMain('background');
    await yieldToMain('user-visible');
    expect(postTask).toHaveBeenCalledWith(expect.any(Function), {
      priority: 'background',
    });
    expect(yieldTask).toHaveBeenCalledTimes(1);
  });
  it('falls back to a macrotask on Safari or older Electron', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('scheduler', undefined);
    let ran = false;
    const pending = yieldToMain().then(() => {
      ran = true;
    });
    await Promise.resolve();
    expect(ran).toBe(false);
    await vi.runAllTimersAsync();
    await pending;
    expect(ran).toBe(true);
  });
  it('reports abort without requiring newer AbortSignal methods', () => {
    const controller = new AbortController();
    throwIfAborted(controller.signal);
    controller.abort();
    expect(() => throwIfAborted(controller.signal)).toThrow(
      'Icon loading cancelled',
    );
  });
});
