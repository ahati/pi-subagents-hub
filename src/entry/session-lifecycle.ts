import {
  type ExtensionAPI,
  type ExtensionContext,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { isKeyRelease, matchesKey } from "@earendil-works/pi-tui";
import type { AgentManager } from "../agent-manager.js";
import type { ParkGateController } from "../commands/pause-state.js";
import type { CompletionOutbox } from "../completion-outbox.js";
import { type RpcHandle, registerRpcHandlers } from "../cross-extension-rpc.js";
import type { GroupJoinManager } from "../group-join.js";
import { invalidatePackageCache, setProjectTrusted } from "../package-resources.js";
import {
  PauseStore,
  pauseStoreDir,
  resolvePauseManifestPath,
  sweepOrphanPauseManifests,
} from "../pause-store.js";
import type { SubagentScheduler } from "../schedule.js";
import { resolveStorePath, ScheduleStore } from "../schedule-store.js";
import type { AgentRecord } from "../types.js";
import type { AgentWidget, UICtx } from "../ui/agent-widget.js";
import type { ViewerBackgroundAction } from "../ui/conversation-viewer.js";
import type { FleetList, FleetUICtx } from "../ui/fleet-list.js";
import type { WorkflowTask } from "../workflow/task.js";

const MANAGER_KEY = Symbol.for("pi-subagents:manager");

export interface LifecycleDeps {
  manager: AgentManager;
  park: ParkGateController;
  widget: AgentWidget;
  fleet: FleetList;
  groupJoin: GroupJoinManager;
  outbox: CompletionOutbox;
  scheduler: SubagentScheduler;
  foregroundHandoffs: Map<string, () => void>;
  workflowTasks: Map<string, WorkflowTask>;
  reloadCustomAgents: () => void;
  syncPauseManifest: (ctx: ExtensionContext) => void;
  pauseAgentRecord: (rec: AgentRecord) => string | undefined;
  resumeAgentById: (ctx: ExtensionContext, rec: AgentRecord, prompt?: string) => Promise<boolean>;
  resolveAgentRef: (ref: string) => AgentRecord | undefined;
  isSchedulingEnabled: () => boolean;
  isWorkflowsEnabled: () => boolean;
  resolveWorkflowCollisions: (ctx: ExtensionContext) => void;
  runWorkflowFlag: (ctx: ExtensionContext) => void;
  registerMentionProvider: (ctx: ExtensionContext) => void;
  spawnTopLevel: (piRef: any, ctxRef: any, type: string, prompt: string, options: any) => string;
  ownsManagerRegistry: boolean;
  registryEntry: any;
  registerTurnGroup: () => void;
  getCurrentCtx: () => ExtensionContext | undefined;
  setCurrentCtx: (ctx: ExtensionContext | undefined) => void;
}

export function createHandoffWatcher(
  pi: ExtensionAPI,
  manager: AgentManager,
  foregroundHandoffs: Map<string, () => void>,
  widget: AgentWidget,
  fleetArg: FleetList | (() => FleetList),
) {
  const getFleet = () => (typeof fleetArg === "function" ? fleetArg() : fleetArg);
  let handoffKeyUi: ExtensionContext["ui"] | undefined;
  let unsubHandoffKey: (() => void) | undefined;

  function sendForegroundToBackground(ids: Iterable<string>): number {
    let sent = 0;
    for (const id of [...ids]) {
      const wake = foregroundHandoffs.get(id);
      if (!wake || !manager.sendToBackground(id)) continue;
      foregroundHandoffs.delete(id);
      wake();
      sent++;
      const record = manager.getRecord(id);
      if (record) {
        pi.events.emit("subagents:created", {
          id,
          type: record.type,
          description: record.description,
          isBackground: true,
        });
      }
    }
    if (sent > 0) {
      widget.ensureTimer();
      widget.update();
      getFleet().ensureTimer();
      getFleet().update();
    }
    return sent;
  }

  function backgroundActionFor(record: AgentRecord, notify: (message: string) => void): ViewerBackgroundAction {
    return {
      available: () => foregroundHandoffs.has(record.id),
      send: () => {
        if (sendForegroundToBackground([record.id]) > 0) notify(`Sent "${record.description}" to the background.`);
      },
    };
  }

  function watchHandoffKey(ui: ExtensionContext["ui"]): void {
    if (ui === handoffKeyUi) return;
    unsubHandoffKey?.();
    handoffKeyUi = ui;
    unsubHandoffKey = ui.onTerminalInput(data => {
      if (isKeyRelease(data) || foregroundHandoffs.size === 0 || !matchesKey(data, "ctrl+b")) return undefined;
      if (!getFleet().editorHasFocus()) return undefined;
      const sent = sendForegroundToBackground(foregroundHandoffs.keys());
      if (sent > 0) ui.notify(`Sent ${sent === 1 ? "1 agent" : `${sent} agents`} to the background.`, "info");
      return { consume: true };
    });
  }

  function dispose(): void {
    unsubHandoffKey?.();
    unsubHandoffKey = undefined;
    handoffKeyUi = undefined;
  }

  return { watchHandoffKey, backgroundActionFor, dispose };
}

export function registerSessionLifecycle(
  pi: ExtensionAPI,
  deps: LifecycleDeps,
  handoff: { watchHandoffKey: (ui: ExtensionContext["ui"]) => void; dispose: () => void },
) {
  const {
    manager,
    park,
    widget,
    fleet,
    groupJoin,
    outbox,
    scheduler,
    workflowTasks,
    reloadCustomAgents,
    syncPauseManifest,
    pauseAgentRecord,
    resumeAgentById,
    resolveAgentRef,
    isSchedulingEnabled,
    resolveWorkflowCollisions,
    runWorkflowFlag,
    registerMentionProvider,
    spawnTopLevel,
    ownsManagerRegistry,
    registryEntry,
    registerTurnGroup,
    getCurrentCtx,
    setCurrentCtx,
  } = deps;

  let rpcHandle: RpcHandle | undefined;

  function startScheduler(ctx: ExtensionContext) {
    try {
      const sessionId = ctx.sessionManager?.getSessionId?.();
      if (!sessionId) return;
      const path = resolveStorePath(ctx.cwd, sessionId);
      const store = new ScheduleStore(path);
      scheduler.start(pi, ctx, manager, store);
      pi.events.emit("subagents:scheduler_ready", { sessionId, jobCount: store.list().length });
    } catch (err) {
      console.warn("[pi-subagents-hub] Failed to start scheduler:", err);
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    setCurrentCtx(ctx);
    park.resetOnSessionStart();
    setProjectTrusted(ctx.isProjectTrusted?.() === true);
    invalidatePackageCache();
    reloadCustomAgents();
    if (ctx.hasUI) {
      widget.setUICtx(ctx.ui);
      fleet.setUICtx(ctx.ui as any);
      handoff.watchHandoffKey(ctx.ui);
    }
    manager.clearCompleted(true);
    if (!rpcHandle) {
      rpcHandle = registerRpcHandlers({
        events: pi.events,
        pi,
        getCtx: getCurrentCtx,
        manager: {
          spawn: spawnTopLevel,
          awaitStartup: (id) => manager.awaitStartup(id),
          getRecord: (id) => manager.getRecord(id),
          abort: (id) => manager.abort(id),
          pauseAgent: (id) => {
            const record = manager.getRecord(id);
            return record !== undefined && pauseAgentRecord(record) === undefined;
          },
          resumeAgent: (id, prompt) => {
            const record = manager.getRecord(id);
            const activeCtx = getCurrentCtx();
            if (!record || !activeCtx) return Promise.resolve(false);
            return resumeAgentById(activeCtx, record, prompt);
          },
          consumeResult: (id) => {
            const record = resolveAgentRef(id);
            if (!record || record.parentAgentId) return false;
            if (record.status === "running" || record.status === "queued") return false;
            record.resultConsumed = true;
            outbox.cancel(record.id);
            return true;
          },
          steer: (id, message) => manager.steer(id, message),
        },
      });
      pi.events.emit("subagents:ready", {});
    }
    if (isSchedulingEnabled() && !scheduler.isActive()) startScheduler(ctx);

    try {
      const sid = ctx.sessionManager?.getSessionId?.();
      if (sid) {
        const sessionDir = ctx.sessionManager?.getSessionDir?.();
        if (sessionDir) {
          sweepOrphanPauseManifests(pauseStoreDir(ctx.cwd), id =>
            id === sid || SessionManager.findById(ctx.cwd, id, sessionDir) !== undefined);
        }
        const store = new PauseStore(resolvePauseManifestPath(ctx.cwd, sid));
        const parked = store.list();
        const workflows = store.listWorkflows();
        const mainTurn = store.getMainTurn();
        const hint: string[] = [];
        if (parked.length > 0) {
          hint.push(`${parked.length} subagent${parked.length === 1 ? "" : "s"} paused here`);
        }
        if (workflows.length > 0) {
          hint.push(`${workflows.length} workflow run${workflows.length === 1 ? "" : "s"} paused here`);
        }
        const respawnCount = parked.filter(e => e.respawn !== undefined).length;
        if (respawnCount > 0) hint.push(`${respawnCount} to re-run from scratch`);
        if (mainTurn?.parked) {
          hint.push(`the main turn is parked (${mainTurn.pendingTools} pending tool call${mainTurn.pendingTools === 1 ? "" : "s"})`);
        }
        if (hint.length > 0) ctx.ui.notify(`${hint.join(" — ")} — /continue to resume.`, "info");
      }
    } catch {
      // hint only
    }

    registerMentionProvider(ctx);
    resolveWorkflowCollisions(ctx);
    runWorkflowFlag(ctx);
  });

  pi.on("session_before_switch", () => {
    manager.clearCompleted(true);
    scheduler.stop();
  });

  pi.on("session_shutdown", async (event, shutdownCtx) => {
    if (event?.reason === "resume" && park.mainTurnSwitchInProgress) {
      park.mainTurnSwitchInProgress = false;
      if (ownsManagerRegistry && (globalThis as any)[MANAGER_KEY] === registryEntry) {
        delete (globalThis as any)[MANAGER_KEY];
      }
      return;
    }
    rpcHandle?.unsubSpawn();
    rpcHandle?.unsubStop();
    rpcHandle?.unsubPause();
    rpcHandle?.unsubResume();
    rpcHandle?.unsubPing();
    rpcHandle?.unsubConsume();
    rpcHandle?.unsubSteer();
    rpcHandle = undefined;
    setCurrentCtx(undefined);
    if (ownsManagerRegistry && (globalThis as any)[MANAGER_KEY] === registryEntry) {
      delete (globalThis as any)[MANAGER_KEY];
    }
    scheduler.stop();
    for (const task of workflowTasks.values()) task.abortController.abort();
    workflowTasks.clear();

    if (park.armedPause) {
      park.armedPause = false;
      try {
        await park.landPark(shutdownCtx, 0, manager, syncPauseManifest, pauseAgentRecord);
        const store = park.pauseStoreFor(shutdownCtx);
        const parked = store.getMainTurn();
        if (parked) store.setMainTurn({ ...parked, claim: { pid: -1, at: new Date().toISOString() } });
      } catch {
        // best-effort
      }
    }
    manager.abortAll();
    groupJoin.dispose();
    widget.dispose();
    outbox.dispose();
    fleet.dispose();
    handoff.dispose();

    await manager.dispose(pi);
    try {
      pi.events.emit("subagents:disposed", {});
    } catch {
      // stale runtime
    }
  });

  pi.on("tool_execution_start", async (_event, ctx) => {
    widget.setUICtx(ctx.ui as UICtx);
    fleet.setUICtx(ctx.ui as unknown as FleetUICtx);
    handoff.watchHandoffKey(ctx.ui);
    widget.onTurnStart();
  });

  pi.on("turn_end", (event) => {
    registerTurnGroup();
    outbox.onTurnEnd(event.message.role === "assistant" ? event.message.stopReason : undefined);
  });
  pi.on("agent_end", () => outbox.onAgentEnd());
  pi.on("agent_settled", () => outbox.onAgentEnd());

  pi.on("tool_call", async (_event, ctx) => {
    if (park.armedPause) await park.landPark(ctx, 1, manager, syncPauseManifest, pauseAgentRecord);
    if (park.parkedMain) await park.holdMainTurnGate(ctx.signal);
    return undefined;
  });
  pi.on("turn_end", async (event, ctx) => {
    if (park.armedPause) await park.landPark(ctx, event.toolResults.length, manager, syncPauseManifest, pauseAgentRecord);
    if (park.parkedMain && (event.toolResults.length > 0 || ctx.hasPendingMessages())) ctx.abort();
    return undefined;
  });
}
