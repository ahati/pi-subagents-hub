/**
 * rpc-lifecycle-gating.test.ts — issue #142.
 *
 * pi runs every extension factory BEFORE applying an agent's `extensions:`
 * filter, and only delivers lifecycle events (session_start, …) to the
 * survivors — but the `pi.events` bus is shared with the filtered-out
 * activations. The old code registered the RPC handlers and emitted
 * `subagents:ready` at factory time, so a child session that excluded
 * pi-subagents-hub still saw `subagents:ready` + a working `subagents:rpc:ping`,
 * yet every spawn failed with "No active session" (its session_start never
 * fired, so currentCtx stayed undefined).
 *
 * The fix defers BOTH the RPC registration and the readiness broadcast to the
 * first bound session_start. These tests drive the real extension factory with
 * a mock ExtensionAPI and assert the timing: nothing is wired at factory time;
 * everything is wired (once) on session_start.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";

const RPC_CHANNELS = [
  "subagents:rpc:ping", "subagents:rpc:spawn", "subagents:rpc:stop", "subagents:rpc:pause", "subagents:rpc:resume",
  "subagents:rpc:consume", "subagents:rpc:steer", "subagents:rpc:get", "subagents:rpc:list",
  "subagents:rpc:workflow_get", "subagents:rpc:workflow_list",
] as const;

function makePi() {
  const tools = new Map<string, any>();
  const lifecycle = new Map<string, any>(); // pi.on(...) — session_start, session_shutdown, …
  const busHandlers = new Map<string, (raw: any) => unknown>(); // pi.events.on(...) — rpc channels
  const busUnsubs = new Map<string, ReturnType<typeof vi.fn>>(); // the unsubscribe each pi.events.on(...) returned
  const pi = {
    registerMessageRenderer: vi.fn(),
    registerTool: vi.fn((t: any) => tools.set(t.name, t)),
    registerCommand: vi.fn(),
    registerEntryRenderer: vi.fn(),
    registerFlag: vi.fn(),
    getFlag: vi.fn(),
    on: vi.fn((event: string, handler: any) => lifecycle.set(event, handler)),
    events: {
      emit: vi.fn(),
      on: vi.fn((event: string, handler: any) => {
        busHandlers.set(event, handler);
        const unsub = vi.fn();
        busUnsubs.set(event, unsub);
        return unsub;
      }),
    },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
  return { pi, tools, lifecycle, busHandlers, busUnsubs };
}

function ctx(hasUI = false, setWidget = vi.fn()) {
  return {
    hasUI,
    ui: {
      setStatus: vi.fn(),
      setWidget,
      notify: vi.fn(),
      onTerminalInput: vi.fn(() => vi.fn()),
      getEditorText: vi.fn(() => ""),
      custom: vi.fn(),
    },
    cwd: process.cwd(),
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    sessionManager: { getSessionId: vi.fn(() => "s1"), getBranch: vi.fn(() => []) },
    getSystemPrompt: vi.fn(() => "parent"),
  } as any;
}

const readyEmits = (pi: any): unknown[] =>
  pi.events.emit.mock.calls.filter((c: any[]) => c[0] === "subagents:ready");
/** Emits of `event` carrying `id` in the payload. */
const idEmits = (pi: any, event: string, id: string): unknown[] =>
  pi.events.emit.mock.calls.filter((c: any[]) => c[0] === event && c[1]?.id === id);
const onCallsFor = (pi: any, channel: string): unknown[] =>
  pi.events.on.mock.calls.filter((c: any[]) => c[0] === channel);

describe("issue #142: RPC handlers + subagents:ready are gated on session_start", () => {
  let tmpDir: string;
  let agentDir: string;
  let prevCwd: string;
  let prevAgentDir: string | undefined;
  let prevHome: string | undefined;

  beforeEach(() => {
    // Hermetic cwd + global dir with scheduling off, so session_start doesn't
    // spin a scheduler or touch the dev's filesystem — isolates the RPC wiring.
    tmpDir = mkdtempSync(join(tmpdir(), "pi-142-"));
    agentDir = mkdtempSync(join(tmpdir(), "pi-142-agentdir-"));
    prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    prevHome = process.env.HOME;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.HOME = agentDir;
    prevCwd = process.cwd();
    mkdirSync(join(tmpDir, ".pi"), { recursive: true });
    writeFileSync(join(tmpDir, ".pi", "subagents.json"), JSON.stringify({ schedulingEnabled: false }));
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(prevCwd);
    if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    if (prevHome == null) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(tmpDir, { recursive: true, force: true });
    rmSync(agentDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("does NOT advertise or register RPC at factory time (the filtered-out case)", () => {
    const { pi, busHandlers } = makePi();

    // A filtered-out activation only ever gets the factory run — its
    // session_start never fires. So after the factory alone, nothing should
    // be on the shared bus.
    subagentsExtension(pi);

    expect(readyEmits(pi), "no subagents:ready before session_start").toHaveLength(0);
    for (const channel of RPC_CHANNELS) {
      expect(busHandlers.has(channel), `${channel} must not be registered at factory time`).toBe(false);
    }
  });

  it("advertises and registers RPC on session_start, and spawn works once bound", async () => {
    const { pi, lifecycle, busHandlers } = makePi();
    subagentsExtension(pi);

    await lifecycle.get("session_start")({}, ctx());

    // Readiness broadcast once, all seven channels now live.
    expect(readyEmits(pi), "subagents:ready fires once bound").toHaveLength(1);
    for (const channel of RPC_CHANNELS) {
      expect(busHandlers.has(channel), `${channel} registered on session_start`).toBe(true);
    }

    // spawn no longer hits the "No active session" trap — currentCtx is set.
    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}) as any); // never resolves
    const requestId = "req-142";
    await busHandlers.get("subagents:rpc:spawn")!({
      requestId,
      type: "general-purpose",
      prompt: "go",
      options: { description: "rpc gating test" },
    });

    const reply = pi.events.emit.mock.calls.find(
      (c: any[]) => c[0] === `subagents:rpc:spawn:reply:${requestId}`,
    );
    expect(reply, "spawn emitted a reply").toBeTruthy();
    expect(reply![1].success, `spawn succeeded, got: ${JSON.stringify(reply![1])}`).toBe(true);
    expect(reply![1].data.id).toBeTruthy();
  });

  // The ping reply must name exactly the channels this activation subscribed,
  // read off the bus rather than from RPC_CHANNELS: a `subagents:rpc:*` handler
  // wired directly in src/index.ts shows up here too, and a channel that is
  // subscribed but not advertised (or the reverse) fails either way.
  it("ping advertises exactly the RPC channels the real factory subscribes", async () => {
    const { pi, lifecycle, busHandlers } = makePi();
    subagentsExtension(pi);

    await lifecycle.get("session_start")({}, ctx());
    const subscribed = pi.events.on.mock.calls
      .map((c: any[]) => c[0] as string)
      .filter((channel) => channel.startsWith("subagents:rpc:"))
      .map((channel) => channel.slice("subagents:rpc:".length))
      .filter((name) => name !== "ping")
      .sort();

    await busHandlers.get("subagents:rpc:ping")!({ requestId: "req-ping" });

    const reply = pi.events.emit.mock.calls.find(
      (c: any[]) => c[0] === "subagents:rpc:ping:reply:req-ping",
    );
    expect(reply, "ping emitted a reply").toBeTruthy();
    const advertised = [...reply![1].data.capabilities].sort();
    expect(advertised).toEqual(subscribed);
  });

  // Every channel session_start wires has to be released by session_shutdown:
  // on reload or session replacement the process survives, and a handler left
  // subscribed by the old activation would answer the next session's RPC (and
  // be joined by a second registration) — ping included, so a caller is not
  // told the extension is live by a session that is gone.
  it("unsubscribes every RPC handler on session_shutdown", async () => {
    const { pi, lifecycle, busUnsubs } = makePi();
    subagentsExtension(pi);

    await lifecycle.get("session_start")({}, ctx());
    const rpcUnsubs = [...busUnsubs.entries()].filter(([channel]) => channel.startsWith("subagents:rpc:"));
    expect(rpcUnsubs).toHaveLength(RPC_CHANNELS.length);

    await lifecycle.get("session_shutdown")();

    for (const [channel, unsub] of rpcUnsubs) {
      expect(unsub, `${channel} must be unsubscribed on shutdown`).toHaveBeenCalled();
    }
  });

  // The RPC handler emits nothing itself: the event comes from the manager's
  // onSteered callback wired in src/index.ts. This pins that the bus path
  // reaches it, so observers do not miss bus-originated steers.
  it("subagents:rpc:steer emits subagents:steered for an RPC-spawned agent", async () => {
    const { pi, lifecycle, busHandlers } = makePi();
    subagentsExtension(pi);

    await lifecycle.get("session_start")({}, ctx());

    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}) as any); // never resolves
    try {
      await busHandlers.get("subagents:rpc:spawn")!({
        requestId: "req-steer-spawn",
        type: "general-purpose",
        prompt: "go",
        options: { description: "rpc steer test" },
      });
      const spawnReply = pi.events.emit.mock.calls.find(
        (c: any[]) => c[0] === "subagents:rpc:spawn:reply:req-steer-spawn",
      );
      const id: string = spawnReply![1].data.id;

      await busHandlers.get("subagents:rpc:steer")!({ requestId: "req-steer", agentId: id, message: "also fix the lint" });

      const steerReply = pi.events.emit.mock.calls.find(
        (c: any[]) => c[0] === "subagents:rpc:steer:reply:req-steer",
      );
      expect(steerReply![1]).toEqual({ success: true });
      // Flat payload: the agent shape, with the event's own field beside it.
      expect(pi.events.emit).toHaveBeenCalledWith(
        "subagents:steered",
        expect.objectContaining({ id, message: "also fix the lint" }),
      );
    } finally {
      await lifecycle.get("session_shutdown")();
    }
  });

  // The resume funnel is where `subagents:resumed` lives, so the bus path and
  // every UI surface announce the same thing. A gate-parked resume continues
  // the ORIGINAL run — no second start callback fires.
  it("pause then resume over RPC emits subagents:resumed and does not re-emit subagents:started", async () => {
    const { pi, lifecycle, busHandlers } = makePi();
    subagentsExtension(pi);

    await lifecycle.get("session_start")({}, ctx());

    vi.mocked(runAgent).mockImplementation((_ctx: any, _type: any, _prompt: any, options: any) => {
      options.onSessionCreated?.({ messages: [], subscribe: () => vi.fn() });
      return new Promise(() => {}) as any; // keep the run alive behind its gate
    });
    try {
      await busHandlers.get("subagents:rpc:spawn")!({
        requestId: "req-resume-spawn",
        type: "general-purpose",
        prompt: "go",
        options: { description: "rpc resume test" },
      });
      const spawnReply = pi.events.emit.mock.calls.find(
        (c: any[]) => c[0] === "subagents:rpc:spawn:reply:req-resume-spawn",
      );
      const id: string = spawnReply![1].data.id;
      expect(idEmits(pi, "subagents:started", id), "one start for the spawn").toHaveLength(1);

      await busHandlers.get("subagents:rpc:pause")!({ requestId: "req-resume-pause", agentId: id });
      const pauseReply = pi.events.emit.mock.calls.find(
        (c: any[]) => c[0] === "subagents:rpc:pause:reply:req-resume-pause",
      );
      expect(pauseReply![1]).toEqual({ success: true });
      expect(pi.events.emit).toHaveBeenCalledWith("subagents:paused", {
        id,
        type: "general-purpose",
        description: "rpc resume test",
      });

      await busHandlers.get("subagents:rpc:resume")!({ requestId: "req-resume-resume", agentId: id });
      const resumeReply = pi.events.emit.mock.calls.find(
        (c: any[]) => c[0] === "subagents:rpc:resume:reply:req-resume-resume",
      );
      expect(resumeReply![1]).toEqual({ success: true });
      expect(pi.events.emit).toHaveBeenCalledWith("subagents:resumed", {
        id,
        type: "general-purpose",
        description: "rpc resume test",
      });
      // The gate-parked resume continues the original run in place.
      expect(idEmits(pi, "subagents:started", id), "no second start on resume").toHaveLength(1);
    } finally {
      await lifecycle.get("session_shutdown")();
    }
  });

  it("a refused RPC resume emits no subagents:resumed", async () => {
    const { pi, lifecycle, busHandlers } = makePi();
    subagentsExtension(pi);

    await lifecycle.get("session_start")({}, ctx());

    vi.mocked(runAgent).mockImplementation((_ctx: any, _type: any, _prompt: any, options: any) => {
      options.onSessionCreated?.({ messages: [], subscribe: () => vi.fn() });
      return new Promise(() => {}) as any; // still running: nothing to resume
    });
    try {
      await busHandlers.get("subagents:rpc:spawn")!({
        requestId: "req-refuse-spawn",
        type: "general-purpose",
        prompt: "go",
        options: { description: "rpc refusal test" },
      });
      const spawnReply = pi.events.emit.mock.calls.find(
        (c: any[]) => c[0] === "subagents:rpc:spawn:reply:req-refuse-spawn",
      );
      const id: string = spawnReply![1].data.id;

      await busHandlers.get("subagents:rpc:resume")!({ requestId: "req-refuse-resume", agentId: id });

      const resumeReply = pi.events.emit.mock.calls.find(
        (c: any[]) => c[0] === "subagents:rpc:resume:reply:req-refuse-resume",
      );
      expect(resumeReply![1]).toEqual({ success: false, error: "Agent cannot be resumed" });
      expect(pi.events.emit).not.toHaveBeenCalledWith("subagents:resumed", expect.anything());
    } finally {
      await lifecycle.get("session_shutdown")();
    }
  });

  it("renders an RPC-spawned agent in the fleet view while it is running", async () => {
    const { pi, lifecycle, busHandlers } = makePi();
    const activeCtx = ctx(true);
    subagentsExtension(pi);

    await lifecycle.get("session_start")({}, activeCtx);

    vi.mocked(runAgent).mockImplementation((_ctx, _type, _prompt, options: any) => {
      options?.onSessionCreated?.({ subscribe: () => vi.fn() });
      return new Promise(() => {}) as any;
    }); // keep agent running
    try {
      await busHandlers.get("subagents:rpc:spawn")!({
        requestId: "req-widget",
        type: "general-purpose",
        prompt: "go",
        options: { description: "visible RPC agent" },
      });

      await vi.waitFor(() => {
        expect(activeCtx.ui.setWidget).toHaveBeenCalledWith(
          "fleet",
          expect.any(Function),
          { placement: "belowEditor" },
        );
        expect(activeCtx.ui.setStatus).toHaveBeenCalledWith("subagents", "1 running agent");
      });
    } finally {
      await lifecycle.get("session_shutdown")();
    }
  });

  it("wires live tool activity for an RPC-spawned background agent", async () => {
    const { pi, lifecycle, busHandlers } = makePi();
    let onToolActivity: ((activity: { type: "start" | "end"; toolName: string }) => void) | undefined;
    vi.mocked(runAgent).mockImplementation((_ctx, _type, _prompt, options: any) => {
      onToolActivity = options.onToolActivity;
      options.onSessionCreated?.({ subscribe: () => vi.fn() });
      return new Promise(() => {}) as any;
    });
    subagentsExtension(pi);

    const extensionCtx = ctx(true);
    await lifecycle.get("session_start")({}, extensionCtx);
    // TaskExecute runs inside a root tool call, so the extension already has
    // the UI context before pi-tasks sends its cross-extension spawn request.
    await lifecycle.get("tool_execution_start")({}, extensionCtx);
    await busHandlers.get("subagents:rpc:spawn")!({
      requestId: "req-activity",
      type: "general-purpose",
      prompt: "go",
      options: { description: "rpc activity test", isBackground: true },
    });
    await vi.waitFor(() => expect(onToolActivity).toBeTypeOf("function"));
    expect(onToolActivity).toBeTypeOf("function");
  });

  it("is idempotent — a second session_start does not re-advertise or double-register", async () => {
    const { pi, lifecycle } = makePi();
    subagentsExtension(pi);

    await lifecycle.get("session_start")({}, ctx());
    await lifecycle.get("session_start")({}, ctx());

    expect(readyEmits(pi), "subagents:ready emitted exactly once across two session_starts").toHaveLength(1);
    for (const channel of RPC_CHANNELS) {
      expect(onCallsFor(pi, channel), `${channel} registered exactly once`).toHaveLength(1);
    }
  });
});
