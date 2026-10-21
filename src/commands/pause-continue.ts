import { existsSync } from "node:fs";
import {
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  getAgentDir,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { type AgentManager, isTopLevelAgent } from "../agent-manager.js";
import { getDefaultMaxTurns, normalizeMaxTurns } from "../agent-runner.js";
import { getAgentConfig, resolveSpawnType } from "../agent-types.js";
import { runInChildSessionContext } from "../child-context.js";
import { getOutputTranscriptDefault } from "../output-file.js";
import {
  type PausedAgentEntry,
  type PausedWorkflowEntry,
  PauseStore,
  resolvePauseManifestPath,
  resolvePauseStorePath,
} from "../pause-store.js";
import { continueSessionBare, finalReportFromSessionFile } from "../session-continue.js";
import { shadowToolsFactory } from "../shadow-tools.js";
import type { AgentRecord, AgentTombstone } from "../types.js";
import type { AgentActivity } from "../ui/agent-widget.js";
import { pauseWorkflowTask, resumeWorkflowTask, type WorkflowTask } from "../workflow/task.js";
import { type ParkGateController, recordName } from "./pause-state.js";

const MANAGER_KEY = Symbol.for("pi-subagents:manager");

export interface PauseContinueDeps {
  pi: ExtensionAPI;
  manager: AgentManager;
  park: ParkGateController;
  agentActivity: Map<string, AgentActivity>;
  startBackgroundResume: (
    ctx: ExtensionContext,
    existing: AgentRecord,
    prompt: string | undefined,
    opts: { outputTranscript: boolean; maxTurns?: number; toolCallId?: string },
  ) => Promise<AgentRecord | undefined>;
  spawnResolved: (piRef: any, ctxRef: any, type: string, prompt: string | undefined, options: any) => string;
  reloadCustomAgents: () => void;
  resolveModel: (model: string, registry?: any) => any;
  isShowCostEnabled: () => boolean;
  workflowTasks?: Map<string, WorkflowTask>;
  relaunchWorkflow?: (ctx: ExtensionContext, entry: PausedWorkflowEntry) => Promise<boolean>;
}

export function resumeAgentSession(
  ctx: ExtensionContext,
  record: AgentRecord,
  startBackgroundResume: PauseContinueDeps["startBackgroundResume"],
  prompt?: string,
): Promise<boolean> {
  const config = getAgentConfig(record.type);
  return startBackgroundResume(ctx, record, prompt, {
    outputTranscript: config?.outputTranscript ?? getOutputTranscriptDefault(),
    maxTurns: normalizeMaxTurns(config?.maxTurns ?? getDefaultMaxTurns()),
  }).then(resumed => resumed !== undefined);
}

export async function resumeAgentById(
  ctx: ExtensionContext,
  record: AgentRecord,
  deps: PauseContinueDeps,
  prompt?: string,
): Promise<boolean> {
  const resumed = record.session
    ? await resumeAgentSession(ctx, record, deps.startBackgroundResume, prompt)
    : deps.manager.unpause(record.id);
  if (resumed) {
    deps.pi.events.emit("subagents:resumed", {
      id: record.id,
      type: record.type,
      description: record.description,
    });
  }
  return resumed;
}

export function pauseAgentRecord(
  record: AgentRecord,
  pi: ExtensionAPI,
  manager: AgentManager,
): string | undefined {
  const refusal = !isTopLevelAgent(record)
    ? "it is owned by another agent or workflow"
    : record.isBackground === false
      ? "it is blocking its caller"
      : record.worktree
        ? "worktree-isolated runs cannot pause"
        : undefined;
  if (refusal || !manager.pause(record.id)) return refusal ?? "not pausable";
  pi.events.emit("subagents:paused", {
    id: record.id,
    type: record.type,
    description: record.description,
  });
  return undefined;
}

export function syncPauseManifest(
  ctx: ExtensionContext,
  park: ParkGateController,
  manager: AgentManager,
  workflowTasks?: ReadonlyMap<string, WorkflowTask>,
): void {
  const sessionId = ctx.sessionManager?.getSessionId?.();
  if (!sessionId) return;
  try {
    const store = new PauseStore(resolvePauseStorePath(ctx.cwd, sessionId));
    const previous = new Map(store.list().map(e => [e.id, e.pausedAt]));
    const entries: PausedAgentEntry[] = manager.listAgents()
      .filter(isTopLevelAgent)
      .filter(a => a.status === "paused")
      .map(a => park.pausedAgentRow(a))
      .filter((a): a is PausedAgentEntry => a !== undefined)
      .map(a => ({ ...a, pausedAt: previous.get(a.id) ?? a.pausedAt }));
    const present = new Set(entries.map(e => e.id));
    for (const [id, entry] of [...park.capturedSettled]) {
      if (manager.getRecord(id)?.resultConsumed === true) {
        park.capturedSettled.delete(id);
        continue;
      }
      const record = manager.getRecord(id);
      const current = record && park.isCapturableResult(record)
        ? { ...park.pauseEntryFor(record), pausedAt: entry.pausedAt }
        : entry;
      if (current !== entry) park.capturedSettled.set(id, current);
      if (!present.has(id)) entries.push(current);
    }
    if (workflowTasks !== undefined) {
      const prevWf = new Map(store.listWorkflows().map(w => [w.id, w.pausedAt]));
      const workflows: PausedWorkflowEntry[] = [...workflowTasks.values()]
        .filter(t => t.status === "paused" && t.journalPath !== undefined)
        .map(t => ({
          id: t.id,
          journalPath: t.journalPath!,
          script: t.script,
          args: t.args,
          toolCallId: t.toolCallId,
          pausedAt: prevWf.get(t.id) ?? new Date(t.pausedAt ?? Date.now()).toISOString(),
        }));
      store.replaceBoth(entries, workflows);
    } else {
      store.replace(entries);
    }
  } catch {
    // Manifest write failed — in-session pause/resume still works.
  }
}

export async function pauseAllCommand(
  ctx: ExtensionCommandContext,
  deps: PauseContinueDeps,
): Promise<void> {
  const { pi, manager, park, workflowTasks } = deps;
  if (!ctx.isIdle()) {
    if (park.armedPause) {
      park.armedPause = false;
      ctx.ui.notify("Pause cancelled.", "info");
      return;
    }
    park.armedPause = true;
    ctx.ui.notify("Pausing when the turn reaches its next boundary — /pause again to cancel.", "info");
    return;
  }
  const captured = park.captureSettledResults(ctx, manager, c => syncPauseManifest(c, park, manager, workflowTasks));
  const active = manager.listAgents().filter(isTopLevelAgent)
    .filter(a => a.status === "running" || a.status === "queued");
  const activeWorkflows = workflowTasks
    ? [...workflowTasks.values()].filter(t => t.status === "running")
    : [];
  if (active.length === 0 && activeWorkflows.length === 0 && captured === 0) {
    ctx.ui.notify("No active agents to pause.", "info");
    return;
  }
  let paused = 0;
  let ephemeral = 0;
  let lost = 0;
  const refused: string[] = [];
  for (const record of active) {
    const refusal = pauseAgentRecord(record, pi, manager);
    if (refusal !== undefined) {
      refused.push(`@${recordName(record)} (${refusal})`);
      continue;
    }
    paused++;
    if (!record.sessionFile) {
      if (park.respawnSpecFor(record)) ephemeral++;
      else lost++;
    }
  }
  let pausedWorkflows = 0;
  for (const task of activeWorkflows) {
    if (pauseWorkflowTask(task)) {
      pausedWorkflows++;
    }
  }
  syncPauseManifest(ctx, park, manager, workflowTasks);
  const parts: string[] = [];
  if (paused > 0) parts.push(`Paused ${paused} agent${paused === 1 ? "" : "s"}`);
  if (pausedWorkflows > 0) parts.push(`Paused ${pausedWorkflows} workflow run${pausedWorkflows === 1 ? "" : "s"}`);
  if (captured > 0) parts.push(`Captured ${captured} completed result${captured === 1 ? "" : "s"} for /continue`);
  if (ephemeral > 0) parts.push(`${ephemeral} with no session — /continue re-runs ${ephemeral === 1 ? "it" : "them"} from scratch`);
  if (lost > 0) parts.push(`${lost} without a persisted session — quitting loses ${lost === 1 ? "it" : "them"}`);
  if (refused.length > 0) parts.push(`skipped ${refused.join(", ")}`);
  ctx.ui.notify(parts.join("; ") + ".", "info");
}

export async function continuePausedEntry(
  ctx: ExtensionContext,
  entry: PausedAgentEntry,
  deps: PauseContinueDeps,
): Promise<"resumed" | "respawned" | "stale" | "failed"> {
  const { manager } = deps;
  const live = manager.listAgents().find(a => a.id === entry.id);
  if (live) {
    if (live.status !== "paused") return "stale";
    return (await resumeAgentById(ctx, live, deps)) ? "resumed" : "failed";
  }
  if (entry.sessionFile === undefined) {
    return (await respawnPausedEntry(ctx, entry, deps)) ? "respawned" : "failed";
  }
  const tombstone: AgentTombstone = {
    handle: entry.handle ?? entry.id,
    alias: entry.alias,
    id: entry.id,
    type: entry.type,
    description: entry.description,
    sessionFile: entry.sessionFile,
    completedAt: Date.now(),
  };
  return (await reviveTombstone(ctx, tombstone, undefined, "Continuing", deps)) ? "resumed" : "failed";
}

export async function respawnPausedEntry(
  ctx: ExtensionContext,
  entry: PausedAgentEntry,
  deps: PauseContinueDeps,
): Promise<boolean> {
  const { pi, manager, spawnResolved, reloadCustomAgents, resolveModel } = deps;
  const respawn = entry.respawn;
  const target = `@${entry.alias ?? entry.handle ?? entry.id}`;
  if (!respawn) return false;
  reloadCustomAgents();
  const dispatch = resolveSpawnType(entry.type);
  if (!dispatch.ok || dispatch.fellBackFrom !== undefined) {
    ctx.ui.notify(`Could not re-run ${target} — the ${entry.type} agent is no longer available.`, "warning");
    return false;
  }
  let model: unknown;
  if (respawn.model !== undefined) {
    const resolved = resolveModel(respawn.model, ctx.modelRegistry);
    if (typeof resolved === "string") {
      ctx.ui.notify(`Could not re-run ${target} — ${resolved}`, "warning");
      return false;
    }
    model = resolved;
  }
  try {
    const id = spawnResolved(pi, ctx, dispatch.type, respawn.prompt, {
      description: entry.description,
      reclaim: { handle: entry.handle ?? entry.id, alias: entry.alias },
      isBackground: true,
      ...(model !== undefined ? { model } : {}),
      ...(respawn.thinking !== undefined ? { thinkingLevel: respawn.thinking } : {}),
      ...(respawn.maxTurns !== undefined ? { maxTurns: respawn.maxTurns } : {}),
      ...(respawn.isolated !== undefined ? { isolated: respawn.isolated } : {}),
      ...(respawn.inheritContext !== undefined ? { inheritContext: respawn.inheritContext } : {}),
    });
    await manager.awaitStartup(id);
    ctx.ui.notify(`Re-running ${target} from scratch — the earlier transcript and tool state are gone.`, "info");
    return true;
  } catch (err) {
    ctx.ui.notify(
      `Could not re-run ${target}: ${err instanceof Error ? err.message : String(err)}`,
      "warning",
    );
    return false;
  }
}

export async function continuePausedCommand(
  ctx: ExtensionCommandContext,
  deps: PauseContinueDeps,
): Promise<void> {
  const { pi, manager, park, agentActivity, isShowCostEnabled } = deps;
  const sessionId = ctx.sessionManager?.getSessionId?.();
  if (!sessionId) {
    ctx.ui.notify("No active session.", "warning");
    return;
  }
  const store = new PauseStore(resolvePauseManifestPath(ctx.cwd, sessionId));
  const entries = store.list();
  const mainTurn = store.getMainTurn();
  const workflowEntries = store.listWorkflows();
  const livePausedWorkflows = deps.workflowTasks
    ? [...deps.workflowTasks.values()].filter(t => t.status === "paused")
    : [];

  if (
    entries.length === 0 &&
    !mainTurn?.parked &&
    workflowEntries.length === 0 &&
    livePausedWorkflows.length === 0
  ) {
    ctx.ui.notify("Nothing paused in this session.", "info");
    return;
  }

  const deliverable: PausedAgentEntry[] = [];
  const revivable: PausedAgentEntry[] = [];
  for (const entry of entries) {
    if (park.capturedSettled.has(entry.id)) {
      if (manager.getRecord(entry.id)?.resultConsumed === true) {
        park.capturedSettled.delete(entry.id);
        continue;
      }
      deliverable.push(entry);
      continue;
    }
    if (!manager.getRecord(entry.id) && entry.sessionFile !== undefined && finalReportFromSessionFile(entry.sessionFile, { quiet: true }) !== undefined) {
      deliverable.push(entry);
      continue;
    }
    revivable.push(entry);
  }

  let delivered = 0;
  const undelivered: PausedAgentEntry[] = [];
  for (const entry of deliverable) {
    const live = manager.getRecord(entry.id);
    const report = live
      ? (live.result ?? live.error ?? "")
      : entry.sessionFile === undefined
        ? undefined
        : finalReportFromSessionFile(entry.sessionFile);
    if (!live && report === undefined) {
      undelivered.push(entry);
      continue;
    }
    try {
      park.deliverCapturedResult(entry, live, report ?? "", pi, isShowCostEnabled(), agentActivity);
      if (live) live.resultConsumed = true;
      park.capturedSettled.delete(entry.id);
      delivered++;
    } catch {
      undelivered.push(entry);
    }
  }

  let continuedMain = false;
  if (park.parkedMain) {
    park.openMainTurnGate();
    store.setMainTurn(undefined);
    continuedMain = true;
    park.flushHeldNudges();
  } else if (mainTurn?.parked) {
    if (park.claimLive(mainTurn.claim)) {
      ctx.ui.notify(
        `Another pi window holds the claim on the parked main turn (pid ${mainTurn.claim.pid}) — continue there, or wait for it to exit.`,
        "warning",
      );
      return;
    }
    store.setMainTurn({ ...mainTurn, claim: { pid: process.pid, at: new Date().toISOString() } });
    const ok = await continueParkedMainTurn(ctx, store, revivable, deps);
    if (ok) return;
    continuedMain = false;
    ctx.ui.notify("Continuing the subagents only — the main turn could not be continued.", "warning");
  }

  let resumed = 0;
  let respawned = 0;
  let stale = 0;
  let failedRevive = 0;
  let failedRespawn = 0;
  const failed: PausedAgentEntry[] = [];
  for (const entry of revivable) {
    const outcome = await continuePausedEntry(ctx, entry, deps);
    if (outcome === "resumed") resumed++;
    else if (outcome === "respawned") respawned++;
    else if (outcome === "stale") stale++;
    else {
      failed.push(entry);
      if (entry.sessionFile === undefined) failedRespawn++;
      else failedRevive++;
    }
  }
  store.replace([...failed, ...undelivered]);

  let resumedWorkflows = 0;
  let failedWorkflows = 0;
  const remainingWorkflows: PausedWorkflowEntry[] = [];
  const handledWorkflowIds = new Set<string>();

  for (const task of livePausedWorkflows) {
    if (resumeWorkflowTask(task)) {
      resumedWorkflows++;
      handledWorkflowIds.add(task.id);
    } else {
      failedWorkflows++;
    }
  }

  for (const entry of workflowEntries) {
    if (handledWorkflowIds.has(entry.id)) {
      continue;
    }
    const live = deps.workflowTasks?.get(entry.id);
    if (live) {
      if (live.status === "paused") {
        if (resumeWorkflowTask(live)) {
          resumedWorkflows++;
          handledWorkflowIds.add(entry.id);
        } else {
          failedWorkflows++;
          remainingWorkflows.push(entry);
        }
      }
      continue;
    }
    if (deps.relaunchWorkflow) {
      const ok = await deps.relaunchWorkflow(ctx, entry);
      if (ok) {
        resumedWorkflows++;
        handledWorkflowIds.add(entry.id);
      } else {
        failedWorkflows++;
        remainingWorkflows.push(entry);
      }
    } else {
      failedWorkflows++;
      remainingWorkflows.push(entry);
    }
  }
  store.replaceWorkflows(remainingWorkflows);

  const parts: string[] = [];
  if (continuedMain) parts.push("Continued the parked main turn");
  if (resumed > 0) parts.push(`Continued ${resumed} agent${resumed === 1 ? "" : "s"}`);
  if (resumedWorkflows > 0) parts.push(`Continued ${resumedWorkflows} workflow run${resumedWorkflows === 1 ? "" : "s"}`);
  if (respawned > 0) parts.push(`${respawned} re-ran from scratch (transcript not restored)`);
  if (stale > 0) parts.push(`${stale} already handled`);
  if (delivered > 0) parts.push(`Delivered ${delivered} captured agent result${delivered === 1 ? "" : "s"}`);
  if (failedRevive > 0) parts.push(`${failedRevive} could not be revived (kept in the manifest)`);
  if (failedRespawn > 0) parts.push(`${failedRespawn} could not be re-run (kept in the manifest)`);
  if (failedWorkflows > 0) parts.push(`${failedWorkflows} workflow run${failedWorkflows === 1 ? "" : "s"} could not be continued (kept in the manifest)`);
  if (undelivered.length > 0) parts.push(`${undelivered.length} result${undelivered.length === 1 ? "" : "s"} could not be delivered (kept in the manifest)`);
  if (parts.length === 0) parts.push("Nothing left to continue");
  ctx.ui.notify(parts.join("; ") + ".", !continuedMain && resumed === 0 && resumedWorkflows === 0 && respawned === 0 && delivered === 0 && (failed.length > 0 || failedWorkflows > 0) ? "warning" : "info");
}

export async function continueParkedMainTurn(
  ctx: ExtensionCommandContext,
  store: PauseStore,
  entries: PausedAgentEntry[],
  deps: PauseContinueDeps,
): Promise<boolean> {
  const { park } = deps;
  const sessionFile = ctx.sessionManager?.getSessionFile?.();
  if (!sessionFile) {
    ctx.ui.notify("Could not continue the parked main turn — the session file is unknown.", "warning");
    return false;
  }
  try {
    const current = ctx.sessionManager;
    const sessionManager = current instanceof SessionManager ? current : SessionManager.open(sessionFile);
    const cwd = sessionManager.getCwd();
    const agentDir = getAgentDir();
    const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: ctx.isProjectTrusted?.() ?? true });
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [shadowToolsFactory],
    });
    await runInChildSessionContext(() => loader.reload());
    const { session } = await createAgentSession({
      sessionManager,
      cwd,
      agentDir,
      settingsManager,
      resourceLoader: loader,
      model: ctx.model,
      thinkingLevel: ctx.thinkingLevel,
      scopedModels: ctx.scopedModels ? [...ctx.scopedModels] : undefined,
    });
    const result = await continueSessionBare(session);
    if (result.continuationError) {
      ctx.ui.notify(`The parked main turn was healed, but its continuation failed: ${result.continuationError}`, "warning");
    } else if (result.alreadyComplete) {
      ctx.ui.notify("The parked main turn was already complete.", "info");
    } else {
      ctx.ui.notify("Continuing the parked main turn — pi reloads the session when it finishes.", "info");
    }
    const failed: PausedAgentEntry[] = [];
    let adopted = false;
    park.mainTurnSwitchInProgress = true;
    try {
      await ctx.switchSession(sessionFile, {
        withSession: async fresh => {
          adopted = true;
          const runCtx = fresh ?? ctx;
          const notify = (message: string, level: "info" | "warning") => {
            try {
              runCtx.ui.notify(message, level);
            } catch {
              /* stale ctx after replacement */
            }
          };
          const freshRegistry = (globalThis as any)[MANAGER_KEY] as {
            revivePausedEntry?: (c: ExtensionContext, e: PausedAgentEntry) => Promise<"resumed" | "respawned" | "stale" | "failed">;
            relaunchPausedWorkflow?: (c: ExtensionContext, e: PausedWorkflowEntry) => Promise<boolean>;
          } | undefined;
          const revive = freshRegistry?.revivePausedEntry ?? (fresh ? undefined : (c: ExtensionContext, e: PausedAgentEntry) => continuePausedEntry(c, e, deps));
          if (!revive) {
            notify("Could not revive the parked agents — pi-subagents-hub is not active in the resumed session.", "warning");
            for (const entry of entries) failed.push(entry);
          } else {
            for (const entry of entries) {
              let outcome: "resumed" | "respawned" | "stale" | "failed" = "failed";
              try {
                outcome = await revive(runCtx, entry);
              } catch (err) {
                notify(`Could not revive a parked agent: ${err instanceof Error ? err.message : String(err)}`, "warning");
              }
              if (outcome !== "resumed" && outcome !== "respawned") failed.push(entry);
            }
          }
          const relaunchWf = freshRegistry?.relaunchPausedWorkflow ?? (fresh ? undefined : (c: ExtensionContext, e: PausedWorkflowEntry) => deps.relaunchWorkflow ? deps.relaunchWorkflow(c, e) : Promise.resolve(false));
          const workflowEntries = store.listWorkflows();
          const failedWorkflows: PausedWorkflowEntry[] = [];
          if (!relaunchWf && workflowEntries.length > 0) {
            notify("Could not continue the workflow runs — pi-subagents-hub is not active in the resumed session.", "warning");
            for (const wf of workflowEntries) failedWorkflows.push(wf);
          } else {
            for (const wf of workflowEntries) {
              let ok = false;
              try {
                ok = (await relaunchWf?.(runCtx, wf)) ?? false;
              } catch (err) {
                notify(`Could not continue workflow run: ${err instanceof Error ? err.message : String(err)}`, "warning");
              }
              if (!ok) failedWorkflows.push(wf);
            }
          }
          store.setMainTurn(undefined);
          store.replaceBoth(failed, failedWorkflows);
        },
      });
    } finally {
      park.mainTurnSwitchInProgress = false;
    }
    if (!adopted) {
      const mainTurnRef = store.getMainTurn();
      if (mainTurnRef) store.setMainTurn({ ...mainTurnRef, claim: { pid: -1, at: new Date().toISOString() } });
      ctx.ui.notify("The parked main turn could not be adopted in this host — continuing the subagents only.", "warning");
      return false;
    }
    return true;
  } catch (err) {
    ctx.ui.notify(
      `Could not continue the parked main turn: ${err instanceof Error ? err.message : String(err)}`,
      "warning",
    );
    return false;
  }
}

export async function reviveTombstone(
  ctx: ExtensionContext,
  entry: AgentTombstone,
  prompt: string | undefined,
  verb: string,
  deps: PauseContinueDeps,
): Promise<boolean> {
  const { manager, reloadCustomAgents, spawnResolved } = deps;
  const target = `@${entry.alias ?? entry.handle}`;

  if (!existsSync(entry.sessionFile)) {
    manager.dropTombstone(entry.handle);
    ctx.ui.notify(`Could not resume ${target} — its session is gone.`, "warning");
    return false;
  }

  reloadCustomAgents();
  const dispatch = resolveSpawnType(entry.type);
  if (!dispatch.ok || dispatch.fellBackFrom !== undefined) {
    ctx.ui.notify(`Could not resume ${target} — the ${entry.type} agent is no longer available.`, "warning");
    return false;
  }

  try {
    const id = spawnResolved(deps.pi, ctx, dispatch.type, prompt, {
      description: entry.description,
      reclaim: { handle: entry.handle, alias: entry.alias },
      resumeSessionFile: entry.sessionFile,
      isBackground: true,
    });
    await manager.awaitStartup(id);
    ctx.ui.notify(`${verb} ${target}`, "info");
    return true;
  } catch (err) {
    ctx.ui.notify(
      `Could not resume ${target}: ${err instanceof Error ? err.message : String(err)}`,
      "warning",
    );
    return false;
  }
}
