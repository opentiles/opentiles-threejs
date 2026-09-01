/**
 * A small LRU keyed by string. Recency is `Map` insertion order (`touch`
 * re-inserts), and `prune` evicts least-recently-used unpinned entries until
 * the budget holds. Pinned entries (visible / still required tiles) are
 * never evicted, so the cache may temporarily exceed the budget.
 */
export class LruCache<V> {
  private map = new Map<string, V>();

  constructor(private budget: number) {}

  get size(): number {
    return this.map.size;
  }

  get(key: string): V | undefined {
    return this.map.get(key);
  }

  has(key: string): boolean {
    return this.map.has(key);
  }

  /** Insert or replace, counting as most recently used. */
  set(key: string, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
  }

  /** Mark as most recently used. */
  touch(key: string): void {
    const v = this.map.get(key);
    if (v !== undefined) {
      this.map.delete(key);
      this.map.set(key, v);
    }
  }

  delete(key: string): V | undefined {
    const v = this.map.get(key);
    this.map.delete(key);
    return v;
  }

  values(): IterableIterator<V> {
    return this.map.values();
  }

  entries(): IterableIterator<[string, V]> {
    return this.map.entries();
  }

  /** Evict LRU-first until at budget, skipping pinned entries. */
  prune(isPinned: (key: string, value: V) => boolean, onEvict: (key: string, value: V) => void): void {
    if (this.map.size <= this.budget) return;
    for (const [key, value] of [...this.map.entries()]) {
      if (this.map.size <= this.budget) break;
      if (isPinned(key, value)) continue;
      this.map.delete(key);
      onEvict(key, value);
    }
  }

  clear(onEvict?: (key: string, value: V) => void): void {
    if (onEvict) for (const [k, v] of this.map) onEvict(k, v);
    this.map.clear();
  }
}
