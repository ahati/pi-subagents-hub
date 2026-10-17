/**
 * resume-handler.ts — Resume orchestration and background continuation for AgentManager.
 */

import { resumeAgent, type ToolActivity } from "../agent-runner.js";
import type { AgentRecord } from "../types.js";
import { addUsage, type LifetimeUsage } from "../usage.js";
import type { AgentRegistry } from "./agent-registry.js";
import type { ConcurrencyPool } from "./concurrency-pool.js";
import {
  type CompactionInfo,
  externallyHalted,
  gateOf,
  occupiesPoolSlot,
  type ResumeOptions,
  releaseGate,
} from "./manager-types.js";

export interface ResumeDeps {
  registry: AgentRegistry;
  pool: ConcurrencyPool;
  unpause: (id: string) => boolean;
  abort: (id: string) => boolean;
  drainQueue: () => void;
  abortOwnedChildren: (id: string) => void;
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
  record.result = text;
  record.completedAt ??= Date.now();
}

export function failResume(record: AgentRecord, err: unknown): void {
  if (!externallyHalted(record)) {
    record.status = "error";
    record.error = err instanceof Error ? err.message : String(err);
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
  if (gate?.closed && record.status === "queued") {
    return record;
  }
  if (gate?.closed && record.status === "paused") {
    const p = record.chargedPool;
    if (p !== undefined && !pool.poolHasRoom(p)) {
      record.status = "queued";
      record.completedAt = undefined;
      pool.queue.push({
        id,
        pool: p,
        start: async () => {
          pool.acquireSlot(record);
          gate.open();
          record.status = "running";
        },
        release: () => {},
      });
      return record;
    }
    pool.acquireSlot(record);
    gate.open();
    record.status = "running";
    record.completedAt = undefined;
    return record;
  }

  const bare = record.status === "paused";
  if (!record.session) {
    return unpause(id) ? record : undefined;
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
            onComplete?.(record);
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
      if (activity.type === "end") record.toolUses++;
      options?.onToolActivity?.(activity);
    },
    onTextDelta: options?.onTextDelta,
    onAssistantUsage: (usage: LifetimeUsage) => {
      addUsage(record.lifetimeUsage, usage);
      onUsage?.(record, usage);
      options?.onAssistantUsage?.(usage);
    },
    onCompaction: (info: CompactionInfo) => {
      record.compactionCount++;
      onCompact?.(record, info);
      options?.onCompaction?.(info);
    },
    signal: abortController.signal,
  };

  try {
    settleOutcome(record, await (effectivePrompt === undefined
      ? resumeAgent(record.session, callbacks)
      : resumeAgent(record.session, effectivePrompt, callbacks)));
  } catch (err) {
    failResume(record, err);
  }
  pool.detachParentAbort(record);
  abortOwnedChildren(id);
  return record;
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
  record.startedAt = Date.now();
  if (occupiesPoolSlot(record)) {
    record.chargedPool = "background";
    pool.acquireSlot(record);
  }
  onStart?.(record);

  const abortController = new AbortController();
  record.abortController = abortController;
  let detachParentSignal: (() => void) | undefined;
  if (parentSignal) {
    const onParentAbort = () => abort(id);
    parentSignal.addEventListener("abort", onParentAbort, { once: true });
    detachParentSignal = () => parentSignal.removeEventListener("abort", onParentAbort);
  }

  try { options.onStarted?.(); } catch { /* ignore */ }

  const settle = () => {
    detachParentSignal?.();
    detachParentSignal = undefined;
    releaseGate(record);
    if (record.outputCleanup) {
      try { record.outputCleanup(); } catch { /* ignore */ }
      record.outputCleanup = undefined;
    }
    abortOwnedChildren(id);
    pool.releaseSlot(record);
    try { onComplete?.(record); } catch { /* ignore */ }
    drainQueue();
  };

  const resumeOptions = {
    type: record.type,
    maxTurns: options.maxTurns ?? record.invocation?.maxTurns,
    onTurnEnd: options.onTurnEnd,
    onToolActivity: (activity: ToolActivity) => {
      if (activity.type === "end") record.toolUses++;
      options.onToolActivity?.(activity);
    },
    onTextDelta: options.onTextDelta,
    onAssistantUsage: (usage: LifetimeUsage) => {
      addUsage(record.lifetimeUsage, usage);
      onUsage?.(record, usage);
      options.onAssistantUsage?.(usage);
    },
    onCompaction: (info: CompactionInfo) => {
      record.compactionCount++;
      onCompact?.(record, info);
      options.onCompaction?.(info);
    },
    signal: abortController.signal,
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
