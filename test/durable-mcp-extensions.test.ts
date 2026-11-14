import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MemoryStorage } from "@earendil-works/pi-durable";
import { describe, expect, it, vi } from "vitest";
import { runAgent } from "../src/agent-runner.js";
import { bridgePiToolToDurableTool } from "../src/runner/durable-tool-bridge.js";

function createMockCtx(): ExtensionContext {
  return {
    cwd: process.cwd(),
    getSystemPrompt: () => "You are a test assistant.",
    model: { provider: "mock-provider", id: "mock-model" },
    modelRegistry: {
      find: vi.fn(),
      getAvailable: () => [],
    },
    isProjectTrusted: () => true,
  } as unknown as ExtensionContext;
}

function createMockPi(): ExtensionAPI {
  return {
    exec: vi.fn(async () => ({ stdout: "", stderr: "", code: 0 })),
    events: {
      emit: vi.fn(),
      on: vi.fn(),
    },
  } as unknown as ExtensionAPI;
}

vi.setConfig({ testTimeout: 30_000 });

describe("Durable runner with extensions and MCP tools", () => {
  it("boots extension runtime and binds tools to the durable registry", async () => {
    const ctx = createMockCtx();
    const pi = createMockPi();
    const storage = new MemoryStorage();
    const toolActivities: any[] = [];

    const result = await runAgent(ctx, "Explore", undefined, {
      pi,
      storage,
      onToolActivity: (activity) => toolActivities.push(activity),
    });

    expect(result).toBeDefined();
    expect(result.aborted).toBe(false);
    expect(result.session).toBeDefined();
    // Verify session has active tool names available
    const activeToolNames = result.session.getActiveToolNames();
    expect(Array.isArray(activeToolNames)).toBe(true);
  });

  it("bridges custom extension and MCP tools, delivering lifecycle events and formatted results", async () => {
    const events: any[] = [];
    const mockTool = {
      name: "mcp__fixture__echo",
      description: "Echo tool",
      parameters: { type: "object", properties: { message: { type: "string" } } },
      execute: vi.fn(async (_callId, params: any, _signal, update) => {
        update?.("streaming update");
        return { content: [{ type: "text", text: `echo: ${params.message}` }] };
      }),
    };

    const sessionMock: any = {
      messages: [],
      _emit: (e: any) => events.push(e),
      agent: {},
    };

    const durableTool = bridgePiToolToDurableTool(mockTool as any, {
      onToolStart: (info) => sessionMock._emit({ type: "tool_execution_start", ...info }),
      onToolUpdate: (info) => sessionMock._emit({ type: "tool_execution_update", ...info }),
      onToolResult: (res) => {
        sessionMock.messages.push(res);
        sessionMock._emit({ type: "tool_execution_end", ...res });
      },
    });

    const mockApi: any = { output: vi.fn() };
    const res = await durableTool.execute({ message: "test input" }, mockApi, BACKGROUND_CONTEXT);

    expect(mockTool.execute).toHaveBeenCalledTimes(1);
    expect(res.isError).toBe(false);
    expect(res.output).toEqual([{ type: "text", text: "echo: test input" }]);
    expect(events.map(e => e.type)).toEqual([
      "tool_execution_start",
      "tool_execution_update",
      "tool_execution_end",
    ]);
    expect(sessionMock.messages).toHaveLength(1);
    expect(sessionMock.messages[0].content).toEqual([{ type: "text", text: "echo: test input" }]);
  });
});
