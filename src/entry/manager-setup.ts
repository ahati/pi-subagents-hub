import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AgentManager, isTopLevelAgent } from "../agent-manager.js";
import { AGENT_RECORD_ENTRY_TYPE, type AgentRecordEntryData, agentRecordEntryData } from "../agent-record-entry.js";
import { syncPauseManifest } from "../commands/pause-continue.js";
import type { ParkGateController } from "../commands/pause-state.js";
import type { CompletionOutbox } from "../completion-outbox.js";
import { GroupJoinManager } from "../group-join.js";
import { resolveJoinMode } from "../invocation-config.js";
import { gateOf } from "../manager/manager-types.js";
import { createOutputFilePath, ensureOutputFile, streamToOutputFile } from "../output-file.js";
import type { AgentRecord, JoinMode } from "../types.js";
import type { AgentActivity, AgentWidget } from "../ui/agent-widget.js";
import type { FleetList } from "../ui/fleet-list.js";
import { toSubagentInfo } from "../subagent-info.js";
import { getLifetimeTotal, type PendingUsagePool, toReportedUsage } from "../usage.js";
import { buildNotificationDetails, createActivityTracker, formatTaskNotification } from "./renderers.js";

export interface ManagerSetupDeps {
  pi: ExtensionAPI;
  park: ParkGateController;
  agentActivity: Map<string, AgentActivity>;
  getWidget: () => AgentWidget;
  getFleet: () => FleetList;
  outbox: CompletionOutbox;
  pendingUsage: PendingUsagePool;
  isReportUsageEnabled: () => boolean;
  isShowCostEnabled: () => boolean;
  getDefaultJoinMode: () => JoinMode;
  getCurrentCtx: () => ExtensionContext | undefined;
  getTurnGroupSpawns: () => string[];
  joinTurnGroup: (id: string, joinMode: JoinMode | undefined) => void;
}


export function createManagerSetup(deps: ManagerSetupDeps) {
  const {
    pi,
    park,
    agentActivity,
    getWidget,
    getFleet,
    outbox,
    pendingUsage,
    isReportUsageEnabled,
    isShowCostEnabled,
    getDefaultJoinMode,
    getCurrentCtx,
    getTurnGroupSpawns,
    joinTurnGroup,
  } = deps;

  const widget = {
    markFinished: (id: string) => getWidget().markFinished(id),
    markRunning: (id: string) => getWidget().markRunning(id),
    update: () => getWidget().update(),
    ensureTimer: () => getWidget().ensureTimer(),
  };

  const fleet = {
    onAgentFinished: (id: string) => getFleet().onAgentFinished(id),
    update: () => getFleet().update(),
    ensureTimer: () => getFleet().ensureTimer(),
  };

  function sendIndividualNudge(record: AgentRecord) {
    const activity = agentActivity.get(record.id);
    agentActivity.delete(record.id);
    widget.markFinished(record.id);
    fleet.onAgentFinished(record.id);
    try {
      const footer = record.outputFile ? `\nFull transcript available at: ${record.outputFile}` : '';
      const message = {
        content: formatTaskNotification(record, 500, isShowCostEnabled()) + footer,
        details: buildNotificationDetails(record, activity),
      };
      outbox.add({ ids: [record.id], build: () => message });
    } catch { /* ignore stale completion side-effects */ }
    widget.update();
  }

  const groupJoin = new GroupJoinManager(
    (records, partial) => {
      const activities = new Map<string, AgentActivity | undefined>();
      for (const r of records) {
        activities.set(r.id, agentActivity.get(r.id));
        agentActivity.delete(r.id);
        widget.markFinished(r.id);
        fleet.onAgentFinished(r.id);
      }

      const members = records.filter(r => !r.resultConsumed).flatMap(r => {
        try {
          return [{ id: r.id, text: formatTaskNotification(r, 300, isShowCostEnabled()), details: buildNotificationDetails(r, activities.get(r.id)) }];
        } catch { return []; }
      });
      if (members.length > 0) {
        outbox.add({
          ids: members.map(m => m.id),
          build: (ids) => {
            const unread = members.filter(m => ids.includes(m.id));
            const notifications = unread.map(m => m.text).join('\n\n');
            const label = partial
              ? `${unread.length} agent(s) finished (partial — others still running)`
              : `${unread.length} agent(s) finished`;

            const [first, ...rest] = unread;
            const details = first.details;
            if (rest.length > 0) details.others = rest.map(m => m.details);
            return {
              content: `Background agent group completed: ${label}\n\n${notifications}\n\nUse get_subagent_result for full output.`,
              details,
            };
          },
        });
      }
      widget.update();
    },
    30_000,
  );

  /** A nested result the parent has neither collected inline nor read yet. */
  function shouldNotifyParent(record: AgentRecord): record is AgentRecord & { parentAgentId: string } {
    return record.parentAgentId !== undefined &&
      record.isBackground === true &&
      record.status !== "paused" &&
      record.resultConsumed !== true;
  }

  function nestedCompletionMessage(record: AgentRecord): string {
    const footer = record.outputFile ? `\nFull transcript available at: ${record.outputFile}` : "";
    return `${formatTaskNotification(record, 500, isShowCostEnabled())}${footer}\n\nUse get_subagent_result for full output.`;
  }

  /** Steer the owner's live session; a parent without one gets the message on its next run. */
  function deliverNestedCompletion(owner: AgentRecord, message: string): void {
    if (!owner.session) {
      owner.pendingSteers = [...(owner.pendingSteers ?? []), message];
      return;
    }
    owner.pendingChildNotifications ??= new Set();
    const delivery: Promise<void> = owner.session.steer(message).then(
      () => undefined,
      (err) => { console.error("[pi-subagents-hub] nested completion notification failed:", err); },
    ).finally(() => {
      owner.pendingChildNotifications?.delete(delivery);
    });
    owner.pendingChildNotifications.add(delivery);
  }

  function notifyParentOfNestedCompletion(record: AgentRecord): void {
    if (!shouldNotifyParent(record)) return;
    const owner = manager.getRecord(record.parentAgentId);
    if (!owner || (owner.status !== "running" && owner.status !== "paused")) return;
    // An inline get_subagent_result(wait: true) already delivers this result.
    if (owner.waitingChildIds?.has(record.id)) return;
    deliverNestedCompletion(owner, nestedCompletionMessage(record));
  }

  const manager = new AgentManager((record) => {
    if (!isTopLevelAgent(record)) {
      notifyParentOfNestedCompletion(record);
      return;
    }
    const currentCtx = getCurrentCtx();
    if (currentCtx) syncPauseManifest(currentCtx, park, manager);

    if (record.status === "paused") {
      pi.appendEntry<AgentRecordEntryData>(AGENT_RECORD_ENTRY_TYPE, agentRecordEntryData(record));
      agentActivity.delete(record.id);
      widget.update();
      fleet.update();
      return;
    }

    const isError = record.status === "error" || record.status === "stopped" || record.status === "aborted";
    // One shape for every listener: the whitelist in subagent-info.ts, not
    // whatever AgentRecord happens to hold.
    const eventData = toSubagentInfo(record);
    if (isError) {
      pi.events.emit("subagents:failed", eventData);
    } else {
      pi.events.emit("subagents:completed", eventData);
    }

    // Persist the final record: get_subagent_result answers from it once the
    // live record is gone, and other extensions reconstruct history from it.
    pi.appendEntry<AgentRecordEntryData>(AGENT_RECORD_ENTRY_TYPE, agentRecordEntryData(record));

    if (record.resultConsumed) {
      agentActivity.delete(record.id);
      widget.markFinished(record.id);
      fleet.onAgentFinished(record.id);
      widget.update();
      return;
    }

    if (getTurnGroupSpawns().includes(record.id)) {
      widget.update();
      return;
    }

    const result = groupJoin.onAgentComplete(record);
    if (result === 'pass') {
      sendIndividualNudge(record);
    }
    widget.update();
  }, undefined, (record) => {
    if (!isTopLevelAgent(record)) return;
    const currentCtx = getCurrentCtx();
    if (currentCtx?.hasUI) {
      widget.ensureTimer();
      widget.update();
      fleet.ensureTimer();
      fleet.update();
    }
    pi.events.emit("subagents:started", {
      id: record.id,
      type: record.type,
      description: record.description,
    });
  }, (record, info) => {
    if (!isTopLevelAgent(record)) return;
    pi.events.emit("subagents:compacted", {
      id: record.id,
      type: record.type,
      description: record.description,
      reason: info.reason,
      tokensBefore: info.tokensBefore,
      compactionCount: record.compactionCount,
    });
  }, (record, usage) => {
    if (isReportUsageEnabled()) pendingUsage.add(usage);
    const reported = toReportedUsage(usage);
    if (!reported) return;
    const invocation = record.invocation;
    try {
      pi.events.emit("subagents:usage", {
        id: record.id,
        type: record.type,
        description: record.description,
        ...(invocation?.modelId !== undefined ? { model: invocation.modelId } : {}),
        ...(invocation?.thinking !== undefined ? { thinking: invocation.thinking } : {}),
        ...(invocation?.requestedThinking !== undefined ? { requestedThinking: invocation.requestedThinking } : {}),
        depth: record.depth ?? 1,
        ...(record.parentAgentId !== undefined ? { parentAgentId: record.parentAgentId } : {}),
        ...(record.workflowId !== undefined ? { workflowId: record.workflowId } : {}),
        usage: reported,
      });
    } catch {
      // ignore
    }
  }, (record, message) => {
    if (!isTopLevelAgent(record)) return;
    pi.events.emit("subagents:steered", { id: record.id, message });
  });

  async function startBackgroundResume(
    ctx: ExtensionContext,
    existing: AgentRecord,
    prompt: string | undefined,
    opts: { outputTranscript: boolean; maxTurns?: number; toolCallId?: string },
  ): Promise<AgentRecord | undefined> {
    const id = existing.id;
    const isTopLevel = isTopLevelAgent(existing);
    const isGated = gateOf(existing)?.closed === true;
    const joinMode = isTopLevel ? resolveJoinMode(getDefaultJoinMode(), true) : undefined;
    const transcriptAnchor = existing.session?.messages.length ?? 0;

    let bgState = agentActivity.get(id);
    let bgCallbacks: any;
    if (!bgState || !isGated) {
      const tracker = createActivityTracker(opts.maxTurns);
      bgState = tracker.state;
      bgCallbacks = tracker.callbacks;
      bgState.session = existing.session;
    }

    /**
     * What belongs to a NEW RUN, as opposed to the resume call that asked for it.
     *
     * `onStarted` fires from `startResume`, so this runs for a resume that starts
     * now and for one that waits in the pool behind the concurrency limit — and
     * never for the two outcomes that start no run: opening a pause gate (the run
     * never stopped) and unparking a record that had not started yet (the
     * original spawn's wiring owns that run, its transcript and its `created`
     * event). Doing this at accept time instead put a queued record in the widget
     * as running and re-announced an agent that already existed.
     */
    const wireNewRun = (): void => {
      const rec = manager.getRecord(id);
      if (!rec) return;
      if (opts.outputTranscript) {
        rec.outputFile = createOutputFilePath(ctx.cwd, id, ctx.sessionManager.getSessionId());
        ensureOutputFile(rec.outputFile);
        if (rec.session) {
          rec.outputCleanup = streamToOutputFile(rec.session, rec.outputFile, id, ctx.cwd, transcriptAnchor);
        }
      }
      rec.toolCallId = opts.toolCallId;
      if (joinMode) rec.joinMode = joinMode;
      if (isTopLevel && opts.toolCallId !== undefined) joinTurnGroup(id, joinMode);
      if (bgState) agentActivity.set(id, bgState);
      if (isTopLevel) {
        widget.markRunning(id);
        widget.ensureTimer();
        widget.update();
      }
      fleet.ensureTimer();
      fleet.update();
      if (isTopLevel && !isGated) {
        pi.events.emit("subagents:created", {
          id,
          type: existing.type,
          description: existing.description,
          isBackground: true,
        });
      }
    };

    return manager.resume(id, prompt, undefined, {
      isBackground: true,
      maxTurns: opts.maxTurns,
      onTurnEnd: bgCallbacks?.onTurnEnd,
      onToolActivity: bgCallbacks?.onToolActivity,
      onAssistantUsage: bgCallbacks?.onAssistantUsage,
      onStarted: wireNewRun,
    });
  }

  return {
    manager,
    groupJoin,
    sendIndividualNudge,
    startBackgroundResume,
  };
}
