import { describe, expect, it } from 'vitest';
import { ZipCache, ZipOpenGate } from './zip-cache';

describe('shared ZIP byte budget', () => {
  it('evicts least recently used packs within one global byte budget', () => {
    const cache = new ZipCache<object, string>(10);
    const first = {},
      second = {},
      third = {};
    cache.set(first, 'first', 4);
    cache.set(second, 'second', 4);
    expect(cache.get(first)).toBe('first');
    cache.set(third, 'third', 6);
    expect(cache.get(second)).toBeUndefined();
    expect(cache.get(first)).toBe('first');
    expect(cache.residentBytes).toBe(10);
    cache.set(first, 'oversized', 11);
    expect(cache.get(first)).toBeUndefined();
    expect(cache.residentBytes).toBe(6);
    cache.delete(third);
    expect(cache.residentBytes).toBe(0);
  });

  it('keeps an evicted value alive for an already running read', () => {
    const cache = new ZipCache<object, { data: string }>(1);
    const first = {},
      second = {};
    cache.set(first, { data: 'original' }, 1);
    const inFlight = cache.get(first);
    cache.set(second, { data: 'next' }, 1);
    expect(cache.get(first)).toBeUndefined();
    expect(inFlight?.data).toBe('original');
  });

  it('bounds in-flight opens and releases a slot after failure', async () => {
    const gate = new ZipOpenGate(1);
    let release: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const order: string[] = [];
    const first = gate.run(async () => {
      order.push('first');
      await waiting;
      throw new Error('failed');
    });
    const second = gate.run(async () => {
      order.push('second');
      return 2;
    });
    expect(order).toEqual(['first']);
    release();
    await expect(first).rejects.toThrow('failed');
    expect(await second).toBe(2);
    expect(order).toEqual(['first', 'second']);
  });
});
