import { describe, expect, it } from 'vitest';
import { LruCache } from '../src/lru';

describe('LruCache', () => {
  it('evicts least-recently-used first, skipping pinned entries', () => {
    const lru = new LruCache<number>(2);
    lru.set('a', 1);
    lru.set('b', 2);
    lru.set('c', 3);
    lru.touch('a'); // order now: b, c, a
    const evicted: string[] = [];
    lru.prune((k) => k === 'b', (k) => evicted.push(k));
    expect(evicted).toEqual(['c']);
    expect(lru.has('a')).toBe(true);
    expect(lru.has('b')).toBe(true);
    expect(lru.size).toBe(2);
  });

  it('does nothing under budget and can exceed it when everything is pinned', () => {
    const lru = new LruCache<number>(1);
    lru.set('a', 1);
    lru.set('b', 2);
    const evicted: string[] = [];
    lru.prune(() => true, (k) => evicted.push(k));
    expect(evicted).toEqual([]);
    expect(lru.size).toBe(2);
  });

  it('clear disposes everything', () => {
    const lru = new LruCache<number>(10);
    lru.set('a', 1);
    lru.set('b', 2);
    const evicted: string[] = [];
    lru.clear((k) => evicted.push(k));
    expect(evicted.sort()).toEqual(['a', 'b']);
    expect(lru.size).toBe(0);
  });
});
