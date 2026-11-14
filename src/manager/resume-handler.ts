/**
 * resume-handler.ts — Resume orchestration and background continuation for AgentManager.
 */

import { abortable } from "../abortable.js";
import { resumeAgent, type ToolActivity } from "../agent-runner.js";
import type { AgentRecord } from "../types.js";
import { addUsage, type LifetimeUsage } from "../usage.js";
import type { AgentRegistry } from "./agent-registry.js";
import type { ConcurrencyPool } from "./concurrency-pool.js";
import {
  type CompactionInfo,
  countToolUse,
  externallyHalted,
  gateOf,
  occupiesPoolSlot,
  type ResumeOptions,
  releaseGate,
} from "./manager-types.js";
import { consumeTerminalResult, waitForRecord } from "./wait-for-record.js";

export interface ResumeDeps {
  registry: AgentRegistry;
  pool: ConcurrencyPool;
  unpause: (id: string) => boolean;
  abort: (id: string) => boolean;
  drainQueue: () => void;
  abortOwnedChildren: (id: string) => void;
  waitForBackgroundChild?: (parentId: string, signal?: AbortSignal) => Promise<boolean>;
  onComplete?: (record: AgentRecord) => void;
  onStart?: (record: AgentRecord) => void;
  onUsage?: (record: AgentRecord, usage: LifetimeUsage) => void;
  onCompact?: (record: AgentRecord, info: CompactionInfo) => void;
}

export function settleOutcome(
  record: AgentRecord,
  { text, failure, aborted, steered }: Awaited<ReturnType<typeof resumeAgent>>,
): void {
  if (!externallyHalted(record)) {
    if (aborted) {
      record.status = "aborted";
    } else if (failure) {
      record.status = "error";
      record.error = failure;
    } else {
      record.status = steered ? "steered" : "completed";
    }
  }
  // A run that settles as an abort or failure takes its open ask_parent
  // questions with it: nobody answers a dead run, and the error surfaces must
  // not dangle a footer for questions that will never be resolved.
  if (aborted || failure) {
    for (const q of record.questions ?? []) {
      if (q.state === "open" || q.state === "delivered") q.state = "dropped";
    }
  }
  record.result = text;
  record.completedAt ??= Date.now();
}

export function failResume(record: AgentRecord, err: unknown): void {
  if (!externallyHalted(record)) {
    record.status = "error";
    record.error = err instanceof Error ? err.message : String(err);
  }
  for (const q of record.questions ?? []) {
    if (q.state === "open" || q.state === "delivered") q.state = "dropped";
  }
  record.completedAt ??= Date.now();
}

export async function resumeRecord(
  deps: ResumeDeps,
  id: string,
  prompt?: string,
  signal?: AbortSignal,
  options?: ResumeOptions,
): Promise<AgentRecord | undefined> {
  const { registry, pool, unpause, abort, abortOwnedChildren, onComplete, onUsage, onCompact } = deps;
  const record = registry.agents.get(id);
  if (!record) return undefined;

  const gate = gateOf(record);
  if (gate?.closed && (record.status === "queued" || record.status === "paused")) {
    // Queue steering before releasing the gate. Do not delay background callers
    // on either the session's steer promise or the still-running turn.
    if (prompt && record.session) {
      try {
        void record.session.steer(prompt).catch(err => console.error("[pi-subagents-hub] paused steer failed:", err));
      } catch (err) {
        console.error("[pi-subagents-hub] paused steer failed:", err);
      }
    }
    if (record.status === "paused") {
      const p = record.chargedPool;
      record.completedAt = undefined;
      if (p !== undefined && !pool.poolHasRoom(p)) {
        record.status = "queued";
        pool.queue.push({
          id,
          pool: p,
          start: async () => {
            pool.acquireSlot(record);
            record.status = "running";
            gate.open();
          },
          release: () => {},
        });
      } else {
        pool.acquireSlot(record);
        record.status = "running";
        gate.open();
      }
    }
    if (!options?.isBackground) await waitInline(record, signal, () => abort(id));
    return record;
  }

  const bare = record.status === "paused";
  if (!bare && (record.status === "running" || record.status === "queued")) {
    if (options?.isBackground) return undefined;
    throw new Error(`Agent "${record.id}" is still ${record.status}. Wait for it to finish or steer it.`);
  }
  if (!record.session) {
    if (!unpause(id)) return undefined;
    if (!options?.isBackground) await waitInline(record, signal, () => abort(id));
    return record;
  }

  const effectivePrompt = bare ? undefined : prompt;

  if (options?.isBackground) {
    if (record.status === "running" || record.status === "queued") return undefined;

    record.isBackground = true;
    record.resultConsumed = false;
    record.result = undefined;
    record.error = undefined;
    record.completedAt = undefined;
    record.status = "queued";

    if (!pool.armQueuedAbort(record, signal, () => abort(id))) return record;
    const start = () => startResume(deps, id, record, effectivePrompt, signal, options);
    if (occupiesPoolSlot(record) && !pool.poolHasRoom("background")) {
      pool.queue.push({
        id,
        pool: "background",
        start: async () => {
          try {
            start();
          } catch (err) {
            record.status = "error";
            record.error = err instanceof Error ? err.message : String(err);
            record.completedAt = Date.now();
            pool.detachParentAbort(record);
            pool.releaseSlot(record);
            try { onComplete?.(record); } catch (callbackError) {
              console.error("[pi-subagents-hub] resume completion callback failed:", callbackError);
            } finally {
              deps.drainQueue();
            }
          }
        },
        release: () => {},
      });
    } else {
      start();
    }
    return record;
  }

  record.status = "running";
  record.seenToolCalls = new Set();
  record.startedAt = Date.now();
  record.completedAt = undefined;
  record.result = undefined;
  record.error = undefined;

  const abortController = new AbortController();
  record.abortController = abortController;
  pool.armParentAbort(record, signal, () => abort(id));
  if (signal?.aborted) abort(id);

  const callbacks = {
    type: record.type,
    maxTurns: options?.maxTurns ?? record.invocation?.maxTurns,
    onTurnEnd: options?.onTurnEnd,
    onToolActivity: (activity: ToolActivity) => {
      countToolUse(record, activity);
      options?.onToolActivity?.(activity);
    },
    onTextDelta: options?.onTextDelta,
    onAssistantUsage: (usage: LifetimeUsage) => {
      addUsage(record.lifetimeUsage, usage);
      addUsage(record.ownUsage, usage);
      onUsage?.(record, usage);
      options?.onAssistantUsage?.(usage);
    },
    onCompaction: (info: CompactionInfo) => {
      record.compactionCount++;
      onCompact?.(record, info);
      options?.onCompaction?.(info);
    },
    signal: abortController.signal,
    waitForBackgroundChild: () => deps.waitForBackgroundChild?.(id, abortController.signal) ?? Promise.resolve(false),
  };

  const session = record.session;
  const promise = (async () => {
    try {
      settleOutcome(record, await (effectivePrompt === undefined
        ? resumeAgent(session, callbacks)
        : resumeAgent(session, effectivePrompt, callbacks)));
    } catch (err) {
      failResume(record, err);
    } finally {
      pool.detachParentAbort(record);
      abortOwnedChildren(id);
    }
    return record.result ?? "";
  })();
  record.promise = promise;
  await promise;
  consumeTerminalResult(record);
  return record;
}

/** Inline continuation owns cancellation, unlike a read-only result wait. */
async function waitInline(record: AgentRecord, signal: AbortSignal | undefined, abort: () => void): Promise<void> {
  const onAbort = () => abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    if (signal?.aborted) onAbort();
    // A gated run already has its promise, even when reopening is queued.
    if (record.promise) await abortable(record.promise, signal);
    else await waitForRecord(record, signal);
    consumeTerminalResult(record);
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

export function startResume(
  deps: ResumeDeps,
  id: string,
  record: AgentRecord,
  prompt: string | undefined,
  parentSignal: AbortSignal | undefined,
  options: ResumeOptions,
): void {
  if (!record.session) return;
  const { pool, abort, drainQueue, abortOwnedChildren, onComplete, onStart, onUsage, onCompact } = deps;

  record.status = "running";
  record.seenToolCalls = new Set();
  record.startedAt = Date.now();
  if (occupiesPoolSlot(record)) {
    record.chargedPool = "background";
    pool.acquireSlot(record);
  }
  try { onStart?.(record); } catch (err) {
    console.error("[pi-subagents-hub] resume start callback failed:", err);
  }

  const abortController = new AbortController();
  record.abortController = abortController;
  pool.armParentAbort(record, parentSignal, () => abort(id));
  if (parentSignal?.aborted) abort(id);

  try { options.onStarted?.(); } catch { /* ignore */ }

  const settle = () => {
    pool.detachParentAbort(record);
    releaseGate(record);
    if (record.outputCleanup) {
      try { record.outputCleanup(); } catch { /* ignore */ }
      record.outputCleanup = undefined;
    }
    abortOwnedChildren(id);
    pool.releaseSlot(record);
    try { onComplete?.(record); } catch (err) {
      console.error("[pi-subagents-hub] resume completion callback failed:", err);
    } finally {
      drainQueue();
    }
  };

  const resumeOptions = {
    type: record.type,
    maxTurns: options.maxTurns ?? record.invocation?.maxTurns,
    onTurnEnd: options.onTurnEnd,
    onToolActivity: (activity: ToolActivity) => {
      countToolUse(record, activity);
      options.onToolActivity?.(activity);
    },
    onTextDelta: options.onTextDelta,
    onAssistantUsage: (usage: LifetimeUsage) => {
      addUsage(record.lifetimeUsage, usage);
      addUsage(record.ownUsage, usage);
      onUsage?.(record, usage);
      options.onAssistantUsage?.(usage);
    },
    onCompaction: (info: CompactionInfo) => {
      record.compactionCount++;
      onCompact?.(record, info);
      options.onCompaction?.(info);
    },
    signal: abortController.signal,
    waitForBackgroundChild: () => deps.waitForBackgroundChild?.(id, abortController.signal) ?? Promise.resolve(false),
  };

  const promise = (prompt === undefined
    ? resumeAgent(record.session, resumeOptions)
    : resumeAgent(record.session, prompt, resumeOptions))
    .then((outcome) => {
      settleOutcome(record, outcome);
      settle();
      return outcome.text;
    })
    .catch((err) => {
      failResume(record, err);
      settle();
      return "";
    });

  record.promise = promise;
}
