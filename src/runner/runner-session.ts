/**
 * runner-session.ts — session setup, tool binding, and execution loop for runAgent.
 */

import { resolve } from "node:path";
import { BACKGROUND_CONTEXT, withAbortSignal } from "@earendil-works/chord/context";
import { type Model } from "@earendil-works/pi-ai";
import { streamSimple } from "@earendil-works/pi-ai/compat";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import {
  type AgentSession,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionContext,
  getAgentDir,
  type LoadExtensionsResult,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
  type Conversation,
  createRegistry,
  defineExtension,
  Harness,
  MemoryStorage,
  type Registry,
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
  BUILTIN_TOOL_NAMES,
  getAgentConfig,
  getConfig,
  getMemoryToolNames,
  getReadOnlyMemoryToolNames,
  getToolNamesForType,
} from "../agent-types.js";
import { runInChildSessionContext } from "../child-context.js";
import { buildParentContext } from "../context.js";
import { DEFAULT_AGENTS } from "../default-agents.js";
import { detectEnv } from "../env.js";
import { buildMemoryBlock, buildReadOnlyMemoryBlock } from "../memory.js";
import {
  createAskAnswerTools,
  createNestedSubagentTools,
  getMaxSubagentDepth,
} from "../nested-tools.js";
import { buildAgentPrompt, inheritableParentPrompt, type PromptExtras } from "../prompts.js";
import { continueSessionBare } from "../session-continue.js";
import { preloadSkills } from "../skill-loader.js";
import {
  createStructuredCapture,
  createStructuredOutputTool,
  structuredRetryPrompt,
} from "../structured-output.js";
import type { AgentConfig, SubagentType } from "../types.js";
import { bridgePiToolToDurableTool } from "./durable-tool-bridge.js";
import {
  extensionCanonicalNames,
  installExtensionToolScope,
  type NestedCallGate,
  parseExtensionsSpec,
  parseExtSelectors,
  SCOPE_GATE_NAME,
  scopeGateExtension,
} from "./extension-scope.js";
import {
  collectResponseText,
  finalTurnError,
  getLastAssistantText,
  observeRun,
  resolveConfiguredSessionDir,
} from "./runner-helpers.js";
import {
  getRememberAgents,
  resolveDefaultModel,
  resolveEffectiveMaxTurns,
} from "./runner-settings.js";
import {
  EXCLUDED_TOOL_NAMES,
  PI_BUILTIN_EXTENSIONS,
  type RunOptions,
  type RunResult,
} from "./runner-types.js";

interface PreparedSystemPrompt {
  systemPrompt: string;
  toolNames: string[];
  noSkills: boolean;
}

/**
 * SRP Phase 1: Prepare the agent's system prompt, inheritance, memory blocks, and skills.
 */
async function prepareAgentSystemPrompt(
  ctx: ExtensionContext,
  type: SubagentType,
  agentConfig: AgentConfig | undefined,
  config: ReturnType<typeof getConfig>,
  effectiveCwd: string,
  configCwd: string,
  options: RunOptions,
): Promise<PreparedSystemPrompt> {
  const env = await detectEnv(options.pi, effectiveCwd);

  // Get parent system prompt for append-mode agents, without the sections the
  // child session renders itself (skills, cwd, extension sections).
  const parentSystemPrompt = typeof ctx.getSystemPrompt === "function"
    ? inheritableParentPrompt(ctx.getSystemPrompt(), ctx.cwd)
    : "";

  const extras: PromptExtras = {};
  if (options.worktreeBase) extras.worktreeBase = options.worktreeBase;
  if (options.workflow && !options.structuredOutput) extras.workflowChild = true;

  const isolated = agentConfig?.isolated ?? options.isolated;
  const skills = isolated ? false : config.skills;

  if (Array.isArray(skills)) {
    const loaded = preloadSkills(skills, configCwd);
    if (loaded.length > 0) {
      extras.skillBlocks = loaded;
    }
  }

  let toolNames = getToolNamesForType(type);

  if (agentConfig?.memory) {
    const existingNames = new Set(toolNames);
    const denied = agentConfig.disallowedTools ? new Set(agentConfig.disallowedTools) : undefined;
    const effectivelyHas = (name: string) => existingNames.has(name) && !denied?.has(name);
    const hasWriteTools = effectivelyHas("write") || effectivelyHas("edit");

    if (hasWriteTools) {
      const extraNames = getMemoryToolNames(existingNames);
      if (extraNames.length > 0) toolNames = [...toolNames, ...extraNames];
      extras.memoryBlock = buildMemoryBlock(agentConfig.name, agentConfig.memory, configCwd);
    } else {
      const extraNames = getReadOnlyMemoryToolNames(existingNames);
      if (extraNames.length > 0) toolNames = [...toolNames, ...extraNames];
      extras.memoryBlock = buildReadOnlyMemoryBlock(agentConfig.name, agentConfig.memory, configCwd);
    }
  }

  let systemPrompt: string;
  if (agentConfig) {
    systemPrompt = buildAgentPrompt(agentConfig, effectiveCwd, env, parentSystemPrompt, extras);
  } else {
    const fallback = DEFAULT_AGENTS.get("general-purpose");
    if (!fallback) throw new Error(`No fallback config available for unknown type "${type}"`);
    systemPrompt = buildAgentPrompt({ ...fallback, name: type }, effectiveCwd, env, parentSystemPrompt, extras);
  }

  const noSkills = skills === false || Array.isArray(skills);
  return { systemPrompt, toolNames, noSkills };
}

interface RunnerResourceContext {
  loader: DefaultResourceLoader;
  agentDir: string;
  sessionSettingsManager: SettingsManager;
  nestedCallGate: NestedCallGate;
  extNames: Set<string>;
  narrowing: Map<string, Set<string>>;
  mcpToolPatterns: string[] | undefined;
  noExtensions: boolean;
}

/**
 * SRP Phase 2: Create resource loader, compute extension filters, and report misconfiguration warnings.
 */
async function createRunnerResourceLoader(
  ctx: ExtensionContext,
  type: SubagentType,
  agentConfig: AgentConfig | undefined,
  config: ReturnType<typeof getConfig>,
  configCwd: string,
  effectiveCwd: string,
  systemPrompt: string,
  noSkills: boolean,
  options: RunOptions,
): Promise<RunnerResourceContext> {
  const isolated = agentConfig?.isolated ?? options.isolated;
  const extensions = isolated ? false : config.extensions;
  const excludeExtensions = isolated ? undefined : config.excludeExtensions;
  const agentDir = getAgentDir();

  const { extNames, narrowing } = parseExtSelectors(
    isolated ? [] : (agentConfig?.extSelectors ?? []),
  );
  const mcpToolPatterns = agentConfig?.mcpToolPatterns;
  const noExtensions = extensions === false;

  const extensionsSpec = Array.isArray(extensions)
    ? parseExtensionsSpec(extensions, configCwd)
    : undefined;
  const keepNames = extensionsSpec?.names ?? new Set<string>();
  const excludeNames = new Set((excludeExtensions ?? []).map((n: string) => n.toLowerCase()));
  const hasExcludes = excludeNames.size > 0;
  const loadAll = extensions === true || extensionsSpec?.wildcard === true;
  const additionalExtensionPaths = extensionsSpec?.paths.length ? extensionsSpec.paths : undefined;
  let discoveredNames: Set<string> | undefined;
  const extensionsOverride: ((base: LoadExtensionsResult) => LoadExtensionsResult) | undefined =
    noExtensions || (loadAll && !hasExcludes)
      ? undefined
      : (base) => {
          discoveredNames = new Set(base.extensions.flatMap((e) => extensionCanonicalNames(e.path)));
          return {
            ...base,
            extensions: base.extensions.filter((e) => {
              if (e.path === `<inline:${SCOPE_GATE_NAME}>`) return true;
              const canons = extensionCanonicalNames(e.path);
              if (canons.some((n) => excludeNames.has(n))) return false;
              return loadAll || canons.some((n) => keepNames.has(n));
            }),
          };
        };

  const projectTrusted = typeof ctx.isProjectTrusted === "function" ? ctx.isProjectTrusted() : true;
  const settingsManager = SettingsManager.create(configCwd, agentDir, { projectTrusted });
  const sessionSettingsManager =
    resolve(effectiveCwd) === resolve(configCwd)
      ? settingsManager
      : Object.assign(SettingsManager.create(configCwd, agentDir, { projectTrusted }), {
          isProjectTrusted: () => false,
        });
  const nestedCallGate: NestedCallGate = {};

  const loader = new DefaultResourceLoader({
    cwd: configCwd,
    agentDir,
    settingsManager,
    noExtensions,
    additionalExtensionPaths,
    extensionsOverride,
    extensionFactories: [
      ...PI_BUILTIN_EXTENSIONS,
      ...(noExtensions ? [] : [scopeGateExtension(nestedCallGate)]),
    ],
    disabledBuiltinExtensions: process.argv.some((a) => a === "--no-extensions" || a === "-ne")
      ? ["codemode", "tool-search", "mcp"]
      : process.argv.includes("--no-mcp")
        ? ["mcp"]
        : undefined,
    noSkills,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => systemPrompt,
    appendSystemPromptOverride: () => [],
  });
  await runInChildSessionContext(() => loader.reload());

  if (agentConfig?.builtinToolNames?.length) {
    const knownBuiltins = new Set(BUILTIN_TOOL_NAMES);
    for (const name of agentConfig.builtinToolNames) {
      if (!knownBuiltins.has(name)) {
        options.onToolActivity?.({
          type: "warning",
          toolName: `tools-error:tool "${name}" requested by agent "${type}" is not a known built-in`,
        });
      }
    }
  }

  if (hasExcludes && noExtensions) {
    options.onToolActivity?.({
      type: "warning",
      toolName: `extension-error:exclude_extensions has no effect for agent "${type}" — extensions: false loads nothing`,
    });
  }
  if (hasExcludes && discoveredNames) {
    for (const name of excludeNames) {
      if (!discoveredNames.has(name)) {
        options.onToolActivity?.({
          type: "warning",
          toolName: `extension-error:exclude_extensions: "${name}" for agent "${type}" did not match any discovered extension`,
        });
      }
    }
  }
  if (keepNames.size > 0 || extNames.size > 0) {
    const survivingNames = new Set(
      loader.getExtensions().extensions.flatMap((e) => extensionCanonicalNames(e.path)),
    );
    for (const name of keepNames) {
      if (!survivingNames.has(name)) {
        options.onToolActivity?.({
          type: "warning",
          toolName: excludeNames.has(name)
            ? `extension-error:extension "${name}" is in both extensions: and exclude_extensions: for agent "${type}" — exclude wins`
            : `extension-error:extension "${name}" requested by agent "${type}" was not loaded`,
        });
      }
    }
    for (const name of extNames) {
      if (!survivingNames.has(name)) {
        options.onToolActivity?.({
          type: "warning",
          toolName: `extension-error:ext:${name} referenced by agent "${type}" but extension "${name}" is not loaded (check extensions:/exclude_extensions:)`,
        });
      }
    }
  }
  // MCP tools come from extensions, so with none loaded these entries cannot match.
  if (mcpToolPatterns && noExtensions) {
    options.onToolActivity?.({
      type: "end",
      toolName: `tools-error:${mcpToolPatterns.join(", ")} requested by agent "${type}" need extensions, but it loads none`,
    });
  }

  return {
    loader,
    agentDir,
    sessionSettingsManager,
    nestedCallGate,
    extNames,
    narrowing,
    mcpToolPatterns,
    noExtensions,
  };
}

interface SessionToolLoadout {
  model: any;
  thinkingLevel: any;
  nestedTools: any[];
  askTools: any[];
  structuredTools: any[];
  structuredCapture: ReturnType<typeof createStructuredCapture> | undefined;
  disallowedSet: Set<string> | undefined;
  readmitToolNames: Set<string>;
  sessionTools: string[] | undefined;
  sessionExcludeTools: string[] | undefined;
}

/**
 * SRP Phase 3: Model resolution, custom tools creation (nested, ask, structured), and tool admission calculation.
 */
function buildSessionToolLoadout(
  ctx: ExtensionContext,
  type: SubagentType,
  agentConfig: AgentConfig | undefined,
  loader: DefaultResourceLoader,
  settingsManager: SettingsManager,
  toolNames: string[],
  extNames: Set<string>,
  mcpToolPatterns: string[] | undefined,
  noExtensions: boolean,
  configCwd: string,
  options: RunOptions,
): SessionToolLoadout {
  const isolated = agentConfig?.isolated ?? options.isolated;

  let model = options.model ?? resolveDefaultModel(
    ctx.model, ctx.modelRegistry, agentConfig?.model,
  );
  if (!options.model && !agentConfig?.model) {
    const defaultModel = settingsManager.getDefaultModel?.();
    if (defaultModel) {
      const provider = settingsManager.getDefaultProvider?.() ?? ctx.model?.provider ?? "";
      const found = ctx.modelRegistry.find(provider, defaultModel);
      if (found) model = found;
    }
  }

  if (!options.model && agentConfig?.model && resolveDefaultModel(undefined, ctx.modelRegistry, agentConfig.model) === undefined) {
    const slashIdx = agentConfig.model.indexOf("/");
    const notFound = slashIdx === -1
      || !ctx.modelRegistry.find(agentConfig.model.slice(0, slashIdx), agentConfig.model.slice(slashIdx + 1));
    options.onToolActivity?.({
      type: "warning",
      toolName: `model-error:model "${agentConfig.model}" pinned by agent "${type}" is ${notFound ? "not a known model" : "unavailable (provider not authenticated or model disabled)"} — running on the parent model instead`,
    });
  }

  const thinkingLevel = options.thinkingLevel ?? agentConfig?.thinking ?? ctx.thinkingLevel;

  const disallowedSet: Set<string> | undefined = agentConfig?.disallowedTools
    ? new Set(agentConfig.disallowedTools)
    : undefined;

  const effectiveMaxDepth = options.nestedRuntime?.maxSubagentDepth ?? getMaxSubagentDepth();
  const nestedRuntime = options.nestedRuntime && options.nestedRuntime.depth < effectiveMaxDepth
    ? options.nestedRuntime
    : undefined;
  const nestedTools = agentConfig?.allowedSubagents && nestedRuntime && !isolated
    ? createNestedSubagentTools({
        manager: nestedRuntime.manager,
        pi: options.pi,
        parentAgentId: nestedRuntime.parentAgentId,
        depth: nestedRuntime.depth,
        maxSubagentDepth: effectiveMaxDepth,
        allowedSubagents: agentConfig.allowedSubagents,
        configCwd,
      })
    : [];

  const askTools = options.nestedRuntime && !isolated && !nestedTools.some((tool: any) => tool.name === "ask_parent")
    ? createAskAnswerTools({
        manager: options.nestedRuntime.manager,
        pi: options.pi,
        parentAgentId: options.nestedRuntime.parentAgentId,
      })
    : [];
  const nestedToolNames = new Set([...nestedTools, ...askTools].map((tool: any) => tool.name));

  const structuredCapture = options.structuredOutput ? createStructuredCapture() : undefined;
  const structuredTools = options.structuredOutput && structuredCapture
    ? [createStructuredOutputTool(options.structuredOutput, structuredCapture)]
    : [];
  const structuredToolNames = new Set(structuredTools.map((tool: any) => tool.name));
  const readmitToolNames = new Set<string>([
    ...[...nestedToolNames].filter((name: string) => !disallowedSet?.has(name)),
    ...structuredToolNames,
  ]);

  const builtinToolNameSet = new Set(toolNames);

  // As in Claude Code, refuse an agent whose `tools:` list resolved to nothing
  if (options.resumeSessionFile === undefined) {
    const loadedNames = new Set(
      loader
        .getExtensions()
        .extensions.filter((e) => e.path !== `<inline:${SCOPE_GATE_NAME}>`)
        .flatMap((e) => extensionCanonicalNames(e.path)),
    );
    const unrecognized = agentConfig?.builtinToolNames?.filter((n) => !BUILTIN_TOOL_NAMES.includes(n)) ?? [];
    const unmatched = [...extNames].filter((n) => !loadedNames.has(n));
    const extensionToolsPossible =
      loadedNames.size > 0 &&
      (extNames.size === 0 || unmatched.length < extNames.size || !!mcpToolPatterns);
    if (
      (unrecognized.length > 0 || unmatched.length > 0) &&
      toolNames.every((n) => !BUILTIN_TOOL_NAMES.includes(n) || disallowedSet?.has(n)) &&
      readmitToolNames.size === 0 &&
      !extensionToolsPossible
    ) {
      const reasons = [
        unrecognized.length > 0 ? `unrecognized [${unrecognized.join(", ")}]` : "",
        unmatched.length > 0
          ? `recognized but matched no tools in this session [${unmatched.map((n) => `ext:${n}`).join(", ")}]`
          : "",
      ].filter(Boolean);
      throw new Error(
        `Agent '${type}' would be spawned with zero tools — refusing. Its tools list resolved to nothing: ` +
          `${reasons.join("; ")}. Fix the agent's tools frontmatter or pass a different subagent_type.`,
      );
    }
  }

  let sessionTools: string[] | undefined;
  let sessionExcludeTools: string[] | undefined;
  if (noExtensions) {
    sessionTools = [
      ...toolNames.filter(
        (t: string) => !EXCLUDED_TOOL_NAMES.includes(t) && !disallowedSet?.has(t),
      ),
      ...[...nestedToolNames].filter((t: string) => !disallowedSet?.has(t)),
      ...structuredToolNames,
    ];
  } else {
    const denyTools = new Set<string>(
      EXCLUDED_TOOL_NAMES.filter((t) => !nestedToolNames.has(t)),
    );
    for (const name of BUILTIN_TOOL_NAMES) {
      if (!builtinToolNameSet.has(name)) denyTools.add(name);
    }
    if (disallowedSet) {
      for (const name of disallowedSet) {
        if (!structuredToolNames.has(name)) denyTools.add(name);
      }
    }
    sessionExcludeTools = [...denyTools];
  }

  return {
    model,
    thinkingLevel,
    nestedTools,
    askTools,
    structuredTools,
    structuredCapture,
    disallowedSet,
    readmitToolNames,
    sessionTools,
    sessionExcludeTools,
  };
}

interface CreateSessionParams {
  ctx: ExtensionContext;
  type: SubagentType;
  agentConfig: AgentConfig | undefined;
  effectiveCwd: string;
  agentDir: string;
  loader: DefaultResourceLoader;
  sessionSettingsManager: SettingsManager;
  model: any;
  thinkingLevel: any;
  sessionTools: string[] | undefined;
  sessionExcludeTools: string[] | undefined;
  customTools: any[];
  noExtensions: boolean;
  nestedCallGate: NestedCallGate;
  toolNames: string[];
  disallowedSet: Set<string> | undefined;
  extNames: Set<string>;
  narrowing: Map<string, Set<string>>;
  mcpToolPatterns: string[] | undefined;
  readmitToolNames: Set<string>;
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
}> {
  const {
    ctx, type, agentConfig, effectiveCwd, agentDir, loader, sessionSettingsManager,
    model, thinkingLevel, sessionTools, sessionExcludeTools, customTools,
    noExtensions, nestedCallGate, toolNames, disallowedSet, extNames,
    narrowing, mcpToolPatterns, readmitToolNames, options,
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
    model,
    tools: sessionTools,
    customTools,
    resourceLoader: loader,
  };
  if (sessionExcludeTools) {
    sessionOpts.excludeTools = sessionExcludeTools;
  }
  if (thinkingLevel) {
    sessionOpts.thinkingLevel = thinkingLevel;
  }

  const { session } = await runInChildSessionContext(() => createAgentSession(sessionOpts));

  const baseSessionName = agentConfig?.name ?? type;
  session.setSessionName(
    options.agentId ? `${baseSessionName}#${options.agentId.slice(0, 8)}` : baseSessionName,
  );

  await session.bindExtensions({
    onError: (err: any) => {
      options.onToolActivity?.({
        type: "warning",
        toolName: `extension-error:${err.extensionPath}`,
      });
    },
  });

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
      nestedCallGate,
    });
  }

  // Durable Registry setup
  const registry = createRegistry();
  // Option B: Install CodingTools with live activity forwarding
  const rawCodingTools = [
    createReadTool(),
    createWriteTool(),
    createEditTool(),
    createBashTool(),
  ];
  const codingTools = rawCodingTools.map((tool) => {
    const origExecute = tool.execute.bind(tool);
    return {
      ...tool,
      execute: async (input: any, api: any, context: any) => {
        const lastAssistant =
          (session.state?.streamingMessage?.role === "assistant" ? session.state.streamingMessage : undefined) ??
          ([...session.messages].reverse().find((m: any) => m.role === "assistant") as any);
        const pendingCall = lastAssistant?.content?.find(
          (c: any) =>
            c.type === "toolCall" &&
            c.name === tool.name &&
            !session.messages.some((m: any) => m.role === "toolResult" && m.toolCallId === (c.id ?? c.toolUseId)),
        );
        const callId = api?.callId ?? pendingCall?.id ?? pendingCall?.toolUseId ?? `tool_${Date.now()}`;

        if ((session as any).agent?.beforeToolCall) {
          const decision = await (session as any).agent.beforeToolCall(
            { toolCall: { type: "toolCall", id: callId, name: tool.name, arguments: input }, args: input },
            options.signal,
          );
          if (decision?.block) {
            throw new Error(decision.reason ?? `Tool call blocked: ${tool.name}`);
          }
        }
        if (options.signal?.aborted) {
          throw new Error("Aborted");
        }

        options.onToolActivity?.({ type: "start", toolName: tool.name, toolCallId: callId, args: input });
        (session as any)._emit?.({ type: "tool_execution_start", toolCallId: callId, toolName: tool.name, args: input });

        let accumulatedOutput = "";
        const wrappedApi = api
          ? {
              ...api,
              output: (chunk: string, skipped?: boolean) => {
                api.output?.(chunk, skipped);
                if (chunk) {
                  accumulatedOutput += chunk;
                  (session as any)._emit?.({
                    type: "tool_execution_update",
                    toolCallId: callId,
                    toolName: tool.name,
                    args: input,
                    partialResult: {
                      content: [{ type: "text", text: accumulatedOutput }],
                    },
                  });
                }
              },
            }
          : api;

        let toolResult: any;
        try {
          const res = await origExecute(input, wrappedApi, context);
          let content: any[] = [];
          if (Array.isArray((res as any)?.output)) {
            content = (res as any).output;
          } else if (typeof (res as any)?.output === "string") {
            content = [{ type: "text", text: (res as any).output }];
          } else if (typeof (res as any)?.structuredOutput?.output === "string") {
            content = [{ type: "text", text: (res as any).structuredOutput.output }];
          } else if (typeof api?.retainedOutput === "function" && api.retainedOutput()?.text) {
            content = [{ type: "text", text: api.retainedOutput().text }];
          } else if (accumulatedOutput) {
            content = [{ type: "text", text: accumulatedOutput }];
          } else if (typeof res === "string") {
            content = [{ type: "text", text: res }];
          }

          const details = (res as any)?.details ?? (res as any)?.structuredOutput;
          const isError = (res as any)?.isError === true;
          toolResult = {
            role: "toolResult" as const,
            toolCallId: callId,
            toolName: tool.name,
            content,
            details,
            isError,
            timestamp: Date.now(),
          };
          if ((session as any).agent?.afterToolCall) {
            const hookOverride = await (session as any).agent.afterToolCall(
              {
                toolCall: { type: "toolCall", id: callId, name: tool.name, arguments: input },
                args: input,
                result: toolResult,
                isError,
              },
              options.signal,
            );
            if (hookOverride?.content) {
              toolResult.content = hookOverride.content;
            }
          }
          session.messages.push(toolResult as any);
          (session as any)._emit?.({ type: "message_start", message: toolResult });
          (session as any)._emit?.({ type: "message_end", message: toolResult });
          return res;
        } catch (err: any) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          toolResult = {
            role: "toolResult" as const,
            toolCallId: callId,
            toolName: tool.name,
            content: [{ type: "text", text: errorMsg }],
            isError: true,
            timestamp: Date.now(),
          };
          if ((session as any).agent?.afterToolCall) {
            try {
              await (session as any).agent.afterToolCall(
                {
                  toolCall: { type: "toolCall", id: callId, name: tool.name, arguments: input },
                  args: input,
                  result: toolResult,
                  isError: true,
                },
                options.signal,
              );
            } catch {
              // ignore hook error during exception handling
            }
          }
          session.messages.push(toolResult as any);
          (session as any)._emit?.({ type: "message_start", message: toolResult });
          (session as any)._emit?.({ type: "message_end", message: toolResult });
          throw err;
        } finally {
          options.onToolActivity?.({ type: "end", toolName: tool.name, toolCallId: callId });
          (session as any)._emit?.({
            type: "tool_execution_end",
            toolCallId: callId,
            toolName: tool.name,
            result: toolResult,
            isError: toolResult?.isError === true,
          });
        }
      },
    };
  });
  registry.install(defineExtension({ name: "coding-tools", tools: codingTools as any }));

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
          onActivity: options.onToolActivity,
          beforeToolCall: (context, signal) =>
            (session as any).agent?.beforeToolCall?.(context, signal),
          afterToolCall: (context, signal) =>
            (session as any).agent?.afterToolCall?.(context, signal),
          onToolStart: (info) => {
            (session as any)._emit?.({
              type: "tool_execution_start",
              toolName: info.toolName,
              toolCallId: info.toolCallId,
              args: info.args,
            });
          },
          onToolUpdate: (info) => {
            (session as any)._emit?.({
              type: "tool_execution_update",
              toolName: info.toolName,
              toolCallId: info.toolCallId,
              args: info.args,
              partialResult: info.partialResult,
            });
          },
          onToolResult: (resMsg) => {
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
  return { session, registry, toolsFilter };
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

  const models = builtinModels();
  const allModels: Model<any>[] = [
    ...(toolLoadout.model ? [toolLoadout.model] : []),
    ...(ctx.model ? [ctx.model] : []),
    ...(ctx.modelRegistry?.getAll ? ctx.modelRegistry.getAll() : []),
  ];
  const byProvider = new Map<string, Model<any>[]>();
  let lastStreamError: string | undefined;
  let lastStreamErrorMessage: any | undefined;

  const agentState = (session.agent as any)?._state ?? (session as any).state;
  if (agentState) {
    agentState.isStreaming = true;
    agentState.streamingMessage = undefined;
  }

  let activeAssistantMessage: any;
  let activeText = "";

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
      options.onTextDelta?.("", activeText);
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
      options.onTextDelta?.(event.delta ?? "", activeText);
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
      if (event.type === "toolcall_start") {
        const item = event.partial?.content?.[event.contentIndex];
        if (item && item.type === "toolCall") {
          options.onToolActivity?.({
            type: "start",
            toolName: item.name,
            toolCallId: item.id,
            args: item.arguments,
          });
        }
      }
      if (agentState) {
        agentState.streamingMessage = activeAssistantMessage;
      }
      (session as any)._emit?.({ type: "message_update", message: activeAssistantMessage, assistantMessageEvent: event });
    } else if (event.type === "done") {
      if (activeAssistantMessage && event.message) {
        Object.assign(activeAssistantMessage, event.message);
      }
      const finalMsg = event.message ?? activeAssistantMessage;
      if (finalMsg && !session.messages.includes(finalMsg)) {
        session.messages.push(finalMsg);
      }
      if (agentState) {
        agentState.streamingMessage = undefined;
      }
      (session as any)._emit?.({ type: "message_end", message: finalMsg });
      (session as any)._emit?.({ type: "turn_end" });
      activeAssistantMessage = undefined;
    }
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
                  try {
                    handleStreamChunk(item.value);
                  } catch {
                    // best effort
                  }
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
          res.result?.().then((msg: any) => {
            if (msg?.stopReason === "error") {
              lastStreamError = msg.errorMessage ?? "provider error with no output";
              lastStreamErrorMessage = msg;
            }
          }).catch((err: any) => {
            lastStreamError = err instanceof Error ? err.message : String(err);
          });
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
          res.result?.().then((msg: any) => {
            if (msg?.stopReason === "error") {
              lastStreamError = msg.errorMessage ?? "provider error with no output";
              lastStreamErrorMessage = msg;
            }
          }).catch((err: any) => {
            lastStreamError = err instanceof Error ? err.message : String(err);
          });
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
      // pi-durable and pi-agent-core can resolve different pi-ai copies.
      // TranscriptContext is branded, so their otherwise compatible Models
      // registries are nominally distinct to TypeScript.
      models: models as unknown as Parameters<typeof Harness.open>[1]["models"],
      registry,
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

  const run = observeRun(session, { ...options, maxTurns: resolveEffectiveMaxTurns(type, options.maxTurns) });
  const collector = collectResponseText(session);
  const startIndex = session.messages.length;

  const abortListener = () => {
    session.abort?.();
    conversation?.abort(baseContext).catch(() => {});
  };
  options.signal?.addEventListener("abort", abortListener, { once: true });

  try {
    conversation = await harness.root(baseContext, {
      agent: {
        model: modelRef,
        thinkingLevel: (toolLoadout.thinkingLevel as any) ?? undefined,
        instructions: systemPrompt,
        maxTurns: resolveEffectiveMaxTurns(type, options.maxTurns),
        cwd: effectiveCwd,
        ...(toolsFilter ? { tools: toolsFilter } : {}),
      },
    });



    let trimmed = "";
    if (prompt === undefined) {
      await continueSessionBare(session, { signal: options.signal });
    } else {
      let effectivePrompt = prompt;
      if (options.inheritContext && !options.resumeSessionFile) {
        const parentContext = buildParentContext(ctx);
        if (parentContext) {
          effectivePrompt = parentContext + prompt;
        }
      }

      const userMessage = {
        role: "user" as const,
        content: [{ type: "text" as const, text: effectivePrompt }],
        timestamp: Date.now(),
      };
      session.messages.push(userMessage as any);
      session.sessionManager?.appendMessage?.(userMessage as any);

      const submission = await conversation.submit({ type: "input", content: effectivePrompt }, baseContext);
      const settled = await submission.wait(baseContext);

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
        await retrySubmission.wait(baseContext);
      }

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
      if (trimmed && options.onTextDelta) {
        options.onTextDelta(trimmed, trimmed);
      }

      // Check if pause gate was installed (e.g. agent paused mid-run)
      const newMessages = messages[0]?.role === "user" ? messages.slice(1) : messages;
      if ((session as any).agent?.finishTurn) {
        await (session as any).agent.finishTurn(
          { message: newMessages[0] ?? { role: "assistant", content: [] }, toolResults: [] },
          options.signal,
        );
      }

      // Replace in-progress live messages with finalized committed messages
      session.messages.splice(startIndex);
      session.messages.push(userMessage as any);

      // Append newly produced messages to session and sessionManager for persistence
      for (const msg of newMessages) {
        session.messages.push(msg as any);
        session.sessionManager?.appendMessage?.(msg as any);
        if (options.onAssistantUsage && (msg as any).usage) {
          const u = (msg as any).usage;
          options.onAssistantUsage({
            input: u.input ?? 0,
            output: u.output ?? 0,
            cacheRead: u.cacheRead ?? 0,
            cacheWrite: u.cacheWrite ?? 0,
            cost: u.cost?.total ?? (typeof u.cost === "number" ? u.cost : 0),
          });
        }
      }

      if (settled.status === "unanswered") {
        if (lastStreamErrorMessage) {
          session.messages.push(lastStreamErrorMessage);
          session.sessionManager?.appendMessage?.(lastStreamErrorMessage);
        } else {
          const errText =
            lastStreamError ?? (settled as any).detail ?? (settled as any).reason ?? "provider error with no output";
          const failureMessage = {
            role: "assistant" as const,
            content: [{ type: "text" as const, text: "" }],
            stopReason: "error" as const,
            errorMessage: errText,
            timestamp: Date.now(),
          };
          session.messages.push(failureMessage as any);
          session.sessionManager?.appendMessage?.(failureMessage as any);
        }
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
    const failure = finalError ?? structuredFailure;

    return {
      responseText: resolvedResponseText,
      session,
      aborted: options.signal?.aborted === true || run.aborted,
      steered: run.steered,
      failure,
      ...(toolLoadout.structuredCapture?.json !== undefined ? { structuredJson: toolLoadout.structuredCapture.json } : {}),
      ...(structuredRetried ? { structuredRetried } : {}),
    };
  } finally {
    run.unsubscribe();
    collector.unsubscribe();
    options.signal?.removeEventListener("abort", abortListener);
    if (agentState) {
      agentState.isStreaming = false;
      agentState.streamingMessage = undefined;
    }
    try {
      await harness.close(baseContext);
    } catch {
      // best-effort cleanup
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

  // 1. Prepare agent system prompt, memory, and skills
  const { systemPrompt, toolNames, noSkills } = await prepareAgentSystemPrompt(
    ctx, type, agentConfig, config, effectiveCwd, configCwd, options,
  );

  // 2. Setup resource loader, extension overrides, and configuration warnings
  const resourceContext = await createRunnerResourceLoader(
    ctx, type, agentConfig, config, configCwd, effectiveCwd, systemPrompt, noSkills, options,
  );

  // 3. Resolve model and compute tool admission loadout
  const toolLoadout = buildSessionToolLoadout(
    ctx, type, agentConfig, resourceContext.loader, resourceContext.sessionSettingsManager,
    toolNames, resourceContext.extNames, resourceContext.mcpToolPatterns, resourceContext.noExtensions,
    configCwd, options,
  );

  // 4. Instantiate session, bind extensions (including MCP), and build durable registry
  const { session, registry, toolsFilter } = await createDurableRegistryAndSession({
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
    options,
  });

  // 5. Execute agent loop durably with NodeExecutionEnv and return observed results
  return executeDurableAgentPrompt(
    ctx, session, registry, prompt, type, effectiveCwd, systemPrompt, toolLoadout, toolsFilter, options,
  );
}
