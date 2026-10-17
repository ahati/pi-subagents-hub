import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AgentManager, isTopLevelAgent } from "../agent-manager.js";
import { syncPauseManifest } from "../commands/pause-continue.js";
import type { ParkGateController } from "../commands/pause-state.js";
import type { CompletionOutbox } from "../completion-outbox.js";
import { GroupJoinManager } from "../group-join.js";
import { resolveJoinMode } from "../invocation-config.js";
import { createOutputFilePath, ensureOutputFile, streamToOutputFile } from "../output-file.js";
import type { AgentRecord, JoinMode } from "../types.js";
import type { AgentActivity, AgentWidget } from "../ui/agent-widget.js";
import type { FleetList } from "../ui/fleet-list.js";
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

export function buildEventData(record: AgentRecord) {
  const durationMs = record.completedAt ? record.completedAt - record.startedAt : Date.now() - record.startedAt;
  const u = record.lifetimeUsage;
  const total = getLifetimeTotal(u);
  const tokens = total > 0
    ? { input: u.input, output: u.output, total }
    : undefined;
  const usage = toReportedUsage(u);
  return {
    id: record.id,
    type: record.type,
    description: record.description,
    result: record.result,
    error: record.error,
    status: record.status,
    toolUses: record.toolUses,
    durationMs,
    tokens,
    usage,
  };
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
    agentActivity.delete(record.id);
    widget.markFinished(record.id);
    fleet.onAgentFinished(record.id);
    try {
      const footer = record.outputFile ? `\nFull transcript available at: ${record.outputFile}` : '';
      const message = {
        content: formatTaskNotification(record, 500, isShowCostEnabled()) + footer,
        details: buildNotificationDetails(record, 500, agentActivity.get(record.id)),
      };
      outbox.add({ ids: [record.id], build: () => message });
    } catch { /* ignore stale completion side-effects */ }
    widget.update();
  }

  const groupJoin = new GroupJoinManager(
    (records, partial) => {
      for (const r of records) { agentActivity.delete(r.id); widget.markFinished(r.id); fleet.onAgentFinished(r.id); }

      const members = records.filter(r => !r.resultConsumed).flatMap(r => {
        try {
          return [{ id: r.id, text: formatTaskNotification(r, 300, isShowCostEnabled()), details: buildNotificationDetails(r, 300, agentActivity.get(r.id)) }];
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

  const manager = new AgentManager((record) => {
    if (!isTopLevelAgent(record)) return;
    const currentCtx = getCurrentCtx();
    if (currentCtx) syncPauseManifest(currentCtx, park, manager);

    if (record.status === "paused") {
      pi.appendEntry("subagents:record", {
        id: record.id, type: record.type, description: record.description,
        status: record.status, result: record.result, error: record.error,
        startedAt: record.startedAt, completedAt: record.completedAt,
      });
      agentActivity.delete(record.id);
      widget.update();
      fleet.update();
      return;
    }

    const isError = record.status === "error" || record.status === "stopped" || record.status === "aborted";
    const eventData = buildEventData(record);
    if (isError) {
      pi.events.emit("subagents:failed", eventData);
    } else {
      pi.events.emit("subagents:completed", eventData);
    }

    pi.appendEntry("subagents:record", {
      id: record.id, type: record.type, description: record.description,
      status: record.status, result: record.result, error: record.error,
      startedAt: record.startedAt, completedAt: record.completedAt,
    });

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
    const joinMode = resolveJoinMode(getDefaultJoinMode(), true);
    existing.toolCallId = opts.toolCallId;
    if (joinMode) existing.joinMode = joinMode;
    if (opts.outputTranscript) {
      existing.outputFile = createOutputFilePath(ctx.cwd, id, ctx.sessionManager.getSessionId());
      ensureOutputFile(existing.outputFile);
    }
    const transcriptAnchor = existing.session?.messages.length ?? 0;

    const { state: bgState, callbacks: bgCallbacks } = createActivityTracker(opts.maxTurns);
    bgState.session = existing.session;

    const record = await manager.resume(id, prompt, undefined, {
      isBackground: true,
      maxTurns: opts.maxTurns,
      onTurnEnd: bgCallbacks.onTurnEnd,
      onToolActivity: bgCallbacks.onToolActivity,
      onMessageStart: bgCallbacks.onMessageStart,
      onAssistantUsage: bgCallbacks.onAssistantUsage,
      onStarted: () => {
        const rec = manager.getRecord(id);
        if (rec?.session && rec.outputFile) {
          rec.outputCleanup = streamToOutputFile(rec.session, rec.outputFile, id, ctx.cwd, transcriptAnchor);
        }
      },
    });
    if (!record) return undefined;

    if (opts.toolCallId !== undefined) joinTurnGroup(id, joinMode);

    agentActivity.set(id, bgState);
    widget.markRunning(id);
    widget.ensureTimer();
    widget.update();
    fleet.ensureTimer();
    fleet.update();

    pi.events.emit("subagents:created", {
      id,
      type: existing.type,
      description: existing.description,
      isBackground: true,
    });

    return record;
  }

  return {
    manager,
    groupJoin,
    sendIndividualNudge,
    startBackgroundResume,
  };
}
