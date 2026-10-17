/**
 * manager-types.ts — Types, interfaces, constants, and predicates for AgentManager.
 */

import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ToolActivity } from "../agent-runner.js";
import type {
  AgentInvocation,
  AgentRecord,
  IsolationMode,
  Pool,
  SubagentType,
  ThinkingLevel,
} from "../types.js";
import type { LifetimeUsage } from "../usage.js";
import type { CompiledSchema } from "../workflow/json-schema.js";

export type { Pool };

export type OnAgentComplete = (record: AgentRecord) => void;
export type OnAgentStart = (record: AgentRecord) => void;
export type OnAgentSteered = (record: AgentRecord, message: string) => void;
export type OnAgentCompact = (record: AgentRecord, info: CompactionInfo) => void;
export type OnAgentUsage = (record: AgentRecord, usage: LifetimeUsage) => void;
export type CompactionInfo = { reason: "manual" | "threshold" | "overflow"; tokensBefore: number };

/** Default max concurrent background agents. */
export const DEFAULT_MAX_CONCURRENT = 10;

/** Default max concurrent foreground (blocking) agents — 0 = unlimited. */
export const DEFAULT_MAX_CONCURRENT_FOREGROUND = 0;

/** How many evicted agents stay addressable by name. */
export const MAX_TOMBSTONES = 100;

/** Best-effort ceiling on one child's shutdown handlers. */
export const CHILD_SHUTDOWN_TIMEOUT_MS = 3_000;

/**
 * Validate a caller-supplied SpawnOptions.cwd.
 */
export function assertValidSpawnCwd(cwd: unknown): asserts cwd is string | undefined | null {
  if (cwd == null) return;
  if (typeof cwd !== "string" || !isAbsolute(cwd)) {
    throw new Error(`SpawnOptions.cwd must be an absolute path: "${String(cwd)}"`);
  }
  let isDirectory = false;
  try {
    isDirectory = statSync(cwd).isDirectory();
  } catch {
    throw new Error(`SpawnOptions.cwd does not exist: "${cwd}"`);
  }
  if (!isDirectory) {
    throw new Error(`SpawnOptions.cwd is not a directory: "${cwd}"`);
  }
}

/**
 * Whether a record occupies one of the `maxConcurrent` background slots.
 */
export function occupiesPoolSlot(
  record: Pick<AgentRecord, "isBackground" | "parentAgentId" | "workflowId">,
): boolean {
  return !!record.isBackground && isTopLevelAgent(record);
}

/**
 * Whether a record is one of the session's own agents, rather than something
 * another agent or a workflow owns.
 */
export function isTopLevelAgent(
  record: Pick<AgentRecord, "parentAgentId" | "workflowId">,
): boolean {
  return record.parentAgentId === undefined && record.workflowId === undefined;
}

/**
 * Whether a record occupies one of the `maxConcurrentForeground` slots.
 */
export function occupiesForegroundSlot(
  record: Pick<AgentRecord, "blocking" | "parentAgentId" | "workflowId">,
): boolean {
  return !!record.blocking && isTopLevelAgent(record);
}

/**
 * Whether an external halt already fixed this record's status.
 */
export function externallyHalted(record: Pick<AgentRecord, "status">): boolean {
  return record.status === "stopped" || record.status === "paused";
}

/**
 * A record with the pause gate attached.
 */
export type GatedRecord = AgentRecord & { pauseGate?: PauseGate };

/**
 * The suspension gate a parked record carries.
 */
export interface PauseGate {
  closed: boolean;
  wait(signal?: AbortSignal): Promise<void>;
  open(): void;
}

/** Create a closed gate. */
export function createPauseGate(): PauseGate {
  let release: (() => void) | undefined;
  const opened = new Promise<void>((resolve) => { release = resolve; });
  const gate: PauseGate = {
    closed: true,
    open() {
      if (!gate.closed) return;
      gate.closed = false;
      release?.();
    },
    wait(signal?: AbortSignal) {
      if (!gate.closed) return Promise.resolve();
      if (!signal) return opened;
      if (signal.aborted) return Promise.resolve();
      return new Promise<void>((resolve) => {
        const settle = () => {
          signal.removeEventListener("abort", settle);
          resolve();
        };
        signal.addEventListener("abort", settle, { once: true });
        void opened.then(settle);
      });
    },
  };
  return gate;
}

/** Sessions whose hooks are already wrapped — installation is idempotent. */
const gatedAgents = new WeakSet<object>();

/**
 * Wrap a child session's `beforeToolCall` and `finishTurn` so a parked run
 * suspends at its next boundary instead of continuing.
 */
export function installPauseGate(
  host: GatedRecord,
  session: AgentSession | undefined = host.session,
): void {
  const agent = session?.agent;
  if (!agent || gatedAgents.has(agent)) return;
  gatedAgents.add(agent);

  const awaitGate = async (signal?: AbortSignal): Promise<void> => {
    const gate = gateOf(host);
    if (!gate?.closed) return;
    await gate.wait(host.abortController?.signal ?? signal);
  };

  const priorBeforeToolCall = agent.beforeToolCall;
  agent.beforeToolCall = async (context, signal) => {
    await awaitGate(signal);
    return priorBeforeToolCall?.(context, signal);
  };

  const priorFinishTurn = agent.finishTurn;
  agent.finishTurn = (async (turn, signal) => {
    await awaitGate(signal);
    return priorFinishTurn?.(turn, signal);
  }) as NonNullable<AgentSession["agent"]["finishTurn"]>;
}

/** The gate a pause() closed, if this record is parked. */
export function gateOf(record: AgentRecord): PauseGate | undefined {
  return (record as GatedRecord).pauseGate;
}

/**
 * Release anything a closed gate is holding and drop it.
 */
export function releaseGate(record: AgentRecord): void {
  const gate = gateOf(record);
  if (!gate) return;
  gate.open();
  (record as GatedRecord).pauseGate = undefined;
}

/** One entry in the shared two-pool spawn queue. */
export interface QueueEntry {
  id: string;
  pool: Pool;
  start: () => Promise<void>;
  release: () => void;
}

export interface SpawnArgs {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  type: SubagentType;
  prompt: string | undefined;
  options: SpawnOptions;
}

export interface SpawnOptions {
  description: string;
  name?: string;
  resumeSessionFile?: string;
  reclaim?: { handle: string; alias?: string };
  model?: Model<any>;
  maxTurns?: number;
  isolated?: boolean;
  inheritContext?: boolean;
  thinkingLevel?: ThinkingLevel;
  isBackground?: boolean;
  bypassQueue?: boolean;
  blocking?: boolean;
  workflowId?: string;
  structuredOutput?: CompiledSchema;
  isolation?: IsolationMode;
  cwd?: string;
  onBeforeWorktreeCleanup?: (worktreePath: string) => Promise<void>;
  invocation?: AgentInvocation;
  signal?: AbortSignal;
  onSpawned?: (id: string) => void;
  onQueued?: (id: string, ahead: number) => void;
  onToolActivity?: (activity: ToolActivity) => void;
  onTextDelta?: (delta: string, fullText: string) => void;
  onSessionCreated?: (session: AgentSession) => void;
  onTurnEnd?: (turnCount: number) => void;
  onAssistantUsage?: (usage: { input: number; output: number; cacheWrite: number }) => void;
  onCompaction?: (info: CompactionInfo) => void;
  depth?: number;
  parentAgentId?: string;
  maxSubagentDepth?: number;
  configCwd?: string;
  rootSessionId?: string;
}

export interface ResumeOptions {
  isBackground?: boolean;
  maxTurns?: number;
  onTurnEnd?: (turnCount: number) => void;
  onToolActivity?: (activity: ToolActivity) => void;
  onTextDelta?: (delta: string, fullText: string) => void;
  onAssistantUsage?: (usage: { input: number; output: number; cacheWrite: number }) => void;
  onCompaction?: (info: CompactionInfo) => void;
  onStarted?: () => void;
}

/**
 * Close the extension lifecycle `runAgent` opened with `bindExtensions`, then dispose.
 */
export async function shutdownChildSession(session: AgentSession | undefined): Promise<void> {
  try {
    const runner = session?.extensionRunner;
    if (runner?.hasHandlers?.("session_shutdown")) {
      await Promise.race([
        runner.emit({ type: "session_shutdown", reason: "quit" }),
        new Promise<void>(resolve => setTimeout(resolve, CHILD_SHUTDOWN_TIMEOUT_MS).unref()),
      ]);
    }
  } catch { /* a partial session must degrade, not take the teardown down with it */ }
  try { session?.dispose?.(); } catch { /* ignore */ }
}
