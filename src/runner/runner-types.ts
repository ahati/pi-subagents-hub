/**
 * runner-types.ts — tool names, constants, interfaces and types for the subagent runner.
 */

import type { Model } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  type ExtensionAPI,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import type { NestedAgentManager } from "../nested-tools.js";
import type { SubagentType, ThinkingLevel } from "../types.js";
import type { LifetimeUsage } from "../usage.js";
import type { CompiledSchema } from "../workflow/json-schema.js";

/**
 * Tool names registered by THIS extension. Single source of truth so the
 * registration sites (index.ts) and the subagent exclusion list below can't
 * drift apart. These are our own tools, not pi built-ins, so they can't be
 * derived from pi — but they only need defining once.
 */
export const SUBAGENT_TOOL_NAMES = {
  AGENT: "Agent",
  WORKFLOW: "SubagentWorkflow",
  GET_RESULT: "get_subagent_result",
  STEER: "steer_subagent",
  ANSWER: "answer_subagent",
} as const;

/** Names of tools registered by this extension that subagents must NOT inherit. */
export const EXCLUDED_TOOL_NAMES: string[] = Object.values(SUBAGENT_TOOL_NAMES);

/**
 * pi's built-in codemode, tool-search and MCP extensions, as its CLI hands them to
 * the resource loader. They only exist when passed in as `extensionFactories` — an
 * SDK-built loader gets none of them — so without this a subagent has no `codemode`
 * and no MCP servers. Entries mirror the CLI's (`builtin: true` loads them as
 * `builtin:<name>`, honouring `-builtin:<name>` and `noExtensions`; `replaceable`
 * lets a third-party MCP extension take over). The CLI's llama.cpp entry is not
 * exported, so it is left out. Shared across spawns like the CLI's list: each
 * factory keeps its state per `(pi) => …` call, not per factory.
 */
export const PI_BUILTIN_EXTENSIONS: InlineExtension[] = [
  { name: "codemode", factory: createCodemodeExtension(), replaceable: true, builtin: true },
  { name: "tool-search", factory: createToolSearchExtension(), replaceable: true, builtin: true },
  { name: "mcp", factory: createMcpExtension(), replaceable: true, builtin: true },
];

/**
 * A tool event in the subagent, or a one-shot agent-file diagnostic.
 *
 * `warning` is not a tool event: it carries a single misconfiguration message
 * in `toolName` (a `model-error:`/`tools-error:`/`extension-error:` prefix)
 * and must never be counted as a tool use.
 */
export interface ToolActivity {
  type: "start" | "end" | "warning";
  toolName: string;
  /**
   * pi's per-call id, pairing a start with its end. Absent on `warning` and on
   * synthetic callers that predate it — the tracker then matches ends by tool
   * name instead.
   */
  toolCallId?: string;
  /** The call's arguments as sent (`start` only). Feeds the activity subtext's arg hints. */
  args?: unknown;
}

export interface RunOptions {
  /** ExtensionAPI instance — used for pi.exec() instead of execSync. */
  pi: ExtensionAPI;
  /** Manager-assigned id; suffixes session name to disambiguate parallel spawns (e.g. `Explore#a1b2c3d4`). */
  agentId?: string;
  model?: Model<any>;
  maxTurns?: number;
  signal?: AbortSignal;
  /** Applies only when the agent file leaves `isolated:` unset — frontmatter is authoritative. */
  isolated?: boolean;
  inheritContext?: boolean;
  thinkingLevel?: ThinkingLevel;
  /**
   * Reopen this pi session file rather than starting an empty conversation.
   * `createAgentSession` seeds itself from whatever its SessionManager holds,
   * so pointing it at an existing file rehydrates that agent's history and the
   * prompt continues it. Everything else — tools, model, system prompt, turn
   * caps — is still resolved from the agent type, so the continuation runs
   * under the type's *current* definition, not the one the original run used.
   */
  resumeSessionFile?: string;
  /**
   * True when another agent spawned this one. Only top-level agents get a
   * handle, so only they can be reopened by name — which is the whole reason
   * `rememberAgents` persists a session at all. A nested run's transcript would
   * be unreachable by anything, so it stays in memory unless its own
   * frontmatter asks otherwise.
   */
  nested?: boolean;
  /**
   * True when a workflow run spawned this agent. Its final text is the value
   * `agent()` resolves to rather than a report a person reads, and the prompt
   * says so — but only when `structuredOutput` is unset, since that child
   * already has a `StructuredOutput` tool to answer through and two competing
   * "this is how you return your answer" instructions is worse than one.
   */
  workflow?: boolean;
  /** Override working directory (e.g. for worktree isolation). */
  cwd?: string;
  /**
   * Directory the worktree copy was created from. Set only when `cwd` points
   * into a worktree — the prompt then tells the agent to stay in the copy
   * instead of following the inherited parent prompt back to the main tree.
   */
  worktreeBase?: string;
  /**
   * Where .pi config is discovered (project extensions, skills, pi settings,
   * agent memory). Default: same as the working directory. The manager sets
   * this to the parent session's cwd when `SpawnOptions.cwd` points the
   * working directory elsewhere — the agent works *there* but carries the
   * parent project's config (the target's `.pi` extensions never execute).
   *
   * WARNING for future callers: if you pass `cwd` pointing at a directory the
   * user didn't open, you almost certainly must pass `configCwd` too —
   * omitting it makes the target's `.pi` extensions execute in this process.
   * (Worktree isolation is the one intentional exception: its copy IS the
   * parent's repo, so config resolving inside it is correct.)
   */
  configCwd?: string;
  /** Called on tool start/end with activity info. */
  onToolActivity?: (activity: ToolActivity) => void;
  /** Called on streaming text deltas from the assistant response. */
  onTextDelta?: (delta: string, fullText: string) => void;
  onSessionCreated?: (session: AgentSession) => void;
  /** Called at the end of each agentic turn with the cumulative count. */
  onTurnEnd?: (turnCount: number) => void;
  /**
   * Called once per assistant message_end with that message's usage delta.
   * Lets callers maintain a lifetime accumulator that survives compaction
   * (which replaces session.state.messages and resets stats-derived sums).
   *
   * `cost` is pi's own `usage.cost.total` for that message — priced from the
   * model's rates, so it is 0 (not missing) for a model pi has no pricing for.
   * We never price anything ourselves; every dollar figure this extension shows
   * or reports traces back to this field.
   */
  onAssistantUsage?: (usage: LifetimeUsage) => void;
  /**
   * Called when the session successfully compacts. `tokensBefore` is upstream's
   * pre-compaction context size estimate. Aborted compactions don't fire.
   */
  onCompaction?: (info: { reason: "manual" | "threshold" | "overflow"; tokensBefore: number }) => void;
  /**
   * Make this child report through a `StructuredOutput` tool built from this
   * schema, and put the validated payload on {@link RunResult.structuredJson}.
   *
   * Already compiled by the caller, so a schema this runtime cannot validate
   * fails at the call that wrote it rather than inside the child.
   */
  structuredOutput?: CompiledSchema;
  /** Runtime bridge for opt-in child-safe nested delegation. */
  nestedRuntime?: {
    manager: NestedAgentManager;
    parentAgentId: string;
    depth: number;
    maxSubagentDepth?: number;
  };
}

export interface RunResult {
  responseText: string;
  session: AgentSession;
  /** True if the agent was hard-aborted (max_turns + grace exceeded). */
  aborted: boolean;
  /** True if the agent was steered to wrap up (hit soft turn limit) but finished in time. */
  steered: boolean;
  /**
   * A failure message for the run's FINAL assistant turn, when that turn failed:
   * a provider error (stopReason "error"), or a "length" stop that produced no
   * text (a silent max-token death). pi resolves an exhausted-retries failure
   * normally instead of rejecting, so without this the manager would report such
   * a run as completed — with an empty result, or worse, an earlier turn's text
   * presented as the answer (#144). Undefined for a clean stop, or a "length"
   * stop that produced text (a legitimate truncated answer).
   */
  failure?: string;
  /**
   * The validated `StructuredOutput` payload as canonical JSON, when the caller
   * asked for a schema and the child produced one.
   *
   * Deliberately not folded into {@link responseText}: `record.result` picks up
   * a worktree branch note on the way out, which would leave the caller with
   * unparseable JSON, and merging the two would make "produced structured
   * output" indistinguishable from "happened to answer in JSON".
   */
  structuredJson?: string;
  /** Whether the extra structured-output prompt had to be sent. */
  structuredRetried?: boolean;
}

import type { BareToolExecutor } from "../session-continue.js";

/**
 * Options for {@link resumeAgent}. The event callbacks are the same per-run
 * wiring the spawn path uses; `execute` is a `continueSessionBare` passthrough.
 * The turn limit is resolved as `runAgent` resolves it — an explicit `maxTurns`,
 * else the agent type's own `max_turns`, else the project default — and counted
 * afresh from the resume, bare continuation included (#368).
 */
export interface ResumeAgentOptions {
  /** The agent's type, for its own `max_turns`. Always known: the manager passes `record.type`. */
  type: SubagentType;
  /** Explicit turn limit for the resumed run, counted afresh from the resume (#368). */
  maxTurns?: number;
  /** Called at the end of each resumed turn with the count since the resume. */
  onTurnEnd?: (turnCount: number) => void;
  onToolActivity?: (activity: ToolActivity) => void;
  onTextDelta?: (delta: string, fullText: string) => void;
  onAssistantUsage?: (usage: LifetimeUsage) => void;
  onCompaction?: (info: { reason: "manual" | "threshold" | "overflow"; tokensBefore: number }) => void;
  signal?: AbortSignal;
  /** Override tool execution for the bare continuation (healing/seam injection). */
  execute?: BareToolExecutor;
}
