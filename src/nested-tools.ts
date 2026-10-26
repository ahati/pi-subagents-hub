import type { Model } from "@earendil-works/pi-ai";
import {
  type AgentSession,
  defineTool,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { abortable } from "./abortable.js";
import {
  buildAgentRegistry,
  getAgentConfigIn,
  getAvailableTypesIn,
  resolveEnabledTypeIn,
  resolveTypeIn,
} from "./agent-types.js";
import { loadCustomAgents } from "./custom-agents.js";
import { isolationParam, resolveAgentInvocationConfig } from "./invocation-config.js";
import { resolveModel } from "./model-resolver.js";
import { checkModelScope } from "./model-scope.js";
import {
  createOutputFilePath,
  getOutputTranscriptDefault,
  streamToOutputFile,
  writeInitialEntry,
} from "./output-file.js";
import { formatAnswerSteer, formatQuestionCard, getForegroundOutcomeNote, getStatusNote, openQuestionsFooter, partialOutputSuffix } from "./status-note.js";
import type {
  AgentConfig,
  AgentInvocation,
  AgentQuestion,
  AgentRecord,
  IsolationMode,
  ThinkingLevel,
} from "./types.js";
import { addUsage } from "./usage.js";
import { isWorktreeIsolationEnabled } from "./worktree.js";

/**
 * Hard ceiling on nesting for every branch: main session = 0, its subagents = 1,
 * their children = 2. `0`/`1` disables nesting entirely. Set from
 * `subagents.json` (`maxSubagentDepth`). Read when a subagent session is built,
 * so a change applies to sessions started after it.
 */
let maxSubagentDepth = 2;

export function getMaxSubagentDepth(): number { return maxSubagentDepth; }
export function setMaxSubagentDepth(n: number): void { maxSubagentDepth = Math.max(0, Math.floor(n)); }

const NESTED_TOOL_NAMES = ["Agent", "get_subagent_result", "steer_subagent", "ask_parent", "answer_subagent"] as const;

interface NestedSpawnOptions {
  description: string;
  model?: Model<any>;
  maxTurns?: number;
  isolated?: boolean;
  inheritContext?: boolean;
  thinkingLevel?: ThinkingLevel;
  isBackground?: boolean;
  isolation?: IsolationMode;
  invocation?: AgentInvocation;
  signal?: AbortSignal;
  onAssistantUsage?: (usage: { input: number; output: number; cacheWrite: number }) => void;
  onSessionCreated?: (session: AgentSession) => void;
  depth: number;
  parentAgentId: string;
  maxSubagentDepth: number;
  configCwd?: string;
  rootSessionId?: string;
}

export interface NestedAgentManager {
  spawn(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    type: string,
    prompt: string,
    options: NestedSpawnOptions,
  ): string;
  /** Resolves once the spawned agent is running; rejects on a startup failure. */
  awaitStartup(id: string): Promise<void>;
  spawnAndWait(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    type: string,
    prompt: string,
    options: Omit<NestedSpawnOptions, "isBackground">,
    /** Fires synchronously after spawn, before the session exists — where the transcript is attached. */
    onSpawned?: (id: string) => void,
  ): Promise<{ id: string; record: AgentRecord }>;
  getRecord(id: string): AgentRecord | undefined;
  resume(id: string, prompt: string, signal?: AbortSignal, options?: { maxTurns?: number }): Promise<AgentRecord | undefined>;
}

export interface NestedToolContext {
  manager: NestedAgentManager;
  pi: ExtensionAPI;
  parentAgentId: string;
  depth: number;
  maxSubagentDepth: number;
  /** "all" = any enabled agent; string[] = only those types. Never empty. */
  allowedSubagents: "all" | string[];
  /** Root used for agent/config discovery; may differ from the agent's working directory. */
  configCwd: string;
}

function textResult(text: string, isError = false) {
  return { content: [{ type: "text" as const, text }], isError, details: {} };
}

function ownsRecord(record: AgentRecord | undefined, parentAgentId: string): record is AgentRecord {
  return record?.parentAgentId === parentAgentId;
}

/**
 * Who can actually answer this child's question, computed rather than assumed:
 * the nearest ancestor whose run is live AND whose own caller is not blocked in
 * a `spawnAndWait` — a blocked ancestor takes its next turn only after this
 * child settles, so addressing it would promise a mid-run answer that cannot
 * happen (upstream #410's core defect). The chain ends at a top-level agent
 * (`parentAgentId === undefined`), whose owner is the main session.
 *
 * `chainBlocked` on the root result says whether the main session can only
 * take its turn after this run settles — because the chain climbed through
 * blocked owners, or because this child is itself a foreground run the root
 * is blocked on. The tool text must not promise a mid-run answer then.
 */
function resolveAnswerer(manager: NestedAgentManager, child: AgentRecord): { kind: "agent"; record: AgentRecord } | { kind: "root"; chainBlocked: boolean } {
  const seen = new Set<string>();
  let climbedBlocked = false;
  for (let id = child.parentAgentId; id !== undefined && !seen.has(id); ) {
    seen.add(id);
    const owner = manager.getRecord(id);
    if (!owner) break;
    if (owner.status === "running" && !owner.blocking) return { kind: "agent", record: owner };
    climbedBlocked = true;
    id = owner.parentAgentId;
  }
  return { kind: "root", chainBlocked: climbedBlocked || child.blocking === true };
}

/**
 * How the caller received this record, which decides the outcome wording.
 *
 *   - "inline": a foreground spawn or a resume. The full output is in this very
 *     result and no agent id was handed back, so the note must say there is
 *     nothing left to fetch — otherwise the parent invents an id, calls
 *     `get_subagent_result`, and hits "not owned by this parent" (#174, the same
 *     trap the top-level foreground path fell into).
 *   - "fetched": `get_subagent_result` on a background child. The parent holds a
 *     valid id and can poll again, so the background wording applies.
 */
type ResultPosition = "inline" | "fetched";

function formatRecord(record: AgentRecord, position: ResultPosition): string {
  if (record.status === "error") {
    return `Agent failed: ${record.error ?? "unknown error"}${partialOutputSuffix(record)}`;
  }
  if (record.status === "queued" || record.status === "running") {
    return `Agent ${record.id} is ${record.status}.`;
  }
  // A truncated run must not read as a finished one. The top-level path carries
  // this in its result headline; a nested result has no headline, so the note
  // leads — appended, it would look like part of the child's own output.
  const text = record.result?.trim() || record.error?.trim() || "No output.";
  const note = position === "inline"
    ? getForegroundOutcomeNote(record.status)
    : getStatusNote(record.status);
  const noted = note ? `Nested agent${note}.\n\n${text}` : text;
  // Unanswered questions ride the result as a footer — the safety net when no
  // answerer reached the child mid-run. Formatted at read time, never merged
  // into record.result (same reason structuredJson is kept separate).
  const footer = openQuestionsFooter(record);
  return footer ? `${noted}\n\n${footer}` : noted;
}

/** Build child-safe orchestration tools scoped to one parent agent instance. */
export function createNestedSubagentTools(context: NestedToolContext): ToolDefinition[] {
  // Agents resolve from a registry built for THIS branch's config root (under
  // worktree isolation, the copy). Never via registerAgents — that is
  // process-global state shared with the main session and every other agent.
  const loadRegistry = () => buildAgentRegistry(loadCustomAgents(context.configCwd));
  const allowedTypesIn = (registry: Map<string, AgentConfig>): Set<string> | undefined =>
    context.allowedSubagents === "all"
      ? undefined
      : new Set(context.allowedSubagents.map(name => resolveTypeIn(registry, name) ?? name));
  const availableIn = (registry: Map<string, AgentConfig>): string[] => {
    const allowed = allowedTypesIn(registry);
    return getAvailableTypesIn(registry).filter(name => allowed === undefined || allowed.has(name));
  };

  const agentTool = defineTool({
    name: NESTED_TOOL_NAMES[0],
    label: "Agent",
    description:
      "Launch a child-safe nested subagent for bounded delegated work. " +
      "Only use agent types allowed by this parent agent; nesting is depth-limited.",
    parameters: Type.Object({
      prompt: Type.String({ description: "Self-contained task for the nested agent." }),
      description: Type.String({ description: "Short 3-5 word task description." }),
      subagent_type: Type.String({ description: `Allowed nested agent type. Available: ${availableIn(loadRegistry()).join(", ") || "none"}.` }),
      model: Type.Optional(Type.String({ description: "Optional provider/model override." })),
      thinking: Type.Optional(Type.String({ description: "Optional thinking level." })),
      max_turns: Type.Optional(Type.Number({ minimum: 1 })),
      run_in_background: Type.Optional(
        Type.Boolean({
          description: "Defaults to false for nested spawns — the call blocks and returns the child's result inline. Set true only for work you will collect later with get_subagent_result; a detached child is stopped when you finish.",
        }),
      ),
      resume: Type.Optional(Type.String({ description: "Resume a nested agent owned by this parent." })),
      isolated: Type.Optional(Type.Boolean()),
      inherit_context: Type.Optional(Type.Boolean()),
      ...isolationParam(isWorktreeIsolationEnabled()),
    }),
    execute: async (_toolCallId, params, signal, _onUpdate, ctx) => {
      if (params.resume) {
        const existing = context.manager.getRecord(params.resume);
        if (!ownsRecord(existing, context.parentAgentId)) {
          return textResult(`Nested agent not found or not owned by this parent: "${params.resume}".`, true);
        }
        // Frontmatter authoritative, as on the spawn path; the manager falls
        // back to the limit the child was spawned with, then the default.
        const resumed = await context.manager.resume(params.resume, params.prompt, signal, {
          maxTurns: getAgentConfigIn(loadRegistry(), existing.type)?.maxTurns ?? params.max_turns,
        });
        return resumed
          ? textResult(formatRecord(resumed, "inline"), resumed.status === "error")
          : textResult(`Failed to resume nested agent "${params.resume}".`, true);
      }

      if (context.depth >= context.maxSubagentDepth) {
        return textResult(
          `Nested subagent call blocked (depth=${context.depth}, max=${context.maxSubagentDepth}). Complete the task directly.`,
          true,
        );
      }

      // Reloaded per call so new agent files are picked up without a restart.
      const registry = loadRegistry();
      const rawType = params.subagent_type;
      // Strict resolve, never the fallback policy: a project-level
      // `fallbackSubagent` must not hand a nested caller an agent its allowlist
      // never named. The list stays allowlist-filtered so a typo can't enumerate
      // agents this parent may not reach.
      const resolvedType = resolveEnabledTypeIn(registry, rawType);
      if (resolvedType === undefined) {
        return textResult(
          `Unknown or disabled nested agent type: "${rawType}". Allowed: ${availableIn(registry).join(", ") || "none"}.`,
          true,
        );
      }
      const allowed = allowedTypesIn(registry);
      if (allowed !== undefined && !allowed.has(resolvedType)) {
        return textResult(
          `Nested agent type "${resolvedType}" is not allowed for this parent. Allowed: ${[...allowed].join(", ")}.`,
          true,
        );
      }

      const config = getAgentConfigIn(registry, resolvedType);
      // Foreground regardless of `backgroundByDefault` — see the reasoning on
      // ResolveOptions. An explicit `true` here still opts in.
      const invocation = resolveAgentInvocationConfig(config, params, {
        worktreeAllowed: isWorktreeIsolationEnabled(),
        defaultRunInBackground: false,
      });
      let model = ctx.model;
      if (invocation.modelInput) {
        const resolvedModel = resolveModel(invocation.modelInput, ctx.modelRegistry);
        if (typeof resolvedModel === "string") {
          if (invocation.modelFromParams) return textResult(resolvedModel, true);
        } else {
          model = resolvedModel;
        }
      }

      // Same scopeModels policy as the top-level Agent tool — a nested spawn
      // must not escape the allowlist. A "warn" verdict proceeds silently:
      // child sessions have no UI surface to toast to.
      const scopeVerdict = checkModelScope({
        model,
        cwd: context.configCwd,
        modelRegistry: ctx.modelRegistry,
        callerSupplied: invocation.modelFromParams,
        agentLabel: config?.displayName ?? resolvedType,
        modelInput: invocation.modelInput,
      });
      if (scopeVerdict.kind === "error") return textResult(scopeVerdict.message, true);

      // The whole branch shares the root session's transcript directory; read it
      // off the owning parent rather than this child session's own id.
      const rootSessionId = context.manager.getRecord(context.parentAgentId)?.rootSessionId;
      const childDepth = context.depth + 1;
      const options: NestedSpawnOptions = {
        description: params.description,
        model,
        maxTurns: invocation.maxTurns,
        isolated: invocation.isolated,
        inheritContext: invocation.inheritContext,
        thinkingLevel: invocation.thinking,
        isolation: invocation.isolation,
        invocation: {
          thinking: invocation.thinking,
          maxTurns: invocation.maxTurns,
          isolated: invocation.isolated,
          inheritContext: invocation.inheritContext,
          runInBackground: invocation.runInBackground,
          isolation: invocation.isolation,
        },
        // Nested children are hidden from every reporting surface, so their spend
        // would otherwise be unattributable. Fold it into every ancestor's record:
        // the top-level one appears in lifecycle events, completion notifications,
        // and `/agents`, and those all read `lifetimeUsage`. The whole chain is
        // walked, not just the immediate parent — a spawn callback only fires for
        // that child's OWN turns, so stopping at one level would hide a
        // great-grandchild from the only record anyone can see. (The live
        // widget/fleet counters read their own per-agent activity tracker, which
        // still sees only the top-level agent's own turns.)
        onAssistantUsage: (usage) => {
          for (let id: string | undefined = context.parentAgentId; id !== undefined; ) {
            const ancestor = context.manager.getRecord(id);
            if (!ancestor) break;
            addUsage(ancestor.lifetimeUsage, usage);
            id = ancestor.parentAgentId;
          }
        },
        depth: childDepth,
        parentAgentId: context.parentAgentId,
        maxSubagentDepth: context.maxSubagentDepth,
        configCwd: context.configCwd,
        rootSessionId,
      };

      // Transcript wiring, same gate as the top-level path: the child's
      // `output_transcript` frontmatter wins, else the project default. Without
      // it a nested run leaves no artifact but the string it returned — the
      // parent's own transcript records the call and the answer, never the tool
      // calls in between, which is exactly what a misbehaving child needs to
      // explain itself. Filed under the ROOT session and this branch's config
      // root, so a nested transcript lands in the same `tasks/` directory as its
      // ancestors' rather than in a directory of its own.
      const transcriptSessionId =
        rootSessionId !== undefined && (config?.outputTranscript ?? getOutputTranscriptDefault())
          ? rootSessionId
          : undefined;
      let childId: string | undefined;
      const attachTranscript = (id: string): void => {
        childId = id;
        if (transcriptSessionId === undefined) return;
        const rec = context.manager.getRecord(id);
        if (!rec) return;
        rec.outputFile = createOutputFilePath(context.configCwd, id, transcriptSessionId);
        writeInitialEntry(rec.outputFile, id, params.prompt, ctx.cwd);
      };
      options.onSessionCreated = (session) => {
        const rec = childId === undefined ? undefined : context.manager.getRecord(childId);
        if (rec?.outputFile && childId !== undefined) {
          rec.outputCleanup = streamToOutputFile(session, rec.outputFile, childId, ctx.cwd);
        }
      };

      // `ctx` is forwarded to the manager unmodified, never captured at tool-build
      // time: each AgentSession builds its own ExtensionRunner from that session's
      // cwd/sessionManager/modelRegistry, so this is the CHILD's context. Capturing
      // one earlier would silently give a grandchild the wrong worktree base, the
      // wrong conversation under inherit_context, and the wrong inherited model.
      //
      // spawn() throws on strict worktree-isolation failure and cwd validation —
      // report it as a tool error, like the top-level Agent tool does, instead of
      // letting it escape into the child's turn.
      try {
        if (invocation.runInBackground) {
          const id = context.manager.spawn(context.pi, ctx, resolvedType, params.prompt, {
            ...options,
            isBackground: true,
          });
          // Synchronous, before the event loop yields — onSessionCreated fires
          // asynchronously inside runAgent, so the file is attached in time.
          attachTranscript(id);
          // Worktree isolation starts the agent asynchronously; surface its
          // failure as a tool error, like the synchronous throw used to.
          await context.manager.awaitStartup(id);
          return textResult(`Nested agent started in background. Agent ID: ${id}`);
        }

        const { record } = await context.manager.spawnAndWait(
          context.pi,
          ctx,
          resolvedType,
          params.prompt,
          { ...options, signal },
          attachTranscript,
        );
        return textResult(formatRecord(record, "inline"), record.status === "error");
      } catch (err) {
        return textResult(err instanceof Error ? err.message : String(err), true);
      }
    },
  });

  const resultTool = defineTool({
    name: NESTED_TOOL_NAMES[1],
    label: "Get Nested Agent Result",
    description: "Check or wait for a background nested agent owned by this parent.",
    parameters: Type.Object({
      agent_id: Type.String(),
      wait: Type.Optional(Type.Boolean()),
    }),
    execute: async (_toolCallId, params, signal) => {
      const record = context.manager.getRecord(params.agent_id);
      if (!ownsRecord(record, context.parentAgentId)) {
        return textResult(`Nested agent not found or not owned by this parent: "${params.agent_id}".`, true);
      }
      // Wait for completion if requested. Cancellation (e.g. the parent's tool
      // call is aborted) stops only this wait; the nested child keeps running and
      // stays unconsumed. Queued records have no promise until the manager starts
      // them, so poll — abortably — until they leave the queue, then await.
      if (params.wait && (record.status === "queued" || record.status === "running")) {
        while (record.status === "queued") {
          await abortable(new Promise<void>(resolve => setTimeout(resolve, 250)), signal);
        }
        if (record.promise) await abortable(record.promise, signal);
      }
      return textResult(formatRecord(record, "fetched"), record.status === "error");
    },
  });

  const steerTool = defineTool({
    name: NESTED_TOOL_NAMES[2],
    label: "Steer Nested Agent",
    description: "Send guidance to a running nested agent owned by this parent.",
    parameters: Type.Object({
      agent_id: Type.String(),
      message: Type.String(),
    }),
    execute: async (_toolCallId, params) => {
      const record = context.manager.getRecord(params.agent_id);
      if (!ownsRecord(record, context.parentAgentId) || record.status !== "running") {
        return textResult(`Running nested agent not found or not owned by this parent: "${params.agent_id}".`, true);
      }
      // Session not ready yet — queue the steer. The manager flushes pending
      // steers when the session is created (same contract as the top-level tool).
      if (!record.session) {
        if (!record.pendingSteers) record.pendingSteers = [];
        record.pendingSteers.push(params.message);
        return textResult(`Steering message queued for nested agent ${params.agent_id}.`);
      }
      try {
        await record.session.steer(params.message);
      } catch (err) {
        return textResult(`Failed to steer nested agent: ${err instanceof Error ? err.message : String(err)}`, true);
      }
      return textResult(`Steering message sent to nested agent ${params.agent_id}.`);
    },
  });

  return [agentTool, resultTool, steerTool, ...createAskAnswerTools({
    manager: context.manager,
    pi: context.pi,
    parentAgentId: context.parentAgentId,
  })];
}

/** Everything the ask/answer tools need — an owner and the bus, nothing else. */
export interface AskAnswerContext {
  manager: NestedAgentManager;
  pi: ExtensionAPI;
  /** This session's own record id — what its children carry as parentAgentId. */
  parentAgentId: string;
}

/**
 * ask_parent + answer_subagent, on their own. Asking needs an owner, never
 * delegation headroom, so this pair is injected into EVERY non-isolated
 * subagent at any depth — with or without an allowlist — while the delegation
 * tools above stay behind the allowedSubagents and depth-cap gates.
 */
export function createAskAnswerTools(context: AskAnswerContext): ToolDefinition[] {
  /**
   * The child asks its owner a question and, in mailbox mode, keeps working on
   * its stated assumption. Never blocks: a blocked child holds a concurrency
   * slot and an owner's attention; suspension (`block: true`) lands with the
   * pause-gate work and is refused for now.
   */
  const askTool = defineTool({
    name: NESTED_TOOL_NAMES[3],
    label: "Ask Parent",
    description:
      "Ask your parent agent for a decision or fact you cannot resolve yourself. " +
      "The question is delivered to your parent (or the main session) and you CONTINUE WORKING on your stated assumption; " +
      "the answer arrives later as a steering message. Ask at most one open question at a time — asking again supersedes the previous one.",
    parameters: Type.Object({
      question: Type.String({ description: "The specific decision or fact you need." }),
      context: Type.Optional(Type.String({ description: "What you tried and why you cannot resolve it yourself." })),
      assumption: Type.Optional(Type.String({ description: "What you will do if no answer arrives. State it so your parent can correct course cheaply." })),
      block: Type.Optional(Type.Boolean({ description: "Not supported yet — suspension is refused. Ask without it." })),
    }),
    execute: async (_toolCallId, params) => {
      // The suite is built per child session; `parentAgentId` in the context is
      // THIS session's own record id (its children carry it as their parent).
      const self = context.manager.getRecord(context.parentAgentId);
      if (!self) return textResult("Agent record not found; the question cannot be routed.", true);
      if (params.block) {
        return textResult("Suspension is not available yet — ask without block and continue on your stated assumption.", true);
      }

      const open = (self.questions ?? []).filter(q => q.state === "open" || q.state === "delivered");
      for (const q of open) q.state = "superseded";
      const q: AgentQuestion = {
        id: `q-${(self.questions?.length ?? 0) + 1}`,
        question: params.question,
        ...(params.context !== undefined ? { context: params.context } : {}),
        ...(params.assumption !== undefined ? { assumption: params.assumption } : {}),
        mode: "mailbox",
        state: "open",
        askedAt: Date.now(),
      };
      if (!self.questions) self.questions = [];
      self.questions.push(q);

      const card = formatQuestionCard(self, q);
      const answerer = resolveAnswerer(context.manager, self);
      if (answerer.kind === "agent") {
        const owner = answerer.record;
        // Mark delivered before the await: an owner that answers within the
        // steer's resolution window must not be clobbered back to delivered.
        q.state = "delivered";
        q.deliveredTo = owner.id;
        try {
          if (!owner.session) {
            owner.pendingSteers = [...(owner.pendingSteers ?? []), card];
          } else {
            await owner.session.steer(card);
          }
        } catch {
          // Undeliverable right now: the question stays on the record and the
          // result-time footer still surfaces it to whoever reads the result.
          q.state = "open";
          q.deliveredTo = undefined;
          return textResult(`Question ${q.id} recorded but could not be delivered mid-run; it will ride your result. Continue on your stated assumption.`);
        }
        const delivery = owner.blocking
          ? "your parent is mid-task, so the answer may only arrive at its next turn or with your result"
          : "the answer will reach you mid-run as a steering message";
        const superseded = open.length > 0 ? ` Supersedes ${open.map(x => x.id).join(", ")}.` : "";
        return textResult(`Question ${q.id} delivered to your parent agent (${owner.type} "${owner.description}").${superseded} Continue on your stated assumption — ${delivery}.`);
      }

      // Owner chain dead or fully blocked: the main session answers. Sent as a
      // steer that triggers a turn when idle; if the root turn is aborted the
      // message is lost, and the result-time footer remains the safety net.
      // Mark delivered before the send, same anti-clobber order as above.
      q.state = "delivered";
      q.deliveredTo = "root";
      try {
        context.pi.sendMessage(
          { customType: "subagent-question", content: card, display: true },
          { deliverAs: "steer", triggerTurn: true },
        );
      } catch {
        q.state = "open";
        q.deliveredTo = undefined;
        return textResult(`Question ${q.id} recorded but could not be delivered; it will ride your result. Continue on your stated assumption.`);
      }
      const rootDelivery = answerer.chainBlocked
        ? "the main session is waiting on this run, so expect the answer only with your result — finish cleanly"
        : "the answer will reach you as a steering message, or rides your result if the run ends first";
      return textResult(`Question ${q.id} delivered to the main session. Continue on your stated assumption — ${rootDelivery}.`);
    },
  });

  /** The owner answers one of its children's open questions. */
  const answerTool = defineTool({
    name: NESTED_TOOL_NAMES[4],
    label: "Answer Nested Agent",
    description: "Answer a question one of your nested agents asked via ask_parent. The answer is delivered to the (still running) agent as a steering message.",
    parameters: Type.Object({
      agent_id: Type.String({ description: "The asking agent's ID, from the question card." }),
      question_id: Type.Optional(Type.String({ description: "Defaults to the agent's oldest open question." })),
      answer: Type.String({ description: "The decision or fact the agent asked for." }),
    }),
    execute: async (_toolCallId, params) => {
      const record = context.manager.getRecord(params.agent_id);
      const qs = record?.questions ?? [];
      const q = params.question_id
        ? qs.find(x => x.id === params.question_id)
        : qs.find(x => x.state === "open" || x.state === "delivered") ?? qs[qs.length - 1];
      // The direct owner answers its own child's question — and so does any
      // session the card was routed to: resolveAnswerer skips blocked owners,
      // so the card may legitimately land on a grandparent rather than the
      // child's own `parentAgentId`.
      const routed = q !== undefined && q.deliveredTo === context.parentAgentId;
      if (!record || (!ownsRecord(record, context.parentAgentId) && !routed)) {
        return textResult(`Nested agent not found or not owned by this parent: "${params.agent_id}".`, true);
      }
      if (!q || (q.state !== "open" && q.state !== "delivered")) {
        const closed = !q ? ""
          : q.state === "superseded" ? ` — it was superseded by a later ask`
          : q.state === "dropped" ? ` — it was dropped when the run ended in failure or was aborted; it asked: "${q.question}"`
          : ` — its state is ${q.state}`;
        return textResult(`No open question${params.question_id ? ` "${params.question_id}"` : ""} on agent ${params.agent_id}${closed}.`, true);
      }
      if (record.status !== "running" && record.status !== "queued") {
        return textResult(`Agent ${params.agent_id} already finished (${record.status}); the question rode its result. Resume it with the answer instead.`, true);
      }
      const priorState = q.state;
      q.state = "answered";
      q.answer = params.answer;
      q.answeredBy = context.parentAgentId;
      const message = formatAnswerSteer(q);
      try {
        if (!record.session) {
          record.pendingSteers = [...(record.pendingSteers ?? []), message];
        } else {
          await record.session.steer(message);
        }
      } catch (err) {
        // Delivery failed: un-answer, so the question stays open for a retry
        // instead of silently vanishing behind a state the child never saw.
        q.state = priorState;
        q.answer = undefined;
        q.answeredBy = undefined;
        return textResult(`Failed to deliver the answer to agent ${params.agent_id}: ${err instanceof Error ? err.message : String(err)}`, true);
      }
      return textResult(`Answer to ${q.id} delivered to agent ${params.agent_id}.`);
    },
  });

  return [askTool, answerTool];
}
