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
  isUncutPromptProvider,
  resolveDefaultModel,
  resolveEffectiveMaxTurns,
} from "./runner-settings.js";
import {
  EXCLUDED_TOOL_NAMES,
  PI_BUILTIN_EXTENSIONS,
  type RunOptions,
  type RunResult,
} from "./runner-types.js";

/**
 * Open an agent's saved session to continue it — or a copy of it, when the
 * session belongs to another parent.
 *
 * pi's `/fork` and `/clone` copy the parent's entries, saved agent records
 * included, so two parent sessions can each resume the same agent. Appending
 * both continuations to one file would interleave two histories in it. The
 * child's header names the parent that spawned it; a resume from any other
 * parent forks the child alongside, exactly as pi forked the parent, and the
 * copy is that parent's from then on. A header with no parent (a child
 * spawned from a context without a session file) gives nothing to compare,
 * so it opens in place as before.
 */
function reopenSession(file: string, parentSessionFile: string | undefined, sessionDir: string | undefined): SessionManager {
  const opened = SessionManager.open(file, sessionDir);
  const owner = opened.getHeader()?.parentSession;
  if (owner === undefined || owner === parentSessionFile) return opened;
  return SessionManager.forkFrom(file, opened.getCwd(), sessionDir, { parentSession: parentSessionFile });
}

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

  const agentDir = getAgentDir();
  const projectTrusted = ctx.isProjectTrusted();
  const settingsManager = SettingsManager.create(configCwd, agentDir, { projectTrusted });

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

  // Get parent system prompt for append-mode agents. For bridge providers that
  // re-home the prompt into another harness (like claude-bridge), the bridge relies
  // on matching the parent's full assembled prompt verbatim to project it into
  // portable parts without harness leakage. For all other providers, strip the
  // sections the child session renders itself (skills, cwd, extension sections).
  // Get parent system prompt for append-mode agents. For bridge providers that
  // re-home the prompt into another harness (like claude-bridge), the bridge relies
  // on matching the parent's full assembled prompt verbatim to project it into
  // portable parts without harness leakage. For all other providers, strip the
  // sections the child session renders itself (skills, cwd, extension sections).
  const parentSystemPrompt = isUncutPromptProvider(model?.provider)
    ? ctx.getSystemPrompt()
    : inheritableParentPrompt(ctx.getSystemPrompt(), ctx.cwd);

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
  // ask_parent/answer_subagent need only an owner, never delegation headroom:
  // every non-isolated subagent gets them, at any depth, with or without an
  // allowlist — unless its own disallowedTools names them. Only when the full
  // delegation suite is present are they already inside nestedTools.
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

  // As in Claude Code, refuse an agent whose `tools:` list resolved to nothing: with
  // no tool it can only narrate calls it cannot make. Extension tools register after
  // spawn (MCP once its servers connect), so they count as possible whenever an
  // extension they could come from loaded, or any `mcp__` entry can reach a bridge.
  //
  // A resume reopens an existing conversation: the config may have changed since
  // its first run, and refusing then would strand every revive path (`/agents`,
  // pause-continue, `Agent({resume})`) without the session it was asked to reopen.
  if (options.resumeSessionFile === undefined) {
    const loadedNames = new Set(
      loader
        .getExtensions()
        .extensions.filter((e) => e.path !== `<inline:${SCOPE_GATE_NAME}>`)
        .flatMap((e) => extensionCanonicalNames(e.path)),
    );
    const unrecognized = agentConfig?.builtinToolNames?.filter((n) => !BUILTIN_TOOL_NAMES.includes(n)) ?? [];
    const unmatched = [...extNames].filter((n) => !loadedNames.has(n));
    // `extensions: false` and `isolated` load nothing, so `loadedNames` is empty then.
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

  const configuredSessionDir = resolveConfiguredSessionDir(agentConfig?.sessionDir, effectiveCwd);
  const defaultSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR ?? settingsManager.getSessionDir?.();
  const persistSession = agentConfig?.persistSession ?? (options.nested ? false : getRememberAgents());
  const parentSessionFile = ctx.sessionManager?.getSessionFile?.();
  const sessionManager = options.resumeSessionFile
    // Reopening an existing conversation: the file already carries its own
    // header (cwd, parent) and history, so none of the create-time options
    // apply. `sessionDir` still matters for a later /new or /branch off it.
    ? reopenSession(options.resumeSessionFile, parentSessionFile, configuredSessionDir ?? defaultSessionDir)
    : persistSession
      ? SessionManager.create(effectiveCwd, configuredSessionDir ?? defaultSessionDir, {
          parentSession: parentSessionFile,
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
    customTools: [...nestedTools, ...askTools, ...structuredTools],
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
      mcpToolPatterns: isolated ? undefined : mcpToolPatterns,
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
      // Parent context only for a fresh conversation — a reopened one already
      // holds its history, and a live resume never re-sends the parent's either.
      if (options.inheritContext && !options.resumeSessionFile) {
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
