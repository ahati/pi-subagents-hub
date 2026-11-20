/**
 * runner-session.ts — session setup, tool binding, and execution loop for runAgent.
 */

import { resolve } from "node:path";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { type AssistantMessageEventStream, type Message, type Model } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import {
  type AgentSession,
  convertToLlm,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionContext,
  getAgentDir,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
  type Conversation,
  type Cursor,
  createRegistry,
  defineExtension,
  type EntryId,
  type EntryRecord,
  Harness,
  MemoryStorage,
  type Registry,
  type Submission,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import {
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
} from "@earendil-works/pi-durable/tools";
import {
  getAgentConfig,
  getConfig,
} from "../agent-types.js";
import { getCacheRetention, installCacheRetention } from "../cache-retention.js";
import { runInChildSessionContext } from "../child-context.js";
import { buildParentContext } from "../context.js";
import { continueSessionBare } from "../session-continue.js";
import { structuredRetryPrompt } from "../structured-output.js";
import type { AgentConfig, EffectiveThinkingLevel, SubagentType } from "../types.js";
import { clearDurableContextUsage, setDurableContextUsage } from "../usage.js";
import { restoreBranchModel, restoreBranchThinkingLevel } from "./branch-selection.js";
import { bridgeDurableTool, bridgePiToolToDurableTool } from "./durable-tool-bridge.js";
import {
  installExtensionToolScope,
  type NestedCallGate,
} from "./extension-scope.js";
import {
  collectResponseText,
  finalTurnError,
  getLastAssistantText,
  observeRun,
  resolveConfiguredSessionDir,
} from "./runner-helpers.js";
import {
  createRunnerResourceLoader,
} from "./runner-loader.js";
import {
  prepareAgentSystemPrompt,
} from "./runner-prompt.js";
import {
  getRememberAgents,
  resolveDefaultModel,
  resolveEffectiveMaxTurns,
} from "./runner-settings.js";
import {
  buildSessionToolLoadout,
  resolveRunModel,
  type SessionToolLoadout,
} from "./runner-tools.js";
import type { RunOptions, RunResult } from "./runner-types.js";

interface CreateSessionParams {
  ctx: ExtensionContext;
  type: SubagentType;
  agentConfig: AgentConfig | undefined;
  effectiveCwd: string;
  agentDir: string;
  loader: DefaultResourceLoader;
  sessionSettingsManager: SettingsManager;
  model: Model<any> | undefined;
  thinkingLevel: EffectiveThinkingLevel | undefined;
  sessionTools: string[] | undefined;
  sessionExcludeTools: string[] | undefined;
  customTools: ToolDefinition[];
  noExtensions: boolean;
  nestedCallGate: NestedCallGate;
  toolNames: string[];
  disallowedSet: Set<string> | undefined;
  extNames: Set<string>;
  narrowing: Map<string, Set<string>>;
  mcpToolPatterns: string[] | undefined;
  readmitToolNames: Set<string>;
  requiredExtensionPaths: Set<string>;
  options: RunOptions;
}

/**
 * Open an agent's saved session to continue it — or a copy of it, when the
 * session belongs to another parent.
 */
function reopenSession(file: string, parentSessionFile: string | undefined, sessionDir: string | undefined): SessionManager {
  const opened = SessionManager.open(file, sessionDir);
  const header = opened.getHeader();
  if (!header?.parentSession || header.parentSession === parentSessionFile) return opened;
  return SessionManager.forkFrom(file, opened.getCwd(), sessionDir, { parentSession: parentSessionFile });
}

/**
 * SRP Phase 4: Session creation, extension binding, scope installation, and durable registry setup.
 */
async function createDurableRegistryAndSession(params: CreateSessionParams): Promise<{
  session: AgentSession;
  registry: Registry;
  toolsFilter?: { remove: readonly ToolRegistration[] };
  model: Model<any> | undefined;
  thinkingLevel: EffectiveThinkingLevel | undefined;
}> {
  const {
    ctx, type, agentConfig, effectiveCwd, agentDir, loader, sessionSettingsManager,
    model, thinkingLevel, sessionTools, sessionExcludeTools, customTools,
    noExtensions, nestedCallGate, toolNames, disallowedSet, extNames,
    narrowing, mcpToolPatterns, readmitToolNames, requiredExtensionPaths, options,
  } = params;

  const configuredSessionDir = resolveConfiguredSessionDir(agentConfig?.sessionDir, effectiveCwd);
  const defaultSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR ?? sessionSettingsManager.getSessionDir?.();
  const persistSession = agentConfig?.persistSession ?? (options.nested ? false : getRememberAgents());
  const parentSessionFile = ctx.sessionManager?.getSessionFile?.();
  const sessionManager = options.resumeSessionFile
    ? reopenSession(options.resumeSessionFile, parentSessionFile, configuredSessionDir ?? defaultSessionDir)
    : persistSession
      ? SessionManager.create(effectiveCwd, configuredSessionDir ?? defaultSessionDir, {
          parentSession: parentSessionFile,
        })
      : SessionManager.inMemory(effectiveCwd);

  // Test doubles (and older managers) need not expose a branch; an empty one
  // leaves the selection to `createAgentSession`.
  const branch = options.resumeSessionFile !== undefined && typeof sessionManager.getBranch === "function"
    ? sessionManager.getBranch()
    : [];
  const restoredModel = options.resumeSessionFile !== undefined
    ? (model ?? restoreBranchModel(branch, ctx.modelRegistry))
    : model;
  const restoredThinkingLevel = options.resumeSessionFile !== undefined
    ? (thinkingLevel ?? restoreBranchThinkingLevel(branch))
    : thinkingLevel;

  const parentModelRuntime = (ctx.modelRegistry as unknown as { runtime?: unknown } | undefined)?.runtime;
  const sessionOpts: Parameters<typeof createAgentSession>[0] & {
    modelRegistry: any;
    modelRuntime?: unknown;
  } = {
    cwd: effectiveCwd,
    agentDir,
    sessionManager,
    settingsManager: sessionSettingsManager,
    modelRegistry: ctx.modelRegistry,
    ...(parentModelRuntime !== undefined && { modelRuntime: parentModelRuntime as never }),
    model: restoredModel,
    tools: sessionTools,
    customTools,
    resourceLoader: loader,
  };
  if (sessionExcludeTools) {
    sessionOpts.excludeTools = sessionExcludeTools;
  }
  if (restoredThinkingLevel) {
    sessionOpts.thinkingLevel = restoredThinkingLevel;
  }

  const { session } = await runInChildSessionContext(() => createAgentSession(sessionOpts));
  installCacheRetention(session, agentConfig?.cacheRetention ?? getCacheRetention());
  const effectiveModel = options.resumeSessionFile !== undefined
    ? (restoredModel ?? session.model ?? resolveDefaultModel(ctx.model, ctx.modelRegistry, agentConfig?.model))
    : model;
  const effectiveThinkingLevel = options.resumeSessionFile !== undefined
    ? (restoredThinkingLevel ?? session.thinkingLevel ?? agentConfig?.thinking ?? ctx.thinkingLevel)
    : thinkingLevel;

  const baseSessionName = agentConfig?.name ?? type;
  session.setSessionName(
    options.agentId ? `${baseSessionName}#${options.agentId.slice(0, 8)}` : baseSessionName,
  );

  let requiredBindingError: Error | undefined;
  await session.bindExtensions({
    onError: (err: any) => {
      options.onToolActivity?.({
        type: "warning",
        toolName: `extension-error:${err.extensionPath}`,
      });
      if (requiredExtensionPaths.has(resolve(err.extensionPath))) {
        requiredBindingError = new Error(`Required subagent extension failed to bind: ${err.extensionPath}`);
      }
    },
  });
  if (requiredBindingError) throw requiredBindingError;

  if ((session as any)._extensionRunner?.emitBeforeAgentStart) {
    await (session as any)._extensionRunner.emitBeforeAgentStart(
      { prompt: "", messageType: "user" },
      { cwd: effectiveCwd },
    );
  }

  if (!noExtensions) {
    const isolated = agentConfig?.isolated ?? options.isolated;
    installExtensionToolScope(session, {
      loader,
      toolNames,
      disallowedSet,
      extNames,
      narrowing,
      mcpToolPatterns: isolated ? undefined : mcpToolPatterns,
      readmitToolNames,
      handlerOnlyPaths: requiredExtensionPaths,
      nestedCallGate,
    });
  }

  // Durable Registry setup
  const registry = createRegistry();
  // Shared lifecycle handlers for durable tool bridging
  const toolBridgeOptions = {
    beforeToolCall: (context: any, signal?: AbortSignal) =>
      (session as any).agent?.beforeToolCall?.(context, signal),
    afterToolCall: (context: any, signal?: AbortSignal) =>
      (session as any).agent?.afterToolCall?.(context, signal),
    onToolStart: (info: { toolName: string; toolCallId: string; args: any }) => {
      (session as any)._emit?.({
        type: "tool_execution_start",
        toolName: info.toolName,
        toolCallId: info.toolCallId,
        args: info.args,
      });
    },
    onToolUpdate: (info: { toolName: string; toolCallId: string; args: any; partialResult: any }) => {
      (session as any)._emit?.({
        type: "tool_execution_update",
        toolName: info.toolName,
        toolCallId: info.toolCallId,
        args: info.args,
        partialResult: info.partialResult,
      });
    },
    onToolResult: (resMsg: any) => {
      session.messages.push(resMsg);
      (session as any)._emit?.({ type: "message_start", message: resMsg });
      (session as any)._emit?.({ type: "message_end", message: resMsg });
      (session as any)._emit?.({
        type: "tool_execution_end",
        toolName: resMsg.toolName,
        toolCallId: resMsg.toolCallId,
        result: resMsg,
        isError: resMsg.isError === true,
      });
    },
    signal: options.signal,
    resolveCallId: (toolName: string, api: any) => {
      const lastAssistant =
        (session.state?.streamingMessage?.role === "assistant" ? session.state.streamingMessage : undefined) ??
        ([...session.messages].reverse().find((m: any) => m.role === "assistant") as any);
      const pendingCall = lastAssistant?.content?.find(
        (c: any) =>
          c.type === "toolCall" &&
          c.name === toolName &&
          !session.messages.some((m: any) => m.role === "toolResult" && m.toolCallId === (c.id ?? c.toolUseId)),
      );
      return api?.callId ?? pendingCall?.id ?? pendingCall?.toolUseId;
    },
  };

  // Option B: Install CodingTools with live activity forwarding
  const rawCodingTools = [
    createReadTool(),
    createWriteTool(),
    createEditTool(),
    createBashTool(),
  ].filter((tool) => toolNames.includes(tool.name));
  const codingTools = rawCodingTools.map((tool) => bridgeDurableTool(tool, toolBridgeOptions));
  registry.install(defineExtension({ name: "coding-tools", tools: codingTools }));

  // Extract all active session tools (MCP tools, extension tools, custom tools, nested subagent tools)
  const activeToolNames = session.getActiveToolNames();
  const durableBridgedTools: ToolRegistration[] = [];
  const builtInCodingNames = new Set(["read", "write", "edit", "bash"]);

  for (const name of activeToolNames) {
    if (builtInCodingNames.has(name)) continue;
    const toolDef = session.getToolDefinition(name);
    if (toolDef) {
      const toolToBridge = {
        name: (toolDef as any).name ?? name,
        description: (toolDef as any).description ?? "",
        parameters: (toolDef as any).parameters ?? { type: "object", properties: {} },
        execute: (toolDef as any).execute ?? (async () => ({ content: [] })),
        prepareArguments: (toolDef as any).prepareArguments,
      };
      durableBridgedTools.push(
        bridgePiToolToDurableTool(toolToBridge as any, {
          ...toolBridgeOptions,
          toolContext: (callId: string) =>
            (session as any)._extensionRunner?.createToolContext(callId, options.signal) ?? ctx,
        }),
      );
    }
  }

  if (durableBridgedTools.length > 0) {
    registry.install(
      defineExtension({
        name: `pi-bridged-tools-${type}`,
        tools: durableBridgedTools,
      }),
    );
  }

  let toolsFilter: { remove: readonly ToolRegistration[] } | undefined;
  if (disallowedSet && disallowedSet.size > 0) {
    toolsFilter = {
      remove: [...disallowedSet].map((name) => ({ name } as unknown as ToolRegistration)),
    };
  }

  options.onSessionCreated?.(session);
  return { session, registry, toolsFilter, model: effectiveModel, thinkingLevel: effectiveThinkingLevel };
}

/** One committed message of a drain, with the entry and index it came from. */
interface CommittedAppend {
  entryId: EntryId;
  index: number;
  message: Message;
}

/**
 * Place an assistant message's tool results in the order it called them. Durable settles and commits parallel tool
 * tasks as each finishes, so a transcript can commit `toolResult(b)` before `toolResult(a)`; its own context view
 * applies `orderToolResults`, but the saved session, viewer and native resume read the committed order.
 *
 * Only tool results move: every other message keeps its position, a run never crosses the assistant message it answers,
 * and a result that matches none of its calls keeps its place behind the matched ones.
 */
function orderCommittedToolResults(
  appends: readonly CommittedAppend[],
  history: readonly AgentMessage[],
): CommittedAppend[] {
  const ordered = [...appends];
  let start = 0;
  while (start < ordered.length) {
    if (ordered[start].message.role !== "toolResult") {
      start++;
      continue;
    }
    let end = start + 1;
    while (end < ordered.length && ordered[end].message.role === "toolResult") end++;

    // The assistant a run answers is the message right before it — in this drain, or already committed.
    let assistant: AgentMessage | undefined;
    for (let previous = start - 1; previous >= 0; previous--) {
      const message = ordered[previous].message;
      if (message.role === "assistant") assistant = message;
      if (message.role === "assistant" || message.role === "user") break;
    }
    if (assistant === undefined && start === 0) {
      for (let index = history.length - 1; index >= 0 && assistant === undefined; index--) {
        if (history[index].role === "assistant") assistant = history[index];
      }
    }

    const callOrder = new Map<string, number>();
    if (assistant?.role === "assistant") {
      for (const part of assistant.content) {
        if (part.type === "toolCall" && !callOrder.has(part.id)) callOrder.set(part.id, callOrder.size);
      }
    }
    if (callOrder.size > 0) {
      const rank = (item: CommittedAppend) =>
        item.message.role === "toolResult"
          ? (callOrder.get(item.message.toolCallId) ?? Number.MAX_SAFE_INTEGER)
          : Number.MAX_SAFE_INTEGER;
      const run = ordered.slice(start, end).sort((a, b) => rank(a) - rank(b));
      for (let offset = 0; offset < run.length; offset++) ordered[start + offset] = run[offset];
    }
    start = end;
  }
  return ordered;
}

/**
 * SRP Phase 5: Execute prompt using @earendil-works/pi-durable Harness with NodeExecutionEnv.
 */
async function executeDurableAgentPrompt(
  ctx: ExtensionContext,
  session: AgentSession,
  registry: Registry,
  prompt: string | undefined,
  type: SubagentType,
  effectiveCwd: string,
  systemPrompt: string,
  toolLoadout: SessionToolLoadout,
  toolsFilter: { remove: readonly ToolRegistration[] } | undefined,
  options: RunOptions,
): Promise<RunResult> {
  if (options.signal?.aborted) {
    return {
      responseText: "",
      session,
      aborted: true,
      steered: false,
    };
  }

  clearDurableContextUsage(session);
  // Native continuation must retain Pi's persistence, queues and usage events.
  if (prompt === undefined) {
    const collector = collectResponseText(session);
    const startIndex = session.messages.length;
    const run = observeRun(session, { ...options, maxTurns: resolveEffectiveMaxTurns(type, options.maxTurns) });
    const onAbort = () => { void session.abort(); };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const result = await continueSessionBare(session, { signal: options.signal });
      return {
        responseText: collector.getText().trim() || getLastAssistantText(session, startIndex) || result.finalText || "",
        session,
        failure: finalTurnError(session, startIndex) ?? result.continuationError,
        aborted: options.signal?.aborted === true || run.aborted,
        steered: run.steered,
      };
    } finally {
      collector.unsubscribe();
      run.unsubscribe();
      options.signal?.removeEventListener("abort", onAbort);
    }
  }

  const models = builtinModels();
  const allModels: Model<any>[] = [
    ...(toolLoadout.model ? [toolLoadout.model] : []),
    ...(ctx.model ? [ctx.model] : []),
    ...(ctx.modelRegistry?.getAll ? ctx.modelRegistry.getAll() : []),
  ];
  const byProvider = new Map<string, Model<any>[]>();
  let lastStreamError: string | undefined;

  // Durable owns a temporary live state view, not Pi's native execution state.
  const agentState = { ...session.agent.state };
  const stateDescriptor = Object.getOwnPropertyDescriptor(session.agent, "state");
  const streamingDescriptor = Object.getOwnPropertyDescriptor(session, "isStreaming");
  const idleDescriptor = Object.getOwnPropertyDescriptor(session, "isIdle");
  const providerResults: Promise<unknown>[] = [];
  if (agentState) {
    agentState.isStreaming = true;
    agentState.streamingMessage = undefined;
  }

  let activeAssistantMessage: any;
  let activeText = "";
  const accountedMessages = new WeakSet<object>();
  function accountAssistant(message: AgentMessage) {
    if (message.role !== "assistant" || accountedMessages.has(message)) return;
    accountedMessages.add(message);
    const usage = message.usage;
    if (!usage) return;
    if (
      message.stopReason !== "error" &&
      message.stopReason !== "aborted" &&
      (usage.input ?? 0) + (usage.output ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0) > 0
    ) {
      setDurableContextUsage(session, usage, toolLoadout.model?.contextWindow ?? ctx.model?.contextWindow ?? 0);
    }
    options.onAssistantUsage?.({
      input: usage.input ?? 0,
      output: usage.output ?? 0,
      cacheRead: usage.cacheRead ?? 0,
      cacheWrite: usage.cacheWrite ?? 0,
      cost: usage.cost?.total ?? 0,
    });
  }

  function ensureActiveMessage() {
    if (!activeAssistantMessage) {
      activeAssistantMessage = {
        role: "assistant",
        content: [],
        timestamp: Date.now(),
      };
      if (agentState) {
        agentState.streamingMessage = activeAssistantMessage;
      }
      (session as any)._emit?.({ type: "message_start", message: activeAssistantMessage });
    }
    return activeAssistantMessage;
  }

  function handleStreamChunk(event: any) {
    if (!event) return;
    if (event.type === "start") {
      (session as any)._emit?.({ type: "turn_start" });
      activeAssistantMessage = {
        role: "assistant",
        content: [],
        timestamp: Date.now(),
      };
      if (agentState) {
        agentState.streamingMessage = activeAssistantMessage;
      }
      activeText = "";
      (session as any)._emit?.({ type: "message_start", message: activeAssistantMessage });
    } else if (event.type === "thinking_start") {
      ensureActiveMessage();
      if (!activeAssistantMessage.content.some((p: any) => p.type === "thinking")) {
        activeAssistantMessage.content.push({ type: "thinking", thinking: "" });
      }
      (session as any)._emit?.({ type: "message_update", message: activeAssistantMessage, assistantMessageEvent: event });
    } else if (event.type === "thinking_delta") {
      ensureActiveMessage();
      if (event.partial?.content) {
        activeAssistantMessage.content = [...event.partial.content];
      } else {
        let thinkingPart = activeAssistantMessage.content.find((p: any) => p.type === "thinking");
        if (!thinkingPart) {
          thinkingPart = { type: "thinking", thinking: "" };
          activeAssistantMessage.content.push(thinkingPart);
        }
        thinkingPart.thinking += event.delta ?? "";
      }
      if (agentState) {
        agentState.streamingMessage = activeAssistantMessage;
      }
      (session as any)._emit?.({ type: "message_update", message: activeAssistantMessage, assistantMessageEvent: event });

    } else if (event.type === "thinking_end") {
      if (activeAssistantMessage) {
        const thinkingPart = activeAssistantMessage.content.find((p: any) => p.type === "thinking");
        if (thinkingPart && typeof event.content === "string") {
          thinkingPart.thinking = event.content;
        }
        if (agentState) {
          agentState.streamingMessage = activeAssistantMessage;
        }
        (session as any)._emit?.({ type: "message_update", message: activeAssistantMessage, assistantMessageEvent: event });
      }
    } else if (event.type === "text_start") {
      ensureActiveMessage();
      if (!activeAssistantMessage.content.some((p: any) => p.type === "text")) {
        activeAssistantMessage.content.push({ type: "text", text: "" });
      }
      (session as any)._emit?.({ type: "message_update", message: activeAssistantMessage, assistantMessageEvent: event });
    } else if (event.type === "text_delta") {
      ensureActiveMessage();
      activeText += event.delta ?? "";
      if (event.partial?.content) {
        activeAssistantMessage.content = [...event.partial.content];
      } else {
        let textPart = activeAssistantMessage.content.find((p: any) => p.type === "text");
        if (!textPart) {
          textPart = { type: "text", text: "" };
          activeAssistantMessage.content.push(textPart);
        }
        textPart.text = activeText;
      }
      if (agentState) {
        agentState.streamingMessage = activeAssistantMessage;
      }
      (session as any)._emit?.({ type: "message_update", message: activeAssistantMessage, assistantMessageEvent: event });

    } else if (event.type === "text_end") {
      if (activeAssistantMessage) {
        const textPart = activeAssistantMessage.content.find((p: any) => p.type === "text");
        if (textPart && typeof event.content === "string") {
          textPart.text = event.content;
        }
        if (agentState) {
          agentState.streamingMessage = activeAssistantMessage;
        }
        (session as any)._emit?.({ type: "message_update", message: activeAssistantMessage, assistantMessageEvent: event });
      }
    } else if (event.type === "toolcall_start" || event.type === "toolcall_delta" || event.type === "toolcall_end") {
      ensureActiveMessage();
      if (event.partial?.content) {
        activeAssistantMessage.content = [...event.partial.content];
      }
      if (agentState) {
        agentState.streamingMessage = activeAssistantMessage;
      }
      (session as any)._emit?.({ type: "message_update", message: activeAssistantMessage, assistantMessageEvent: event });
    } else if (event.type === "done" || event.type === "error") {
      if (activeAssistantMessage && event.message) {
        Object.assign(activeAssistantMessage, event.message);
      }
      const finalMsg = event.message ?? event.error ?? activeAssistantMessage;
      if (finalMsg && !session.messages.includes(finalMsg)) {
        session.messages.push(finalMsg);
      }
      if (agentState) {
        agentState.streamingMessage = undefined;
      }
      if (finalMsg) {
        accountAssistant(finalMsg);
        (session as any)._emit?.({ type: "message_end", message: finalMsg });
        (session as any)._emit?.({ type: "turn_end", message: finalMsg, toolResults: [] });
      }
      activeAssistantMessage = undefined;
    }
  }

  function watchProviderResult(res: AssistantMessageEventStream) {
    const result = res.result?.().then((message) => {
      accountAssistant(message);
      if (message?.stopReason === "error") {
        lastStreamError = message.errorMessage ?? "provider error with no output";
      }
    }).catch((error: unknown) => {
      lastStreamError = error instanceof Error ? error.message : String(error);
    });
    if (result) providerResults.push(result);
  }

  function interceptEventStream(res: any) {
    if (!res || typeof res[Symbol.asyncIterator] !== "function") return res;
    return new Proxy(res, {
      get(target, prop, receiver) {
        if (prop === Symbol.asyncIterator) {
          return () => {
            const iter = target[Symbol.asyncIterator]();
            let first = true;
            return {
              async next() {
                if (first) {
                  first = false;
                  await drainCommitted();
                  if ((session as any).agent?.finishTurn) {
                    await (session as any).agent.finishTurn(
                      { message: activeAssistantMessage ?? { role: "assistant", content: [] }, toolResults: [] },
                      options.signal,
                    );
                  }
                  if (options.signal?.aborted) {
                    return { done: true, value: undefined };
                  }
                }
                const item = await iter.next();
                if (!item.done && item.value) {
                  handleStreamChunk(item.value);
                  await run.settleControls();
                  await Promise.all(admissions);
                  if (admissionError) throw admissionError;
                  // The provider boundary is before durable creates tool tasks.
                  // Stop here too, so even immediate tool scheduling cannot race the abort commit.
                  if (run.aborted) throw new Error("Agent turn limit reached");
                }
                return item;
              },
              return(v: any) {
                return iter.return ? iter.return(v) : Promise.resolve({ done: true, value: v });
              },
              throw(e: any) {
                return iter.throw ? iter.throw(e) : Promise.reject(e);
              },
            };
          };
        }
        const val = Reflect.get(target, prop, receiver);
        return typeof val === "function" ? val.bind(target) : val;
      },
    });
  }

  for (const m of allModels) {
    if (!m?.provider) continue;
    const list = byProvider.get(m.provider) ?? [];
    if (!list.some((existing) => existing.id === m.id)) {
      list.push(m);
    }
    byProvider.set(m.provider, list);
  }
  for (const [providerId, providerModels] of byProvider) {
    models.setProvider({
      id: providerId,
      name: providerId,
      auth: {
        apiKey: {
          name: providerId,
          resolve: async () => {
            const target = providerModels[0];
            if (ctx.modelRegistry?.getApiKeyAndHeaders && target) {
              try {
                const res = await ctx.modelRegistry.getApiKeyAndHeaders(target);
                if (res?.ok) {
                  return {
                    auth: {
                      apiKey: res.apiKey ?? "configured",
                      headers: res.headers,
                      baseUrl: res.baseUrl,
                    },
                    source: "registry",
                  };
                }
              } catch {
                // best effort
              }
            }
            return { auth: { apiKey: "configured" }, source: "configured" };
          },
        },
      },
      getModels: () => providerModels,
      streamSimple: (m, context, opts) => {
        const streamFn = ctx.modelRegistry?.streamSimple
          ? (model: any, c: any, o: any) => ctx.modelRegistry.streamSimple(model, c, o)
          : (session as any)?._modelRuntime?.streamSimple
            ? (model: any, c: any, o: any) => (session as any)._modelRuntime.streamSimple(model, c, o)
            : streamSimple;
        try {
          const res = streamFn(m, context, opts as any);
          watchProviderResult(res);
          return interceptEventStream(res);
        } catch (err: any) {
          lastStreamError = err instanceof Error ? err.message : String(err);
          throw err;
        }
      },
      stream: (m, context, opts) => {
        const streamFn = ctx.modelRegistry?.stream
          ? (model: any, c: any, o: any) => ctx.modelRegistry.stream(model, c, o)
          : (session as any)?._modelRuntime?.stream
            ? (model: any, c: any, o: any) => (session as any)._modelRuntime.stream(model, c, o)
            : streamSimple;
        try {
          const res = streamFn(m, context, opts as any);
          watchProviderResult(res);
          return interceptEventStream(res);
        } catch (err: any) {
          lastStreamError = err instanceof Error ? err.message : String(err);
          throw err;
        }
      },
    });
  }

  const storage = options.storage ?? new MemoryStorage();
  const baseContext = options.signal ? withAbortSignal(options.signal, BACKGROUND_CONTEXT) : BACKGROUND_CONTEXT;

  const harness = await Harness.open(
    storage,
    {
      models,
      registry,
      // No host remains to restart queued inputs after this runner returns.
      // Settle them explicitly if a preceding run fails instead of hanging wait().
      settings: { afterFailedRun: "withdraw" },
      env: ({ cwd }) => new NodeExecutionEnv({ cwd: cwd ?? effectiveCwd }),
    },
    baseContext,
  );

  const modelRef = toolLoadout.model
    ? { provider: toolLoadout.model.provider, modelId: toolLoadout.model.id }
    : ctx.model
      ? { provider: ctx.model.provider, modelId: ctx.model.id }
      : undefined;

  let conversation: Conversation;
  let structuredRetried = false;
  let submissionFailure: string | undefined;

  const maxTurns = resolveEffectiveMaxTurns(type, options.maxTurns);
  let abortPromise: Promise<void> | undefined;
  const abortDurable = () => {
    abortPromise ??= conversation?.abort(BACKGROUND_CONTEXT).catch(() => {});
  };
  const run = observeRun(session, {
    ...options,
    maxTurns,
    onAssistantUsage: undefined, // One shared identity guard for provider and session terminal events.
    onAssistantMessage: accountAssistant,
    abort: abortDurable,
    toolBoundariesOnly: true,
  });
  const collector = collectResponseText(session);
  const startIndex = session.messages.length;
  const priorMessages = session.messages.slice();
  const submissions: Submission[] = [];
  const admissions: Promise<void>[] = [];
  let admissionError: unknown;
  let acceptingInput = true;
  const originalSteer = session.agent.steer;
  const originalFollowUp = session.agent.followUp;
  const persistedEntries = new Set<EntryId>();
  const persistedMessageOffsets = new Map<EntryId, number>();
  const committedMessages: typeof session.messages = [];

  async function drainCommitted() {
    if (!conversation) return;
    let cursor: Cursor | undefined;
    const appends: CommittedAppend[] = [];
    const scanned: EntryRecord[] = [];
    do {
      const page = await conversation.entries({ order: "ascending" }, 200, cursor, BACKGROUND_CONTEXT);
      for (const entry of page.items) {
        if (persistedEntries.has(entry.id)) continue;
        if (entry.kind !== "hub.history") {
          if (entry.kind === "pi.compaction") clearDurableContextUsage(session);
          const messages = entry.model ?? [];
          for (let index = persistedMessageOffsets.get(entry.id) ?? 0; index < messages.length; index++) {
            const message = messages[index];
            if (message.role !== "system") appends.push({ entryId: entry.id, index, message });
          }
        }
        scanned.push(entry);
      }
      cursor = page.next;
    } while (cursor);

    // The transcript is append-only, so a result can only be placed correctly before it is appended.
    for (const { entryId, index, message } of orderCommittedToolResults(appends, committedMessages)) {
      session.sessionManager.appendMessage(message);
      committedMessages.push(message);
      persistedMessageOffsets.set(entryId, index + 1);
    }
    // Finalize only after appending: a throw mid-entry resumes from the recorded offsets on the retry.
    for (const entry of scanned) {
      persistedEntries.add(entry.id);
      persistedMessageOffsets.delete(entry.id);
    }
    // Publish committed history without replaying events or replacing streamingMessage.
    session.messages.splice(startIndex, session.messages.length - startIndex, ...committedMessages);
  }

  // Keep Pi's public input processing (including transformed inputs and images).
  // Only replace the final queue destination while durable owns execution.
  const queueInput = (message: Parameters<typeof originalSteer>[0], mode: "steer" | "followUp") => {
    if (!acceptingInput) {
      (mode === "steer" ? originalSteer : originalFollowUp).call(session.agent, message);
      return;
    }
    const modelMessage = convertToLlm([message])[0];
    if (modelMessage?.role !== "user") throw new Error("Queued input must be a user message");
    const admission = conversation.submit({ type: "input", content: modelMessage.content, whenBusy: mode }, baseContext)
      .then((submission) => { submissions.push(submission); })
      .catch((error: unknown) => { admissionError = error; });
    admissions.push(admission);
    session.clearQueue();
  };

  const abortListener = () => { abortDurable(); };
  options.signal?.addEventListener("abort", abortListener, { once: true });

  try {
    Object.defineProperty(session.agent, "state", { configurable: true, get: () => agentState });
    // Durable runs its own engine, so Pi's native run flag never moves: without the `isIdle` patch the session reports
    // `isStreaming === true` and `isIdle === true` at once.
    Object.defineProperty(session, "isStreaming", { configurable: true, get: () => true });
    Object.defineProperty(session, "isIdle", { configurable: true, get: () => false });
    conversation = await harness.root(baseContext, {
      agent: {
        model: modelRef,
        thinkingLevel: toolLoadout.thinkingLevel ?? undefined,
        instructions: systemPrompt,
        // The observer supplies grace turns and aborts before hard-boundary tools.
        maxTurns: undefined,
        cwd: effectiveCwd,
        ...(toolsFilter ? { tools: toolsFilter } : {}),
      },
    });

    // Seed actual normalized transcript entries, retaining roles, tool arguments and images.
    // Seeded entries are never replayed into Pi's already persisted transcript.
    if (priorMessages.length > 0) {
      await conversation.submit({
        type: "write",
        entry: { kind: "hub.history", model: convertToLlm(priorMessages) },
      }, baseContext);
    }
    const steeringMode = session.agent.steeringMode;
    const followUpMode = session.agent.followUpMode;
    session.agent.steeringMode = "all";
    session.agent.followUpMode = "all";
    const pendingSteering = session.getSteeringMessages().length > 0 ? session.agent.peekQueuedMessages() : [];
    session.agent.clearSteeringQueue();
    const pendingFollowUp = session.agent.peekQueuedMessages();
    session.clearQueue();
    session.agent.steeringMode = steeringMode;
    session.agent.followUpMode = followUpMode;
    session.agent.steer = (message) => queueInput(message, "steer");
    session.agent.followUp = (message) => queueInput(message, "followUp");

    let trimmed = "";
    {
      let effectivePrompt = prompt;
      if (options.inheritContext && !options.resumeSessionFile) {
        const parentContext = buildParentContext(ctx);
        if (parentContext) {
          effectivePrompt = parentContext + prompt;
        }
      }

      const submission = await conversation.submit({ type: "input", content: effectivePrompt }, baseContext);
      submissions.push(submission);
      for (const message of pendingSteering) queueInput(message, "steer");
      for (const message of pendingFollowUp) queueInput(message, "followUp");
      await submission.wait(baseContext);
      // Initial settlement can start a successor for accepted follow-ups.
      // Recheck admissions because input may arrive at the final-answer boundary.
      const drainAdmissions = async () => {
        let admitted: number;
        do {
          admitted = admissions.length;
          await Promise.all(admissions);
          if (admissionError) throw admissionError;
          await conversation.waitForIdle(baseContext);
          if (
            admitted === admissions.length &&
            !options.signal?.aborted &&
            !run.aborted &&
            !run.steered &&
            !lastStreamError &&
            !finalTurnError(session, startIndex)
          ) {
            try {
              await options.nestedRuntime?.manager.waitForBackgroundChild?.(
                options.nestedRuntime.parentAgentId,
                options.signal,
              );
            } catch (err) {
              if (!options.signal?.aborted && !run.aborted) throw err;
            }
          }
        } while (admitted !== admissions.length);
      };
      await drainAdmissions();

      if (
        toolLoadout.structuredCapture !== undefined &&
        toolLoadout.structuredCapture.json === undefined &&
        options.signal?.aborted !== true
      ) {
        structuredRetried = true;
        const retrySubmission = await conversation.submit(
          { type: "input", content: structuredRetryPrompt(toolLoadout.structuredCapture) },
          baseContext,
        );
        submissions.push(retrySubmission);
        // Input stays open: a steer accepted now queues behind the retry as `whenBusy: "steer"` and starts a successor,
        // whereas closing it here would hand the steer to Pi's native queue, which durable never drains.
        await retrySubmission.wait(baseContext);
        await drainAdmissions();
      }
      acceptingInput = false;

      const contextView = await conversation.context(baseContext);
      const messages = contextView.messages;

      let responseText = "";
      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i];
        if (msg && msg.role === "assistant" && Array.isArray(msg.content)) {
          for (const part of msg.content) {
            if (part && typeof part === "object" && (part as any).type === "text") {
              responseText = (part as any).text;
              break;
            }
          }
          if (responseText) break;
        }
      }

      trimmed = responseText.trim();


      // Check if pause gate was installed (e.g. agent paused mid-run)
      const newMessages = messages.filter((message) => message.role !== "system");
      if ((session as any).agent?.finishTurn) {
        await (session as any).agent.finishTurn(
          { message: newMessages[0] ?? { role: "assistant", content: [] }, toolResults: [] },
          options.signal,
        );
      }

      await drainCommitted();
      const settlements = await Promise.all(submissions.map((item) => item.wait(baseContext)));
      const settled = [...settlements].reverse().find((item) => item.status === "unanswered");
      if (settled?.status === "unanswered" && !run.aborted && !options.signal?.aborted) {
        submissionFailure = lastStreamError ??
          (typeof settled.detail === "string" ? settled.detail : settled.reason);
      }
    }

    const streamText = collector.getText().trim();
    const fallbackText = getLastAssistantText(session, startIndex);
    const resolvedResponseText = streamText || fallbackText || trimmed;

    const structuredFailure =
      toolLoadout.structuredCapture !== undefined && toolLoadout.structuredCapture.json === undefined
        ? toolLoadout.structuredCapture.lastError !== undefined
          ? `The agent's StructuredOutput call did not match the required schema: ${toolLoadout.structuredCapture.lastError}`
          : "The agent did not report its answer through StructuredOutput."
        : undefined;

    const finalError = finalTurnError(session, startIndex);
    const failure = finalError ?? submissionFailure ?? structuredFailure;

    return {
      responseText: resolvedResponseText,
      session,
      aborted: options.signal?.aborted === true || run.aborted,
      steered: run.steered,
      failure,
      ...(toolLoadout.structuredCapture?.json !== undefined ? { structuredJson: toolLoadout.structuredCapture.json } : {}),
      ...(structuredRetried ? { structuredRetried } : {}),
    };
  } catch (error) {
    if (!options.signal?.aborted && !run.aborted) throw error;
    return {
      responseText: collector.getText().trim() || getLastAssistantText(session, startIndex),
      session,
      aborted: true,
      steered: run.steered,
    };
  } finally {
    acceptingInput = false;
    try {
      try {
        await run.settleControls();
      } finally {
        await Promise.all(admissions);
      }
    } finally {
      session.agent.steer = originalSteer;
      session.agent.followUp = originalFollowUp;
      try {
        if (options.signal?.aborted || run.aborted) abortDurable();
        await abortPromise;
        await Promise.all(providerResults);
      } finally {
        if (stateDescriptor) Object.defineProperty(session.agent, "state", stateDescriptor);
        else Reflect.deleteProperty(session.agent, "state");
        if (streamingDescriptor) Object.defineProperty(session, "isStreaming", streamingDescriptor);
        else Reflect.deleteProperty(session, "isStreaming");
        if (idleDescriptor) Object.defineProperty(session, "isIdle", idleDescriptor);
        else Reflect.deleteProperty(session, "isIdle");
        try {
          // Retry only messages whose append failed, with an independent context.
          await drainCommitted();
        } finally {
          run.unsubscribe();
          collector.unsubscribe();
          options.signal?.removeEventListener("abort", abortListener);
          agentState.isStreaming = false;
          agentState.streamingMessage = undefined;
          try {
            await harness.close(BACKGROUND_CONTEXT);
          } catch {
            // best-effort cleanup
          }
        }
      }
    }
  }
}

/**
 * Execute a subagent with full lifecycle orchestration via @earendil-works/pi-durable.
 */
export async function runAgent(
  ctx: ExtensionContext,
  type: SubagentType,
  prompt: string | undefined,
  options: RunOptions,
): Promise<RunResult> {
  const agentConfig = getAgentConfig(type);
  const effectiveCwd = options.cwd ?? ctx.cwd;
  const configCwd = options.configCwd ?? effectiveCwd;
  const config = getConfig(type);

  // Resolve the model before the prompt: append-mode inheritance depends on the
  // provider, and a bridge provider needs the parent prompt verbatim.
  const agentDir = getAgentDir();
  const projectTrusted = ctx.isProjectTrusted();
  const runSettingsManager = SettingsManager.create(configCwd, agentDir, { projectTrusted });
  const model = resolveRunModel(ctx, type, agentConfig, runSettingsManager, options);

  // 1. Prepare agent system prompt, memory, and skills
  // A reopened session restores its own model from the saved branch only after
  // the prompt exists. Until then the parent's provider is the only signal for
  // provider-shaped prompts (claude-bridge needs the parent prompt verbatim),
  // so a resume with no resolved model falls back to it as it did before.
  const promptModel = model ?? (options.resumeSessionFile !== undefined ? ctx.model : undefined);
  const prepared = await prepareAgentSystemPrompt(
    ctx, type, agentConfig, config, effectiveCwd, configCwd, promptModel, options,
  );
  const { systemPrompt, toolNames, noSkills } = prepared;

  // 2. Setup resource loader, extension overrides, and configuration warnings
  const resourceContext = await createRunnerResourceLoader(
    ctx, type, agentConfig, config, configCwd, effectiveCwd, agentDir, runSettingsManager, systemPrompt, noSkills, options,
  );

  // 3. Compute the tool admission loadout
  const toolLoadout = buildSessionToolLoadout(
    ctx, type, agentConfig, resourceContext.loader,
    toolNames, resourceContext.extNames, resourceContext.mcpToolPatterns, resourceContext.noExtensions,
    prepared.nested, model, options,
  );

  // 4. Instantiate session, bind extensions (including MCP), and build durable registry
  const { session, registry, toolsFilter, model: effectiveModel, thinkingLevel: effectiveThinkingLevel } =
    await createDurableRegistryAndSession({
      ctx,
      type,
      agentConfig,
      effectiveCwd,
      agentDir: resourceContext.agentDir,
      loader: resourceContext.loader,
      sessionSettingsManager: resourceContext.sessionSettingsManager,
      model: toolLoadout.model,
      thinkingLevel: toolLoadout.thinkingLevel,
      sessionTools: toolLoadout.sessionTools,
      sessionExcludeTools: toolLoadout.sessionExcludeTools,
      customTools: [...toolLoadout.nestedTools, ...toolLoadout.askTools, ...toolLoadout.structuredTools],
      noExtensions: resourceContext.noExtensions,
      nestedCallGate: resourceContext.nestedCallGate,
      toolNames,
      disallowedSet: toolLoadout.disallowedSet,
      extNames: resourceContext.extNames,
      narrowing: resourceContext.narrowing,
      mcpToolPatterns: resourceContext.mcpToolPatterns,
      readmitToolNames: toolLoadout.readmitToolNames,
      requiredExtensionPaths: resourceContext.requiredExtensionPaths,
      options,
    });
  toolLoadout.model = effectiveModel;
  toolLoadout.thinkingLevel = effectiveThinkingLevel;

  // 5. Execute agent loop durably with NodeExecutionEnv and return observed results
  return executeDurableAgentPrompt(
    ctx, session, registry, prompt, type, effectiveCwd, systemPrompt, toolLoadout, toolsFilter, options,
  );
}
