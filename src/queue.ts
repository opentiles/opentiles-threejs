/**
 * Deduplicated, prioritized fetch queue with bounded concurrency and
 * two-level cancelation: `retain` drops queued jobs that are no longer
 * wanted and (optionally) aborts in-flight ones via their `AbortSignal`.
 *
 * The queue only schedules; outcomes (cache writes, error handling, retry)
 * live in the `run` callback, which must swallow its own handled errors —
 * any rejection is treated as "job over".
 */
export interface FetchQueueOptions {
  /** Maximum jobs running at once. */
  concurrency: number;
  /** Perform one job; resolve/reject ends it either way. */
  run: (key: string, signal: AbortSignal) => Promise<void>;
}

interface Job {
  key: string;
  priority: number;
  running: boolean;
  controller: AbortController | null;
}

export class FetchQueue {
  private jobs = new Map<string, Job>();
  private running = 0;

  constructor(private opts: FetchQueueOptions) {}

  /** Queue a job (no-op but a priority update if already queued/running). */
  request(key: string, priority: number): void {
    const existing = this.jobs.get(key);
    if (existing) {
      existing.priority = priority;
      return;
    }
    this.jobs.set(key, { key, priority, running: false, controller: null });
    this.dispatch();
  }

  has(key: string): boolean {
    return this.jobs.has(key);
  }

  /** Queued + running jobs. */
  get pending(): number {
    return this.jobs.size;
  }

  /**
   * Keep only jobs `keep` approves: the rest are dropped (queued) or
   * aborted (running, when `abortRunning`). An aborted job's `run` decides
   * how to record the abort.
   */
  retain(keep: (key: string) => boolean, abortRunning = true): void {
    for (const job of [...this.jobs.values()]) {
      if (keep(job.key)) continue;
      if (!job.running) this.jobs.delete(job.key);
      else if (abortRunning) job.controller?.abort();
    }
    this.dispatch();
  }

  /** Abort everything and forget all jobs. */
  clear(): void {
    for (const job of this.jobs.values()) if (job.running) job.controller?.abort();
    this.jobs.clear();
  }

  private dispatch(): void {
    while (this.running < this.opts.concurrency) {
      let best: Job | null = null;
      for (const job of this.jobs.values())
        if (!job.running && (best === null || job.priority > best.priority)) best = job;
      if (!best) return;
      this.start(best);
    }
  }

  private start(job: Job): void {
    job.running = true;
    job.controller = new AbortController();
    this.running++;
    this.opts
      .run(job.key, job.controller.signal)
      .catch(() => {})
      .finally(() => {
        this.running--;
        this.jobs.delete(job.key);
        this.dispatch();
      });
  }
}

/** A non-404 HTTP failure status (404 is a distinct, non-error outcome). */
export class HttpError extends Error {
  constructor(readonly status: number, url: string) {
    super(`HTTP ${status} for ${url}`);
  }
}

/**
 * GET `url` as bytes. `null` means 404 ("no data", cacheable, never retried).
 * Transient failures (network errors, 5xx) retry with exponential backoff;
 * an abort always surfaces immediately.
 */
export async function fetchBytes(
  url: string,
  signal: AbortSignal,
  retries = 2,
  baseDelayMs = 400,
): Promise<ArrayBuffer | null> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { signal });
      if (res.status === 404) return null;
      if (!res.ok) throw new HttpError(res.status, url);
      return await res.arrayBuffer();
    } catch (err) {
      if (signal.aborted || attempt >= retries) throw err;
      await new Promise((r) => setTimeout(r, baseDelayMs * 2 ** attempt));
      if (signal.aborted) throw err;
    }
  }
}
