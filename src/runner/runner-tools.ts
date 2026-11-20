import type { Model } from "@earendil-works/pi-ai";
import type {
  DefaultResourceLoader,
  ExtensionContext,
  SettingsManager,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { BUILTIN_TOOL_NAMES } from "../agent-types.js";
import { createAskAnswerTools } from "../nested-tools.js";
import {
  createStructuredCapture,
  createStructuredOutputTool,
} from "../structured-output.js";
import type {
  AgentConfig,
  EffectiveThinkingLevel,
  SubagentType,
} from "../types.js";
import {
  extensionCanonicalNames,
  SCOPE_GATE_NAME,
} from "./extension-scope.js";
import type { PreparedNestedTools } from "./runner-prompt.js";
import { resolveDefaultModel } from "./runner-settings.js";
import { EXCLUDED_TOOL_NAMES, type RunOptions } from "./runner-types.js";

export interface SessionToolLoadout {
  model: Model<any> | undefined;
  thinkingLevel: EffectiveThinkingLevel | undefined;
  nestedTools: ToolDefinition[];
  askTools: ToolDefinition[];
  structuredTools: ToolDefinition[];
  structuredCapture: ReturnType<typeof createStructuredCapture> | undefined;
  disallowedSet: Set<string> | undefined;
  readmitToolNames: Set<string>;
  sessionTools: string[] | undefined;
  sessionExcludeTools: string[] | undefined;
}

/**
 * Resolve the run model before the prompt is built: append-mode inheritance
 * depends on the provider, and a bridge provider needs the parent prompt verbatim.
 */
export function resolveRunModel(
  ctx: ExtensionContext,
  type: SubagentType,
  agentConfig: AgentConfig | undefined,
  settingsManager: SettingsManager,
  options: RunOptions,
): ReturnType<typeof resolveDefaultModel> {
  if (options.resumeSessionFile !== undefined) return options.model;
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

  return model;
}

/**
 * Model resolution, custom tools creation (nested, ask, structured), and tool admission calculation.
 */
export function buildSessionToolLoadout(
  ctx: ExtensionContext,
  type: SubagentType,
  agentConfig: AgentConfig | undefined,
  loader: DefaultResourceLoader,
  toolNames: string[],
  extNames: Set<string>,
  mcpToolPatterns: string[] | undefined,
  noExtensions: boolean,
  nested: PreparedNestedTools,
  model: ReturnType<typeof resolveDefaultModel>,
  options: RunOptions,
): SessionToolLoadout {
  const isolated = agentConfig?.isolated ?? options.isolated;

  const thinkingLevel = options.resumeSessionFile === undefined
    ? (options.thinkingLevel ?? agentConfig?.thinking ?? ctx.thinkingLevel)
    : options.thinkingLevel;

  const { disallowedSet, tools: nestedTools } = nested;

  const askTools = options.nestedRuntime && !isolated && !nestedTools.some((tool) => tool.name === "ask_parent")
    ? createAskAnswerTools({
        manager: options.nestedRuntime.manager,
        pi: options.pi,
        parentAgentId: options.nestedRuntime.parentAgentId,
      })
    : [];
  const nestedToolNames = new Set([...nestedTools, ...askTools].map((tool) => tool.name));

  const structuredCapture = options.structuredOutput ? createStructuredCapture() : undefined;
  const structuredTools = options.structuredOutput && structuredCapture
    ? [createStructuredOutputTool(options.structuredOutput, structuredCapture)]
    : [];
  const structuredToolNames = new Set(structuredTools.map((tool) => tool.name));
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
