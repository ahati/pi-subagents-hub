/**
 * agent-manager.ts — Tracks agents, background execution, resume support.
 *
 * Modularized facade orchestrating ConcurrencyPool, AgentRegistry, and ResumeHandler.
 */

import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { runAgent } from "./agent-runner.js";
import { getAgentConfig } from "./agent-types.js";
import { AgentRegistry } from "./manager/agent-registry.js";
import { ConcurrencyPool } from "./manager/concurrency-pool.js";
import {
  assertValidSpawnCwd,
  createPauseGate,
  DEFAULT_MAX_CONCURRENT,
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
import { assignHandle, handleBase } from "./mention.js";
import { describeModel } from "./model-resolver.js";
import type { AgentRecord, AgentTombstone, MentionResolution, SubagentType } from "./types.js";
import { addUsage } from "./usage.js";
import { cleanupWorktree, createWorktree, isWorktreeIsolationEnabled, pruneWorktrees } from "./worktree.js";

export * from "./manager/agent-registry.js";
export * from "./manager/concurrency-pool.js";
export * from "./manager/manager-types.js";
export * from "./manager/resume-handler.js";

export class AgentManager {
  private readonly registry = new AgentRegistry();
  private readonly pool: ConcurrencyPool;
  private cleanupInterval: ReturnType<typeof setInterval>;
  private onComplete?: OnAgentComplete;
  private onStart?: OnAgentStart;
  private onCompact?: OnAgentCompact;
  private onUsage?: OnAgentUsage;
  private onSteered?: OnAgentSteered;
  private worktreeRepos = new Set<string>();
  private startups = new Map<string, Promise<void>>();

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

    const id = randomUUID().slice(0, 17);
    const abortController = new AbortController();
    const record: AgentRecord = {
      id,
      type,
      handle: !isTopLevelAgent(options)
        ? undefined
        : options.reclaim?.handle ?? assignHandle(handleBase(type), this.registry.takenHandles()),
      description: options.description,
      alias: isTopLevelAgent(options) ? options.reclaim?.alias : undefined,
      status: options.isBackground ? "queued" : "running",
      toolUses: 0,
      startedAt: Date.now(),
      abortController,
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0, cost: 0 },
      compactionCount: 0,
      isBackground: options.isBackground,
      blocking: options.blocking,
      invocation: options.invocation,
      depth: options.depth ?? 1,
      parentAgentId: options.parentAgentId,
      workflowId: options.workflowId,
      maxSubagentDepth: options.maxSubagentDepth,
      rootSessionId: options.rootSessionId,
      spawnPrompt: prompt,
    };
    this.registry.agents.set(id, record);
    if (record.handle !== undefined && record.alias === undefined && options.name !== undefined) {
      record.alias = assignHandle(handleBase(options.name), this.registry.takenHandles());
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
        if (queuedPool !== undefined) {
          if (queuedPool === "foreground") record.resultConsumed = true;
          record.status = "error";
          record.error = err instanceof Error ? err.message : String(err);
          record.completedAt = Date.now();
          this.onComplete?.(record);
        } else {
          this.registry.agents.delete(id);
        }
        this.drainQueue();
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

    const isolation = options.workflowId !== undefined
      ? options.isolation
      : getAgentConfig(type)?.isolation ?? options.isolation;
    let worktreeCwd: string | undefined;
    if (isolation === "worktree" && isWorktreeIsolationEnabled()) {
      const wt = await createWorktree(pi, baseCwd, id);
      if (!wt) {
        this.pool.releaseSlot(record);
        throw new Error(
          'Cannot run with isolation: "worktree" — not a git repo, no commits yet, or `git worktree add` failed. ' +
          'Initialize git and commit at least once, or omit `isolation`.',
        );
      }
      record.worktree = wt;
      worktreeCwd = customCwd !== undefined ? wt.workPath : wt.path;
      this.worktreeRepos.add(baseCwd);
      record.invocation ??= {};
      record.invocation.isolation = "worktree";

      if (record.status !== "running") {
        this.pool.releaseSlot(record);
        record.worktreeResult = await cleanupWorktree(pi, baseCwd, wt, options.description);
        this.drainQueue();
        return;
      }
    }

    this.onStart?.(record);

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
        if (activity.type === "end") record.toolUses++;
        options.onToolActivity?.(activity);
      },
      onTurnEnd: options.onTurnEnd,
      onTextDelta: options.onTextDelta,
      onAssistantUsage: (usage) => {
        addUsage(record.lifetimeUsage, usage);
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
          for (const msg of record.pendingSteers) {
            session.steer(msg).catch(() => {});
          }
          record.pendingSteers = undefined;
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

        if (record.worktree) {
          if (options.onBeforeWorktreeCleanup) {
            try {
              await options.onBeforeWorktreeCleanup(record.worktree.path);
            } catch { /* ignore */ }
          }
          const wtResult = await cleanupWorktree(pi, baseCwd, record.worktree, options.description);
          record.worktreeResult = wtResult;
          if (wtResult.hasChanges && wtResult.branch) {
            const repoNote = customCwd !== undefined ? ` in \`${baseCwd}\`` : "";
            record.result = (record.result ?? "") +
              `\n\n---\nChanges saved to branch \`${wtResult.branch}\`${repoNote}. Merge with: \`git merge ${wtResult.branch}\`${customCwd !== undefined ? ` (run in \`${baseCwd}\`)` : ""}`;
          }
        }

        this.abortOwnedChildren(id);
        this.settleRun(record, true);
        return responseText;
      })
      .catch(async (err) => {
        if (!externallyHalted(record)) {
          record.status = "error";
        }
        record.error = err instanceof Error ? err.message : String(err);
        record.completedAt ??= Date.now();
        detach();

        if (record.outputCleanup) {
          try { record.outputCleanup(); } catch { /* ignore */ }
          record.outputCleanup = undefined;
        }

        if (record.worktree) {
          try {
            const wtResult = await cleanupWorktree(pi, baseCwd, record.worktree, options.description);
            record.worktreeResult = wtResult;
          } catch { /* ignore */ }
        }

        this.abortOwnedChildren(id);
        this.settleRun(record, false);
        return "";
      });

    record.promise = promise;
    options.onSpawned?.(id);
  }

  private settleRun(record: AgentRecord, guardCallback: boolean): void {
    releaseGate(record);
    if (!record.isBackground) record.resultConsumed = true;
    record.blocking = false;
    const pool = record.chargedPool;
    this.pool.releaseSlot(record);

    if (guardCallback) {
      try { this.onComplete?.(record); } catch { /* ignore */ }
    } else {
      this.onComplete?.(record);
    }

    if (record.isBackground || pool !== undefined) this.drainQueue();
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

  steer(id: string, message: string): boolean {
    const record = this.registry.agents.get(id);
    if (!record) return false;
    if (record.status !== "running" && record.status !== "queued") return false;
    if (record.session) {
      record.session.steer(message).catch(() => {});
    } else {
      if (!record.pendingSteers) record.pendingSteers = [];
      record.pendingSteers.push(message);
    }
    this.onSteered?.(record, message);
    return true;
  }

  getRecord(id: string): AgentRecord | undefined {
    return this.registry.agents.get(id);
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

  private removeRecord(id: string, record: AgentRecord): void {
    releaseGate(record);
    record.abortController?.abort();
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

  clearCompleted(skipUnconsumed = false): void {
    for (const [id, record] of this.registry.agents) {
      if (record.status === "running" || record.status === "queued") continue;
      if (skipUnconsumed && !record.resultConsumed) continue;
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

  async dispose(pi?: ExtensionAPI): Promise<void> {
    clearInterval(this.cleanupInterval);
    this.dequeue(() => true);
    const sessions = [...this.registry.agents.values()].map(record => record.session);
    this.registry.agents.clear();
    this.startups.clear();
    this.pool.pausedQueued.clear();
    if (pi) {
      const prune = (repo: string) => { pruneWorktrees(pi, repo).catch(() => {}); };
      prune(process.cwd());
      for (const repo of this.worktreeRepos) prune(repo);
    }
    await Promise.all(sessions.map(session => shutdownChildSession(session)));
  }
}
