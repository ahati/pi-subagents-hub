import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type EventBus, PROTOCOL_VERSION, type RpcDeps, registerRpcHandlers, type SpawnCapable } from "../src/cross-extension-rpc.js";
import { isScopeModelsEnabled, setScopeModelsEnabled } from "../src/model-scope.js";

/**
 * Hard-coded on purpose: the advertised capabilities are a contract, so this
 * must not be derived from the implementation's own list.
 */
const EXPECTED_CAPABILITIES = ["consume", "get", "list", "pause", "resume", "spawn", "steer", "stop"]; // sorted

/** Simple in-process event bus for testing. */
function createEventBus(): EventBus {
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  return {
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(handler);
      return () => { listeners.get(event)?.delete(handler); };
    },
    emit(event, data) {
      for (const handler of listeners.get(event) ?? []) handler(data);
    },
  };
}

/** Bus wrapper recording every channel something subscribed to. */
function createRecordingEventBus() {
  const bus = createEventBus();
  const channels = new Set<string>();
  return {
    bus: {
      on(event: string, handler: (data: unknown) => void) {
        channels.add(event);
        return bus.on(event, handler);
      },
      emit: bus.emit,
    },
    channels,
  };
}

/** A record shaped enough for `toSubagentInfo` to read. */
function record(over: Record<string, unknown> = {}) {
  return {
    id: "agent-42",
    type: "general-purpose",
    description: "x",
    status: "completed",
    toolUses: 0,
    startedAt: 0,
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    ownUsage: { input: 0, output: 0, cacheWrite: 0 },
    ...over,
  };
}

describe("cross-extension RPC", () => {
  let events: EventBus;
  let manager: SpawnCapable;
  let ctx: object | undefined;
  let deps: RpcDeps;

  beforeEach(() => {
    events = createEventBus();
    manager = {
      spawn: vi.fn().mockReturnValue("agent-42"),
      awaitStartup: vi.fn().mockResolvedValue(undefined),
      abort: vi.fn().mockReturnValue(true),
      pauseAgent: vi.fn().mockReturnValue(true),
      resumeAgent: vi.fn().mockResolvedValue(true),
      getRecord: vi.fn().mockReturnValue({}),
      listAgents: vi.fn().mockReturnValue([record()]),
      isNotificationPending: vi.fn().mockReturnValue(false),
      consumeResult: vi.fn().mockReturnValue(true),
      steer: vi.fn().mockResolvedValue(true),
    };
    ctx = { session: true };
    deps = { events, pi: { events }, getCtx: () => ctx, manager };
  });

  // --- ping ---

  describe("ping RPC", () => {
    it("replies with the protocol version and the wired capabilities", async () => {
      registerRpcHandlers(deps);
      const reply = vi.fn();
      events.on("subagents:rpc:ping:reply:req-1", reply);
      events.emit("subagents:rpc:ping", { requestId: "req-1" });

      await vi.waitFor(() => expect(reply).toHaveBeenCalled());
      const { data } = reply.mock.calls[0][0];
      expect(data.version).toBe(PROTOCOL_VERSION);
      // Sorted: the wire order is incidental, the set is the contract.
      expect([...data.capabilities].sort()).toEqual(EXPECTED_CAPABILITIES);
      expect(data.features).toEqual(expect.arrayContaining(["get", "list", "notification-pending"]));
    });

    it("advertises nothing it cannot answer — every capability has a live handler", async () => {
      registerRpcHandlers(deps);
      const pingReply = vi.fn();
      events.on("subagents:rpc:ping:reply:req-cap", pingReply);
      events.emit("subagents:rpc:ping", { requestId: "req-cap" });
      await vi.waitFor(() => expect(pingReply).toHaveBeenCalled());

      const capabilities: string[] = pingReply.mock.calls[0][0].data.capabilities;
      expect(Array.isArray(capabilities)).toBe(true);
      expect(capabilities.length).toBeGreaterThan(0);
      // Named payloads: a capability with no entry here is one this test does
      // not know how to exercise, and an advertised-but-unwired name times out.
      const payloads: Record<string, object> = {
        spawn: { type: "general-purpose", prompt: "x" },
        stop: { agentId: "agent-42" },
        pause: { agentId: "agent-42" },
        resume: { agentId: "agent-42" },
        consume: { agentId: "agent-42" },
        steer: { agentId: "agent-42", message: "x" },
        get: { agentId: "agent-42" },
        list: {},
      };

      for (const capability of capabilities) {
        const channel = `subagents:rpc:${capability}`;
        const requestId = `req-cap-${capability}`;
        const reply = vi.fn();
        events.on(`${channel}:reply:${requestId}`, reply);
        events.emit(channel, { requestId, ...payloads[capability] });

        await vi.waitFor(() => expect(reply).toHaveBeenCalled());
        // Success envelope only: most handlers return nothing, so `data` is
        // omitted by design (`handleRpc`).
        expect(reply.mock.calls[0][0].success).toBe(true);
      }
    });

    it("wires nothing the capabilities do not advertise", async () => {
      const { bus, channels } = createRecordingEventBus();
      registerRpcHandlers({ ...deps, events: bus });

      // Snapshot before any test-side listener: subscribing to a reply channel
      // would land in the recorded set too, and it is not a wired handler.
      const registered = [...channels].filter(c => c.startsWith("subagents:rpc:"));

      const reply = vi.fn();
      bus.on("subagents:rpc:ping:reply:req-wired", reply);
      bus.emit("subagents:rpc:ping", { requestId: "req-wired" });
      await vi.waitFor(() => expect(reply).toHaveBeenCalled());
      const advertised = (reply.mock.calls[0][0].data.capabilities as string[])
        .map(c => `subagents:rpc:${c}`);

      expect(registered.sort()).toEqual(["subagents:rpc:ping", ...advertised].sort());
    });

    it("returns a fresh capabilities array per reply", async () => {
      registerRpcHandlers(deps);
      const first = vi.fn();
      const second = vi.fn();
      events.on("subagents:rpc:ping:reply:req-caps-1", first);
      events.on("subagents:rpc:ping:reply:req-caps-2", second);

      events.emit("subagents:rpc:ping", { requestId: "req-caps-1" });
      await vi.waitFor(() => expect(first).toHaveBeenCalled());
      // A caller that mutates what it got must not change every later reply.
      first.mock.calls[0][0].data.capabilities.length = 0;

      events.emit("subagents:rpc:ping", { requestId: "req-caps-2" });
      await vi.waitFor(() => expect(second).toHaveBeenCalled());
      expect([...second.mock.calls[0][0].data.capabilities].sort()).toEqual(EXPECTED_CAPABILITIES);
    });

    it("scopes replies — other requestIds do not receive it", async () => {
      registerRpcHandlers(deps);
      const wrongReply = vi.fn();
      events.on("subagents:rpc:ping:reply:req-other", wrongReply);
      events.emit("subagents:rpc:ping", { requestId: "req-1" });

      await new Promise((r) => setTimeout(r, 20));
      expect(wrongReply).not.toHaveBeenCalled();
    });

    it("unsub stops responding to pings", async () => {
      const { unsubPing } = registerRpcHandlers(deps);
      unsubPing();

      const reply = vi.fn();
      events.on("subagents:rpc:ping:reply:req-1", reply);
      events.emit("subagents:rpc:ping", { requestId: "req-1" });

      await new Promise((r) => setTimeout(r, 20));
      expect(reply).not.toHaveBeenCalled();
    });
  });

  // --- spawn ---

  describe("spawn RPC", () => {
    it("returns agent id on success", async () => {
      registerRpcHandlers(deps);
      const reply = vi.fn();
      events.on("subagents:rpc:spawn:reply:req-s1", reply);
      events.emit("subagents:rpc:spawn", {
        requestId: "req-s1", type: "general-purpose", prompt: "do stuff",
      });

      await vi.waitFor(() => expect(reply).toHaveBeenCalled());
      expect(reply).toHaveBeenCalledWith({ success: true, data: { id: "agent-42" } });
      expect(manager.spawn).toHaveBeenCalledWith(
        deps.pi, ctx, "general-purpose", "do stuff", {},
      );
    });

    it("passes options through to manager.spawn", async () => {
      registerRpcHandlers(deps);
      const reply = vi.fn();
      events.on("subagents:rpc:spawn:reply:req-s2", reply);
      events.emit("subagents:rpc:spawn", {
        requestId: "req-s2", type: "Explore", prompt: "find it",
        options: { description: "search", isBackground: true },
      });

      await vi.waitFor(() => expect(reply).toHaveBeenCalled());
      expect(manager.spawn).toHaveBeenCalledWith(
        deps.pi, ctx, "Explore", "find it",
        { description: "search", isBackground: true },
      );
    });

    it("returns error when no active session", async () => {
      ctx = undefined;
      registerRpcHandlers(deps);
      const reply = vi.fn();
      events.on("subagents:rpc:spawn:reply:req-s3", reply);
      events.emit("subagents:rpc:spawn", {
        requestId: "req-s3", type: "general-purpose", prompt: "x",
      });

      await vi.waitFor(() => expect(reply).toHaveBeenCalled());
      expect(reply).toHaveBeenCalledWith({ success: false, error: "No active session" });
      expect(manager.spawn).not.toHaveBeenCalled();
    });

    it("returns error when manager.spawn throws", async () => {
      (manager.spawn as ReturnType<typeof vi.fn>).mockImplementation(() => {
        throw new Error("unknown agent type");
      });
      registerRpcHandlers(deps);
      const reply = vi.fn();
      events.on("subagents:rpc:spawn:reply:req-s4", reply);
      events.emit("subagents:rpc:spawn", {
        requestId: "req-s4", type: "bad-type", prompt: "x",
      });

      await vi.waitFor(() => expect(reply).toHaveBeenCalled());
      expect(reply).toHaveBeenCalledWith({ success: false, error: "unknown agent type" });
    });

    it("returns error when the agent fails to start after spawn returns", async () => {
      // With isolation: "worktree" the agent is not running when spawn() hands
      // back an id — the repo copy is an awaited git call. A failure there has
      // to be an error envelope, not an id for an agent that never ran.
      (manager.awaitStartup as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error('Cannot run with isolation: "worktree"'),
      );
      registerRpcHandlers(deps);
      const reply = vi.fn();
      events.on("subagents:rpc:spawn:reply:req-s4b", reply);
      events.emit("subagents:rpc:spawn", {
        requestId: "req-s4b", type: "general-purpose", prompt: "x",
        options: { isolation: "worktree" },
      });

      await vi.waitFor(() => expect(reply).toHaveBeenCalled());
      expect(reply).toHaveBeenCalledWith({
        success: false, error: 'Cannot run with isolation: "worktree"',
      });
      expect(manager.awaitStartup).toHaveBeenCalledWith("agent-42");
    });

    it("scopes replies — other requestIds do not receive it", async () => {
      registerRpcHandlers(deps);
      const wrongReply = vi.fn();
      const rightReply = vi.fn();
      events.on("subagents:rpc:spawn:reply:req-other", wrongReply);
      events.on("subagents:rpc:spawn:reply:req-s5", rightReply);
      events.emit("subagents:rpc:spawn", {
        requestId: "req-s5", type: "general-purpose", prompt: "x",
      });

      await vi.waitFor(() => expect(rightReply).toHaveBeenCalled());
      expect(wrongReply).not.toHaveBeenCalled();
    });

    it("unsub stops responding to spawns", async () => {
      const { unsubSpawn } = registerRpcHandlers(deps);
      unsubSpawn();

      const reply = vi.fn();
      events.on("subagents:rpc:spawn:reply:req-s6", reply);
      events.emit("subagents:rpc:spawn", {
        requestId: "req-s6", type: "general-purpose", prompt: "x",
      });

      // Give any potential async handler time to fire
      await new Promise((r) => setTimeout(r, 20));
      expect(reply).not.toHaveBeenCalled();
    });
  });

  // --- stop ---

  describe("stop RPC", () => {
    // The default double reports a record with neither owner field, i.e. one of
    // the session's own agents — the case the ownership guard must let through.
    it("returns success when agent is aborted", async () => {
      registerRpcHandlers(deps);
      const reply = vi.fn();
      events.on("subagents:rpc:stop:reply:req-st1", reply);
      events.emit("subagents:rpc:stop", { requestId: "req-st1", agentId: "agent-42" });

      await vi.waitFor(() => expect(reply).toHaveBeenCalled());
      expect(reply).toHaveBeenCalledWith({ success: true });
      expect(manager.abort).toHaveBeenCalledWith("agent-42");
    });

    // `abort` returning false no longer means "no such agent" — the handler's
    // own lookup covers that, and the only case left is a record that is neither
    // running nor queued, i.e. one that has already finished.
    it("says so when the agent exists but has already finished", async () => {
      (manager.abort as ReturnType<typeof vi.fn>).mockReturnValue(false);
      registerRpcHandlers(deps);
      const reply = vi.fn();
      events.on("subagents:rpc:stop:reply:req-st2", reply);
      events.emit("subagents:rpc:stop", { requestId: "req-st2", agentId: "settled" });

      await vi.waitFor(() => expect(reply).toHaveBeenCalled());
      expect(reply).toHaveBeenCalledWith({ success: false, error: "Agent is not running" });
    });

    it("returns error when the agent is unknown to the manager", async () => {
      (manager.getRecord as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
      registerRpcHandlers(deps);
      const reply = vi.fn();
      events.on("subagents:rpc:stop:reply:req-st5", reply);
      events.emit("subagents:rpc:stop", { requestId: "req-st5", agentId: "nonexistent" });

      await vi.waitFor(() => expect(reply).toHaveBeenCalled());
      expect(reply).toHaveBeenCalledWith({ success: false, error: "Agent not found" });
      expect(manager.abort).not.toHaveBeenCalled();
    });

    // A nested child and a workflow's agent both have an owner that is waiting
    // on them, so an id that leaked to another extension must not let it abort
    // one out from under that owner.
    it("refuses to stop another agent's nested child", async () => {
      (manager.getRecord as ReturnType<typeof vi.fn>).mockReturnValue({ parentAgentId: "agent-1" });
      registerRpcHandlers(deps);
      const reply = vi.fn();
      events.on("subagents:rpc:stop:reply:req-st6", reply);
      events.emit("subagents:rpc:stop", { requestId: "req-st6", agentId: "agent-child" });

      await vi.waitFor(() => expect(reply).toHaveBeenCalled());
      expect(reply).toHaveBeenCalledWith({
        success: false,
        error: "Agent is owned by another agent or workflow",
      });
      expect(manager.abort).not.toHaveBeenCalled();
    });

    it("refuses to stop a workflow's agent", async () => {
      (manager.getRecord as ReturnType<typeof vi.fn>).mockReturnValue({ workflowId: "wf-1" });
      registerRpcHandlers(deps);
      const reply = vi.fn();
      events.on("subagents:rpc:stop:reply:req-st7", reply);
      events.emit("subagents:rpc:stop", { requestId: "req-st7", agentId: "agent-wf" });

      await vi.waitFor(() => expect(reply).toHaveBeenCalled());
      expect(reply).toHaveBeenCalledWith({
        success: false,
        error: "Agent is owned by another agent or workflow",
      });
      expect(manager.abort).not.toHaveBeenCalled();
    });

    it("scopes replies — other requestIds do not receive it", async () => {
      registerRpcHandlers(deps);
      const wrongReply = vi.fn();
      const rightReply = vi.fn();
      events.on("subagents:rpc:stop:reply:req-other", wrongReply);
      events.on("subagents:rpc:stop:reply:req-st3", rightReply);
      events.emit("subagents:rpc:stop", { requestId: "req-st3", agentId: "agent-42" });

      await vi.waitFor(() => expect(rightReply).toHaveBeenCalled());
      expect(wrongReply).not.toHaveBeenCalled();
    });

    it("unsub stops responding to stop requests", async () => {
      const { unsubStop } = registerRpcHandlers(deps);
      unsubStop();

      const reply = vi.fn();
      events.on("subagents:rpc:stop:reply:req-st4", reply);
      events.emit("subagents:rpc:stop", { requestId: "req-st4", agentId: "agent-42" });

      await new Promise((r) => setTimeout(r, 20));
      expect(reply).not.toHaveBeenCalled();
    });
  });

  // --- pause ---

  describe("pause RPC", () => {
    it("returns success when agent is paused", async () => {
      registerRpcHandlers(deps);
      const reply = vi.fn();
      events.on("subagents:rpc:pause:reply:req-p1", reply);
      events.emit("subagents:rpc:pause", { requestId: "req-p1", agentId: "agent-42" });

      await vi.waitFor(() => expect(reply).toHaveBeenCalled());
      expect(reply).toHaveBeenCalledWith({ success: true });
      expect(manager.pauseAgent).toHaveBeenCalledWith("agent-42");
    });

    it("errors when the agent does not exist", async () => {
      vi.mocked(manager.getRecord).mockReturnValue(undefined);
      registerRpcHandlers(deps);
      const reply = vi.fn();
      events.on("subagents:rpc:pause:reply:req-p2", reply);
      events.emit("subagents:rpc:pause", { requestId: "req-p2", agentId: "ghost" });

      await vi.waitFor(() => expect(reply).toHaveBeenCalled());
      expect(reply).toHaveBeenCalledWith({ success: false, error: "Agent not found" });
      expect(manager.pauseAgent).not.toHaveBeenCalled();
    });

    it("refuses another agent's or a workflow's child, like stop", async () => {
      vi.mocked(manager.getRecord).mockReturnValue({ parentAgentId: "parent-1" });
      registerRpcHandlers(deps);
      const reply = vi.fn();
      events.on("subagents:rpc:pause:reply:req-p3", reply);
      events.emit("subagents:rpc:pause", { requestId: "req-p3", agentId: "agent-42" });

      await vi.waitFor(() => expect(reply).toHaveBeenCalled());
      expect(reply).toHaveBeenCalledWith({ success: false, error: "Agent is owned by another agent or workflow" });
    });

    it("surfaces a refusal as an error, not a silent success", async () => {
      vi.mocked(manager.pauseAgent).mockReturnValue(false);
      registerRpcHandlers(deps);
      const reply = vi.fn();
      events.on("subagents:rpc:pause:reply:req-p4", reply);
      events.emit("subagents:rpc:pause", { requestId: "req-p4", agentId: "agent-42" });

      await vi.waitFor(() => expect(reply).toHaveBeenCalled());
      expect(reply).toHaveBeenCalledWith({ success: false, error: "Agent is not pausable" });
    });

    it("unsub stops responding to pauses", async () => {
      const { unsubPause } = registerRpcHandlers(deps);
      unsubPause();

      const reply = vi.fn();
      events.on("subagents:rpc:pause:reply:req-p5", reply);
      events.emit("subagents:rpc:pause", { requestId: "req-p5", agentId: "agent-42" });

      await new Promise((r) => setTimeout(r, 20));
      expect(reply).not.toHaveBeenCalled();
    });
  });

  // --- resume ---

  describe("resume RPC", () => {
    it("continues the agent, forwarding an optional prompt", async () => {
      registerRpcHandlers(deps);
      const reply = vi.fn();
      events.on("subagents:rpc:resume:reply:req-r1", reply);
      events.emit("subagents:rpc:resume", { requestId: "req-r1", agentId: "agent-42", prompt: "carry on" });

      await vi.waitFor(() => expect(reply).toHaveBeenCalled());
      expect(reply).toHaveBeenCalledWith({ success: true });
      expect(manager.resumeAgent).toHaveBeenCalledWith("agent-42", "carry on");
    });

    it("errors when the agent does not exist", async () => {
      vi.mocked(manager.getRecord).mockReturnValue(undefined);
      registerRpcHandlers(deps);
      const reply = vi.fn();
      events.on("subagents:rpc:resume:reply:req-r2", reply);
      events.emit("subagents:rpc:resume", { requestId: "req-r2", agentId: "ghost" });

      await vi.waitFor(() => expect(reply).toHaveBeenCalled());
      expect(reply).toHaveBeenCalledWith({ success: false, error: "Agent not found" });
    });

    it("refuses another agent's or a workflow's child, like stop", async () => {
      vi.mocked(manager.getRecord).mockReturnValue({ workflowId: "wf-1" });
      registerRpcHandlers(deps);
      const reply = vi.fn();
      events.on("subagents:rpc:resume:reply:req-r3", reply);
      events.emit("subagents:rpc:resume", { requestId: "req-r3", agentId: "agent-42" });

      await vi.waitFor(() => expect(reply).toHaveBeenCalled());
      expect(reply).toHaveBeenCalledWith({ success: false, error: "Agent is owned by another agent or workflow" });
    });

    it("errors when there is nothing to continue", async () => {
      vi.mocked(manager.resumeAgent).mockResolvedValue(false);
      registerRpcHandlers(deps);
      const reply = vi.fn();
      events.on("subagents:rpc:resume:reply:req-r4", reply);
      events.emit("subagents:rpc:resume", { requestId: "req-r4", agentId: "agent-42" });

      await vi.waitFor(() => expect(reply).toHaveBeenCalled());
      expect(reply).toHaveBeenCalledWith({ success: false, error: "Agent cannot be resumed" });
    });

    it("unsub stops responding to resumes", async () => {
      const { unsubResume } = registerRpcHandlers(deps);
      unsubResume();

      const reply = vi.fn();
      events.on("subagents:rpc:resume:reply:req-r5", reply);
      events.emit("subagents:rpc:resume", { requestId: "req-r5", agentId: "agent-42" });

      await new Promise((r) => setTimeout(r, 20));
      expect(reply).not.toHaveBeenCalled();
    });
  });

  // --- consume ---

  describe("consume RPC", () => {
    it("returns success when the result is consumed", async () => {
      registerRpcHandlers(deps);
      const reply = vi.fn();
      events.on("subagents:rpc:consume:reply:req-c1", reply);
      events.emit("subagents:rpc:consume", { requestId: "req-c1", agentId: "agent-42" });

      await vi.waitFor(() => expect(reply).toHaveBeenCalled());
      expect(reply).toHaveBeenCalledWith({ success: true });
      expect(manager.consumeResult).toHaveBeenCalledWith("agent-42");
    });

    it("returns an error when the agent is unknown or still running", async () => {
      (manager.consumeResult as ReturnType<typeof vi.fn>).mockReturnValue(false);
      registerRpcHandlers(deps);
      const reply = vi.fn();
      events.on("subagents:rpc:consume:reply:req-c2", reply);
      events.emit("subagents:rpc:consume", { requestId: "req-c2", agentId: "agent-42" });

      await vi.waitFor(() => expect(reply).toHaveBeenCalled());
      expect(reply).toHaveBeenCalledWith({ success: false, error: "Agent not found or still running" });
    });

    it("unsub stops responding to consume requests", async () => {
      const { unsubConsume } = registerRpcHandlers(deps);
      unsubConsume();

      const reply = vi.fn();
      events.on("subagents:rpc:consume:reply:req-c3", reply);
      events.emit("subagents:rpc:consume", { requestId: "req-c3", agentId: "agent-42" });

      await new Promise((r) => setTimeout(r, 20));
      expect(reply).not.toHaveBeenCalled();
      expect(manager.consumeResult).not.toHaveBeenCalled();
    });
  });

  // --- steer ---

  describe("steer RPC", () => {
    it("waits for acceptance and returns session rejection as an error reply", async () => {
      let reject!: (error: Error) => void;
      vi.mocked(manager.steer).mockImplementation(() => new Promise<boolean>((_resolve, fail) => { reject = fail; }));
      registerRpcHandlers(deps);
      const reply = vi.fn();
      events.on("subagents:rpc:steer:reply:req-pending", reply);
      events.emit("subagents:rpc:steer", { requestId: "req-pending", agentId: "agent-42", message: "try now" });

      expect(reply).not.toHaveBeenCalled();
      reject(new Error("session closed"));
      await vi.waitFor(() => expect(reply).toHaveBeenCalledExactlyOnceWith({ success: false, error: "session closed" }));
    });

    it("delivers a message to a running top-level agent", async () => {
      registerRpcHandlers(deps);
      const reply = vi.fn();
      events.on("subagents:rpc:steer:reply:req-m1", reply);
      events.emit("subagents:rpc:steer", { requestId: "req-m1", agentId: "agent-42", message: "also failing: check_suite on 839ab295" });

      await vi.waitFor(() => expect(reply).toHaveBeenCalled());
      expect(reply).toHaveBeenCalledWith({ success: true });
      expect(manager.steer).toHaveBeenCalledWith("agent-42", "also failing: check_suite on 839ab295");
    });

    it("returns error when the agent is unknown to the manager", async () => {
      (manager.getRecord as ReturnType<typeof vi.fn>).mockReturnValue(undefined);
      registerRpcHandlers(deps);
      const reply = vi.fn();
      events.on("subagents:rpc:steer:reply:req-m2", reply);
      events.emit("subagents:rpc:steer", { requestId: "req-m2", agentId: "nonexistent", message: "x" });

      await vi.waitFor(() => expect(reply).toHaveBeenCalled());
      expect(reply).toHaveBeenCalledWith({ success: false, error: "Agent not found" });
      expect(manager.steer).not.toHaveBeenCalled();
    });

    // Same ownership stance as stop: an agent another agent or a workflow is
    // waiting on is not this RPC's to redirect.
    it("refuses to steer another agent's nested child or a workflow's agent", async () => {
      (manager.getRecord as ReturnType<typeof vi.fn>).mockReturnValue({ workflowId: "wf-1" });
      registerRpcHandlers(deps);
      const reply = vi.fn();
      events.on("subagents:rpc:steer:reply:req-m3", reply);
      events.emit("subagents:rpc:steer", { requestId: "req-m3", agentId: "agent-42", message: "x" });

      await vi.waitFor(() => expect(reply).toHaveBeenCalled());
      expect(reply).toHaveBeenCalledWith({ success: false, error: "Agent is owned by another agent or workflow" });
      expect(manager.steer).not.toHaveBeenCalled();
    });

    it("says so when the agent has already finished", async () => {
      (manager.steer as ReturnType<typeof vi.fn>).mockResolvedValue(false);
      registerRpcHandlers(deps);
      const reply = vi.fn();
      events.on("subagents:rpc:steer:reply:req-m4", reply);
      events.emit("subagents:rpc:steer", { requestId: "req-m4", agentId: "agent-42", message: "x" });

      await vi.waitFor(() => expect(reply).toHaveBeenCalled());
      expect(reply).toHaveBeenCalledWith({ success: false, error: "Agent is not running" });
    });

    it("rejects a whitespace-only message before touching the manager", async () => {
      registerRpcHandlers(deps);
      const reply = vi.fn();
      events.on("subagents:rpc:steer:reply:req-m5", reply);
      events.emit("subagents:rpc:steer", { requestId: "req-m5", agentId: "agent-42", message: "   " });

      await vi.waitFor(() => expect(reply).toHaveBeenCalled());
      expect(reply).toHaveBeenCalledWith({ success: false, error: "Steer message must be a non-empty string" });
      expect(manager.steer).not.toHaveBeenCalled();
    });

    it("rejects a non-string message before touching the manager", async () => {
      registerRpcHandlers(deps);
      const reply = vi.fn();
      events.on("subagents:rpc:steer:reply:req-m7", reply);
      events.emit("subagents:rpc:steer", { requestId: "req-m7", agentId: "agent-42", message: 42 });

      await vi.waitFor(() => expect(reply).toHaveBeenCalled());
      expect(reply).toHaveBeenCalledWith({ success: false, error: "Steer message must be a non-empty string" });
      expect(manager.steer).not.toHaveBeenCalled();
    });

    it("unsub stops responding to steer requests", async () => {
      const { unsubSteer } = registerRpcHandlers(deps);
      unsubSteer();

      const reply = vi.fn();
      events.on("subagents:rpc:steer:reply:req-m6", reply);
      events.emit("subagents:rpc:steer", { requestId: "req-m6", agentId: "agent-42", message: "x" });

      await new Promise((r) => setTimeout(r, 20));
      expect(reply).not.toHaveBeenCalled();
    });
  });

  // --- concurrent requests ---

  // --- get / list ---

  describe("get and list RPCs", () => {
    it("returns the agent's public shape, with a pending notification flagged", async () => {
      (manager.isNotificationPending as ReturnType<typeof vi.fn>).mockReturnValue(true);
      registerRpcHandlers(deps);
      const reply = vi.fn();
      events.on("subagents:rpc:get:reply:req-g1", reply);
      events.emit("subagents:rpc:get", { requestId: "req-g1", agentId: "agent-42" });

      await vi.waitFor(() => expect(reply).toHaveBeenCalled());
      const { success, data } = reply.mock.calls[0][0];
      expect(success).toBe(true);
      expect(data.agent).toMatchObject({ id: "agent-42", status: "completed", notificationPending: true });
    });

    it("errors for an id it does not hold", async () => {
      registerRpcHandlers(deps);
      const reply = vi.fn();
      events.on("subagents:rpc:get:reply:req-g2", reply);
      events.emit("subagents:rpc:get", { requestId: "req-g2", agentId: "nope" });

      await vi.waitFor(() => expect(reply).toHaveBeenCalled());
      expect(reply).toHaveBeenCalledWith({ success: false, error: "Agent not found" });
    });

    it("lists every record the manager holds, owned ones included", async () => {
      (manager.listAgents as ReturnType<typeof vi.fn>).mockReturnValue([
        record(),
        record({ id: "child-1", parentAgentId: "agent-42", depth: 2 }),
      ]);
      registerRpcHandlers(deps);
      const reply = vi.fn();
      events.on("subagents:rpc:list:reply:req-l1", reply);
      events.emit("subagents:rpc:list", { requestId: "req-l1" });

      await vi.waitFor(() => expect(reply).toHaveBeenCalled());
      const { data } = reply.mock.calls[0][0];
      expect(data.agents.map((agent: { id: string }) => agent.id)).toEqual(["agent-42", "child-1"]);
      expect(data.agents[1].parentAgentId).toBe("agent-42");
    });

    it("unsub stops responding to both channels", async () => {
      const { unsubGet, unsubList } = registerRpcHandlers(deps);
      unsubGet();
      unsubList();

      const reply = vi.fn();
      events.on("subagents:rpc:get:reply:req-g3", reply);
      events.on("subagents:rpc:list:reply:req-l3", reply);
      events.emit("subagents:rpc:get", { requestId: "req-g3", agentId: "agent-42" });
      events.emit("subagents:rpc:list", { requestId: "req-l3" });

      await new Promise(r => setTimeout(r, 20));
      expect(reply).not.toHaveBeenCalled();
    });
  });

  describe("concurrent requests", () => {
    it("handles multiple simultaneous spawn requests independently", async () => {
      let callCount = 0;
      (manager.spawn as ReturnType<typeof vi.fn>).mockImplementation(() => `agent-${++callCount}`);
      registerRpcHandlers(deps);

      const reply1 = vi.fn();
      const reply2 = vi.fn();
      events.on("subagents:rpc:spawn:reply:req-a", reply1);
      events.on("subagents:rpc:spawn:reply:req-b", reply2);

      events.emit("subagents:rpc:spawn", { requestId: "req-a", type: "Explore", prompt: "first" });
      events.emit("subagents:rpc:spawn", { requestId: "req-b", type: "Plan", prompt: "second" });

      await vi.waitFor(() => {
        expect(reply1).toHaveBeenCalled();
        expect(reply2).toHaveBeenCalled();
      });

      expect(reply1).toHaveBeenCalledWith({ success: true, data: { id: "agent-1" } });
      expect(reply2).toHaveBeenCalledWith({ success: true, data: { id: "agent-2" } });
    });
  });

  // --- model override resolution (regression for cross-extension callers
  //     that forward a serializable string instead of a Model object) ---

  describe("spawn RPC model override", () => {
    const fakeModel = { id: "gpt-5.5", provider: "openai-codex", name: "GPT 5.5" };
    const registry = {
      find: (provider: string, id: string) =>
        provider === fakeModel.provider && id === fakeModel.id ? fakeModel : null,
      getAll: () => [fakeModel],
      getAvailable: () => [fakeModel],
    };

    beforeEach(() => {
      ctx = { session: true, modelRegistry: registry };
      deps = { events, pi: { events }, getCtx: () => ctx, manager };
    });

    it("resolves a string model to a Model instance before manager.spawn", async () => {
      registerRpcHandlers(deps);
      const reply = vi.fn();
      events.on("subagents:rpc:spawn:reply:req-m1", reply);
      events.emit("subagents:rpc:spawn", {
        requestId: "req-m1", type: "general-purpose", prompt: "x",
        options: { model: "openai-codex/gpt-5.5" },
      });

      await vi.waitFor(() => expect(reply).toHaveBeenCalled());
      expect(reply).toHaveBeenCalledWith({ success: true, data: { id: "agent-42" } });
      expect(manager.spawn).toHaveBeenCalledWith(
        deps.pi, ctx, "general-purpose", "x",
        { model: fakeModel },
      );
    });

    it("passes a Model object through unchanged", async () => {
      registerRpcHandlers(deps);
      const reply = vi.fn();
      events.on("subagents:rpc:spawn:reply:req-m2", reply);
      events.emit("subagents:rpc:spawn", {
        requestId: "req-m2", type: "general-purpose", prompt: "x",
        options: { model: fakeModel },
      });

      await vi.waitFor(() => expect(reply).toHaveBeenCalled());
      expect(manager.spawn).toHaveBeenCalledWith(
        deps.pi, ctx, "general-purpose", "x",
        { model: fakeModel },
      );
    });

    it("surfaces a clear error when the model string can't be resolved", async () => {
      registerRpcHandlers(deps);
      const reply = vi.fn();
      events.on("subagents:rpc:spawn:reply:req-m3", reply);
      events.emit("subagents:rpc:spawn", {
        requestId: "req-m3", type: "general-purpose", prompt: "x",
        options: { model: "nope/does-not-exist" },
      });

      await vi.waitFor(() => expect(reply).toHaveBeenCalled());
      const call = (reply as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.success).toBe(false);
      expect(call.error).toMatch(/Model not found/);
      expect(manager.spawn).not.toHaveBeenCalled();
    });

    it("treats an explicit null model as no override at all", async () => {
      // A JSON-forwarding caller can serialize an unset field as null. The
      // runner reads `options.model ?? default`, so null means "inherit" —
      // it must not be resolved, scope-checked, or dereferenced.
      registerRpcHandlers(deps);
      const reply = vi.fn();
      events.on("subagents:rpc:spawn:reply:req-m5", reply);
      events.emit("subagents:rpc:spawn", {
        requestId: "req-m5", type: "general-purpose", prompt: "x",
        options: { model: null },
      });

      await vi.waitFor(() => expect(reply).toHaveBeenCalled());
      expect(reply).toHaveBeenCalledWith({ success: true, data: { id: "agent-42" } });
      expect(manager.spawn).toHaveBeenCalledWith(
        deps.pi, ctx, "general-purpose", "x", { model: null },
      );
    });

    it("errors when ctx has no modelRegistry but a string model is given", async () => {
      ctx = { session: true }; // no modelRegistry
      registerRpcHandlers(deps);
      const reply = vi.fn();
      events.on("subagents:rpc:spawn:reply:req-m4", reply);
      events.emit("subagents:rpc:spawn", {
        requestId: "req-m4", type: "general-purpose", prompt: "x",
        options: { model: "openai-codex/gpt-5.5" },
      });

      await vi.waitFor(() => expect(reply).toHaveBeenCalled());
      const call = (reply as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.success).toBe(false);
      expect(call.error).toMatch(/modelRegistry is unavailable/);
      expect(manager.spawn).not.toHaveBeenCalled();
    });
  });
  // --- scopeModels on the RPC spawn path (#240): an override on the RPC
  //     payload is an orchestrator-level choice, so it gets the Agent tool's
  //     hard error rather than reaching the spawn on an out-of-scope model. ---

  describe("spawn RPC model scope", () => {
    const ALLOWED = { id: "gpt-5.5", provider: "openai-codex", name: "GPT 5.5" };
    const BLOCKED = { id: "claude-sonnet-4", provider: "anthropic", name: "Claude Sonnet 4" };
    const MODELS = [ALLOWED, BLOCKED];
    const registry = {
      find: (provider: string, id: string) =>
        MODELS.find(m => m.provider === provider && m.id === id) ?? null,
      getAll: () => MODELS,
      getAvailable: () => MODELS,
    };

    let projectDir: string;
    let agentDir: string;
    let prevAgentDir: string | undefined;
    let prevEnabled: boolean;

    beforeEach(() => {
      // resolveEnabledModels memoizes on (patterns, mtime+size of both settings
      // files) — a fresh project dir per test keeps one case's allowlist from
      // being served to the next. Same harness as test/model-scope.test.ts.
      projectDir = mkdtempSync(join(tmpdir(), "pi-rpc-scope-project-"));
      agentDir = mkdtempSync(join(tmpdir(), "pi-rpc-scope-global-"));
      prevAgentDir = process.env.PI_CODING_AGENT_DIR;
      process.env.PI_CODING_AGENT_DIR = agentDir;
      prevEnabled = isScopeModelsEnabled();
      mkdirSync(join(projectDir, ".pi"), { recursive: true });
      writeFileSync(
        join(projectDir, ".pi", "settings.json"),
        JSON.stringify({ enabledModels: ["openai-codex/gpt-5.5"] }),
      );
      setScopeModelsEnabled(true);
      ctx = { session: true, cwd: projectDir, modelRegistry: registry };
      deps = { events, pi: { events }, getCtx: () => ctx, manager };
    });

    afterEach(() => {
      setScopeModelsEnabled(prevEnabled); // module-global — restore for other suites
      if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
      rmSync(projectDir, { recursive: true, force: true });
      rmSync(agentDir, { recursive: true, force: true });
    });

    async function spawn(requestId: string, model: unknown) {
      registerRpcHandlers(deps);
      const reply = vi.fn();
      events.on(`subagents:rpc:spawn:reply:${requestId}`, reply);
      events.emit("subagents:rpc:spawn", {
        requestId, type: "general-purpose", prompt: "x", options: { model },
      });
      await vi.waitFor(() => expect(reply).toHaveBeenCalled());
      return (reply as ReturnType<typeof vi.fn>).mock.calls[0][0];
    }

    it("refuses an out-of-scope string override, listing what is allowed", async () => {
      // The reported case: a bare "sonnet" fuzzy-resolves across providers, so
      // only the RESOLVED model can be compared against enabledModels.
      const call = await spawn("req-sc1", "sonnet");
      expect(call.success).toBe(false);
      expect(call.error).toMatch(/Model not in scope/);
      expect(call.error).toContain('"sonnet"');
      expect(call.error).toContain("  openai-codex/gpt-5.5");
      expect(manager.spawn).not.toHaveBeenCalled();
    });

    it("refuses an out-of-scope Model object override too", async () => {
      const call = await spawn("req-sc2", BLOCKED);
      expect(call.success).toBe(false);
      expect(call.error).toMatch(/Model not in scope/);
      expect(call.error).toContain('"anthropic/claude-sonnet-4"');
      expect(manager.spawn).not.toHaveBeenCalled();
    });

    it("spawns normally when the override is in scope", async () => {
      const call = await spawn("req-sc3", "openai-codex/gpt-5.5");
      expect(call).toEqual({ success: true, data: { id: "agent-42" } });
      expect(manager.spawn).toHaveBeenCalledWith(
        deps.pi, ctx, "general-purpose", "x", { model: ALLOWED },
      );
    });

    it("does not check scope while the setting is off", async () => {
      setScopeModelsEnabled(false);
      const call = await spawn("req-sc4", "sonnet");
      expect(call).toEqual({ success: true, data: { id: "agent-42" } });
      expect(manager.spawn).toHaveBeenCalledWith(
        deps.pi, ctx, "general-purpose", "x", { model: BLOCKED },
      );
    });
  });
});
