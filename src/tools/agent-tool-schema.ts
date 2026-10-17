import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getAgentConfig, getAvailableTypes } from "../agent-types.js";
import { formatToolsSuffix, THINKING_LEVELS } from "../entry/renderers.js";
import { isolationParam } from "../invocation-config.js";
import type { ToolDescriptionMode } from "../settings.js";

/** Derive a short model label from a model string. */
export function getModelLabelFromConfig(model: string): string {
  const name = model.includes("/") ? model.split("/").pop()! : model;
  return name.replace(/-\d{8}$/, "");
}

/** First sentence of an agent description — for the compact type list. */
export function firstSentence(text: string): string {
  const match = text.match(/^.*?[.!?](?=\s|$)/s);
  return (match ? match[0] : text).replace(/\s+/g, " ").trim();
}

/** Build the full type list text dynamically from available agents only. */
export function buildTypeListText(): string {
  const available = getAvailableTypes();

  return available.map((name) => {
    const cfg = getAgentConfig(name);
    const modelSuffix = cfg?.model ? ` (${getModelLabelFromConfig(cfg.model)})` : "";
    const toolsSuffix = ` (Tools: ${formatToolsSuffix(cfg)})`;
    return `- ${name}: ${cfg?.description ?? name}${modelSuffix}${toolsSuffix}`;
  }).join("\n");
}

/** Compact type list: one line per agent, first sentence only. */
export function buildCompactTypeListText(): string {
  return getAvailableTypes().map((name) => {
    const cfg = getAgentConfig(name);
    return `- ${name}: ${firstSentence(cfg?.description ?? name)} (Tools: ${formatToolsSuffix(cfg)})`;
  }).join("\n");
}

const scheduleParamShape = {
  schedule: Type.Optional(
    Type.String({
      description:
        'Opt-in only — fire later instead of now. Omit to run immediately (the default, almost always correct). ' +
        'Formats: 6-field cron ("0 0 9 * * 1" = 9am Mon), interval ("5m"/"1h"), one-shot ("+10m" or ISO). ' +
        'Forces run_in_background; incompatible with inherit_context and resume. Returns job ID.',
    }),
  ),
};

export function buildScheduleParam(schedulingEnabled: boolean): Partial<typeof scheduleParamShape> {
  return schedulingEnabled ? scheduleParamShape : {};
}

export function buildAgentToolParams(schedulingEnabled: boolean, worktreeIsolationEnabled: boolean) {
  return Type.Object({
    prompt: Type.String({
      description: "The task for the agent to perform.",
    }),
    description: Type.String({
      description: "A short (3-5 word) description of the task (shown in UI).",
    }),
    name: Type.Optional(
      Type.String({
        description:
          'Optional memorable name for this agent, e.g. "auth-audit", so it can be addressed as `@name` at the prompt and by steer_subagent / get_subagent_result. Letters, digits, `_` and `-`. Worth setting when several agents of the same type run at once; omit for one-off work. The agent stays reachable by its type either way.',
      }),
    ),
    subagent_type: Type.String({
      description: `The type of specialized agent to use. Available types: ${getAvailableTypes().join(", ")}. Custom agents from .pi/agents/*.md (project) or ${getAgentDir()}/agents/*.md (global) are also available.`,
    }),
    model: Type.Optional(
      Type.String({
        description:
          'Optional model override. Accepts "provider/modelId" or fuzzy name (e.g. "haiku", "sonnet"). Omit to use the agent type\'s default.',
      }),
    ),
    thinking: Type.Optional(
      Type.String({
        description: `Thinking level: ${THINKING_LEVELS.join(", ")}. Overrides agent default.`,
      }),
    ),
    max_turns: Type.Optional(
      Type.Number({
        description: "Maximum number of agentic turns before stopping. Omit for unlimited (default).",
        minimum: 1,
      }),
    ),
    run_in_background: Type.Optional(
      Type.Boolean({
        description: "Defaults to true — the agent runs detached, returning its ID immediately, and you are notified on completion. Set false only when your very next action depends on the result; the call then blocks and returns the agent's full output inline.",
      }),
    ),
    resume: Type.Optional(
      Type.String({
        description: "Optional agent ID to resume from. Continues from previous context. Resumes detached like any other spawn; pass run_in_background: false to block and get the result inline. The resumed run gets a fresh max_turns budget. An agent can only be resumed once its current run has finished — use steer_subagent to reach one mid-run.",
      }),
    ),
    isolated: Type.Optional(
      Type.Boolean({
        description: "If true, agent gets no extension/MCP tools — only built-in tools.",
      }),
    ),
    inherit_context: Type.Optional(
      Type.Boolean({
        description: "If true, fork parent conversation into the agent. Default: false (fresh context).",
      }),
    ),
    ...isolationParam(worktreeIsolationEnabled),
    ...buildScheduleParam(schedulingEnabled),
  });
}

export function buildAgentToolDescription(opts: {
  mode: ToolDescriptionMode;
  schedulingEnabled: boolean;
  worktreeIsolationEnabled: boolean;
}): string {
  const scheduleGuideline = opts.schedulingEnabled
    ? `\n- Use \`schedule\` only when the user explicitly asked for scheduled / recurring / delayed execution (e.g. "every Monday", "in an hour"). Don't auto-schedule from vague intent like "monitor X" — run once now or ask.`
    : "";

  const isolationGuideline = opts.worktreeIsolationEnabled
    ? `\n- Use isolation: "worktree" to give the agent its own git worktree (safe parallel file modifications); leave it unset, or pass "off", for none. The worktree is removed when the agent finishes; if it made changes, they are committed to a branch and the branch is named in the result.`
    : "";

  const isolationCompactGuideline = opts.worktreeIsolationEnabled
    ? `\n- isolation: "worktree" gives the agent its own git worktree (removed on completion); changes land on a branch named in the result.`
    : "";

  const compactAgentToolDescription = `Launch an autonomous agent for complex, multi-step tasks. Agent types:
${buildCompactTypeListText()}

Custom agents: .pi/agents/<name>.md (project) or ${getAgentDir()}/agents/<name>.md (global).

Notes:
- description: 3-5 words (shown in UI). Prompts must be self-contained — the agent has not seen this conversation.
- Parallel work: one message, multiple Agent calls — they run concurrently.
- Subagents run in the background by default; you'll be notified when one completes. Pass run_in_background: false only when your very next action depends on the result and nothing else could usefully happen while it runs. Never fabricate or predict a pending agent's results — if the user asks before the notification arrives, say it's still running.
- The result is not shown to the user — summarize it for them. Verify an agent's claimed code changes before reporting work done.
- resume continues a previous agent by ID; steer_subagent messages a running one.${isolationCompactGuideline}`;

  const fullAgentToolDescription = `Launch a new agent to handle complex, multi-step tasks autonomously. Each agent type has specific capabilities and tools available to it.

Available agent types and the tools they have access to:
${buildTypeListText()}

Custom agents can be defined in .pi/agents/<name>.md (project) or ${getAgentDir()}/agents/<name>.md (global) — they are picked up automatically. Project-level agents override global ones. Creating a .md file with the same name as a default agent overrides it.

When using the Agent tool, specify a subagent_type parameter to select which agent type to use.

## When not to use

If the target is already known, use a direct tool — \`read\` for a known path, \`grep\`/\`find\` for a specific symbol or string. Reserve this tool for open-ended questions that span the codebase, or tasks that match an available agent type.

## Usage notes

- Always include a short (3-5 word) description summarizing what the agent will do (shown in UI).
- When you launch multiple agents for independent work, send them in a single message with multiple tool uses so they run concurrently. If the user specifies that they want you to run agents "in parallel", you MUST send a single message with multiple Agent tool use content blocks.
- When the agent is done, it returns a single message back to you. The result is not visible to the user — to show the user, send a text message with a concise summary.
- Trust but verify: an agent's summary describes what it intended to do, not necessarily what it did. When an agent writes or edits code, check the actual changes before reporting the work as done.
- Agents run in the background by default. When an agent runs in the background, you will be automatically notified when it completes — do NOT sleep, poll, or proactively check on its progress. Continue with other work or respond to the user instead.
- **Foreground vs background**: Pass \`run_in_background: false\` only when your very next action depends on the agent's result and nothing else could usefully happen while it runs — e.g., a research agent whose finding gates the edit you're about to make. Otherwise let it run in the background (the default) — this includes fire-and-forget work, independent investigations, and anything where the user might hand you something else in the meantime. Wanting the result "next" is not enough on its own.
- **Don't race**: after launching a background agent, you know nothing about its results. Never fabricate or predict them in any format — not as prose, summary, or structured output. The completion notification arrives in a later turn; it is never something you write yourself. If the user asks before it lands, say the agent is still running — give status, not a guess.
- Use resume with an agent ID to continue a previous agent's work. A new (non-resume) Agent call starts a fresh agent with no memory of prior runs, so the prompt must be self-contained.
- Use steer_subagent to send mid-run messages to a running background agent.
- Clearly tell the agent whether you expect it to write code or just to do research (search, file reads, etc.), since it is not aware of the user's intent.
- If an agent's description says it should be used proactively, try to use it without the user having to ask for it first.
- Use model to specify a different model (as "provider/modelId", or fuzzy e.g. "haiku", "sonnet").
- Use thinking to control extended thinking level.
- Use inherit_context if the agent needs the parent conversation history.${isolationGuideline}${scheduleGuideline}

## Writing the prompt

Brief the agent like a smart colleague who just walked into the room — it hasn't seen this conversation, doesn't know what you've tried, doesn't understand why this task matters.
- Explain what you're trying to accomplish and why.
- Describe what you've already learned or ruled out.
- Give enough context about the surrounding problem that the agent can make judgment calls rather than just following a narrow instruction.
- If you need a short response, say so ("report in under 200 words").
- Lookups: hand over the exact command. Investigations: hand over the question — prescribed steps become dead weight when the premise is wrong.

Terse command-style prompts produce shallow, generic work.

**Never delegate understanding.** Don't write "based on your findings, fix the bug" or "based on the research, implement it." Those phrases push synthesis onto the agent instead of doing it yourself. Write prompts that prove you understood: include file paths, line numbers, what specifically to change.`;

  const renderToolDescriptionTemplate = (template: string): string => {
    const vars: Record<string, () => string> = {
      typeList: buildTypeListText,
      compactTypeList: buildCompactTypeListText,
      agentDir: getAgentDir,
      isolationGuideline: () => isolationGuideline,
      scheduleGuideline: () => scheduleGuideline,
    };
    return template.replace(/\{\{(\w+)\}\}/g, (raw, name: string) => {
      if (vars[name]) return vars[name]();
      console.warn(`[pi-subagents-hub] agent-tool-description.md: unknown placeholder ${raw} left as-is`);
      return raw;
    });
  };

  const loadCustomToolDescription = (): string | undefined => {
    for (const path of [
      join(process.cwd(), ".pi", "agent-tool-description.md"),
      join(getAgentDir(), "agent-tool-description.md"),
    ]) {
      try {
        if (!existsSync(path)) continue;
        const text = readFileSync(path, "utf-8").trim();
        if (text) return renderToolDescriptionTemplate(text);
        console.warn(`[pi-subagents-hub] ${path} is empty — ignoring`);
      } catch (err) {
        console.warn(`[pi-subagents-hub] failed to read ${path}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return undefined;
  };

  if (opts.mode === "compact") return compactAgentToolDescription;
  if (opts.mode === "custom") {
    const custom = loadCustomToolDescription();
    if (custom) return custom;
    console.warn('[pi-subagents-hub] toolDescriptionMode is "custom" but no agent-tool-description.md found — using "full"');
  }
  return fullAgentToolDescription;
}
