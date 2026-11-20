import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  getConfig,
  getMemoryToolNames,
  getReadOnlyMemoryToolNames,
  getToolNamesForType,
} from "../agent-types.js";
import { DEFAULT_AGENTS } from "../default-agents.js";
import { detectEnv } from "../env.js";
import { buildMemoryBlock, buildReadOnlyMemoryBlock } from "../memory.js";
import { createNestedSubagentTools, getMaxSubagentDepth } from "../nested-tools.js";
import {
  buildAgentPrompt,
  inheritableParentPrompt,
  type PromptExtras,
} from "../prompts.js";
import { preloadSkills } from "../skill-loader.js";
import type { AgentConfig, SubagentType } from "../types.js";
import {
  isUncutPromptProvider,
  type resolveDefaultModel,
} from "./runner-settings.js";
import type { RunOptions } from "./runner-types.js";

export interface PreparedNestedTools {
  tools: ReturnType<typeof createNestedSubagentTools>;
  disallowedSet: Set<string> | undefined;
}

export interface PreparedSystemPrompt {
  systemPrompt: string;
  toolNames: string[];
  noSkills: boolean;
  nested: PreparedNestedTools;
}

/**
 * Prepare the agent's system prompt, inheritance, memory blocks, and skills.
 */
export async function prepareAgentSystemPrompt(
  ctx: ExtensionContext,
  type: SubagentType,
  agentConfig: AgentConfig | undefined,
  config: ReturnType<typeof getConfig>,
  effectiveCwd: string,
  configCwd: string,
  model: ReturnType<typeof resolveDefaultModel>,
  options: RunOptions,
): Promise<PreparedSystemPrompt> {
  const env = await detectEnv(options.pi, effectiveCwd);

  // Get parent system prompt for append-mode agents. Bridge providers need the
  // full assembled prompt to project it into their harness; every other provider
  // gets the sections the child renders itself (skills, cwd, extension sections)
  // stripped so they are not duplicated.
  const parentSystemPrompt = typeof ctx.getSystemPrompt === "function"
    ? isUncutPromptProvider(model?.provider)
      ? ctx.getSystemPrompt()
      : inheritableParentPrompt(ctx.getSystemPrompt(), ctx.cwd)
    : "";

  const extras: PromptExtras = {};
  if (options.worktreeBase) extras.worktreeBase = options.worktreeBase;
  if (options.workflow && !options.structuredOutput) extras.workflowChild = true;

  const isolated = agentConfig?.isolated ?? options.isolated;
  const skills = isolated ? false : config.skills;

  // A per-call list (`agent({ disallowedTools })` in a workflow script) adds to
  // the agent definition's; it can narrow what the child gets but never widen
  // it, so both are unioned before the tool scope is applied.
  const disallowedNames = [...(agentConfig?.disallowedTools ?? []), ...(options.disallowedTools ?? [])];
  const disallowedSet = disallowedNames.length > 0 ? new Set(disallowedNames) : undefined;

  // Nested delegation tools (opt-in, ownership-scoped). Empty unless the agent
  // set `allowed_subagents` and a nestedRuntime was provided — and never when
  // isolated. Decided before the prompt is built, which says so when the agent
  // delegates.
  const effectiveMaxDepth = options.nestedRuntime?.maxSubagentDepth ?? getMaxSubagentDepth();
  // At (or past) the cap this agent can never spawn, so it can never own a child
  // to fetch from or steer either — inject nothing rather than three tools whose
  // every call is an error. This is also what makes `maxSubagentDepth` 0/1 mean
  // "nesting off" instead of "nesting always fails".
  const nestedRuntime = options.nestedRuntime && options.nestedRuntime.depth < effectiveMaxDepth
    ? options.nestedRuntime
    : undefined;
  // A workflow agent running the built-in general-purpose (what an untyped
  // agent() gets) does not delegate: Claude Code's `workflow-subagent` drops the
  // Agent tool, and the workflow script is what fans out. A custom agent's own
  // `allowed_subagents` still applies.
  const builtinInWorkflow = options.workflow === true && agentConfig?.isDefault === true;
  const nestedTools = agentConfig?.allowedSubagents && nestedRuntime && !isolated && !builtinInWorkflow
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
  const nestedToolNames = new Set(nestedTools.map(tool => tool.name));
  // Only where the built-in general-purpose can actually spawn — not in a
  // workflow, at the depth cap, isolated, or with `Agent` disallowed.
  if (agentConfig?.isDefault && nestedToolNames.has("Agent") && !disallowedSet?.has("Agent")) {
    extras.delegationGuideline = true;
  }

  if (Array.isArray(skills)) {
    const loaded = preloadSkills(skills, configCwd);
    if (loaded.length > 0) {
      extras.skillBlocks = loaded;
    }
  }

  let toolNames = getToolNamesForType(type);

  if (agentConfig?.memory) {
    const existingNames = new Set(toolNames);
    const effectivelyHas = (name: string) => existingNames.has(name) && !disallowedSet?.has(name);
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
  return { systemPrompt, toolNames, noSkills, nested: { tools: nestedTools, disallowedSet } };
}
