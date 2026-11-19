/**
 * durable-tool-bridge.ts — Adapts Pi, MCP, and native durable tools to @earendil-works/pi-durable ToolRegistration.
 */

import type { Context } from "@earendil-works/chord/context";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { defineTool, type ToolRegistration } from "@earendil-works/pi-durable";

/**
 * The JSON value union chord's tool signature takes. Declared here because
 * chord 1.5.0 exports it from the package root and 1.5.2 from `./json`; the
 * shape is unchanged, and the local alias compiles against both.
 */
type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

/** Set of tools that are idempotent and safe to rerun if interrupted by process restart. */
const REPLAY_SAFE_TOOLS = new Set([
  "read",
  "grep",
  "find",
  "ls",
  "glob",
  "get_subagent_result",
]);

export interface BridgeToolOptions {
  beforeToolCall?: (context: any, signal?: AbortSignal) => Promise<any> | any;
  afterToolCall?: (context: any, signal?: AbortSignal) => Promise<any> | any;
  onToolStart?: (info: { toolName: string; toolCallId: string; args: any }) => void;
  onToolUpdate?: (info: { toolName: string; toolCallId: string; args: any; partialResult: any }) => void;
  onToolResult?: (result: any) => void;
  signal?: AbortSignal;
  toolContext?: unknown | ((callId: string) => unknown);
  resolveCallId?: (toolName: string, api: any) => string | undefined;
}

export interface ExecutablePiTool {
  name: string;
  description?: string;
  parameters: object;
  prepareArguments?: (args: unknown) => unknown;
  execute: (
    toolCallId: string,
    params: any,
    signal?: AbortSignal,
    onUpdate?: (partial: any) => void,
    ctx?: any,
  ) => Promise<AgentToolResult<any>>;
}

interface ToolExecutionCoreParams {
  toolName: string;
  args: any;
  api: any;
  options: BridgeToolOptions;
  invoke: (callId: string, updateCallback: (partial: any) => void) => Promise<unknown>;
}

async function executeWithToolLifecycle(params: ToolExecutionCoreParams): Promise<{
  output: ToolResultMessage["content"];
  isError: boolean;
  details: JsonValue;
  usage?: any;
}> {
  const { toolName, args, api, options, invoke } = params;
  const callId =
    (api as any)?.callId ??
    options.resolveCallId?.(toolName, api) ??
    `call-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  if (options.beforeToolCall) {
    const decision = await options.beforeToolCall(
      { toolCall: { type: "toolCall", id: callId, name: toolName, arguments: args }, args },
      options.signal,
    );
    if (decision?.block) {
      throw new Error(decision.reason ?? `Tool call blocked: ${toolName}`);
    }
  }
  if (options.signal?.aborted) {
    throw new Error("Aborted");
  }

  options.onToolStart?.({
    toolName,
    toolCallId: callId,
    args,
  });

  const updateCallback = (partial: any) => {
    if (!partial) return;
    options.onToolUpdate?.({
      toolName,
      toolCallId: callId,
      args,
      partialResult: partial,
    });
    if (typeof partial === "string") {
      api?.output?.(partial);
    } else if (typeof partial === "object") {
      if (typeof partial.content === "string") {
        api?.output?.(partial.content);
      } else if (Array.isArray(partial.content)) {
        for (const part of partial.content) {
          if (part && typeof part === "object" && part.type === "text" && typeof part.text === "string") {
            api?.output?.(part.text);
          }
        }
      }
    }
  };

  let rawResult: any;
  try {
    rawResult = await invoke(callId, updateCallback);
  } catch (err: unknown) {
    rawResult = {
      content: [{ type: "text", text: err instanceof Error ? err.message : String(err) }],
      details: {},
      isError: true,
    };
  }

  const output: ToolResultMessage["content"] = Array.isArray(rawResult?.content)
    ? (rawResult.content as ToolResultMessage["content"])
    : typeof rawResult?.content === "string"
      ? [{ type: "text" as const, text: rawResult.content }]
      : Array.isArray(rawResult?.output)
        ? (rawResult.output as ToolResultMessage["content"])
        : typeof rawResult?.output === "string"
          ? [{ type: "text" as const, text: rawResult.output }]
          : typeof rawResult?.structuredOutput?.output === "string"
            ? [{ type: "text" as const, text: rawResult.structuredOutput.output }]
            : [];

  let finalOutput = output;
  let finalDetails = rawResult?.details ?? rawResult?.structuredOutput;
  let finalIsError = rawResult?.isError === true;
  let finalUsage = rawResult?.usage;

  try {
    if (options.afterToolCall) {
      const hookResult = await options.afterToolCall(
        {
          toolCall: { type: "toolCall", id: callId, name: toolName, arguments: args },
          args,
          result: { content: output, details: finalDetails, usage: finalUsage },
          isError: finalIsError,
        },
        options.signal,
      );
      finalOutput = hookResult?.content ?? finalOutput;
      finalDetails = hookResult?.details ?? finalDetails;
      finalIsError = hookResult?.isError ?? finalIsError;
      finalUsage = hookResult?.usage ?? finalUsage;
    }
  } catch (err: unknown) {
    finalOutput = [{ type: "text", text: err instanceof Error ? err.message : String(err) }];
    finalDetails = {};
    finalIsError = true;
    finalUsage = undefined;
  }

  options.onToolResult?.({
    role: "toolResult",
    toolName,
    toolCallId: callId,
    content: finalOutput,
    details: finalDetails,
    isError: finalIsError,
    usage: finalUsage,
    timestamp: Date.now(),
  });

  return {
    output: finalOutput,
    isError: finalIsError,
    details: finalDetails as JsonValue,
    usage: finalUsage,
  };
}

/**
 * Adapt a Pi extension tool, MCP tool, or nested subagent tool into a durable ToolRegistration.
 */
export function bridgePiToolToDurableTool(
  tool: ExecutablePiTool,
  options: BridgeToolOptions = {},
): ToolRegistration {
  const isSafe = REPLAY_SAFE_TOOLS.has(tool.name);

  return defineTool({
    name: tool.name,
    description: tool.description ?? "",
    parameters: tool.parameters,
    replay: isSafe ? "safe" : "unsafe",
    prepareArguments: tool.prepareArguments
      ? (args: unknown) => tool.prepareArguments!(args) as object
      : undefined,
    async execute(args: any, api, _chordCtx: Context) {
      return executeWithToolLifecycle({
        toolName: tool.name,
        args,
        api,
        options,
        invoke: (callId, updateCallback) => {
          const effectiveToolContext =
            typeof options.toolContext === "function"
              ? (options.toolContext as (id: string) => unknown)(callId)
              : options.toolContext;
          return tool.execute(callId, args, options.signal, updateCallback, effectiveToolContext);
        },
      });
    },
  });
}

/**
 * Adapt a native @earendil-works/pi-durable ToolRegistration (e.g. coding tools)
 * with the full durable tool bridge lifecycle (hooks, signal checks, event forwarding).
 */
export function bridgeDurableTool(
  tool: ToolRegistration,
  options: BridgeToolOptions = {},
): ToolRegistration {
  return defineTool({
    name: tool.name,
    description: tool.description ?? "",
    parameters: tool.parameters,
    replay: tool.replay,
    prepareArguments: tool.prepareArguments
      ? (args: unknown) => tool.prepareArguments!(args) as object
      : undefined,
    async execute(args: any, api, chordCtx: Context) {
      return executeWithToolLifecycle({
        toolName: tool.name,
        args,
        api,
        options,
        invoke: async (callId) => {
          let accumulatedOutput = "";
          const wrappedApi = api
            ? {
                ...api,
                output: (chunk: string | Uint8Array, skipped?: any) => {
                  api.output?.(chunk, skipped);
                  if (chunk) {
                    const text = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
                    accumulatedOutput += text;
                    options.onToolUpdate?.({
                      toolName: tool.name,
                      toolCallId: callId,
                      args,
                      partialResult: {
                        content: [{ type: "text", text: accumulatedOutput }],
                      },
                    });
                  }
                },
              }
            : api;

          const res = await tool.execute(args, wrappedApi as any, chordCtx);
          let content = res?.output ?? res?.structuredOutput;
          if (typeof api?.retainedOutput === "function" && api.retainedOutput()?.text) {
            content = api.retainedOutput().text;
          } else if (accumulatedOutput && !content) {
            content = accumulatedOutput;
          }
          return {
            ...res,
            output: content,
          };
        },
      });
    },
  });
}
