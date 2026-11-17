/**
 * Cross-extension RPC handlers for the subagents extension.
 *
 * Exposes ping, spawn, stop, pause, resume, consume, and steer RPCs over the
 * pi.events event bus, using per-request scoped reply channels.
 *
 * Reply envelope follows pi-mono convention:
 *   success → { success: true, data?: T }
 *   error   → { success: false, error: string }
 *
 * @see docs/rpc.md — the caller-facing integration reference: spawn options
 * (including the fields spawnTopLevel strips), every error string, the
 * completion-notification race, and what the ping reply's `capabilities` does
 * not promise.
 */

import { isTopLevelAgent } from "./agent-manager.js";
import { type ModelRegistry, resolveModel } from "./model-resolver.js";
import { checkModelScope } from "./model-scope.js";
import { type SubagentInfo, toSubagentInfo } from "./subagent-info.js";
import type { AgentRecord } from "./types.js";
import type { WorkflowDetail, WorkflowInfo } from "./workflow-info.js";

/** Minimal event bus interface needed by the RPC handlers. */
export interface EventBus {
  on(event: string, handler: (data: unknown) => void): () => void;
  emit(event: string, data: unknown): void;
}

/** RPC reply envelope — matches pi-mono's RpcResponse shape. */
export type RpcReply<T = void> =
  | { success: true; data?: T }
  | { success: false; error: string };

/**
 * Request channel advertised in the `ping` reply. Each name `n` is exactly the
 * `<n>` of `subagents:rpc:<n>`; `ping` is excluded because that is the reply
 * you are reading. Deliberately no runtime list beside it — the set is derived
 * from the handlers `registerRpcHandlers` wires, not declared.
 */
export type RpcCapability =
  | "spawn" | "stop" | "pause" | "resume" | "consume" | "steer"
  | "get" | "list" | "workflow_get" | "workflow_list";

/**
 * RPC protocol version — bumped only when an existing envelope or method
 * contract breaks. Additive fields and new channels are advertised through the
 * ping reply's `capabilities` instead.
 */
export const PROTOCOL_VERSION = 2;

/**
 * How long `subagents:rpc:stop` waits for the stopped agent and the agents it
 * owns to settle before replying `{ settled: false }`. Below the 10 s pi-tasks
 * gives the stop reply, so a slow settle never reads to it as a failed stop.
 */
export const STOP_SETTLE_TIMEOUT_MS = 5_000;

/** The largest `settleTimeoutMs` a `subagents:rpc:stop` caller can ask for. */
export const STOP_SETTLE_TIMEOUT_MAX_MS = 60_000;

/**
 * What this build supports, on the `ping` reply.
 *
 * The envelope and spawn contract are still `PROTOCOL_VERSION` 2; these name the
 * additions a caller may need to detect. A missing `features` array means a
 * build older than all of them. Append only: a consumer checks
 * `features.includes(...)`. `capabilities` stays the channel inventory, derived
 * from the wired handlers.
 */
export const FEATURES = [
  "get", "list", "notification-pending",
  "workflow-events", "workflow-get", "workflow-list",
  "stop-settles", "settling",
] as const;

/** Minimal AgentManager interface needed by the spawn/stop/consume/pause/resume RPCs. */
export interface SpawnCapable {
  spawn(pi: unknown, ctx: unknown, type: string, prompt: string, options: any): string;
  /** Resolves once the spawned agent is running; rejects on a startup failure. */
  awaitStartup(id: string): Promise<void>;
  abort(id: string): boolean;
  /**
   * Resolves true once the agent's run and every owned descendant's run have
   * settled, false if `timeoutMs` passes first.
   */
  waitForSettled(id: string, timeoutMs: number): Promise<boolean>;
  /**
   * Whether the agent or an agent it owns is still running, whatever its status
   * says — a stopped agent whose tool call ignored the abort reads true until
   * that call ends.
   */
  isSettling(id: string): boolean;
  /**
   * Pause an active agent: interrupt its run (or dequeue it) while keeping the
   * record and session for a later resume. False when the agent cannot be
   * paused — still starting, worktree-isolated, foreground, already settled.
   */
  pauseAgent(id: string): boolean;
  /**
   * Continue a settled agent's session in the background, with the same
   * wiring a mention-resume gets. `prompt` is a continuation message for a
   * settled record and is ignored for a paused one, which always runs bare
   * from its transcript. False when there is nothing to continue — unknown
   * id, still running or queued, and no session to re-prompt.
   */
  resumeAgent(id: string, prompt?: string): Promise<boolean>;
  /**
   * The record behind an id, for the stop handler's ownership check and for
   * `get`. Narrowed to the two fields `isTopLevelAgent` reads — `get` builds its
   * snapshot from `listAgents`, which carries the whole record.
   */
  getRecord(id: string): Pick<AgentRecord, "parentAgentId" | "workflowId"> | undefined;
  /** Every record the manager holds, owned agents included, any status. */
  listAgents(): AgentRecord[];
  /**
   * Whether the agent has settled but the parent has not been sent its
   * completion notification yet — still held for the parent's next boundary
   * or for its `group`. A notification that will start a parent turn.
   */
  isNotificationPending(id: string): boolean;
  /**
   * Mark a settled agent's result as read by the caller, suppressing the
   * completion notification — what `get_subagent_result` does when it returns
   * one. False when there is no such agent, or it has not settled yet.
   */
  consumeResult(id: string): boolean;
  /**
   * Deliver a message to a running or queued agent's conversation — what
   * `steer_subagent` does. False when the agent is unknown or has settled.
   */
  steer(id: string, message: string): Promise<boolean>;
}

/** Read-only snapshots of workflow runs, for `workflow_get` / `workflow_list`. */
export interface WorkflowReader {
  /** One run's live detail (summary + per-agent snapshot), or undefined. */
  get(id: string): WorkflowDetail | undefined;
  /** Every current run, summary only. */
  list(): WorkflowInfo[];
}

export interface RpcDeps {
  events: EventBus;
  pi: unknown;                    // passed through to manager.spawn
  getCtx: () => unknown | undefined;  // returns current ExtensionContext
  manager: SpawnCapable;
  workflows: WorkflowReader;
}

export interface RpcHandle {
  unsubPing: () => void;
  unsubSpawn: () => void;
  unsubStop: () => void;
  unsubPause: () => void;
  unsubResume: () => void;
  unsubConsume: () => void;
  unsubSteer: () => void;
  unsubGet: () => void;
  unsubList: () => void;
  unsubWorkflowGet: () => void;
  unsubWorkflowList: () => void;
}

/**
 * Wire a single RPC handler: listen on `channel`, run `fn(params)`,
 * emit the reply envelope on `channel:reply:${requestId}`.
 */
function handleRpc<P extends { requestId: string }>(
  events: EventBus,
  channel: string,
  fn: (params: P) => unknown | Promise<unknown>,
): () => void {
  return events.on(channel, async (raw: unknown) => {
    const params = raw as P;
    try {
      const data = await fn(params);
      const reply: { success: true; data?: unknown } = { success: true };
      if (data !== undefined) reply.data = data;
      events.emit(`${channel}:reply:${params.requestId}`, reply);
    } catch (err: any) {
      events.emit(`${channel}:reply:${params.requestId}`, {
        success: false, error: err?.message ?? String(err),
      });
    }
  });
}

/**
 * Register ping, spawn, stop, pause, resume, consume, and steer RPC handlers on
 * the event bus. Returns unsub functions for cleanup.
 */
export function registerRpcHandlers(deps: RpcDeps): RpcHandle {
  const { events, pi, getCtx, manager, workflows } = deps;

  const capabilities: RpcCapability[] = [];

  // Every channel except ping goes through here, so a channel cannot be wired
  // without naming its capability and the ping reply cannot fall behind the
  // handlers again. The name is the channel suffix (`subagents:rpc:<name>`).
  const wire = <P extends { requestId: string }>(
    capability: RpcCapability,
    fn: (params: P) => unknown | Promise<unknown>,
  ): (() => void) => {
    capabilities.push(capability);
    return handleRpc<P>(events, `subagents:rpc:${capability}`, fn);
  };

  const unsubPing = handleRpc(events, "subagents:rpc:ping", () => {
    return {
      version: PROTOCOL_VERSION,
      // Copied: the bus is in-process, so a caller could otherwise mutate the
      // module-local list and change every later reply. All `wire` calls below
      // have run by the time a request can arrive — registration is synchronous
      // and nothing emits ping from inside it.
      capabilities: [...capabilities],
      features: [...FEATURES],
    };
  });

  const unsubSpawn = wire<{ requestId: string; type: string; prompt: string; options?: any }>(
    "spawn", async ({ type, prompt, options }) => {
      const ctx = getCtx();
      if (!ctx) throw new Error("No active session");

      // Cross-extension RPC callers (e.g. pi-tasks TaskExecute) naturally
      // forward serializable values, so options.model can be a string like
      // "openai-codex/gpt-5.5". Resolve it to a real Model instance here
      // — same pattern the scheduler path already uses — so the spawned
      // agent's auth lookup doesn't crash with "No API key found for
      // undefined".
      let normalizedOptions = options ?? {};
      // `!= null` on purpose: a JSON-forwarding caller can serialize an unset
      // field as null, and the runner reads `options.model ?? default`, so null
      // means "inherit" — not an override to resolve or scope-check.
      const override = normalizedOptions.model;
      if (override != null) {
        const { modelRegistry, cwd } = ctx as { modelRegistry?: ModelRegistry; cwd?: string };
        // Names the override the same way in both messages below; an object
        // override would otherwise interpolate as "[object Object]".
        const label = typeof override === "string" ? override : `${override.provider}/${override.id}`;
        if (!modelRegistry) {
          throw new Error(`Model override "${label}" provided but ctx.modelRegistry is unavailable`);
        }
        let model = override;
        if (typeof override === "string") {
          const resolved = resolveModel(override, modelRegistry);
          if (typeof resolved === "string") {
            // resolveModel returns a human-readable error string when the
            // input doesn't match any available model. Surface it instead of
            // silently falling back so the caller sees the auth/typo issue.
            throw new Error(resolved);
          }
          model = resolved;
          normalizedOptions = { ...normalizedOptions, model: resolved };
        }

        // A model on the RPC payload is an orchestrator-level choice, exactly
        // like Agent({ model }) — so it gets the Agent tool's hard error, never
        // the frontmatter warn (#240). The check reads the RESOLVED model:
        // resolveModel is fuzzy, so a bare "sonnet" can land on a provider the
        // caller never named. Frontmatter-pinned and parent-inherited models are
        // resolved later, in agent-runner, and keep warn-and-proceed.
        const verdict = checkModelScope({
          model,
          cwd: cwd ?? process.cwd(),
          modelRegistry,
          callerSupplied: true,
          agentLabel: type,
          modelInput: label,
        });
        if (verdict.kind === "error") throw new Error(verdict.message);
      }

      const id = manager.spawn(pi, ctx, type, prompt, normalizedOptions);
      // With isolation: "worktree" the agent starts asynchronously — wait for
      // it, so a strict-isolation failure is still an error envelope rather
      // than an id for an agent that never ran.
      await manager.awaitStartup(id);
      return { id };
    },
  );

  // Only the session's own agents are this RPC's to stop or steer. A nested
  // child or a workflow's agent is owned by something that is *waiting on it*,
  // and aborting or redirecting it out from under that owner turns another
  // extension's request into a failed step here. Defence in depth rather than
  // a live hole: no RPC hands out agent ids, so a caller has no ordinary way to
  // name one it does not own — but the guard is cheap and the id may leak some
  // other way. Same refuse-what-we-should-not-touch stance as `consume` below.
  const assertOwned = (agentId: string): void => {
    const record = manager.getRecord(agentId);
    if (!record) throw new Error("Agent not found");
    if (!isTopLevelAgent(record)) throw new Error("Agent is owned by another agent or workflow");
  };

  const unsubStop = wire<{ requestId: string; agentId: string; settleTimeoutMs?: unknown }>(
    "stop", async ({ agentId, settleTimeoutMs }) => {
      if (settleTimeoutMs !== undefined && (typeof settleTimeoutMs !== "number" || !Number.isFinite(settleTimeoutMs))) {
        throw new Error("settleTimeoutMs must be a number of milliseconds");
      }
      const timeoutMs = Math.min(Math.max(settleTimeoutMs ?? STOP_SETTLE_TIMEOUT_MS, 0), STOP_SETTLE_TIMEOUT_MAX_MS);
      assertOwned(agentId);
      // `abort` returns false for a record that is neither running nor queued.
      // If its tree is still settling, this is a repeat stop after
      // `settled: false`, and it waits again. Otherwise the agent has finished:
      // not "not found", since the lookup above proved it exists.
      if (!manager.abort(agentId) && !manager.isSettling(agentId)) throw new Error("Agent is not running");
      // Stop means stopped: the reply waits until no tool call of this agent or
      // of any agent it owns can still land (#443). A caller that does not care
      // need not await it. `settled: false` says the bound passed first and
      // something may still be running; `get` then shows `settling`.
      return { settled: await manager.waitForSettled(agentId, timeoutMs) };
    },
  );

  // Pause and resume mirror stop's shape: the ownership guard first, then the
  // capability, with the refusal surfaced as an error string rather than a
  // silent false — a bus caller has no UI to read a no-op from.
  const unsubPause = wire<{ requestId: string; agentId: string }>(
    "pause", ({ agentId }) => {
      assertOwned(agentId);
      if (!manager.pauseAgent(agentId)) throw new Error("Agent is not pausable");
    },
  );

  const unsubResume = wire<{ requestId: string; agentId: string; prompt?: string }>(
    "resume", async ({ agentId, prompt }) => {
      assertOwned(agentId);
      if (!await manager.resumeAgent(agentId, prompt)) throw new Error("Agent cannot be resumed");
    },
  );

  // A caller that has already shown the model an agent's result — pi-tasks'
  // TaskOutput is the one in practice — says so here, so the completion
  // notification for that same result is not delivered on top of it and does
  // not cost the parent a turn. Outside the *version* handshake — an extension
  // built against protocol v2 simply never calls it — but advertised in the
  // ping reply's `capabilities`, so a caller can gate on it instead of waiting
  // out a timeout.
  const unsubConsume = wire<{ requestId: string; agentId: string }>(
    "consume", ({ agentId }) => {
      if (!manager.consumeResult(agentId)) throw new Error("Agent not found or still running");
    },
  );

  // An extension that spawned an agent over the bus and then learns something
  // that agent needs — a second CI failure on the head it is already fixing, a
  // review that landed mid-run — can hand it over instead of spawning a second
  // agent for the same work or dropping the fact. Outside the *version*
  // handshake, like consume: additive and best-effort — but advertised in
  // `capabilities`, so a caller can tell whether it exists at all.
  const unsubSteer = wire<{ requestId: string; agentId: string; message: unknown }>(
    "steer", async ({ agentId, message }) => {
      if (typeof message !== "string" || message.trim().length === 0) throw new Error("Steer message must be a non-empty string");
      assertOwned(agentId);
      if (!await manager.steer(agentId, message)) throw new Error("Agent is not running");
    },
  );

  // Snapshots, for a listener that joined after the lifecycle events it needed
  // had already fired — bound late, or reloaded mid-run. Reads only, so owned
  // agents are included: they carry `parentAgentId` / `workflowId` exactly as
  // on the events, and the caller filters. `assertOwned` guards only mutations.
  //
  // Snapshots also say what the events cannot: `notificationPending`, set while
  // a settled agent's completion is still on its way to the parent. An
  // orchestrator that waits for "nothing active" must wait for it too, or the
  // notification starts a parent turn right after it concluded none would
  // (#103). Not on the events: `completed` fires before the notification is
  // queued, so there it would always read false.
  const snapshot = (record: AgentRecord) => {
    const terminal = record.status !== "running" && record.status !== "queued";
    return {
      ...toSubagentInfo(record),
      // Only meaningful on a terminal record: while it runs, its status says so.
      ...(terminal && manager.isSettling(record.id) ? { settling: true } : {}),
      ...(manager.isNotificationPending(record.id) ? { notificationPending: true } : {}),
    };
  };

  const unsubGet = wire<{ requestId: string; agentId: string }>(
    "get", ({ agentId }) => {
      const record = manager.listAgents().find(candidate => candidate.id === agentId);
      if (!record) throw new Error("Agent not found");
      return { agent: snapshot(record) };
    },
  );

  const unsubList = wire(
    "list", () => ({ agents: manager.listAgents().map(record => snapshot(record)) }),
  );

  // Workflow-run snapshots, for a consumer that missed `workflow_started` or
  // wants the live per-agent detail — pulled rather than pushed, at whatever
  // cadence the consumer wants. A run is top-level, so no ownership guard.
  // `get` carries the per-agent `agents` snapshot; `list` is summaries only.
  const unsubWorkflowGet = wire<{ requestId: string; workflowId: string }>(
    "workflow_get", ({ workflowId }) => {
      const workflow = workflows.get(workflowId);
      if (!workflow) throw new Error("Workflow not found");
      return { workflow };
    },
  );

  const unsubWorkflowList = wire("workflow_list", () => ({ workflows: workflows.list() }));

  return {
    unsubPing, unsubSpawn, unsubStop, unsubPause, unsubResume, unsubConsume, unsubSteer,
    unsubGet, unsubList, unsubWorkflowGet, unsubWorkflowList,
  };
}
