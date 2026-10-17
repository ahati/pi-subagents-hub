/**
 * pi-subagents-hub — A pi extension providing Claude Code-style autonomous sub-agents.
 *
 * Tools:
 *   Agent             — LLM-callable: spawn a sub-agent
 *   get_subagent_result  — LLM-callable: check background agent status/result
 *   steer_subagent       — LLM-callable: send a steering message to a running agent
 *
 * Commands:
 *   /agents                 — Interactive agent management menu
 */

import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { ScrollViewScrollbar } from "@earendil-works/pi-tui";
import { isTopLevelAgent } from "./agent-manager.js";
import {
  getDefaultMaxTurns,
  normalizeMaxTurns,
  resolveEffectiveMaxTurns,
  setDefaultMaxTurns,
  setGraceTurns,
  setRememberAgents,
} from "./agent-runner.js";
import {
  getAgentConfig,
  registerAgents,
  resolveSpawnType,
  setDefaultsDisabled,
  setFallbackSubagent,
} from "./agent-types.js";
import { inChildSessionContext } from "./child-context.js";
import {
  type AgentsMenuDeps,
  pauseAgentsCommand,
  resumeAgentsCommand,
  reviveAgentsCommand,
  showAgentsMenu,
} from "./commands/agents-menu.js";
import {
  continuePausedCommand,
  continuePausedEntry,
  type PauseContinueDeps,
  pauseAgentRecord,
  pauseAllCommand,
  resumeAgentById,
  syncPauseManifest,
} from "./commands/pause-continue.js";
import { ParkGateController } from "./commands/pause-state.js";
import {
  persistSettings,
  type SettingsMenuDeps,
  showSettings,
} from "./commands/settings-menu.js";
import { CompletionOutbox } from "./completion-outbox.js";
import { loadCustomAgents } from "./custom-agents.js";
import { createManagerSetup } from "./entry/manager-setup.js";
import {
  registerMentionInputHook,
  registerMentionProvider,
} from "./entry/mentions-hook.js";
import {
  createActivityTracker,
  FOREIGN_WORKFLOW_TOOL_NAMES,
  formatToolsSuffix,
  registerSubagentRenderers,
  renderRunningAgentStatus,
  WORKFLOW_ENTRY_TYPE,
  WORKFLOW_FILE_FLAG,
  type WorkflowEntryData,
  workflowEntryData,
} from "./entry/renderers.js";
import {
  createHandoffWatcher,
  registerSessionLifecycle,
} from "./entry/session-lifecycle.js";
import { resolveModel } from "./model-resolver.js";
import { setScopeModelsEnabled } from "./model-scope.js";
import {
  setMaxSubagentDepth,
} from "./nested-tools.js";
import {
  setOutputTranscriptDefault,
} from "./output-file.js";
import {
  seedProjectTrust,
  setPackageAgentsGate,
  setPackageWorkflowsGate,
} from "./package-resources.js";
import { SubagentScheduler } from "./schedule.js";
import {
  applyAndEmitLoaded,
  loadSettings,
  type ToolDescriptionMode,
} from "./settings.js";
import { createAgentTool } from "./tools/agent-tool.js";
import {
  createGetResultTool,
  createSteerTool,
  registerToolReportingUsage,
  withUsageReporting,
} from "./tools/inspect-tools.js";
import {
  createWorkflowTool,
  fleetWorkflows,
  resolveWorkflowCollisions,
  runWorkflowFlag,
} from "./tools/workflow-tool.js";
import type {
  AgentMentionMode,
  AgentRecord,
  JoinMode,
  NotificationDetails,
  UIStyle,
  ViewerMarkdownMode,
  WidgetMode,
} from "./types.js";
import {
  type AgentActivity,
  AgentWidget,
} from "./ui/agent-widget.js";
import { FleetList } from "./ui/fleet-list.js";
import {
  openWorkflowFromFleet,
  type WorkflowMenuDeps,
} from "./ui/workflow-menu.js";
import { PendingUsagePool } from "./usage.js";
import {
  pauseWorkflowTask,
  resumeWorkflowTask,
  type WorkflowTask,
} from "./workflow/task.js";
import {
  isWorktreeIsolationEnabled,
  setWorktreeIsolationEnabled,
} from "./worktree.js";

export {
  createActivityTracker,
  FOREIGN_WORKFLOW_TOOL_NAMES,
  formatToolsSuffix,
  renderRunningAgentStatus,
  WORKFLOW_ENTRY_TYPE,
  WORKFLOW_FILE_FLAG,
  type WorkflowEntryData,
  workflowEntryData,
};

export default function (pi: ExtensionAPI) {
  if (inChildSessionContext()) return;

  registerSubagentRenderers(pi, () => showCost);

  pi.registerFlag(WORKFLOW_FILE_FLAG, {
    type: "string",
    description:
      `Run a workflow script at startup: --${WORKFLOW_FILE_FLAG}=<path>. ` +
      "Use the `=` form — the space form consumes the next argument, which would swallow a following prompt.",
  });

  const bootSettings = loadSettings(process.cwd());
  let strictAgentFiles = bootSettings.strictAgentFiles === true;

  setPackageAgentsGate(bootSettings.packageAgents);
  setPackageWorkflowsGate(bootSettings.packageWorkflows);
  seedProjectTrust(process.cwd());

  const reloadCustomAgents = (strict = false) => {
    const userAgents = loadCustomAgents(process.cwd(), strict);
    registerAgents(userAgents);
  };

  reloadCustomAgents(strictAgentFiles);

  const agentActivity = new Map<string, AgentActivity>();

  let reportUsage = false;
  function isReportUsageEnabled(): boolean { return reportUsage; }
  function setReportUsage(b: boolean): void {
    reportUsage = b;
    if (!b) pendingUsage.drain();
  }

  let showCost = false;
  function isShowCostEnabled(): boolean { return showCost; }
  function setShowCost(b: boolean): void { showCost = b; widget.update(); fleet.update(); }

  let showModel = false;
  function isShowModelEnabled(): boolean { return showModel; }
  function setShowModel(b: boolean): void { showModel = b; widget.update(); }

  let viewerMarkdown: ViewerMarkdownMode = "assistant";
  function getViewerMarkdown(): ViewerMarkdownMode { return viewerMarkdown; }
  function setViewerMarkdown(mode: ViewerMarkdownMode): void { viewerMarkdown = mode; }
  function chooseViewerMarkdown(mode: ViewerMarkdownMode, ctx?: ExtensionCommandContext): void {
    setViewerMarkdown(mode);
    persistSettings(ctx, `Viewer markdown set to ${mode}`, settingsDeps);
  }

  const pendingUsage = new PendingUsagePool();
  const park = new ParkGateController();

  const outbox = new CompletionOutbox(
    (message) => park.holdWhileParked(() => pi.sendMessage<NotificationDetails>({
      customType: "subagent-notification",
      content: message.content,
      display: true,
      details: message.details,
    }, { deliverAs: "steer", triggerTurn: true })),
    () => currentCtx?.signal !== undefined,
  );

  let defaultJoinMode: JoinMode = 'smart';
  function getDefaultJoinMode(): JoinMode { return defaultJoinMode; }
  function setDefaultJoinMode(mode: JoinMode) { defaultJoinMode = mode; }

  let turnGroupSpawns: string[] = [];
  let turnGroupCounter = 0;

  function joinTurnGroup(id: string, joinMode: JoinMode | undefined) {
    if (joinMode === 'group' && currentCtx?.signal !== undefined) turnGroupSpawns.push(id);
  }

  let widget!: AgentWidget;
  let fleet!: FleetList;

  const {
    manager,
    groupJoin,
    sendIndividualNudge,
    startBackgroundResume,
  } = createManagerSetup({
    pi,
    park,
    agentActivity,
    getWidget: () => widget,
    getFleet: () => fleet,
    outbox,
    pendingUsage,
    isReportUsageEnabled,
    isShowCostEnabled,
    getDefaultJoinMode,
    getCurrentCtx: () => currentCtx,
    getTurnGroupSpawns: () => turnGroupSpawns,
    joinTurnGroup,
  });

  const MANAGER_KEY = Symbol.for("pi-subagents:manager");

  const spawnResolved = (piRef: any, ctxRef: any, type: string, prompt: string | undefined, options: any) => {
    reloadCustomAgents();
    const dispatch = resolveSpawnType(type);
    if (!dispatch.ok) throw new Error(dispatch.message);
    const { state, callbacks } = createActivityTracker(resolveEffectiveMaxTurns(dispatch.type, options?.maxTurns));
    const id = manager.spawn(piRef, ctxRef, dispatch.type, prompt, { ...options, ...callbacks });
    agentActivity.set(id, state);
    return id;
  };

  const spawnTopLevel = (piRef: any, ctxRef: any, type: string, prompt: string, options: any) => {
    const safeOptions = { ...(options ?? {}) };
    delete safeOptions.parentAgentId;
    delete safeOptions.workflowId;
    delete safeOptions.depth;
    delete safeOptions.maxSubagentDepth;
    delete safeOptions.configCwd;
    delete safeOptions.rootSessionId;
    delete safeOptions.resumeSessionFile;
    delete safeOptions.reclaim;
    delete safeOptions.blocking;
    return spawnResolved(piRef, ctxRef, type, prompt, safeOptions);
  };

  const resolveAgentRef = (ref: string): AgentRecord | undefined => {
    const byId = manager.getRecord(ref);
    if (byId) return byId;
    const resolved = manager.resolveMention(ref);
    return resolved?.kind === "live" ? resolved.record : undefined;
  };

  const registryEntry = {
    waitForAll: () => manager.waitForAll(),
    hasRunning: () => manager.hasRunning(),
    spawn: spawnTopLevel,
    getRecord: (id: string) => {
      const record = manager.getRecord(id);
      return record !== undefined && isTopLevelAgent(record) ? record : undefined;
    },
    revivePausedEntry: (ctx: ExtensionContext, entry: any) => continuePausedEntry(ctx, entry, pauseDeps),
  };
  const ownsManagerRegistry = (globalThis as any)[MANAGER_KEY] === undefined;
  if (ownsManagerRegistry) {
    (globalThis as any)[MANAGER_KEY] = registryEntry;
  }

  let currentCtx: ExtensionContext | undefined;
  const scheduler = new SubagentScheduler();

  let uiStyle: UIStyle = bootSettings.uiStyle ?? "pi";
  function getUIStyle(): UIStyle { return uiStyle; }
  function setUIStyle(s: UIStyle): void { uiStyle = s; widget.update(); fleet.update(); }

  let widgetMode: WidgetMode = "background";
  function getWidgetMode(): WidgetMode { return widgetMode; }
  widget = new AgentWidget(manager, agentActivity, getWidgetMode, isShowCostEnabled, isShowModelEnabled, getUIStyle);
  function setWidgetMode(m: WidgetMode): void { widgetMode = m; widget.update(); }

  const foregroundHandoffs = new Map<string, () => void>();
  const handoff = createHandoffWatcher(pi, manager, foregroundHandoffs, widget, () => fleet);

  function getFullscreenScrollbar(): ScrollViewScrollbar {
    const mode = pi.getSettings().fullscreenScrollbar;
    return mode === "always" || mode === "hidden" ? mode : "auto";
  }

  fleet = new FleetList(
    manager,
    agentActivity,
    isShowCostEnabled,
    getViewerMarkdown,
    (mode) => chooseViewerMarkdown(mode, currentCtx as unknown as ExtensionCommandContext | undefined),
    getFullscreenScrollbar,
    handoff.backgroundActionFor,
    getUIStyle,
  );

  fleet.setLifecycleActions({
    pause: (id) => {
      const record = manager.getRecord(id);
      return record ? pauseAgentRecord(record, pi, manager) : "no such agent";
    },
    resume: (id) => {
      const record = manager.getRecord(id);
      const ctx = currentCtx;
      if (!record || !ctx) return false;
      void resumeAgentById(ctx, record, pauseDeps);
      return true;
    },
  });

  let fleetViewEnabled = true;
  function isFleetViewEnabled(): boolean { return fleetViewEnabled; }
  function setFleetViewEnabled(b: boolean): void { fleetViewEnabled = b; fleet.setEnabled(b); }

  let agentMentionMode: AgentMentionMode = "model";
  function getAgentMentionMode(): AgentMentionMode { return agentMentionMode; }
  function setAgentMentionMode(mode: AgentMentionMode): void { agentMentionMode = mode; }
  function isAgentMentionsEnabled(): boolean { return agentMentionMode !== "off"; }

  let backgroundByDefault = true;
  function getBackgroundByDefault(): boolean { return backgroundByDefault; }
  function setBackgroundByDefault(b: boolean) { backgroundByDefault = b; }

  let schedulingEnabled = true;
  function isSchedulingEnabled(): boolean { return schedulingEnabled; }
  function setSchedulingEnabled(b: boolean) { schedulingEnabled = b; }

  let workflowsEnabled = true;
  let workflowsPinned = false;
  function isWorkflowsEnabled(): boolean { return workflowsEnabled; }
  function isWorkflowsPinned(): boolean { return workflowsPinned; }
  function setWorkflowsEnabled(b: boolean) {
    workflowsEnabled = b;
    workflowsPinned = true;
  }

  function setDisableDefaultAgents(b: boolean): void {
    setDefaultsDisabled(b);
    reloadCustomAgents();
  }

  let toolDescriptionMode: ToolDescriptionMode = "full";
  function getToolDescriptionMode(): ToolDescriptionMode { return toolDescriptionMode; }
  function setToolDescriptionMode(mode: ToolDescriptionMode): void { toolDescriptionMode = mode; }

  function registerTurnGroup() {
    const ids = turnGroupSpawns;
    turnGroupSpawns = [];
    if (ids.length < 2) {
      const record = ids.length === 1 ? manager.getRecord(ids[0]) : undefined;
      if (record?.completedAt != null && !record.resultConsumed) sendIndividualNudge(record);
      return;
    }
    const groupId = `turn-${++turnGroupCounter}`;
    groupJoin.registerGroup(groupId, ids);
    for (const id of ids) {
      const record = manager.getRecord(id);
      if (!record) continue;
      record.groupId = groupId;
      if (record.completedAt != null && !record.resultConsumed) {
        groupJoin.onAgentComplete(record);
      }
    }
  }

  function resumeTurnLimit(record: AgentRecord, explicit?: number): number | undefined {
    return normalizeMaxTurns(getAgentConfig(record.type)?.maxTurns ?? explicit ?? record.invocation?.maxTurns ?? getDefaultMaxTurns());
  }

  applyAndEmitLoaded(
    {
      setMaxConcurrent: (n) => manager.setMaxConcurrent(n),
      setMaxConcurrentForeground: (n) => manager.setMaxConcurrentForeground(n),
      setDefaultMaxTurns,
      setGraceTurns,
      setDefaultJoinMode,
      setBackgroundByDefault,
      setSchedulingEnabled,
      setScopeModels: setScopeModelsEnabled,
      setStrictAgentFiles: (b) => { strictAgentFiles = b; },
      setDisableDefaultAgents,
      setToolDescriptionMode,
      setFleetView: setFleetViewEnabled,
      setAgentMentions: setAgentMentionMode,
      setRememberAgents,
      setWidgetMode,
      setOutputTranscript: setOutputTranscriptDefault,
      setWorktreeIsolation: setWorktreeIsolationEnabled,
      setWorkflowsEnabled,
      setMaxSubagentDepth,
      setFallbackSubagent,
      setReportUsage,
      setShowCost,
      setShowModel,
      setViewerMarkdown,
      setPackageAgents: setPackageAgentsGate,
      setPackageWorkflows: setPackageWorkflowsGate,
      setUIStyle,
    },
    (event, payload) => pi.events.emit(event, payload),
  );

  const pauseDeps: PauseContinueDeps = {
    pi,
    manager,
    park,
    agentActivity,
    startBackgroundResume,
    spawnResolved,
    reloadCustomAgents: () => reloadCustomAgents(),
    resolveModel: (m, r) => resolveModel(m, r),
    isShowCostEnabled,
  };

  const agentTool = createAgentTool({
    pi,
    manager,
    agentActivity,
    widget,
    fleet,
    scheduler,
    foregroundHandoffs,
    reloadCustomAgents: () => reloadCustomAgents(),
    getBackgroundByDefault,
    isSchedulingEnabled,
    isWorktreeIsolationEnabled,
    isShowCostEnabled,
    getToolDescriptionMode,
    getDefaultJoinMode,
    resumeTurnLimit,
    startBackgroundResume,
    joinTurnGroup,
  });

  const registeredAgentTool = withUsageReporting(agentTool, () => reportUsage, pendingUsage);
  pi.registerTool(registeredAgentTool);

  const workflowTasks = new Map<string, WorkflowTask>();

  const workflowTool = createWorkflowTool({
    pi,
    manager,
    workflowTasks,
    widget,
    fleet,
    outbox,
    isWorkflowsEnabled,
    isWorkflowsPinned,
    setWorkflowsDisabledByCollision: () => {
      workflowsEnabled = false;
      widget.update();
      fleet.update();
    },
    isWorktreeIsolationEnabled,
    isSchedulingEnabled,
  });

  if (isWorkflowsEnabled()) pi.registerTool(workflowTool);

  registerToolReportingUsage(pi, createGetResultTool({
    resolveAgentRef,
    isShowCostEnabled,
    outbox,
    pi,
  }), () => reportUsage, pendingUsage);

  registerToolReportingUsage(pi, createSteerTool({
    resolveAgentRef,
    isShowCostEnabled,
    outbox,
    pi,
  }), () => reportUsage, pendingUsage);

  const settingsDeps: SettingsMenuDeps = {
    pi,
    manager,
    widget,
    fleet,
    scheduler,
    reloadCustomAgents: () => reloadCustomAgents(),
    getStrictAgentFiles: () => strictAgentFiles,
    setStrictAgentFiles: (b) => { strictAgentFiles = b; },
    isWorkflowsEnabled,
    isWorkflowsPinned,
    setWorkflowsEnabled,
    isReportUsageEnabled,
    setReportUsage,
    isShowCostEnabled,
    setShowCost,
    isShowModelEnabled,
    setShowModel,
    getViewerMarkdown,
    setViewerMarkdown,
    getUIStyle,
    setUIStyle,
    isFleetViewEnabled,
    setFleetViewEnabled,
    getAgentMentionMode,
    setAgentMentionMode,
    getDefaultJoinMode,
    setDefaultJoinMode,
    getBackgroundByDefault,
    setBackgroundByDefault,
    isSchedulingEnabled,
    setSchedulingEnabled,
    setDisableDefaultAgents,
    getToolDescriptionMode,
    setToolDescriptionMode,
    getWidgetMode,
    setWidgetMode,
  };

  const workflowMenuDeps: WorkflowMenuDeps = {
    tasks: workflowTasks,
    getCtx: () => currentCtx as unknown as ExtensionCommandContext | undefined,
    openRunInHub: (id, ctx) => fleet.openHub({ runId: id }, ctx?.ui as never),
  };

  const agentsMenuDeps: AgentsMenuDeps = {
    pi,
    manager,
    fleet,
    scheduler,
    workflowTasks,
    workflowMenuDeps,
    pauseDeps,
    reloadCustomAgents: () => reloadCustomAgents(),
    isWorkflowsEnabled,
    showSettings: (ctx) => showSettings(ctx, settingsDeps),
  };

  pi.registerCommand("agents", {
    description: "Manage agents",
    handler: async (args, ctx) => {
      const [action, ...rest] = args.trim().split(/\s+/);
      const target = rest.join(" ").trim() || undefined;
      if (action === "pause") { await pauseAgentsCommand(ctx, target, pauseDeps); return; }
      if (action === "resume") { await resumeAgentsCommand(ctx, target, pauseDeps); return; }
      if (action === "revive") { await reviveAgentsCommand(ctx, target, pauseDeps); return; }
      await showAgentsMenu(ctx, agentsMenuDeps);
    },
  });

  pi.registerCommand("pause", {
    description: "Pause all subagents (safe to quit; /continue resumes)",
    handler: async (args, ctx) => {
      if (args.trim()) {
        ctx.ui.notify("/pause takes no argument — for one agent use /agents pause [handle].", "warning");
        return;
      }
      await pauseAllCommand(ctx, pauseDeps);
    },
  });

  pi.registerCommand("continue", {
    description: "Resume agents parked by /pause (works after quit + reload)",
    handler: async (args, ctx) => {
      if (args.trim()) {
        ctx.ui.notify("/continue takes no argument — for one agent use /agents resume [handle].", "warning");
        return;
      }
      await continuePausedCommand(ctx, pauseDeps);
    },
  });

  fleet.setWorkflowSource(() => fleetWorkflows(workflowTasks), id => openWorkflowFromFleet(id, workflowMenuDeps));
  fleet.setWorkflowRunSource(
    id => {
      const task = workflowTasks.get(id);
      return task === undefined
        ? undefined
        : {
            progress: task.workflowProgress,
            task: {
              status: task.status,
              workflowName: task.workflowName,
              startTime: task.startTime,
              endTime: task.endTime,
              totalPausedMs: task.totalPausedMs,
            },
            meta: task.meta,
            agentCount: task.agentCount,
          };
    },
    id => {
      const task = workflowTasks.get(id);
      if (task === undefined || task.abortController.signal.aborted) return false;
      task.abortController.abort();
      return true;
    },
    id => {
      const task = workflowTasks.get(id);
      if (task === undefined || task.control === undefined) return undefined;
      const control = task.control;
      return {
        pause: () => pauseWorkflowTask(task),
        resume: () => resumeWorkflowTask(task),
        skip: index => control.skip(index) === true,
        retry: index => control.retry(index) === true,
      };
    },
  );

  const mentionHookDeps = {
    manager,
    isAgentMentionsEnabled,
    getAgentMentionMode,
    startBackgroundResume,
    resumeTurnLimit,
    registeredAgentTool,
    spawnTopLevel,
    pauseDeps,
  };

  registerMentionInputHook(pi, mentionHookDeps);

  const collisionsState = { collisionsChecked: false };
  const flagState = { workflowFlagHandled: false };
  const mentionState = { mentionProviderRegistered: false };

  registerSessionLifecycle(
    pi,
    {
      manager,
      park,
      widget,
      fleet,
      groupJoin,
      outbox,
      scheduler,
      foregroundHandoffs,
      workflowTasks,
      reloadCustomAgents: () => reloadCustomAgents(),
      syncPauseManifest: (c) => syncPauseManifest(c, park, manager),
      pauseAgentRecord: (r) => pauseAgentRecord(r, pi, manager),
      resumeAgentById: (c, r, p) => resumeAgentById(c, r, pauseDeps, p),
      resolveAgentRef,
      isSchedulingEnabled,
      isWorkflowsEnabled,
      resolveWorkflowCollisions: (c) => resolveWorkflowCollisions(pi, c, workflowTool.description, {
        isWorkflowsEnabled,
        isWorkflowsPinned,
        setWorkflowsDisabledByCollision: () => {
          workflowsEnabled = false;
        },
        updateUi: () => {
          widget.update();
          fleet.update();
        },
      }, collisionsState),
      runWorkflowFlag: (c) => runWorkflowFlag(pi, c, manager, workflowTasks, widget, fleet, isWorkflowsEnabled, flagState),
      registerMentionProvider: (c) => registerMentionProvider(c, mentionHookDeps, mentionState),
      spawnTopLevel,
      ownsManagerRegistry,
      registryEntry,
      registerTurnGroup,
      getCurrentCtx: () => currentCtx,
      setCurrentCtx: (c) => { currentCtx = c; },
    },
    handoff,
  );
}
