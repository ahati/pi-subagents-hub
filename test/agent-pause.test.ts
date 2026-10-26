import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";

vi.mock("../src/agent-runner.js", () => ({
  runAgent: vi.fn(),
  resumeAgent: vi.fn(),
}));

vi.mock("../src/worktree.js", () => ({
  createWorktree: vi.fn(),
  cleanupWorktree: vi.fn(() => ({ hasChanges: false })),
  pruneWorktrees: vi.fn(),
  isWorktreeIsolationEnabled: vi.fn(() => true),
}));

import { resumeAgent, runAgent } from "../src/agent-runner.js";
import { createWorktree } from "../src/worktree.js";

// Mock history persists across tests in a file — the gate test's
// `resumeAgent` not-called assertion must not see earlier tests' calls.
beforeEach(() => {
  vi.mocked(runAgent).mockReset();
  vi.mocked(resumeAgent).mockReset();
});

const mockPi = {} as any;
const mockCtx = { cwd: "/tmp" } as any;

const mockSession = () => ({ dispose: vi.fn() } as any);

const runResult = (overrides: Record<string, unknown> = {}) =>
  ({
    responseText: "done",
    session: mockSession(),
    aborted: false,
    steered: false,
    ...overrides,
  }) as any;

describe("AgentManager — pause / unpause", () => {
  let manager: AgentManager;

  afterEach(() => {
    manager?.dispose();
  });

  /**
   * Spawn with a runAgent the test releases by hand, and wait out the
   * startup — spawn() returns synchronously but the startups entry (which
   * pause() refuses on) clears a microtask later, so a reachable pause point
   * is always past awaitStartup.
   */
  async function spawnHeld(options: { isBackground?: boolean } = {}, prompt = "task") {
    let release!: (value: ReturnType<typeof runResult>) => void;
    vi.mocked(runAgent).mockImplementation(
      () => new Promise<ReturnType<typeof runResult>>(resolve => { release = resolve; }),
    );
    const id = manager.spawn(mockPi, mockCtx, "X", prompt, {
      description: prompt,
      ...options,
    });
    await manager.awaitStartup(id);
    return { id, release };
  }

  /**
   * A fake child session carrying the slots the runner wraps with the record's
   * pause gate (the same shape agent-runner.test.ts fakes): `agent.beforeToolCall`
   * and `agent.finishTurn`, both pre-populated with the hooks the wrapper must
   * delegate to once the gate reopens.
   */
  function gateSession() {
    const priorBeforeToolCall = vi.fn(async () => ({ block: false }));
    const priorFinishTurn = vi.fn(async () => undefined);
    const session = {
      dispose: vi.fn(),
      abort: vi.fn(),
      steer: vi.fn().mockResolvedValue(undefined),
      subscribe: vi.fn(() => () => {}),
      messages: [],
      getActiveToolNames: vi.fn(() => []),
      agent: { beforeToolCall: priorBeforeToolCall, finishTurn: priorFinishTurn },
    } as any;
    return { session, priorBeforeToolCall, priorFinishTurn };
  }

  /**
   * Spawn a run the test releases by hand, handing the fake child session to
   * the manager through onSessionCreated — the moment a real runner installs
   * the record's gate on it.
   */
  async function spawnGated(session: any, prompt = "task") {
    let release!: (value: ReturnType<typeof runResult>) => void;
    vi.mocked(runAgent).mockImplementation(
      (_pi: any, _type: any, _prompt: any, opts: any) =>
        new Promise<ReturnType<typeof runResult>>(resolve => {
          release = resolve;
          opts.onSessionCreated?.(session);
        }),
    );
    const id = manager.spawn(mockPi, mockCtx, "X", prompt, { description: prompt, isBackground: true });
    await manager.awaitStartup(id);
    return { id, release };
  }

  /** The record's gate, as the manager exposes it for observation. */
  const gateOf = (id: string) => (manager.getRecord(id) as any)?.pauseGate as { closed: boolean } | undefined;

  it("pauses a running agent, and the settle keeps 'paused'", async () => {
    manager = new AgentManager();
    const { id, release } = await spawnHeld({ isBackground: true });
    expect(manager.pause(id)).toBe(true);
    const record = manager.getRecord(id)!;
    expect(record.status).toBe("paused");
    // The run settles as an abort would — but externallyHalted must keep the
    // status pause() chose, or a later resume could not be told apart from a
    // run that died mid-turn.
    release(runResult({ aborted: true, responseText: "partial" }));
    await record.promise;
    expect(record.status).toBe("paused");
    expect(record.result).toBe("partial");
    expect(record.completedAt).toBeDefined();
  });

  it("fires onComplete once, with the paused status", async () => {
    const seen: string[] = [];
    manager = new AgentManager(r => { seen.push(r.status); });
    const { id, release } = await spawnHeld({ isBackground: true });
    manager.pause(id);
    release(runResult({ aborted: true }));
    await manager.getRecord(id)!.promise;
    expect(seen).toEqual(["paused"]);
  });

  it("pauses a queued agent: it never self-starts, unpause re-queues it", async () => {
    manager = new AgentManager(undefined, 1);
    const a = await spawnHeld({ isBackground: true }, "a");
    const b = manager.spawn(mockPi, mockCtx, "X", "b", { description: "b", isBackground: true });
    expect(manager.getRecord(b)!.status).toBe("queued");

    expect(manager.pause(b)).toBe(true);
    expect(manager.getRecord(b)!.status).toBe("paused");

    // A settles and frees the slot — but B's entry is parked, so the drain
    // that starts everything else must not start it.
    a.release(runResult({ responseText: "a-done" }));
    await manager.getRecord(a.id)!.promise;
    expect(manager.getRecord(b)!.status).toBe("paused");

    vi.mocked(runAgent).mockClear();
    vi.mocked(runAgent).mockResolvedValue(runResult({ responseText: "b-done" }));
    expect(manager.unpause(b)).toBe(true);
    expect(manager.getRecord(b)!.status).toBe("running");
    await manager.getRecord(b)!.promise;
    expect(manager.getRecord(b)!.status).toBe("completed");
    // The parked queue entry replays verbatim: the re-queued run gets B's
    // original prompt, not some continuation stand-in.
    expect(vi.mocked(runAgent).mock.calls.at(-1)![2]).toBe("b");
  });

  it("refuses to pause a foreground agent", async () => {
    manager = new AgentManager();
    const { id, release } = await spawnHeld({ isBackground: false });
    expect(manager.pause(id)).toBe(false);
    expect(manager.getRecord(id)!.status).toBe("running");
    release(runResult());
    await manager.getRecord(id)!.promise;
  });

  it("refuses to pause a worktree-isolated agent", async () => {
    manager = new AgentManager();
    const { id, release } = await spawnHeld({ isBackground: true });
    const record = manager.getRecord(id)!;
    // Settled worktree agents keep the field; the settle path commits and
    // removes the tree, and a resumed session would hold tools bound to a
    // deleted directory.
    record.worktree = { path: "/tmp/wt" } as any;
    expect(manager.pause(id)).toBe(false);
    expect(record.status).toBe("running");
    release(runResult({ aborted: true }));
    await record.promise;
  });

  it("refuses to pause while startup is in flight (worktree copy)", async () => {
    // A never-resolving copy: the agent is "running" with no session and no
    // queue entry, so "paused" could never be lifted.
    vi.mocked(createWorktree).mockImplementation(() => new Promise(() => {}));
    manager = new AgentManager();
    const id = manager.spawn(mockPi, mockCtx, "X", "task", {
      description: "task",
      isBackground: true,
      isolation: "worktree",
    });
    expect(manager.pause(id)).toBe(false);
  });

  it("refuses to pause a settled agent", async () => {
    manager = new AgentManager();
    const { id, release } = await spawnHeld({ isBackground: true });
    release(runResult());
    await manager.getRecord(id)!.promise;
    expect(manager.pause(id)).toBe(false);
    expect(manager.getRecord(id)!.status).toBe("completed");
  });

  it("leaves session-bearing paused records to resume(): unpause returns false", async () => {
    manager = new AgentManager();
    const { id, release } = await spawnHeld({ isBackground: true });
    manager.pause(id);
    release(runResult({ aborted: true }));
    await manager.getRecord(id)!.promise;
    expect(manager.getRecord(id)!.session).toBeDefined();
    expect(manager.unpause(id)).toBe(false);
  });

  it("resume after pause completes the same record, sending no continuation prompt", async () => {
    manager = new AgentManager();
    const { id, release } = await spawnHeld({ isBackground: true });
    manager.pause(id);
    release(runResult({ aborted: true }));
    await manager.getRecord(id)!.promise;
    const session = manager.getRecord(id)!.session;

    vi.mocked(resumeAgent).mockResolvedValue({ text: "ok" } as any);
    const record = await manager.resume(id);
    expect(record?.status).toBe("completed");
    expect(record?.result).toBe("ok");

    // Bare resume: the session's own transcript continues, so resumeAgent gets
    // an options object — never a prompt, and never a third argument.
    expect(vi.mocked(resumeAgent)).toHaveBeenCalledWith(session, expect.anything());
    const call = vi.mocked(resumeAgent).mock.calls.at(-1)!;
    expect(call).toHaveLength(2);
    expect(JSON.stringify(call)).not.toContain("Continue from where you left off.");
  });

  it("pause closes a gate instead of aborting, and resume reopens it", async () => {
    manager = new AgentManager();
    const { session, priorBeforeToolCall, priorFinishTurn } = gateSession();
    const { id, release } = await spawnGated(session);
    const record = manager.getRecord(id)!;
    const controllerAbort = vi.spyOn(record.abortController!, "abort");

    expect(manager.pause(id)).toBe(true);
    // Synchronously parked; nothing is killed.
    expect(record.status).toBe("paused");
    expect(controllerAbort).not.toHaveBeenCalled();
    expect(record.abortController!.signal.aborted).toBe(false);
    expect(session.abort).not.toHaveBeenCalled();
    expect(gateOf(id)?.closed).toBe(true);

    // Neither boundary of the parked run may proceed: the wrapper the runner
    // installed on the child session holds both until resume opens the gate.
    let toolSettled = false;
    const toolCall = Promise.resolve(session.agent.beforeToolCall({ toolCall: { name: "read" } }))
      .then(() => { toolSettled = true; });
    let turnSettled = false;
    const finishTurn = Promise.resolve(session.agent.finishTurn({} as any))
      .then(() => { turnSettled = true; });
    await new Promise(r => setTimeout(r, 20));
    expect(toolSettled).toBe(false);
    expect(turnSettled).toBe(false);

    expect(await manager.resume(id)).toBeDefined();
    await Promise.all([toolCall, finishTurn]);
    expect(toolSettled).toBe(true);
    expect(turnSettled).toBe(true);
    expect(gateOf(id)?.closed).toBe(false);
    expect(record.status).toBe("running");
    // The suspended run simply continues; no new prompt is sent at the session.
    expect(vi.mocked(resumeAgent)).not.toHaveBeenCalled();

    // Once open, the wrapper passes through to the hook pi had there before.
    await session.agent.beforeToolCall({ toolCall: { name: "read" } });
    await session.agent.finishTurn({} as any);
    expect(priorBeforeToolCall).toHaveBeenCalledTimes(2);
    expect(priorFinishTurn).toHaveBeenCalledTimes(2);

    release(runResult({ responseText: "parked run finished" }));
    await record.promise;
  });

  it("releases a gated call when the run is aborted — the signal race", async () => {
    manager = new AgentManager();
    const { session } = gateSession();
    const { id, release } = await spawnGated(session);
    manager.pause(id);
    const record = manager.getRecord(id)!;

    let settled = false;
    const gated = Promise.resolve(session.agent.beforeToolCall({ toolCall: { name: "read" } }))
      .then(() => { settled = true; }, () => { settled = true; });
    await new Promise(r => setTimeout(r, 20));
    expect(settled).toBe(false); // held by the closed gate

    record.abortController!.abort();

    // A gate that ignored the signal would hang here forever — and with it pi's
    // abort path, which awaits the suspended call before the session can idle.
    const outcome = await Promise.race([
      gated.then(() => "settled" as const),
      new Promise<"pending">(r => setTimeout(() => r("pending"), 100)),
    ]);
    expect(outcome).toBe("settled");

    release(runResult({ aborted: true }));
    await record.promise;
    expect(record.status).toBe("paused");
  });

  it("abortAll leaves paused agents alone", async () => {
    manager = new AgentManager();
    const p = await spawnHeld({ isBackground: true }, "p");
    const r = await spawnHeld({ isBackground: true }, "r");
    expect(manager.pause(p.id)).toBe(true);

    expect(manager.abortAll()).toBe(1);
    expect(manager.getRecord(r.id)!.status).toBe("stopped");
    expect(manager.getRecord(p.id)!.status).toBe("paused");
    p.release(runResult());
    r.release(runResult());
    await Promise.allSettled([
      manager.getRecord(p.id)!.promise,
      manager.getRecord(r.id)!.promise,
    ]);
  });

  it("the 10-minute cleanup skips paused records", async () => {
    manager = new AgentManager();
    const p = await spawnHeld({ isBackground: true }, "p");
    manager.pause(p.id);
    const d = await spawnHeld({ isBackground: true }, "d");
    d.release(runResult());
    await manager.getRecord(d.id)!.promise;

    const stale = Date.now() - 11 * 60_000;
    // Only a consumed result is evicted by the retention timer.
    manager.getRecord(d.id)!.resultConsumed = true;
    manager.getRecord(p.id)!.completedAt = stale;
    manager.getRecord(d.id)!.completedAt = stale;
    (manager as any).cleanup();

    // Paused is exempt — evicting it would tombstone a conversation the user
    // explicitly parked. A completed record the same age goes.
    expect(manager.getRecord(p.id)).toBeDefined();
    expect(manager.getRecord(d.id)).toBeUndefined();
  });

  // The two describes below cover the parked-run slot accounting end to end:
  // the release at park time (and the settle that must not free twice), the
  // re-take on resume, and the queue a reopen waits in when the pool has filled
  // up in the meantime.

  /**
   * Runs released by hand, keyed by prompt, so a test can settle exactly one
   * agent at a time (spawnHeld's single `release` is overwritten as soon as a
   * drain starts the next agent). `sessionFor` hands one prompt's run the
   * fake child session, the moment the runner installs the record's gate.
   */
  function heldRuns(sessionFor?: { prompt: string; session: any }) {
    const releases = new Map<string, (value: any) => void>();
    vi.mocked(runAgent).mockImplementation((_pi: any, _type: any, prompt: any, opts: any) =>
      new Promise<any>(resolve => {
        releases.set(prompt as string, resolve);
        if (sessionFor?.prompt === prompt) opts.onSessionCreated?.(sessionFor.session);
      }),
    );
    return releases;
  }

  /** Spawn a held background run and wait out its startup. */
  async function spawnControlled(prompt: string) {
    const id = manager.spawn(mockPi, mockCtx, "X", prompt, { description: prompt, isBackground: true });
    await manager.awaitStartup(id);
    return id;
  }

  /** The ids in the manager's own queue, as the tests observe queue position. */
  const queuedIds = () => (manager as any).queue.map((e: { id: string }) => e.id) as string[];

  describe("pause() hands the slot back, resume() re-takes it", () => {
    it("pause() frees the slot a queued agent is waiting for", async () => {
      manager = new AgentManager(undefined, 1);
      const releases = heldRuns();
      const a = await spawnControlled("a");
      const b = await spawnControlled("b");
      expect(manager.getRecord(b)!.status).toBe("queued");

      expect(manager.pause(a)).toBe(true);

      // The release is what the drain is for: without it B waits out the whole
      // park, and since paused records are exempt from cleanup() — forever.
      expect(manager.getRecord(b)!.status).toBe("running");
      expect(vi.mocked(runAgent).mock.calls.at(-1)![2]).toBe("b");
      expect((manager as any).runningBackground).toBe(1);

      releases.get("a")!(runResult({ aborted: true }));
      await manager.getRecord(a)!.promise;
      releases.get("b")!(runResult());
      await manager.getRecord(b)!.promise;
    });

    it("a parked run's settle does not free a slot it no longer holds", async () => {
      manager = new AgentManager(undefined, 1);
      const releases = heldRuns();
      const a = await spawnControlled("a");
      const b = await spawnControlled("b");
      expect(manager.pause(a)).toBe(true);
      expect(manager.getRecord(b)!.status).toBe("running");

      // A dies while parked: its slot was already handed back, so the settle
      // must not decrement again — that underflows the counter and silently
      // lifts maxConcurrent.
      releases.get("a")!(runResult({ aborted: true }));
      await manager.getRecord(a)!.promise;
      expect(manager.getRecord(a)!.status).toBe("paused");

      const c = await spawnControlled("c");
      expect(manager.getRecord(c)!.status).toBe("queued");

      // ...and the slot is not lost either: B's settle still frees it.
      releases.get("b")!(runResult());
      await manager.getRecord(b)!.promise;
      expect(manager.getRecord(c)!.status).toBe("running");

      releases.get("c")!(runResult());
      await manager.getRecord(c)!.promise;
    });

    it("resume() reopens immediately when the pool has room, and takes the slot", async () => {
      manager = new AgentManager(undefined, 1);
      const { session } = gateSession();
      const releases = heldRuns({ prompt: "a", session });
      const a = await spawnControlled("a");
      expect(manager.pause(a)).toBe(true);

      // The parked run freed the slot, so a sibling starts while it is parked.
      const sibling = await spawnControlled("sibling");
      expect(manager.getRecord(sibling)!.status).toBe("running");

      releases.get("sibling")!(runResult());
      await manager.getRecord(sibling)!.promise;

      const resumed = await manager.resume(a);
      expect(resumed!.status).toBe("running");
      expect(gateOf(a)?.closed).toBe(false);
      expect(queuedIds()).not.toContain(a);
      // The gate reopen is the resume — no continuation prompt is sent.
      expect(vi.mocked(resumeAgent)).not.toHaveBeenCalled();

      // The boundary the gate held now proceeds.
      let toolSettled = false;
      const toolCall = Promise.resolve(session.agent.beforeToolCall({ toolCall: { name: "read" } }))
        .then(() => { toolSettled = true; });
      await toolCall;
      expect(toolSettled).toBe(true);

      releases.get("a")!(runResult({ responseText: "parked run finished" }));
      const record = await manager.getRecord(a)!.promise;
      expect(record).toBeDefined();
      expect(manager.getRecord(a)!.status).toBe("completed");
    });
  });

  describe("a full pool queues the reopen", () => {
    it("resume() queues the reopen when the pool is full", async () => {
      manager = new AgentManager(undefined, 1);
      const { session } = gateSession();
      const releases = heldRuns({ prompt: "a", session });
      const a = await spawnControlled("a");
      expect(manager.pause(a)).toBe(true);

      // B takes the slot back before A is resumed, so the reopen has to wait.
      const b = await spawnControlled("b");
      expect(manager.getRecord(b)!.status).toBe("running");

      let toolSettled = false;
      const toolCall = Promise.resolve(session.agent.beforeToolCall({ toolCall: { name: "read" } }))
        .then(() => { toolSettled = true; });

      const resumed = await manager.resume(a);
      expect(resumed!.status).toBe("queued");
      expect(gateOf(a)?.closed).toBe(true);
      expect(queuedIds()).toContain(a);
      await new Promise(r => setTimeout(r, 0));
      expect(toolSettled).toBe(false);

      releases.get("b")!(runResult());
      await manager.getRecord(b)!.promise;

      // The drain opens the gate: A continues in place, no continuation prompt.
      expect(manager.getRecord(a)!.status).toBe("running");
      expect(gateOf(a)?.closed).toBe(false);
      await toolCall;
      expect(toolSettled).toBe(true);
      expect(vi.mocked(resumeAgent)).not.toHaveBeenCalled();

      releases.get("a")!(runResult({ responseText: "a done" }));
      await manager.getRecord(a)!.promise;
      expect(manager.getRecord(a)!.status).toBe("completed");
    });

    it("a second resume() while the reopen is queued is a no-op", async () => {
      manager = new AgentManager(undefined, 1);
      const { session } = gateSession();
      const releases = heldRuns({ prompt: "a", session });
      const a = await spawnControlled("a");
      manager.pause(a);
      const b = await spawnControlled("b");
      await manager.resume(a);

      const again = await manager.resume(a);
      expect(again!.status).toBe("queued");
      // Exactly one reopen is queued — a second one would open the gate twice
      // (once per drain) or, worse, fall through to a full second execution.
      expect(queuedIds().filter(id => id === a)).toHaveLength(1);
      expect(vi.mocked(resumeAgent)).not.toHaveBeenCalled();

      releases.get("b")!(runResult());
      await manager.getRecord(b)!.promise;
      expect(queuedIds()).not.toContain(a);
      expect(manager.getRecord(a)!.status).toBe("running");

      releases.get("a")!(runResult());
      await manager.getRecord(a)!.promise;
    });

    it("abort() of a reopen-queued parked run stops the run, not just its queue position", async () => {
      manager = new AgentManager(undefined, 1);
      const { session } = gateSession();
      const releases = heldRuns({ prompt: "a", session });
      const a = await spawnControlled("a");
      manager.pause(a);
      await spawnControlled("b");
      await manager.resume(a);

      expect(manager.abort(a)).toBe(true);
      const record = manager.getRecord(a)!;
      expect(record.status).toBe("stopped");
      // Drop the entry AND stop the run: dropping alone would leave it parked at
      // a boundary nothing can reopen, invisible to every later abort().
      expect(gateOf(a)).toBeUndefined();
      expect(record.abortController!.signal.aborted).toBe(true);

      releases.get("a")!(runResult({ aborted: true }));
      await record.promise;
      expect(record.status).toBe("stopped");

      // No ghost slot was freed on the way out.
      const c = await spawnControlled("c");
      expect(manager.getRecord(c)!.status).toBe("queued");
    });

    it("abortAll() stops a reopen-queued parked run too", async () => {
      manager = new AgentManager(undefined, 1);
      const { session } = gateSession();
      const releases = heldRuns({ prompt: "a", session });
      const a = await spawnControlled("a");
      manager.pause(a);
      const b = await spawnControlled("b");
      await manager.resume(a);

      expect(manager.abortAll()).toBeGreaterThanOrEqual(2);
      expect(manager.getRecord(a)!.status).toBe("stopped");
      expect(gateOf(a)).toBeUndefined();
      expect(manager.getRecord(a)!.abortController!.signal.aborted).toBe(true);

      releases.get("a")!(runResult({ aborted: true }));
      releases.get("b")!(runResult({ aborted: true }));
      await Promise.all([manager.getRecord(a)!.promise, manager.getRecord(b)!.promise]);
      expect(manager.getRecord(a)!.status).toBe("stopped");
    });

    it("abortAll() leaves a reopen-queued parked run that settled alone", async () => {
      manager = new AgentManager(undefined, 1);
      const { session } = gateSession();
      const releases = heldRuns({ prompt: "a", session });
      const a = await spawnControlled("a");
      manager.pause(a);
      const b = await spawnControlled("b");
      await manager.resume(a);
      expect(manager.getRecord(a)!.status).toBe("queued");

      // The held run dies while its reopen waits in the queue: the record is
      // no longer "paused", so the settle records the outcome — and the stale
      // entry stays queued until a drain reaches it.
      releases.get("a")!(runResult({ aborted: true }));
      await manager.getRecord(a)!.promise;
      expect(manager.getRecord(a)!.status).toBe("aborted");
      expect(queuedIds()).toContain(a);

      // Only B was live: the stopped count and A's status both say the settled
      // record was not restamped "stopped" by the abort sweep.
      expect(manager.abortAll()).toBe(1);
      expect(manager.getRecord(a)!.status).toBe("aborted");
      expect(manager.getRecord(b)!.status).toBe("stopped");

      releases.get("b")!(runResult({ aborted: true }));
      await manager.getRecord(b)!.promise;
    });

    it("pause() cancels a queued reopen", async () => {
      manager = new AgentManager(undefined, 1);
      const { session } = gateSession();
      const releases = heldRuns({ prompt: "a", session });
      const a = await spawnControlled("a");
      manager.pause(a);
      const b = await spawnControlled("b");
      await manager.resume(a);
      expect(queuedIds()).toContain(a);

      expect(manager.pause(a)).toBe(true);
      expect(manager.getRecord(a)!.status).toBe("paused");
      // The reopen entry dies with the resume that queued it — only a spawn
      // that never started has something for unpause() to replay.
      expect(queuedIds()).not.toContain(a);
      expect((manager as any).pausedQueued.has(a)).toBe(false);
      expect(gateOf(a)?.closed).toBe(true);

      releases.get("b")!(runResult());
      await manager.getRecord(b)!.promise;

      await manager.resume(a);
      expect(manager.getRecord(a)!.status).toBe("running");
      expect(gateOf(a)?.closed).toBe(false);
      expect(queuedIds().filter(id => id === a)).toHaveLength(0);

      releases.get("a")!(runResult());
      await manager.getRecord(a)!.promise;
    });

    it("a nested child is never queued behind the pool", async () => {
      manager = new AgentManager(undefined, 1);
      const releases = heldRuns();
      const a = await spawnControlled("a");

      const child = manager.spawn(mockPi, mockCtx, "X", "child", {
        description: "child", isBackground: true, depth: 2, parentAgentId: a,
      });
      await manager.awaitStartup(child);
      // Takes no slot (poolFor) — queueing it behind its own parent would be a
      // guaranteed deadlock, not backpressure.
      expect(manager.getRecord(child)!.chargedPool).toBeUndefined();
      expect(manager.pause(child)).toBe(true);

      await manager.resume(child);
      expect(manager.getRecord(child)!.status).toBe("running");
      expect(queuedIds()).not.toContain(child);
      expect(gateOf(child)?.closed).toBe(false);

      const sibling = await spawnControlled("sibling");
      expect(manager.getRecord(sibling)!.status).toBe("queued");

      releases.get("child")!(runResult());
      releases.get("a")!(runResult());
      await Promise.all([manager.getRecord(child)!.promise, manager.getRecord(a)!.promise]);
      releases.get("sibling")!(runResult());
      await manager.getRecord(sibling)!.promise;
    });

    it("waitForAll() waits out a reopen-queued parked run", async () => {
      manager = new AgentManager(undefined, 1);
      const { session } = gateSession();
      const releases = heldRuns({ prompt: "a", session });
      const a = await spawnControlled("a");
      manager.pause(a);
      const b = await spawnControlled("b");
      await manager.resume(a);

      let settled = false;
      const done = manager.waitForAll().then(() => { settled = true; });
      // B started the moment A parked (the slot went back), so this release
      // exists — assert the start rather than relying on the incidental
      // TypeError of a missing release when it does not.
      expect(releases.has("b")).toBe(true);
      expect(manager.getRecord(b)!.status).toBe("running");
      releases.get("b")!(runResult());
      await manager.getRecord(b)!.promise;
      // The drain reopened A: waitForAll must keep waiting for the run the
      // queue was holding, not resolve with B alone.
      expect(manager.getRecord(a)!.status).toBe("running");
      await new Promise(r => setTimeout(r, 0));
      expect(settled).toBe(false);

      releases.get("a")!(runResult({ responseText: "a done" }));
      await done;
      expect(manager.getRecord(a)!.status).toBe("completed");
    });
  });
});
