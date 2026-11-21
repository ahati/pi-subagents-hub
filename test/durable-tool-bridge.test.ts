import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";
import { describe, expect, it, vi } from "vitest";
import { bridgeDurableTool, bridgePiToolToDurableTool, type ExecutablePiTool } from "../src/runner/durable-tool-bridge.js";

describe("bridgePiToolToDurableTool", () => {
  it("converts a Pi tool into a durable ToolRegistration and emits start/result events", async () => {
    const starts: Array<{ toolName: string; toolCallId: string; args: unknown }> = [];
    const results: unknown[] = [];
    const mockTool: ExecutablePiTool = {
      name: "mcp__calculator__add",
      description: "Add two numbers",
      parameters: {
        type: "object",
        properties: { a: { type: "number" }, b: { type: "number" } },
        required: ["a", "b"],
      },
      execute: vi.fn(async (_callId, params) => {
        return {
          content: [{ type: "text", text: String(params.a + params.b) }],
          details: { sum: params.a + params.b },
        };
      }),
    };

    const durableTool = bridgePiToolToDurableTool(mockTool, {
      onToolStart: (info) => starts.push(info),
      onToolResult: (message) => results.push(message),
    });

    expect(durableTool.name).toBe("mcp__calculator__add");
    expect(durableTool.description).toBe("Add two numbers");
    expect(durableTool.replay).toBe("unsafe");

    const mockApi: any = {
      output: vi.fn(),
    };

    const result = await durableTool.execute({ a: 10, b: 25 }, mockApi, BACKGROUND_CONTEXT);

    expect(result.isError).toBe(false);
    expect(result.output).toEqual([{ type: "text", text: "35" }]);
    expect(result.details).toEqual({ sum: 35 });
    expect(mockTool.execute).toHaveBeenCalledTimes(1);

    expect(starts).toHaveLength(1);
    expect(starts[0].toolName).toBe("mcp__calculator__add");
    expect(starts[0].args).toEqual({ a: 10, b: 25 });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      role: "toolResult",
      toolName: "mcp__calculator__add",
      content: [{ type: "text", text: "35" }],
      details: { sum: 35 },
      isError: false,
    });
  });

  it.each([false, true])("preserves tool usage with hook override=%s in durable results and emitted messages", async (override) => {
    const usage = { input: 10, output: 3, cacheRead: 2, cacheWrite: 5, totalTokens: 20,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 1 } };
    const finalUsage = override ? { ...usage, output: 8, totalTokens: 25 } : usage;
    const messages: unknown[] = [];
    const durableTool = bridgePiToolToDurableTool({
      name: "paid-tool", parameters: {},
      execute: async () => ({ content: [{ type: "text", text: "done" }], details: {}, usage }),
    }, {
      afterToolCall: async (context) => {
        expect(context.result.usage).toEqual(usage);
        return override ? { usage: finalUsage } : undefined;
      },
      onToolResult: (message) => messages.push(message),
    });
    const result = await durableTool.execute({}, { output: vi.fn(), callId: "paid-call" } as Parameters<typeof durableTool.execute>[1], BACKGROUND_CONTEXT);
    expect(result.usage).toEqual(finalUsage);
    expect(messages).toEqual([expect.objectContaining({ usage: finalUsage })]);
  });

  it("applies finalized result overrides to durable results and emitted messages", async () => {
    const messages: unknown[] = [];
    const durableTool = bridgePiToolToDurableTool({
      name: "filtered-tool", parameters: {},
      execute: async () => ({ content: [{ type: "text", text: "original" }], details: { original: true } }),
    }, {
      afterToolCall: async () => ({ content: [{ type: "text", text: "filtered" }], details: { filtered: true }, isError: true }),
      onToolResult: (message) => messages.push(message),
    });
    const result = await durableTool.execute({}, { output: vi.fn(), callId: "filtered-call" } as Parameters<typeof durableTool.execute>[1], BACKGROUND_CONTEXT);
    expect(result).toMatchObject({ output: [{ type: "text", text: "filtered" }], details: { filtered: true }, isError: true });
    expect(messages).toEqual([expect.objectContaining({ content: result.output, details: result.details, isError: true })]);
  });

  it("marks read-only inspection tools as replay-safe", () => {
    const readTool: ExecutablePiTool = {
      name: "read",
      parameters: {},
      execute: async () => ({ content: [] }),
    };
    const durableRead = bridgePiToolToDurableTool(readTool);
    expect(durableRead.replay).toBe("safe");

    const grepTool: ExecutablePiTool = {
      name: "grep",
      parameters: {},
      execute: async () => ({ content: [] }),
    };
    const durableGrep = bridgePiToolToDurableTool(grepTool);
    expect(durableGrep.replay).toBe("safe");

    const bashTool: ExecutablePiTool = {
      name: "bash",
      parameters: {},
      execute: async () => ({ content: [] }),
    };
    const durableBash = bridgePiToolToDurableTool(bashTool);
    expect(durableBash.replay).toBe("unsafe");
  });

  it("catches errors and reports isError: true", async () => {
    const failingTool: ExecutablePiTool = {
      name: "failing_tool",
      parameters: {},
      execute: async () => {
        throw new Error("Network timeout contacting MCP service");
      },
    };

    const durableTool = bridgePiToolToDurableTool(failingTool);
    const mockApi: any = { output: vi.fn() };

    const result = await durableTool.execute({}, mockApi, BACKGROUND_CONTEXT);
    expect(result.isError).toBe(true);
    expect(result.output).toEqual([{ type: "text", text: "Network timeout contacting MCP service" }]);
  });

  it.each([undefined, false])("finalizes thrown errors once with redaction and usage (isError override=%s)", async (isError) => {
    const content = [{ type: "text" as const, text: "Service unavailable [redacted]" }];
    const usage = { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 10,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.25 } };
    const messages: unknown[] = [];
    const onToolStart = vi.fn();
    const afterToolCall = vi.fn(async () => ({ content, details: { redacted: true }, usage, isError }));
    const durableTool = bridgePiToolToDurableTool({
      name: "paid-service", parameters: {},
      execute: async () => { throw new Error("Service failed with token=SECRET-123"); },
    }, { afterToolCall, onToolStart, onToolResult: (message) => messages.push(message) });
    const result = await durableTool.execute({}, { output: vi.fn(), callId: "error-call" } as Parameters<typeof durableTool.execute>[1], BACKGROUND_CONTEXT);

    expect(afterToolCall).toHaveBeenCalledTimes(1);
    expect(afterToolCall).toHaveBeenCalledWith({
      toolCall: { type: "toolCall", id: "error-call", name: "paid-service", arguments: {} },
      args: {},
      result: { content: [{ type: "text", text: "Service failed with token=SECRET-123" }], details: {}, usage: undefined },
      isError: true,
    }, undefined);
    expect(result).toEqual({ output: content, details: { redacted: true }, usage, isError: isError ?? true });
    expect(messages).toEqual([{
      role: "toolResult", toolName: "paid-service", toolCallId: "error-call", content,
      details: { redacted: true }, usage, isError: isError ?? true, timestamp: expect.any(Number),
    }]);
    expect(onToolStart.mock.calls).toEqual([
      [{ toolName: "paid-service", toolCallId: "error-call", args: {} }],
    ]);
  });

  it.each([false, true])("handles a throwing finalization hook once after execution throws=%s", async (throws) => {
    const usage = { input: 7, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 10,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.25 } };
    const messages: unknown[] = [];
    const onToolStart = vi.fn();
    const afterToolCall = vi.fn(async () => { throw "Hook failed"; });
    const durableTool = bridgePiToolToDurableTool({
      name: "paid-service", parameters: {},
      execute: async () => {
        if (throws) throw new Error("Service failed");
        return { content: [{ type: "text", text: "done" }], details: { original: true }, usage };
      },
    }, { afterToolCall, onToolStart, onToolResult: (message) => messages.push(message) });
    const result = await durableTool.execute({}, { output: vi.fn(), callId: "hook-error" } as Parameters<typeof durableTool.execute>[1], BACKGROUND_CONTEXT);

    expect(afterToolCall).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ output: [{ type: "text", text: "Hook failed" }], details: {}, isError: true, usage: undefined });
    expect(messages).toEqual([{
      role: "toolResult", toolName: "paid-service", toolCallId: "hook-error", content: result.output,
      details: {}, isError: true, usage: undefined, timestamp: expect.any(Number),
    }]);
    expect(onToolStart.mock.calls).toEqual([
      [{ toolName: "paid-service", toolCallId: "hook-error", args: {} }],
    ]);
  });

  it("passes both toolCall and args to beforeToolCall", async () => {
    let capturedHookContext: any;
    const testTool: ExecutablePiTool = {
      name: "bash",
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
      execute: async (_callId, params) => ({
        content: [{ type: "text", text: `Executed ${params.command}` }],
      }),
    };

    const durableTool = bridgePiToolToDurableTool(testTool, {
      beforeToolCall: async (context) => {
        capturedHookContext = context;
      },
    });

    const mockApi: any = { output: vi.fn(), callId: "call-123" };
    const inputArgs = { command: "ls -la" };
    const result = await durableTool.execute(inputArgs, mockApi, BACKGROUND_CONTEXT);

    expect(result.isError).toBe(false);
    expect(capturedHookContext).toBeDefined();
    expect(capturedHookContext.args).toEqual(inputArgs);
    expect(capturedHookContext.toolCall).toBeDefined();
    expect(capturedHookContext.toolCall.name).toBe("bash");
    expect(capturedHookContext.toolCall.arguments).toEqual(inputArgs);
    expect(capturedHookContext.toolCall.id).toBe("call-123");
  });
});

describe("bridgeDurableTool", () => {
  it("adapts a native ToolRegistration with full lifecycle hooks and event forwarding", async () => {
    const starts: Array<{ toolName: string; toolCallId: string; args: unknown }> = [];
    const updates: Array<{ toolName: string; toolCallId: string; partialResult: any }> = [];
    const results: any[] = [];

    const mockNativeTool: ToolRegistration = defineTool({
      name: "bash",
      description: "Run shell command",
      parameters: { type: "object", properties: { command: { type: "string" } } },
      replay: "unsafe",
      async execute(_args: any, api: any) {
        api.output("chunk1 ");
        api.output("chunk2");
        return {
          output: [{ type: "text", text: "chunk1 chunk2" }],
          details: { exitCode: 0 },
        };
      },
    });

    const bridged = bridgeDurableTool(mockNativeTool, {
      onToolStart: (info) => starts.push(info),
      onToolUpdate: (info) => updates.push(info),
      onToolResult: (res) => results.push(res),
    });

    expect(bridged.name).toBe("bash");
    expect(bridged.replay).toBe("unsafe");

    const mockApi: any = { output: vi.fn(), callId: "bash-call-1" };
    const res = await bridged.execute({ command: "echo hello" }, mockApi, BACKGROUND_CONTEXT);

    expect(res.isError).toBe(false);
    expect(res.output).toEqual([{ type: "text", text: "chunk1 chunk2" }]);
    expect(starts).toHaveLength(1);
    expect(starts[0].toolCallId).toBe("bash-call-1");
    expect(updates).toHaveLength(2);
    expect(updates[0].partialResult).toEqual({ content: [{ type: "text", text: "chunk1 " }] });
    expect(updates[1].partialResult).toEqual({ content: [{ type: "text", text: "chunk1 chunk2" }] });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      role: "toolResult",
      toolName: "bash",
      toolCallId: "bash-call-1",
      isError: false,
    });
  });

  it("handles throwing native tool and resolves custom callId", async () => {
    const mockFailingTool: ToolRegistration = defineTool({
      name: "write",
      description: "Write file",
      parameters: {},
      replay: "unsafe",
      async execute() {
        throw new Error("Disk full");
      },
    });

    const results: any[] = [];
    const bridged = bridgeDurableTool(mockFailingTool, {
      resolveCallId: (toolName) => `custom-${toolName}`,
      onToolResult: (res) => results.push(res),
    });

    const res = await bridged.execute({}, { output: vi.fn() } as any, BACKGROUND_CONTEXT);
    expect(res.isError).toBe(true);
    expect(res.output).toEqual([{ type: "text", text: "Disk full" }]);
    expect(results[0].toolCallId).toBe("custom-write");
  });
});

describe("bridgeDurableTool full result contract", () => {
  it("propagates a ToolPark untouched, without firing end hooks", async () => {
    const park = { sleep: { until: 1234, checkpoint: { phase: 1 } } };
    const mockParkingTool: ToolRegistration = defineTool({
      name: "wait_for_signal",
      description: "Park until a signal arrives",
      parameters: {},
      replay: "safe",
      async execute() {
        return park;
      },
    });

    const starts: unknown[] = [];
    const updates: Array<{ toolName: string; toolCallId: string; partialResult: any }> = [];
    const results: unknown[] = [];
    const bridged = bridgeDurableTool(mockParkingTool, {
      onToolStart: (info) => starts.push(info),
      onToolUpdate: (info) => updates.push(info),
      onToolResult: (res) => results.push(res),
    });

    const res = await bridged.execute({}, { output: vi.fn(), callId: "park-1" } as any, BACKGROUND_CONTEXT);

    expect(res).toBe(park);
    // The call is not over: onToolStart fired, but no result was reported —
    // both end hooks run again when pi-durable re-runs execute() on wake.
    expect(starts).toHaveLength(1);
    expect(results).toHaveLength(0);
    // One status line as the call's live output, naming when it wakes.
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ toolName: "wait_for_signal", toolCallId: "park-1" });
    expect(updates[0].partialResult.content).toEqual([
      { type: "text", text: `parked until ${new Date(1234).toLocaleTimeString()} — the call resumes on wake` },
    ]);
  });

  it("keeps streamed output above the park note and names watched signals", async () => {
    const mockParkingTool: ToolRegistration = defineTool({
      name: "wait_for_approval",
      description: "Park until approved",
      parameters: {},
      replay: "safe",
      async execute(_args: any, api: any) {
        api.output("draft ready");
        return { sleep: { signals: [{ signal: "approval", key: "pr-7" }] } };
      },
    });

    const updates: Array<{ partialResult: any }> = [];
    const bridged = bridgeDurableTool(mockParkingTool, {
      onToolUpdate: (info) => updates.push(info),
    });

    await bridged.execute({}, { output: vi.fn(), callId: "park-2" } as any, BACKGROUND_CONTEXT);

    // The streamed chunk's cumulative update, then the park note appended to it.
    expect(updates[updates.length - 1].partialResult.content).toEqual([
      { type: "text", text: "draft ready\nparked for approval — the call resumes on wake" },
    ]);
  });

  it("preserves structuredOutput and diagnostics from the native tool's result", async () => {
    const structuredOutput = { kind: "read", path: "/tmp/x" };
    const diagnostics = [{ path: "/tmp/x", line: 1 }];
    const nativeRead: ToolRegistration = defineTool({
      name: "read",
      description: "Read file",
      parameters: {},
      replay: "safe",
      async execute() {
        return { output: [{ type: "text", text: "file body" }], structuredOutput, diagnostics };
      },
    });

    const bridged = bridgeDurableTool(nativeRead);
    const res = await bridged.execute({}, { output: vi.fn(), callId: "read-1" } as any, BACKGROUND_CONTEXT);

    expect(res.output).toEqual([{ type: "text", text: "file body" }]);
    expect(res.structuredOutput).toEqual(structuredOutput);
    expect(res.diagnostics).toEqual(diagnostics);
    expect(res.isError).toBe(false);
  });

  it("hands the afterToolCall hook the full toolResult message, not just content/details/usage", async () => {
    const seen: any[] = [];
    const nativeRead: ToolRegistration = defineTool({
      name: "read",
      description: "Read file",
      parameters: {},
      replay: "safe",
      async execute() {
        return { output: [{ type: "text", text: "body" }] };
      },
    });

    const bridged = bridgeDurableTool(nativeRead, {
      afterToolCall: async (context) => {
        seen.push(context);
      },
    });
    await bridged.execute({ path: "/tmp/x" }, { output: vi.fn(), callId: "read-full" } as any, BACKGROUND_CONTEXT);

    expect(seen).toHaveLength(1);
    expect(seen[0].result).toMatchObject({
      role: "toolResult",
      toolCallId: "read-full",
      toolName: "read",
      isError: false,
      content: [{ type: "text", text: "body" }],
    });
    expect(typeof seen[0].result.timestamp).toBe("number");
  });

  it("a returned output beats the retained stream, and a bare-string result still surfaces", async () => {
    const api = () =>
      ({ output: vi.fn(), callId: "bash-1", retainedOutput: () => ({ text: "streamed partial" }) }) as any;

    const returnsOutput: ToolRegistration = defineTool({
      name: "bash",
      description: "Run",
      parameters: {},
      replay: "unsafe",
      async execute() {
        return { output: [{ type: "text", text: "final result" }] };
      },
    });
    const withOutput = await bridgeDurableTool(returnsOutput).execute({}, api(), BACKGROUND_CONTEXT);
    expect(withOutput.output).toEqual([{ type: "text", text: "final result" }]);

    const streamsOnly: ToolRegistration = defineTool({
      name: "bash",
      description: "Run",
      parameters: {},
      replay: "unsafe",
      async execute(_args: any, toolApi: any) {
        toolApi.output("streamed partial");
        return {};
      },
    });
    const streamed = await bridgeDurableTool(streamsOnly).execute({}, api(), BACKGROUND_CONTEXT);
    expect(streamed.output).toEqual([{ type: "text", text: "streamed partial" }]);

    const returnsString: ToolRegistration = defineTool({
      name: "bash",
      description: "Run",
      parameters: {},
      replay: "unsafe",
      async execute() {
        return "bare string" as unknown as Record<string, never>;
      },
    });
    const bare = await bridgeDurableTool(returnsString).execute({}, { output: vi.fn(), callId: "bash-2" } as any, BACKGROUND_CONTEXT);
    expect(bare.output).toEqual([{ type: "text", text: "bare string" }]);
  });
});
