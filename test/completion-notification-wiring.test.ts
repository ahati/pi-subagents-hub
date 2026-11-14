import { afterEach, describe, expect, it, vi } from "vitest";
import type * as AgentRunnerModule from "../src/agent-runner.js";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof AgentRunnerModule>("../src/agent-runner.js");
  return {
    ...actual,
    runAgent: vi.fn(),
  };
});

import { resumeAgent, runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";

interface RegisteredTool {
  name: string;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: undefined,
    ctx: ReturnType<typeof makeHeadlessCtx>,
  ) => Promise<unknown>;
}

function makePi() {
  const tools = new Map<string, RegisteredTool>();
  const handlers = new Map<string, (...args: never[]) => unknown>();

  return {
    pi: {
      registerMessageRenderer: vi.fn(),
      registerTool: vi.fn((tool: RegisteredTool) => {
        tools.set(tool.name, tool);
      }),
      registerCommand: vi.fn(),
      registerEntryRenderer: vi.fn(),
      registerFlag: vi.fn(),
      getFlag: vi.fn(),
      on: vi.fn((event: string, handler: (...args: never[]) => unknown) => {
        handlers.set(event, handler);
      }),
      events: {
        emit: vi.fn(),
        on: vi.fn(() => vi.fn()),
      },
      appendEntry: vi.fn(),
      sendMessage: vi.fn(),
    } as never,
    tools,
    handlers,
  };
}

function makeHeadlessCtx() {
  return {
    hasUI: false,
    ui: {
      setStatus: vi.fn(),
      setWidget: vi.fn(),
      notify: vi.fn(),
    },
    cwd: "/tmp",
    model: undefined,
    modelRegistry: {
      find: vi.fn(),
      getAvailable: vi.fn(() => []),
    },
    sessionManager: {
      getSessionId: vi.fn(() => "session-1"),
      getBranch: vi.fn(() => []),
    },
    getSystemPrompt: vi.fn(() => "parent prompt"),
  } as never;
}

function completedRun() {
  return {
    responseText: "done",
    session: { dispose: vi.fn() },
    aborted: false,
    steered: false,
  } as Awaited<ReturnType<typeof runAgent>>;
}

async function spawnBackground(
  tool: RegisteredTool,
  toolCallId: string,
  description: string,
): Promise<void> {
  await tool.execute(
    toolCallId,
    {
      prompt: "reply done",
      description,
      subagent_type: "general-purpose",
      run_in_background: true,
    },
    undefined,
    undefined,
    makeHeadlessCtx(),
  );
}

describe("background completion notification wiring", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("requests steering for an individual completion after the result-consumption hold", async () => {
    vi.useFakeTimers();
    vi.mocked(runAgent).mockResolvedValue(completedRun());

    const { pi, tools, handlers } = makePi();
    subagentsExtension(pi);

    await spawnBackground(tools.get("Agent")!, "individual-call", "individual child");
    await vi.advanceTimersByTimeAsync(200); // result-consumption hold

    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "subagent-notification",
        content: expect.stringContaining("individual child"),
      }),
      { deliverAs: "steer", triggerTurn: true },
    );

    await handlers.get("session_shutdown")?.();
  });

  it("sends completions that land together as one steering message, not a message each", async () => {
    vi.useFakeTimers();
    // Both runs settle after their spawns return, as real runs do.
    let settleRuns!: () => void;
    const runsSettled = new Promise<void>((resolve) => { settleRuns = resolve; });
    vi.mocked(runAgent).mockImplementation(async () => {
      await runsSettled;
      return completedRun();
    });

    const { pi, tools, handlers } = makePi();
    subagentsExtension(pi);
    const agentTool = tools.get("Agent")!;

    await Promise.all([
      spawnBackground(agentTool, "batch-call-1", "first batched child"),
      spawnBackground(agentTool, "batch-call-2", "second batched child"),
    ]);
    settleRuns();
    await vi.advanceTimersByTimeAsync(200); // result-consumption hold

    expect(pi.sendMessage).toHaveBeenCalledTimes(1);
    expect(pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "subagent-notification",
        content: expect.stringContaining("2 background tasks finished"),
        details: expect.objectContaining({
          description: "first batched child",
          others: [expect.objectContaining({ description: "second batched child" })],
        }),
      }),
      { deliverAs: "steer", triggerTurn: true },
    );

    await handlers.get("session_shutdown")?.();
  });

  it("delivers runs that settle while their Agent calls start up exactly once", async () => {
    vi.useFakeTimers();
    // Settled before the tool's awaitStartup continues — the spawn-time batch
    // used to notify each alone, then again in their group.
    vi.mocked(runAgent).mockResolvedValue(completedRun());

    const { pi, tools, handlers } = makePi();
    subagentsExtension(pi);
    const agentTool = tools.get("Agent")!;

    await Promise.all([
      spawnBackground(agentTool, "instant-call-1", "first instant child"),
      spawnBackground(agentTool, "instant-call-2", "second instant child"),
    ]);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(pi.sendMessage).toHaveBeenCalledTimes(1);

    await handlers.get("session_shutdown")?.();
  });

  it("steers the owning parent subagent when its background nested child completes", async () => {
    const parentSteer = vi.fn().mockResolvedValue("queued");
    let resolveParent!: (value: Awaited<ReturnType<typeof runAgent>>) => void;
    let resolveChild!: (value: Awaited<ReturnType<typeof runAgent>>) => void;
    let resolveChild2!: (value: Awaited<ReturnType<typeof runAgent>>) => void;

    vi.mocked(runAgent)
      .mockImplementationOnce((_ctx, _type, _prompt, opts) => {
        opts.onSessionCreated?.({
          steer: parentSteer,
          dispose: vi.fn(),
          subscribe: vi.fn(() => () => {}),
          messages: [],
          getActiveToolNames: vi.fn(() => []),
        } as never);
        return new Promise((resolve) => { resolveParent = resolve; });
      })
      .mockImplementationOnce(() => new Promise((resolve) => { resolveChild = resolve; }))
      .mockImplementationOnce(() => new Promise((resolve) => { resolveChild2 = resolve; }))
      .mockResolvedValueOnce(completedRun());

    const { pi, tools, handlers } = makePi();
    subagentsExtension(pi);
    const agentTool = tools.get("Agent")!;
    const spawnRes = await agentTool.execute(
      "parent-call",
      { prompt: "orchestrate", description: "parent orchestrator", subagent_type: "general-purpose", run_in_background: true },
      undefined,
      undefined,
      makeHeadlessCtx(),
    ) as { content: Array<{ text: string }> };
    const parentId = /Agent ID: (\S+)/.exec(spawnRes.content[0].text)![1];
    const nestedRuntime = vi.mocked(runAgent).mock.calls.find(c => c[3].agentId === parentId)![3].nestedRuntime!;
    const childId = nestedRuntime.manager.spawn(pi, makeHeadlessCtx(), "Explore", "find files", {
      description: "nested explore",
      isBackground: true,
      depth: 2,
      parentAgentId: parentId,
    });

    resolveChild({ responseText: "found target.ts", session: { dispose: vi.fn() } as never, aborted: false, steered: false });
    await nestedRuntime.manager.getRecord(childId)!.promise;

    expect(parentSteer).toHaveBeenCalledTimes(1);
    const notification = parentSteer.mock.calls[0][0] as string;
    expect(notification).toContain("<task-notification>");
    expect(notification).toContain(`<task-id>${childId}</task-id>`);
    expect(notification).toContain("found target.ts");
    expect(notification).toContain("get_subagent_result");
    expect(pi.sendMessage).not.toHaveBeenCalled();

    // Suppress duplicate steer when the parent is already awaiting the same child inline
    // or when the child is a foreground spawn.
    const parentRecord = nestedRuntime.manager.getRecord(parentId)!;
    const child2Id = nestedRuntime.manager.spawn(pi, makeHeadlessCtx(), "Explore", "second", {
      description: "awaited child",
      isBackground: true,
      depth: 2,
      parentAgentId: parentId,
    });
    parentRecord.waitingChildIds = new Set([child2Id]);
    const child3Id = nestedRuntime.manager.spawn(pi, makeHeadlessCtx(), "Explore", "third", {
      description: "foreground child",
      isBackground: false,
      depth: 2,
      parentAgentId: parentId,
    });
    await nestedRuntime.manager.getRecord(child3Id)!.promise;
    resolveChild2({ responseText: "second", session: { dispose: vi.fn() } as never, aborted: false, steered: false });
    await nestedRuntime.manager.getRecord(child2Id)!.promise;
    expect(parentSteer).toHaveBeenCalledTimes(1);

    resolveParent(completedRun());
    await handlers.get("session_shutdown")?.();
  });

  it("drains nested background child completion notifications on resumeAgent", async () => {
    let queued = false;
    const continueFn = vi.fn(async () => {
      queued = false;
    });
    const fakeSession = {
      messages: [{ role: "assistant", content: [{ type: "text", text: "waiting for child" }] }],
      subscribe: () => () => {},
      prompt: vi.fn(async () => {}),
      agent: {
        hasQueuedMessages: () => queued,
        continue: continueFn,
      },
    } as never;

    let waitCalls = 0;
    const waitForBackgroundChild = vi.fn(async () => {
      waitCalls++;
      if (waitCalls === 1) {
        queued = true;
        return true;
      }
      return false;
    });

    const outcome = await resumeAgent(fakeSession, "check child", {
      type: "general-purpose",
      waitForBackgroundChild,
    });

    expect(waitForBackgroundChild).toHaveBeenCalledTimes(2);
    expect(continueFn).toHaveBeenCalledTimes(1);
    expect(outcome.failure).toBeUndefined();
  });
});
