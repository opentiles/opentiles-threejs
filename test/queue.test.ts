import { describe, expect, it } from 'vitest';
import { FetchQueue } from '../src/queue';

/** A queue whose jobs only finish when the test resolves them. */
function manualQueue(concurrency: number) {
  const started: string[] = [];
  const aborted: string[] = [];
  const resolvers = new Map<string, () => void>();
  const queue = new FetchQueue({
    concurrency,
    run: (key, signal) =>
      new Promise<void>((resolve) => {
        started.push(key);
        signal.addEventListener('abort', () => {
          aborted.push(key);
          resolve();
        });
        resolvers.set(key, resolve);
      }),
  });
  const finish = async (key: string) => {
    resolvers.get(key)?.();
    await new Promise((r) => setTimeout(r));
  };
  return { queue, started, aborted, finish };
}

describe('FetchQueue', () => {
  it('starts highest priority first, bounded by concurrency', async () => {
    const { queue, started, finish } = manualQueue(1);
    queue.request('low', 1);
    queue.request('high', 10);
    queue.request('mid', 5);
    expect(started).toEqual(['low']); // was alone when dispatched
    await finish('low');
    expect(started).toEqual(['low', 'high']);
    await finish('high');
    expect(started).toEqual(['low', 'high', 'mid']);
  });

  it('dedupes and only updates priority on repeat requests', async () => {
    const { queue, started, finish } = manualQueue(1);
    queue.request('a', 1);
    queue.request('b', 2);
    queue.request('c', 3);
    queue.request('b', 99); // bump
    await finish('a');
    expect(started).toEqual(['a', 'b']);
    expect(queue.pending).toBe(2);
  });

  it('retain drops queued jobs and aborts running ones', async () => {
    const { queue, started, aborted, finish } = manualQueue(1);
    queue.request('running', 5);
    queue.request('queued', 1);
    expect(started).toEqual(['running']);
    queue.retain(() => false, true);
    await finish('running'); // settles the aborted promise
    expect(aborted).toEqual(['running']);
    expect(queue.pending).toBe(0);
    expect(started).toEqual(['running']); // 'queued' never started
  });

  it('retain can leave in-flight jobs alone', () => {
    const { queue, aborted } = manualQueue(1);
    queue.request('running', 5);
    queue.retain(() => false, false);
    expect(aborted).toEqual([]);
    expect(queue.pending).toBe(1); // still running
  });
});
