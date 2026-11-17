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
  cleanupRecordOutput,
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
  unpause: (id: string, prompt?: string) => boolean;
  /** Remember a run's promise until it settles, for waitForSettled. */
  trackRun?: (promise: Promise<unknown>) => void;
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

/**
 * Turn limit handed to `resumeAgent`.
 *
 * A caller that already resolved the budget (a nested resume, against its
 * branch's registry) is trusted: `undefined` means unlimited and must not be
 * replaced by the spawn budget, nor looked up again in the global registry.
 * Everyone else keeps the historical fill-in from the limit the agent was
 * spawned with; the runner then applies the type's own `max_turns` and the
 * project default.
 */
function resumeLimit(
  record: AgentRecord,
  options?: ResumeOptions,
): { maxTurns?: number; maxTurnsResolved?: true } {
  if (options?.maxTurnsResolved) return { maxTurns: options.maxTurns, maxTurnsResolved: true };
  return { maxTurns: options?.maxTurns ?? record.invocation?.maxTurns };
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

  // Every other pause is decided by where the record is parked, not by whether
  // it has a session. A record parked after a pool-blocked resume has both a
  // session and a queue entry; `session` alone cannot tell it from a gate-parked
  // one, and treating it as a transcript continuation drops the caller's prompt
  // and leaves the stale entry behind.
  if (record.status === "paused") {
    const parked = pool.pausedQueued.has(id);
    if (!parked && !record.session) {
      // Nothing to continue and nothing to unpark. `/continue` re-runs a record
      // like this from its saved prompt; a live resume has nothing to reach.
      throw new Error(
        `Agent "${id}" is paused with no live queue entry — /continue re-runs it from its saved prompt.`
      );
    }
    if (parked && !record.session) {
      // Parked before its first run: nothing has a session to steer the message
      // into, so it rides the queue entry that unpause puts back.
      if (!unpause(id, prompt)) return undefined;
      if (!options?.isBackground) await waitInline(record, signal, () => abort(id));
      return record;
    }
    if (parked) {
      // Session-backed and queued behind the pool, then paused. That entry's
      // `start` is the earlier resume with the earlier prompt; drop it and let
      // this call issue its own, which carries this prompt.
      pool.pausedQueued.delete(id);
    }
  } else if (record.status === "running" || record.status === "queued") {
    if (options?.isBackground) return undefined;
    throw new Error(`Agent "${record.id}" is still ${record.status}. Wait for it to finish or steer it.`);
  }

  if (!record.session) {
    // Terminal record that never got a session (stopped before it started, an
    // evicted child): there is no transcript to continue. The callers that can
    // reopen one from disk do that on `undefined`.
    return undefined;
  }

  const effectivePrompt = prompt;

  if (options?.isBackground) {
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
    ...resumeLimit(record, options),
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
  deps.trackRun?.(promise);
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
    cleanupRecordOutput(record);
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
    ...resumeLimit(record, options),
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
  deps.trackRun?.(promise);
}
