/**
 * agent-manager.ts — Tracks agents, background execution, resume support.
 *
 * Modularized facade orchestrating ConcurrencyPool, AgentRegistry, and ResumeHandler.
 *
 * Nested children take no pool slot; their width is bounded by
 * `maxConcurrentNested`, which refuses rather than queues — see `spawn`.
 */

import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runAgent } from "./agent-runner.js";
import { getAgentConfig } from "./agent-types.js";
import { AgentRegistry } from "./manager/agent-registry.js";
import { ConcurrencyPool } from "./manager/concurrency-pool.js";
import {
  assertValidSpawnCwd,
  countToolUse,
  createPauseGate,
  DEFAULT_MAX_CONCURRENT,
  DEFAULT_MAX_CONCURRENT_NESTED,
  externallyHalted,
  GatedRecord,
  gateOf,
  installPauseGate,
  isTopLevelAgent,
  OnAgentCompact,
  OnAgentComplete,
  OnAgentStart,
  OnAgentSteered,
  OnAgentUsage,
  Pool,
  ResumeOptions,
  releaseGate,
  SpawnArgs,
  SpawnOptions,
  shutdownChildSession,
} from "./manager/manager-types.js";
import {
  type ResumeDeps,
  resumeRecord,
  settleOutcome,
} from "./manager/resume-handler.js";
import { WorktreeCoordinator } from "./manager/worktree-coordinator.js";
import { assignHandle, handleBase } from "./mention.js";
import { describeModel } from "./model-resolver.js";
import type { AgentRecord, AgentTombstone, MentionResolution, SubagentType } from "./types.js";
import { addUsage } from "./usage.js";

export * from "./manager/agent-registry.js";
export * from "./manager/concurrency-pool.js";
export * from "./manager/manager-types.js";
export * from "./manager/resume-handler.js";
export * from "./manager/worktree-coordinator.js";

export class AgentManager {
  private readonly registry = new AgentRegistry();
  private readonly pool: ConcurrencyPool;
  private readonly worktrees = new WorktreeCoordinator();
  private cleanupInterval: ReturnType<typeof setInterval>;
  private onComplete?: OnAgentComplete;
  private onStart?: OnAgentStart;
  private onCompact?: OnAgentCompact;
  private onUsage?: OnAgentUsage;
  private onSteered?: OnAgentSteered;
  private startups = new Map<string, Promise<void>>();
  private maxConcurrentNested = DEFAULT_MAX_CONCURRENT_NESTED;

  get runningBackground(): number {
    return this.pool.runningBackground;
  }
  set runningBackground(val: number) {
    this.pool.runningBackground = val;
  }
  get runningForeground(): number {
    return this.pool.runningForeground;
  }
  set runningForeground(val: number) {
    this.pool.runningForeground = val;
  }
  get queue() {
    return this.pool.queue;
  }
  get pausedQueued() {
    return this.pool.pausedQueued;
  }

  constructor(
    onComplete?: OnAgentComplete,
    maxConcurrent = DEFAULT_MAX_CONCURRENT,
    onStart?: OnAgentStart,
    onCompact?: OnAgentCompact,
    onUsage?: OnAgentUsage,
    onSteered?: OnAgentSteered,
  ) {
    this.onComplete = onComplete;
    this.onStart = onStart;
    this.onCompact = onCompact;
    this.onUsage = onUsage;
    this.onSteered = onSteered;
    this.pool = new ConcurrencyPool(maxConcurrent);
    this.cleanupInterval = setInterval(() => this.cleanup(), 60_000);
    this.cleanupInterval.unref();
  }

  setMaxConcurrent(n: number) {
    this.pool.setMaxConcurrent(n);
    this.drainQueue();
  }

  getMaxConcurrent(): number {
    return this.pool.getMaxConcurrent();
  }

  setMaxConcurrentForeground(n: number) {
    this.pool.setMaxConcurrentForeground(n);
    this.drainQueue();
  }

  getMaxConcurrentForeground(): number {
    return this.pool.getMaxConcurrentForeground();
  }

  /** Update the cap on running nested children, over which nested spawns are refused. 0 = unlimited. */
  setMaxConcurrentNested(n: number) {
    // Nothing queues on this cap, so a change has nothing to drain.
    this.maxConcurrentNested = Math.max(0, n);
  }

  getMaxConcurrentNested(): number {
    return this.maxConcurrentNested;
  }

  /**
   * Running nested children outside workflows — what `maxConcurrentNested`
   * caps. Read from the records rather than kept as a counter, so no start or
   * settle path can leak a slot.
   */
  private runningNestedCount(): number {
    let n = 0;
    for (const record of this.registry.agents.values()) {
      if (record.status === "running" && record.parentAgentId !== undefined && record.workflowId === undefined) n++;
    }
    return n;
  }

  private drainQueue(): void {
    this.pool.drainQueue(id => this.registry.agents.get(id));
  }

  private dequeue(pred: (entry: { id: string; pool: Pool }) => boolean): void {
    this.pool.dequeue(pred);
  }

  private stopGatedRun(record: AgentRecord): void {
    if (!gateOf(record)?.closed) return;
    releaseGate(record);
    record.abortController?.abort();
  }

  spawn(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    type: SubagentType,
    prompt: string,
    options: SpawnOptions,
  ): string;
  spawn(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    type: SubagentType,
    prompt: string | undefined,
    options: SpawnOptions & { resumeSessionFile: string },
  ): string;
  spawn(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    type: SubagentType,
    prompt: string | undefined,
    options: SpawnOptions,
  ): string {
    assertValidSpawnCwd(options.cwd);

    // Nested fan-out is capped by refusing, not queueing: a nested child cannot
    // queue — its parent waits on it while holding a slot — so refusing is the
    // only bound that cannot deadlock. The parent is told to do the work itself,
    // as Claude Code tells it over CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS. Only
    // nested children count; top-level agents have their pools, and a
    // workflow's agents the run's own cap.
    if (
      options.parentAgentId !== undefined &&
      options.workflowId === undefined &&
      this.maxConcurrentNested > 0 &&
      this.runningNestedCount() >= this.maxConcurrentNested
    ) {
      throw new Error(
        `Concurrent nested subagent limit reached. You can run ${this.maxConcurrentNested} nested subagents at once. Do not retry. ` +
          "Complete this task directly with your tools, or if the user wants more, " +
          "ask them to raise maxConcurrentNested in /agents → Settings.",
      );
    }

    // A reclaimed id must not be live: the record would replace the one in the
    // map, orphaning its run beyond the reach of stop and `abortAll()`.
    // Callers reopen only what they found evicted; this keeps that true.
    if (options.reclaim?.id !== undefined && this.registry.agents.has(options.reclaim.id)) {
      throw new Error(`Agent ${options.reclaim.id} is still in memory, so it cannot be reopened from its saved session.`);
    }
    const id = options.reclaim?.id ?? randomUUID().slice(0, 17);
    const abortController = new AbortController();
    const record: AgentRecord = {
      id,
      type,
      handle: !isTopLevelAgent(options)
        ? undefined
        // A reclaimed handle is taken back as-is while it is free: it belongs to
        // the conversation this spawn is reopening, and re-deriving it would
        // lose the numbering.
        : this.reclaimable(options.reclaim?.handle, options.reclaim?.id)
          ?? assignHandle(handleBase(type), this.registry.takenHandles()),
      description: options.description,
      // Reclaimed here, or filled in below from `name` — in which case it must
      // see the handle this record just took, since both come out of the same
      // namespace.
      alias: !isTopLevelAgent(options) ? undefined : this.reclaimable(options.reclaim?.alias, options.reclaim?.id),
      autoNamed: !isTopLevelAgent(options) ? undefined : options.autoNamed,
      status: options.isBackground ? "queued" : "running",
      toolUses: 0,
      startedAt: Date.now(),
      abortController,
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 },
      ownUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 },
      compactionCount: 0,
      isBackground: options.isBackground,
      blocking: options.blocking,
      invocation: options.invocation,
      depth: options.depth ?? 1,
      parentAgentId: options.parentAgentId,
      workflowId: options.workflowId,
      maxSubagentDepth: options.maxSubagentDepth,
      rootSessionId: options.rootSessionId,
      // A reopen continues this file until its session says otherwise (a fork
      // gets its own, set at session creation). Seeded so a run that fails
      // before it has a session still names the conversation in its saved
      // record and tombstone: without it, the next resume would be refused as
      // never saved.
      sessionFile: options.resumeSessionFile,
      spawnPrompt: prompt,
    };
    this.registry.agents.set(id, record);
    if (record.alias === undefined && isTopLevelAgent(options)) {
      if (options.name !== undefined && options.name.trim() !== "") {
        record.alias = assignHandle(handleBase(options.name), this.registry.takenHandles());
      }
    }

    const args: SpawnArgs = { pi, ctx, type, prompt, options };
    const pool = this.pool.poolFor(record);
    if (pool !== undefined && !options.bypassQueue && !this.pool.poolHasRoom(pool)) {
      record.status = "queued";
      if (!this.pool.armQueuedAbort(record, options.signal, () => this.abort(id))) return id;
      let release!: () => void;
      record.startGate = new Promise<void>(resolve => { release = resolve; });
      this.pool.queue.push({
        id,
        pool,
        start: () => this.launch(id, record, args, pool),
        release: () => release(),
      });
      options.onQueued?.(id, this.pool.queue.filter(e => e.pool === pool).length - 1);
      return id;
    }

    this.launch(id, record, args, undefined);
    return id;
  }

  private launch(id: string, record: AgentRecord, args: SpawnArgs, queuedPool: Pool | undefined): Promise<void> {
    const startup = this.startAgent(id, record, args).then(
      () => { this.startups.delete(id); },
      (err) => {
        this.startups.delete(id);
        // Waiters may still hold this object after it leaves the registry.
        // Always make startup failure terminal before notifying or removing it.
        record.status = "error";
        record.error = err instanceof Error ? err.message : String(err);
        record.completedAt = Date.now();
        record.blocking = false;
        this.pool.detachParentAbort(record);
        this.pool.releaseSlot(record);
        try {
          if (queuedPool !== undefined) {
            if (queuedPool === "foreground") record.resultConsumed = true;
            this.onComplete?.(record);
          } else {
            this.registry.agents.delete(id);
          }
        } catch (callbackError) {
          console.error("[pi-subagents-hub] startup completion callback failed:", callbackError);
        } finally {
          this.drainQueue();
        }
        throw err;
      },
    );
    this.startups.set(id, startup);
    return startup.catch(() => {});
  }

  awaitStartup(id: string): Promise<void> {
    return this.startups.get(id) ?? Promise.resolve();
  }

  private async startAgent(
    id: string,
    record: AgentRecord,
    { pi, ctx, type, prompt, options }: SpawnArgs,
  ) {
    assertValidSpawnCwd(options.cwd);
    const customCwd = options.cwd ?? undefined;
    const baseCwd = customCwd ?? ctx.cwd;

    record.chargedPool = this.pool.poolFor(record);
    record.status = "running";
    record.startedAt = Date.now();
    record.startGate = undefined;
    this.pool.acquireSlot(record);

    // mentions pass none, and RPC forwards only its caller's value. Workflow
    // children are the exception, as in Claude Code, whose workflow agent()
    // reads only the script's option and ignores the definition's.
    // A reopen never gets a worktree, as in Claude Code: a fresh copy of HEAD
    // would not hold the earlier run's edits, and a reopen whose old worktree
    // held any is refused before it gets here (`reopenTarget`).
    const isolation = options.resumeSessionFile !== undefined
      ? undefined
      : options.workflowId !== undefined
        ? options.isolation
        : getAgentConfig(type)?.isolation ?? options.isolation;
    let worktreeCwd: string | undefined;
    if (isolation === "worktree") {
      try {
        const wtSetup = await this.worktrees.setup(pi, baseCwd, id, customCwd);
        if (wtSetup) {
          record.worktree = wtSetup.wt;
          worktreeCwd = wtSetup.worktreeCwd;
          record.invocation ??= {};
          record.invocation.isolation = "worktree";

          if (record.status !== "running") {
            this.pool.releaseSlot(record);
            await this.worktrees.cleanup(pi, baseCwd, record, {
              description: options.description,
              customCwd,
            });
            this.drainQueue();
            return;
          }
        }
      } catch (err) {
        this.pool.releaseSlot(record);
        throw err;
      }
    }

    try { this.onStart?.(record); } catch (err) {
      console.error("[pi-subagents-hub] start callback failed:", err);
    }

    if (options.signal?.aborted) this.abort(id);
    else this.pool.armParentAbort(record, options.signal, () => this.abort(id));
    const detach = () => this.pool.detachParentAbort(record);

    const promise = runAgent(ctx, type, prompt, {
      pi,
      agentId: id,
      model: options.model,
      maxTurns: options.maxTurns,
      isolated: options.isolated,
      inheritContext: options.inheritContext,
      thinkingLevel: options.thinkingLevel,
      structuredOutput: options.structuredOutput,
      resumeSessionFile: options.resumeSessionFile,
      nested: options.parentAgentId !== undefined,
      workflow: options.workflowId !== undefined,
      cwd: worktreeCwd ?? customCwd,
      worktreeBase: worktreeCwd ? baseCwd : undefined,
      configCwd: options.configCwd ?? (customCwd !== undefined ? ctx.cwd : undefined),
      signal: record.abortController!.signal,
      onToolActivity: (activity) => {
        countToolUse(record, activity);
        options.onToolActivity?.(activity);
      },
      onTurnEnd: options.onTurnEnd,
      onTextDelta: options.onTextDelta,
      onAssistantUsage: (usage) => {
        addUsage(record.lifetimeUsage, usage);
        addUsage(record.ownUsage, usage);
        this.onUsage?.(record, usage);
        options.onAssistantUsage?.(usage);
      },
      onCompaction: (info) => {
        record.compactionCount++;
        this.onCompact?.(record, info);
        options.onCompaction?.(info);
      },
      nestedRuntime: {
        manager: this,
        parentAgentId: id,
        depth: record.depth ?? 1,
        maxSubagentDepth: record.maxSubagentDepth,
      },
      onSessionCreated: (session) => {
        record.session = session;
        installPauseGate(record as GatedRecord, session);
        record.sessionFile = session.sessionManager?.getSessionFile?.();
        if (session.model) {
          record.invocation ??= {};
          const requested = record.invocation.requestedThinking ?? record.invocation.thinking;
          Object.assign(record.invocation, describeModel(session.model));
          if (session.thinkingLevel) {
            record.invocation.thinking = session.thinkingLevel;
            if (requested && requested !== session.thinkingLevel) {
              record.invocation.requestedThinking = requested;
            }
          }
        }
        if (record.pendingSteers?.length) {
          const queued = record.pendingSteers;
          record.pendingSteers = undefined;
          // A steer accepted before the session existed was only queued, so a
          // failed delivery stays on the record: the caller was told it was
          // accepted, and the next session creation or resume retries it.
          void Promise.allSettled(
            queued.map(async (msg) => {
              try {
                await session.steer(msg);
              } catch (err) {
                console.error("[pi-subagents-hub] queued steer failed:", err);
                throw err;
              }
            }),
          ).then((results) => {
            const retained = queued.filter((_, index) => results[index].status === "rejected");
            if (retained.length) record.pendingSteers = [...retained, ...(record.pendingSteers ?? [])];
          });
        }
        options.onSessionCreated?.(session);
      },
    })
      .then(async ({ responseText, session, aborted, steered, failure, structuredJson, structuredRetried }) => {
        settleOutcome(record, { text: responseText, failure, aborted, steered });
        record.structuredJson = structuredJson;
        record.structuredRetried = structuredRetried;
        record.session = session;
        detach();

        if (record.outputCleanup) {
          try { record.outputCleanup(); } catch { /* ignore */ }
          record.outputCleanup = undefined;
        }

        try {
          await this.worktrees.cleanup(pi, baseCwd, record, {
            description: options.description,
            customCwd,
            onBeforeWorktreeCleanup: options.onBeforeWorktreeCleanup,
          });
        } catch (cleanupError) {
          console.error("[pi-subagents-hub] worktree cleanup failed:", cleanupError);
        }

        this.abortOwnedChildren(id);
        this.settleRun(record);
        return responseText;
      })
      .catch(async (err) => {
        if (!externallyHalted(record)) {
          record.status = "error";
        }
        record.error = err instanceof Error ? err.message : String(err);
        record.completedAt ??= Date.now();
        for (const q of record.questions ?? []) {
          if (q.state === "open" || q.state === "delivered") q.state = "dropped";
        }
        detach();

        if (record.outputCleanup) {
          try { record.outputCleanup(); } catch { /* ignore */ }
          record.outputCleanup = undefined;
        }

        try {
          await this.worktrees.cleanup(pi, baseCwd, record, {
            description: options.description,
            customCwd,
          });
        } catch (cleanupError) {
          console.error("[pi-subagents-hub] worktree cleanup failed:", cleanupError);
        }

        this.abortOwnedChildren(id);
        this.settleRun(record);
        return "";
      });

    record.promise = promise;
    try { options.onSpawned?.(id); } catch (err) {
      console.error("[pi-subagents-hub] spawned callback failed:", err);
    }
  }

  private settleRun(record: AgentRecord): void {
    releaseGate(record);
    if (!record.isBackground) record.resultConsumed = true;
    record.blocking = false;
    const pool = record.chargedPool;
    this.pool.releaseSlot(record);

    try {
      this.onComplete?.(record);
    } catch (err) {
      console.error("[pi-subagents-hub] completion callback failed:", err);
    } finally {
      if (record.isBackground || pool !== undefined) this.drainQueue();
    }
  }

  private abortOwnedChildren(parentId: string): void {
    for (const [id, record] of this.registry.agents) {
      if (record.parentAgentId === parentId) this.abort(id);
    }
  }

  async spawnAndWait(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    type: SubagentType,
    prompt: string,
    options: Omit<SpawnOptions, "isBackground">,
    onSpawned?: (id: string) => void,
  ): Promise<{ id: string; record: AgentRecord }> {
    const id = this.spawn(pi, ctx, type, prompt, {
      ...options,
      isBackground: false,
      blocking: true,
      onSpawned,
    });
    const record = this.registry.agents.get(id)!;

    if (record.status === "queued") await record.startGate;
    await this.awaitStartup(id);
    if (record.promise) await record.promise;

    if (record.promise === undefined && record.status === "error") {
      throw new Error(record.error ?? "Agent failed to start");
    }
    return { id, record };
  }

  sendToBackground(id: string): boolean {
    const record = this.registry.agents.get(id);
    if (!record?.blocking || !isTopLevelAgent(record) || record.status !== "running" || !record.promise) return false;

    this.pool.detachParentAbort(record);
    this.pool.releaseSlot(record);
    record.chargedPool = "background";
    this.pool.acquireSlot(record);
    record.blocking = false;
    record.isBackground = true;
    record.resultConsumed = false;
    this.drainQueue();
    return true;
  }

  private resumeDeps(): ResumeDeps {
    return {
      registry: this.registry,
      pool: this.pool,
      unpause: (id: string) => this.unpause(id),
      abort: (id: string) => this.abort(id),
      drainQueue: () => this.drainQueue(),
      abortOwnedChildren: (id: string) => this.abortOwnedChildren(id),
      onComplete: this.onComplete,
      onStart: this.onStart,
      onUsage: this.onUsage,
      onCompact: this.onCompact,
    };
  }

  async resume(
    id: string,
    prompt?: string,
    signal?: AbortSignal,
    options?: ResumeOptions,
  ): Promise<AgentRecord | undefined> {
    return resumeRecord(this.resumeDeps(), id, prompt, signal, options);
  }

  async steer(id: string, message: string): Promise<boolean> {
    const record = this.registry.agents.get(id);
    if (!record) return false;
    if (record.status !== "running" && record.status !== "queued") return false;
    if (record.session) {
      await record.session.steer(message);
    } else {
      if (!record.pendingSteers) record.pendingSteers = [];
      record.pendingSteers.push(message);
    }
    try { this.onSteered?.(record, message); } catch (err) {
      console.error("[pi-subagents-hub] steered callback failed:", err);
    }
    return true;
  }

  getRecord(id: string): AgentRecord | undefined {
    return this.registry.agents.get(id);
  }

  /**
   * `name`, if a reopened agent can take it back. Within one activation that is
   * always so — tombstoned names are never allocated (`takenHandles`) — but a
   * resume after a reload reopens from the session's saved record, with no
   * tombstone holding the name, so a fresh agent may have taken it since. A
   * name held by a live record, or by another agent's tombstone, stays with
   * its holder and the reopened agent gets a fresh one.
   *
   * `id` is the agent being reopened, when it keeps its own: its tombstone is
   * the one holding the name, legitimately. The `@handle` path keeps no id and
   * reopens exactly the tombstone that holds the name, so it skips that check.
   */
  private reclaimable(name: string | undefined, id: string | undefined): string | undefined {
    if (name === undefined) return undefined;
    for (const record of this.registry.agents.values()) {
      if (record.handle === name || record.alias === name) return undefined;
    }
    if (id !== undefined) {
      for (const entry of this.registry.tombstones.values()) {
        if (entry.id !== id && (entry.handle === name || entry.alias === name)) return undefined;
      }
    }
    return name;
  }

  resolveMention(name: string): MentionResolution | undefined {
    return this.registry.resolveMention(name);
  }

  dropTombstone(handle: string): void {
    this.registry.dropTombstone(handle);
  }

  listTombstones(): AgentTombstone[] {
    return this.registry.listTombstones();
  }

  listAgents(): AgentRecord[] {
    return this.registry.listAgents();
  }

  abort(id: string): boolean {
    const record = this.registry.agents.get(id);
    if (!record) return false;

    if (record.status === "queued") {
      this.dequeue(q => q.id === id);
      record.status = "stopped";
      record.completedAt = Date.now();
      if (!record.promise) record.resultConsumed = true;
      this.pool.detachParentAbort(record);
      this.stopGatedRun(record);
      return true;
    }

    if (record.status !== "running") return false;
    record.abortController?.abort();
    record.status = "stopped";
    record.completedAt = Date.now();
    return true;
  }

  pause(id: string): boolean {
    const record = this.registry.agents.get(id);
    if (!record) return false;
    if (this.startups.has(id) || record.worktree || record.isBackground === false) return false;

    if (record.status === "queued") {
      const i = this.pool.queue.findIndex(e => e.id === id);
      if (i !== -1) {
        const [entry] = this.pool.queue.splice(i, 1);
        if (gateOf(record)?.closed) entry.release();
        else this.pool.pausedQueued.set(id, entry);
      }
      record.status = "paused";
      record.completedAt = Date.now();
      return true;
    }

    if (record.status !== "running") return false;
    (record as GatedRecord).pauseGate = createPauseGate();
    installPauseGate(record as GatedRecord, record.session);
    record.status = "paused";
    record.completedAt = Date.now();
    const freed = record.slotHeld;
    this.pool.releaseSlot(record);
    if (freed) this.drainQueue();
    return true;
  }

  unpause(id: string): boolean {
    const record = this.registry.agents.get(id);
    if (record?.status !== "paused" || record.session) return false;
    const entry = this.pool.pausedQueued.get(id);
    if (!entry) return false;
    this.pool.pausedQueued.delete(id);
    record.status = "queued";
    record.completedAt = undefined;
    this.pool.queue.push(entry);
    this.drainQueue();
    return true;
  }

  private cleanupOutput(record: AgentRecord): void {
    if (!record.outputCleanup) return;
    try { record.outputCleanup(); } catch { /* ignore */ }
    record.outputCleanup = undefined;
  }

  private removeRecord(id: string, record: AgentRecord): void {
    releaseGate(record);
    record.abortController?.abort();
    this.cleanupOutput(record);
    this.registry.tombstone(record);
    const session = record.session;
    record.session = undefined;
    this.registry.agents.delete(id);
    this.pool.pausedQueued.delete(id);
    this.startups.delete(id);
    void shutdownChildSession(session);
  }

  private cleanup() {
    const cutoff = Date.now() - 10 * 60_000;
    for (const [id, record] of this.registry.agents) {
      if (record.status === "running" || record.status === "queued" || record.status === "paused") continue;
      if ((record.completedAt ?? 0) >= cutoff) continue;
      // Retain unconsumed results: the timer bounds memory after a result is
      // read, it does not expire a result the model has not retrieved yet.
      if (!record.resultConsumed) continue;
      this.removeRecord(id, record);
    }
  }

  /**
   * Called on session start/switch so tasks from a prior session don't persist.
   * Pass skipUnconsumed=true to preserve records the LLM hasn't read yet
   * (resultConsumed=false); the 10-minute cleanup timer evicts them once read.
   * A nested child is spared only while its parent stays: the parent is its
   * only reader, and nothing marks it consumed when the parent collects it.
   */
  clearCompleted(skipUnconsumed = false): void {
    for (const [id, record] of this.registry.agents) {
      if (record.status === "running" || record.status === "queued") continue;
      if (skipUnconsumed && !record.resultConsumed) continue;
      this.removeRecord(id, record);
    }
    // One pass reaches grandchildren too: the map is in spawn order, so a
    // parent is visited, and removed, before its children. A paused child is
    // user intent, not a settled result, so it stays for /continue.
    for (const [id, record] of this.registry.agents) {
      if (record.status === "running" || record.status === "queued" || record.status === "paused") continue;
      if (record.parentAgentId === undefined || this.registry.agents.has(record.parentAgentId)) continue;
      this.removeRecord(id, record);
    }
    this.registry.clearTombstones();
  }

  hasRunning(): boolean {
    return this.registry.hasRunning();
  }

  abortAll(): number {
    let count = 0;
    for (const queued of this.pool.queue) {
      const record = this.registry.agents.get(queued.id);
      if (!record || record.status !== "queued") continue;
      record.status = "stopped";
      record.completedAt = Date.now();
      if (!record.promise) record.resultConsumed = true;
      this.pool.detachParentAbort(record);
      this.stopGatedRun(record);
      count++;
    }
    this.dequeue(() => true);
    for (const record of this.registry.agents.values()) {
      if (record.status === "running") {
        record.abortController?.abort();
        record.status = "stopped";
        record.completedAt = Date.now();
        count++;
      }
    }
    return count;
  }

  async waitForAll(): Promise<void> {
    while (true) {
      this.drainQueue();
      const pending: Promise<unknown>[] = [];
      for (const record of this.registry.agents.values()) {
        if (record.status !== "running" && record.status !== "queued") continue;
        const startup = this.startups.get(record.id);
        if (startup) pending.push(startup);
        if (record.promise) pending.push(record.promise);
      }
      if (pending.length === 0) break;
      await Promise.allSettled(pending);
    }
  }

  takenHandles(): ReadonlySet<string> {
    return this.registry.takenHandles();
  }

  async dispose(pi?: ExtensionAPI): Promise<void> {
    clearInterval(this.cleanupInterval);
    this.dequeue(() => true);
    const records = [...this.registry.agents.values()];
    const sessions = records.map(record => {
      this.cleanupOutput(record);
      return record.session;
    });
    this.registry.agents.clear();
    this.startups.clear();
    this.pool.pausedQueued.clear();
    if (pi) {
      this.worktrees.pruneAll(pi);
    }
    await Promise.all(sessions.map(session => shutdownChildSession(session)));
  }
}
