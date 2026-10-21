import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type AgentManager, isTopLevelAgent } from "../agent-manager.js";
import { buildNotificationDetails, formatTaskNotification, getStatusLabel } from "../entry/renderers.js";
import {
  type CapturedResultStatus,
  type PausedAgentEntry,
  type PausedMainTurn,
  type PausedRespawnSpec,
  PauseStore,
  resolvePauseStorePath,
} from "../pause-store.js";
import { countUnansweredToolCalls } from "../session-continue.js";
import { getStatusNote } from "../status-note.js";
import type { AgentRecord, NotificationDetails } from "../types.js";
import type { AgentActivity } from "../ui/agent-widget.js";
import { pauseWorkflowTask, type WorkflowTask } from "../workflow/task.js";
import { escapeXml } from "../xml.js";

export function recordName(record: AgentRecord): string {
  return record.alias ?? record.handle ?? record.id;
}

export class ParkGateController {
  armedPause = false;
  mainTurnSwitchInProgress = false;
  parkedMain = false;
  mainGate: { promise: Promise<void>; open(): void } | undefined;
  readonly heldNudges: Array<() => void> = [];
  readonly capturedSettled = new Map<string, PausedAgentEntry>();

  holdWhileParked(send: () => void): void {
    if (this.parkedMain) {
      this.heldNudges.push(send);
      return;
    }
    send();
  }

  flushHeldNudges(): void {
    const held = this.heldNudges.splice(0);
    for (const send of held) send();
  }

  resetOnSessionStart(): void {
    this.armedPause = false;
    this.mainTurnSwitchInProgress = false;
    this.openMainTurnGate();
    this.heldNudges.length = 0;
    this.capturedSettled.clear();
  }

  openMainTurnGate(): void {
    this.parkedMain = false;
    this.mainGate?.open();
    this.mainGate = undefined;
  }

  holdMainTurnGate(signal: AbortSignal | undefined): Promise<void> {
    if (!this.mainGate) {
      let open!: () => void;
      const promise = new Promise<void>(resolve => {
        open = resolve;
      });
      this.mainGate = { promise, open };
    }
    const gate = this.mainGate;
    if (signal?.aborted) return Promise.resolve();
    if (!signal) return gate.promise;
    return new Promise<void>(resolve => {
      const settle = () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      };
      const onAbort = () => settle();
      void gate.promise.then(settle);
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  capturedStatus(record: AgentRecord): CapturedResultStatus | undefined {
    return record.status === "completed" || record.status === "steered" || record.status === "error" ? record.status : undefined;
  }

  pauseEntryFor(record: AgentRecord & { sessionFile: string }): PausedAgentEntry {
    const status = this.capturedStatus(record);
    return {
      id: record.id,
      type: record.type,
      handle: record.handle,
      alias: record.alias,
      description: record.description,
      sessionFile: record.sessionFile,
      pausedAt: new Date().toISOString(),
      ...(status
        ? {
            status,
            ...(status === "error" && record.error ? { error: record.error } : {}),
          }
        : {}),
    };
  }

  respawnSpecFor(record: AgentRecord): PausedRespawnSpec | undefined {
    if (record.spawnPrompt === undefined) return undefined;
    const invocation = record.invocation;
    const thinking = invocation?.requestedThinking ?? invocation?.thinking;
    return {
      prompt: record.spawnPrompt,
      ...(invocation?.modelId !== undefined ? { model: invocation.modelId } : {}),
      ...(thinking !== undefined ? { thinking } : {}),
      ...(invocation?.maxTurns !== undefined ? { maxTurns: invocation.maxTurns } : {}),
      ...(invocation?.isolated !== undefined ? { isolated: invocation.isolated } : {}),
      ...(invocation?.inheritContext !== undefined ? { inheritContext: invocation.inheritContext } : {}),
    };
  }

  pausedAgentRow(record: AgentRecord): PausedAgentEntry | undefined {
    if (record.sessionFile) return this.pauseEntryFor({ ...record, sessionFile: record.sessionFile });
    const respawn = this.respawnSpecFor(record);
    if (!respawn) return undefined;
    return {
      id: record.id,
      type: record.type,
      handle: record.handle,
      alias: record.alias,
      description: record.description,
      respawn,
      pausedAt: new Date().toISOString(),
    };
  }

  isCapturableResult(
    record: AgentRecord,
  ): record is AgentRecord & { sessionFile: string; status: CapturedResultStatus } {
    return isTopLevelAgent(record)
      && this.capturedStatus(record) !== undefined
      && record.resultConsumed !== true
      && typeof record.sessionFile === "string";
  }

  captureSettledResults(
    ctx: ExtensionContext,
    manager: AgentManager,
    syncPauseManifest: (ctx: ExtensionContext) => void,
  ): number {
    let captured = 0;
    for (const record of manager.listAgents()) {
      if (!this.isCapturableResult(record) || this.capturedSettled.has(record.id)) continue;
      this.capturedSettled.set(record.id, this.pauseEntryFor(record));
      captured++;
    }
    if (captured > 0) syncPauseManifest(ctx);
    return captured;
  }

  pauseStoreFor(ctx: ExtensionContext): PauseStore {
    const sid = ctx.sessionManager?.getSessionId?.() ?? "";
    return new PauseStore(resolvePauseStorePath(ctx.cwd, sid));
  }

  claimLive(claim: { pid: number } | undefined): boolean {
    if (!claim) return false;
    if (claim.pid <= 0) return false;
    if (claim.pid === process.pid) return true;
    try {
      process.kill(claim.pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  async landPark(
    ctx: ExtensionContext,
    boundaryCount = 0,
    manager: AgentManager,
    syncPauseManifest: (ctx: ExtensionContext) => void,
    pauseAgentRecord: (rec: AgentRecord) => string | undefined,
    workflowTasks?: ReadonlyMap<string, WorkflowTask>,
  ): Promise<void> {
    const branch = ctx.sessionManager?.getBranch?.() ?? [];
    const pendingTools = branch.length > 0 ? countUnansweredToolCalls(branch) : boundaryCount;
    this.armedPause = false;
    this.parkedMain = true;
    const captured = this.captureSettledResults(ctx, manager, syncPauseManifest);
    let paused = 0;
    let ephemeral = 0;
    let lost = 0;
    const refused: string[] = [];
    for (const record of manager.listAgents().filter(isTopLevelAgent)) {
      if (record.status !== "running" && record.status !== "queued") continue;
      const refusal = pauseAgentRecord(record);
      if (refusal !== undefined) {
        refused.push(`@${recordName(record)} (${refusal})`);
        continue;
      }
      paused++;
      if (!record.sessionFile) {
        if (this.respawnSpecFor(record)) ephemeral++;
        else lost++;
      }
    }
    let pausedWorkflows = 0;
    if (workflowTasks) {
      for (const task of workflowTasks.values()) {
        if (task.status === "running") {
          if (pauseWorkflowTask(task)) {
            pausedWorkflows++;
          }
        }
      }
    }
    syncPauseManifest(ctx);
    const mainTurn: PausedMainTurn = {
      parked: true,
      pendingTools,
      claim: { pid: process.pid, at: new Date().toISOString() },
      pausedAt: new Date().toISOString(),
    };
    this.pauseStoreFor(ctx).setMainTurn(mainTurn);
    const parts = [`Main turn parked at its boundary (${pendingTools} pending tool call${pendingTools === 1 ? "" : "s"})`];
    if (paused > 0) parts.push(`parked ${paused} agent${paused === 1 ? "" : "s"}`);
    if (pausedWorkflows > 0) parts.push(`parked ${pausedWorkflows} workflow run${pausedWorkflows === 1 ? "" : "s"}`);
    if (captured > 0) parts.push(`captured ${captured} completed result${captured === 1 ? "" : "s"} for /continue`);
    if (ephemeral > 0) parts.push(`${ephemeral} with no session — /continue re-runs ${ephemeral === 1 ? "it" : "them"} from scratch`);
    if (lost > 0) parts.push(`${lost} without a persisted session — quitting loses ${lost === 1 ? "it" : "them"}`);
    if (refused.length > 0) parts.push(`skipped ${refused.join(", ")}`);
    ctx.ui.notify(parts.join("; ") + " — /continue resumes.", "info");
  }

  deliverCapturedResult(
    entry: PausedAgentEntry,
    live: AgentRecord | undefined,
    report: string,
    pi: ExtensionAPI,
    showCost: boolean,
    agentActivity: Map<string, AgentActivity>,
  ): void {
    const footer = `\nFull transcript available at: ${entry.sessionFile}`;
    if (live) {
      this.holdWhileParked(() => pi.sendMessage<NotificationDetails>({
        customType: "subagent-notification",
        content: formatTaskNotification(live, 500, showCost) + footer,
        display: true,
        details: buildNotificationDetails(live, 500, agentActivity.get(live.id)),
      }, { deliverAs: "followUp", triggerTurn: true }));
      return;
    }
    const status: CapturedResultStatus =
      entry.status === "steered" || entry.status === "error" ? entry.status : "completed";
    const label = getStatusLabel(status, entry.error);
    const content = [
      "<task-notification>",
      `<task-id>${entry.id}</task-id>`,
      `<status>${escapeXml(label)}</status>`,
      `<summary>Agent "${escapeXml(entry.description)}" ${status}${getStatusNote(status)}</summary>`,
      `<result>${escapeXml(report)}</result>`,
      "</task-notification>",
    ].join("\n") + footer;

    this.holdWhileParked(() => pi.sendMessage<NotificationDetails>({
      customType: "subagent-notification",
      content,
      display: true,
      details: {
        id: entry.id,
        description: entry.description,
        status,
        toolUses: 0,
        turnCount: 0,
        totalTokens: 0,
        totalCost: 0,
        durationMs: 0,
        error: entry.error,
        resultPreview: report.length > 500 ? `${report.slice(0, 500)}…` : report,
      },
    }, { deliverAs: "followUp", triggerTurn: true }));
  }
}
