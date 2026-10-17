/**
 * runner-session.ts — session setup, tool binding, and execution loop for runAgent.
 */

import { resolve } from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionContext,
  getAgentDir,
  type LoadExtensionsResult,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
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
  createNestedSubagentTools,
  getMaxSubagentDepth,
} from "../nested-tools.js";
import { buildAgentPrompt, type PromptExtras } from "../prompts.js";
import { continueSessionBare } from "../session-continue.js";
import { preloadSkills } from "../skill-loader.js";
import {
  createStructuredCapture,
  createStructuredOutputTool,
  structuredRetryPrompt,
} from "../structured-output.js";
import type { SubagentType } from "../types.js";
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
  forwardAbortSignal,
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

export async function runAgent(
  ctx: ExtensionContext,
  type: SubagentType,
  prompt: string | undefined,
  options: RunOptions,
): Promise<RunResult> {
  if (prompt === undefined && options.resumeSessionFile === undefined) {
    throw new Error("runAgent requires a prompt unless resumeSessionFile is set");
  }
  const config = getConfig(type);
  const agentConfig = getAgentConfig(type);

  const effectiveCwd = options.cwd ?? ctx.cwd;
  const configCwd = options.configCwd ?? effectiveCwd;

  const env = await detectEnv(options.pi, effectiveCwd);

  const parentSystemPrompt = ctx.getSystemPrompt();

  const extras: PromptExtras = {};
  if (options.worktreeBase) extras.worktreeBase = options.worktreeBase;
  if (options.workflow && !options.structuredOutput) extras.workflowChild = true;

  const isolated = agentConfig?.isolated ?? options.isolated;
  const extensions = isolated ? false : config.extensions;
  const excludeExtensions = isolated ? undefined : config.excludeExtensions;
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
  const agentDir = getAgentDir();

  const { extNames, narrowing } = parseExtSelectors(
    isolated ? [] : (agentConfig?.extSelectors ?? []),
  );
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

  const projectTrusted = ctx.isProjectTrusted();
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
  const nestedToolNames = new Set(nestedTools.map((tool: any) => tool.name));

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

  const configuredSessionDir = resolveConfiguredSessionDir(agentConfig?.sessionDir, effectiveCwd);
  const defaultSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR ?? settingsManager.getSessionDir?.();
  const persistSession = agentConfig?.persistSession ?? (options.nested ? false : getRememberAgents());
  const sessionManager = options.resumeSessionFile
    ? SessionManager.open(options.resumeSessionFile, configuredSessionDir ?? defaultSessionDir)
    : persistSession
      ? SessionManager.create(effectiveCwd, configuredSessionDir ?? defaultSessionDir, {
          parentSession: ctx.sessionManager?.getSessionFile?.(),
        })
      : SessionManager.inMemory(effectiveCwd);

  const parentModelRuntime = (ctx.modelRegistry as unknown as { runtime?: unknown }).runtime;
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
    customTools: [...nestedTools, ...structuredTools],
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

  if (!noExtensions) {
    installExtensionToolScope(session, {
      loader,
      toolNames,
      disallowedSet,
      extNames,
      narrowing,
      readmitToolNames,
      nestedCallGate,
    });
  }

  options.onSessionCreated?.(session);

  const run = observeRun(session, { ...options, maxTurns: resolveEffectiveMaxTurns(type, options.maxTurns) });

  const collector = collectResponseText(session);
  const cleanupAbort = forwardAbortSignal(session, options.signal);

  const startLen = session.messages.length;
  let structuredRetried = false;
  try {
    if (prompt === undefined) {
      await continueSessionBare(session, { signal: options.signal });
    } else {
      let effectivePrompt = prompt;
      if (options.inheritContext) {
        const parentContext = buildParentContext(ctx);
        if (parentContext) {
          effectivePrompt = parentContext + prompt;
        }
      }

      if (options.signal?.aborted !== true) await session.prompt(effectivePrompt);

      if (structuredCapture !== undefined && structuredCapture.json === undefined
        && !run.aborted && options.signal?.aborted !== true) {
        structuredRetried = true;
        await session.prompt(structuredRetryPrompt(structuredCapture));
      }
    }
  } finally {
    run.unsubscribe();
    collector.unsubscribe();
    cleanupAbort();
  }

  const responseText = collector.getText().trim() || getLastAssistantText(session, startLen);
  const structuredFailure = structuredCapture !== undefined && structuredCapture.json === undefined
    ? structuredCapture.lastError !== undefined
      ? `The agent's StructuredOutput call did not match the required schema: ${structuredCapture.lastError}`
      : "The agent did not report its answer through StructuredOutput."
    : undefined;
  return {
    responseText,
    session,
    aborted: run.aborted,
    steered: run.steered,
    failure: finalTurnError(session, startLen) ?? structuredFailure,
    ...(structuredCapture?.json !== undefined ? { structuredJson: structuredCapture.json } : {}),
    ...(structuredRetried ? { structuredRetried } : {}),
  };
}
