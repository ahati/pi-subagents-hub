/**
 * semaphore.ts — concurrency limiter for workflow agent scheduling.
 */

export class Semaphore {
  private active = 0;
  private readonly waiters: (() => void)[] = [];

  constructor(private readonly limit: number) {}

  acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise<void>(resolve => {
      this.waiters.push(resolve);
    });
  }

  release(): void {
    const next = this.waiters.shift();
    // Hand the permit straight over rather than decrementing and re-acquiring;
    // otherwise a burst of releases can let more than `limit` through.
    if (next) next();
    else this.active--;
  }

  /** Wake everyone so aborted callers can observe the abort and bail. */
  drain(): void {
    while (this.waiters.length > 0) {
      const next = this.waiters.shift();
      next?.();
    }
  }
}
