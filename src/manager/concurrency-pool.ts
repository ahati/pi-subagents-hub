/**
 * concurrency-pool.ts — Two-pool concurrency queues, slot tracking, and slot acquisition.
 */

import type { AgentRecord, Pool } from "../types.js";
import {
  DEFAULT_MAX_CONCURRENT,
  DEFAULT_MAX_CONCURRENT_FOREGROUND,
  occupiesForegroundSlot,
  occupiesPoolSlot,
  type QueueEntry,
} from "./manager-types.js";

export class ConcurrencyPool {
  private maxConcurrent: number;
  private maxConcurrentForeground = DEFAULT_MAX_CONCURRENT_FOREGROUND;
  runningBackground = 0;
  runningForeground = 0;
  readonly queue: QueueEntry[] = [];
  readonly pausedQueued = new Map<string, QueueEntry>();

  constructor(maxConcurrent = DEFAULT_MAX_CONCURRENT) {
    this.maxConcurrent = maxConcurrent;
  }

  setMaxConcurrent(n: number): void {
    this.maxConcurrent = Math.max(1, n);
    this.drainQueue();
  }

  getMaxConcurrent(): number {
    return this.maxConcurrent;
  }

  setMaxConcurrentForeground(n: number): void {
    this.maxConcurrentForeground = Math.max(0, n);
    this.drainQueue();
  }

  getMaxConcurrentForeground(): number {
    return this.maxConcurrentForeground;
  }

  poolFor(record: AgentRecord): Pool | undefined {
    if (occupiesPoolSlot(record)) return "background";
    if (this.maxConcurrentForeground > 0 && occupiesForegroundSlot(record)) return "foreground";
    return undefined;
  }

  poolHasRoom(pool: Pool): boolean {
    return pool === "background"
      ? this.runningBackground < this.maxConcurrent
      : this.maxConcurrentForeground === 0 || this.runningForeground < this.maxConcurrentForeground;
  }

  chargePool(pool: Pool | undefined, delta: 1 | -1): void {
    if (pool === "background") this.runningBackground += delta;
    else if (pool === "foreground") this.runningForeground += delta;
  }

  acquireSlot(record: AgentRecord): void {
    if (record.slotHeld || record.chargedPool === undefined) return;
    record.slotHeld = true;
    this.chargePool(record.chargedPool, 1);
  }

  releaseSlot(record: AgentRecord): void {
    if (!record.slotHeld) return;
    record.slotHeld = false;
    this.chargePool(record.chargedPool, -1);
  }

  armQueuedAbort(record: AgentRecord | undefined, signal: AbortSignal | undefined, onAbortRecord: () => void): boolean {
    if (signal === undefined) return true;
    if (signal.aborted) {
      if (record) {
        record.status = "stopped";
        record.completedAt = Date.now();
      }
      return false;
    }
    if (record) this.armParentAbort(record, signal, onAbortRecord);
    return true;
  }

  armParentAbort(record: AgentRecord, signal: AbortSignal | undefined, onAbortRecord: () => void): void {
    this.detachParentAbort(record);
    if (signal === undefined) return;
    const onParentAbort = () => onAbortRecord();
    signal.addEventListener("abort", onParentAbort, { once: true });
    record.detachParentAbort = () => signal.removeEventListener("abort", onParentAbort);
  }

  detachParentAbort(record: AgentRecord): void {
    record.detachParentAbort?.();
    record.detachParentAbort = undefined;
  }

  dequeue(pred: (entry: { id: string; pool: Pool }) => boolean): void {
    const kept: typeof this.queue = [];
    for (const entry of this.queue) {
      if (pred(entry)) entry.release();
      else kept.push(entry);
    }
    this.queue.length = 0;
    this.queue.push(...kept);
  }

  drainQueue(getRecord?: (id: string) => AgentRecord | undefined): void {
    for (;;) {
      const i = this.queue.findIndex(e => this.poolHasRoom(e.pool));
      if (i === -1) return;
      const [next] = this.queue.splice(i, 1);
      const record = getRecord?.(next.id);
      if (getRecord && (!record || record.status !== "queued")) {
        next.release();
        continue;
      }
      void next.start().then(() => next.release(), () => next.release());
    }
  }
}
