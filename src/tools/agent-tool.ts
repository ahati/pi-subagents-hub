import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type AgentManager, isTopLevelAgent } from "../agent-manager.js";
import { getDefaultMaxTurns, normalizeMaxTurns, SUBAGENT_TOOL_NAMES } from "../agent-runner.js";
import { getAgentConfig, resolveSpawnType, resolveType } from "../agent-types.js";
import { buildDetails, createActivityTracker, formatLifetimeTokens, textResult } from "../entry/renderers.js";
import { resolveAgentInvocationConfig, resolveJoinMode } from "../invocation-config.js";
import { describeModel, resolveModel } from "../model-resolver.js";
import { checkModelScope } from "../model-scope.js";
import { createOutputFilePath, getOutputTranscriptDefault, streamToOutputFile, writeInitialEntry } from "../output-file.js";
import type { SubagentScheduler } from "../schedule.js";
import type { ToolDescriptionMode } from "../settings.js";
import { getForegroundOutcomeNote, partialOutputSuffix } from "../status-note.js";
import type { AgentInvocation, AgentRecord, JoinMode, SubagentType } from "../types.js";
import {
  type AgentActivity,
  type AgentDetails,
  type AgentWidget,
  buildInvocationTags,
  describeActivity,
  formatCost,
  formatMs,
  getDisplayName,
  getPromptModeLabel,
  SPINNER,
  type UICtx,
} from "../ui/agent-widget.js";
import type { FleetList } from "../ui/fleet-list.js";
import { getLifetimeCost } from "../usage.js";
import { renderAgentToolCall, renderAgentToolResult } from "./agent-tool-render.js";
import { buildAgentToolDescription, buildAgentToolParams } from "./agent-tool-schema.js";

export interface AgentToolDeps {
  pi: ExtensionAPI;
  manager: AgentManager;
  agentActivity: Map<string, AgentActivity>;
  widget: AgentWidget;
  fleet: FleetList;
  scheduler: SubagentScheduler;
  foregroundHandoffs: Map<string, () => void>;
  reloadCustomAgents: () => void;
  getBackgroundByDefault: () => boolean;
  isSchedulingEnabled: () => boolean;
  isWorktreeIsolationEnabled: () => boolean;
  isShowCostEnabled: () => boolean;
  getToolDescriptionMode: () => ToolDescriptionMode;
  getDefaultJoinMode: () => JoinMode;
  resumeTurnLimit: (record: AgentRecord, explicit?: number) => number | undefined;
  startBackgroundResume: (
    ctx: ExtensionContext,
    existing: AgentRecord,
    prompt: string | undefined,
    opts: { outputTranscript: boolean; maxTurns?: number; toolCallId?: string },
  ) => Promise<AgentRecord | undefined>;
  joinTurnGroup: (id: string, joinMode: JoinMode | undefined) => void;
}

export function createAgentTool(deps: AgentToolDeps) {
  const {
    pi,
    manager,
    agentActivity,
    widget,
    fleet,
    scheduler,
    foregroundHandoffs,
    reloadCustomAgents,
    getBackgroundByDefault,
    isSchedulingEnabled,
    isWorktreeIsolationEnabled,
    isShowCostEnabled,
    getToolDescriptionMode,
    getDefaultJoinMode,
    resumeTurnLimit,
    startBackgroundResume,
    joinTurnGroup,
  } = deps;

  const description = buildAgentToolDescription({
    mode: getToolDescriptionMode(),
    schedulingEnabled: isSchedulingEnabled(),
    worktreeIsolationEnabled: isWorktreeIsolationEnabled(),
  });

  const parameters = buildAgentToolParams(isSchedulingEnabled(), isWorktreeIsolationEnabled());

  return defineTool({
    name: SUBAGENT_TOOL_NAMES.AGENT,
    label: "Agent",
    description,
    promptSnippet: "Launch autonomous sub-agents for complex multi-step tasks",
    promptGuidelines: [
      "Use Agent with specialized agents when the task matches an agent type's description. Subagents are valuable for parallelizing independent queries or for protecting the main context window from excessive results, but should not be used excessively when not needed. Importantly, avoid duplicating work that subagents are already doing — if you delegate research to a subagent, do not also perform the same searches yourself.",
      "For broad codebase exploration or research, spawn Agent with an appropriate subagent_type (e.g. Explore). Otherwise use direct tools (read, grep, find) when the target is already known.",
      "When an agent runs in the background, you will be notified on completion — do not poll or sleep waiting for it. Continue with other work instead.",
      "Trust but verify: an agent's summary describes intent, not outcome. When an agent writes or edits code, check the actual changes before reporting work as done.",
    ],
    parameters,

    renderCall(args, theme, context) {
      return renderAgentToolCall(args as { subagent_type: string; description?: string; name?: string }, theme, context);
    },

    renderResult(result, options, theme, renderContext) {
      return renderAgentToolResult(result, options, theme, renderContext, isShowCostEnabled());
    },

    execute: async (toolCallId, params, signal, onUpdate, ctx) => {
      widget.setUICtx(ctx.ui as UICtx);
      reloadCustomAgents();

      const rawType = params.subagent_type as SubagentType;
      const dispatch = resolveSpawnType(rawType);
      if (!dispatch.ok && !params.resume) return textResult(dispatch.message);
      const subagentType = dispatch.ok ? dispatch.type : rawType;
      const requestedType = (dispatch.ok && dispatch.fellBackFrom) || subagentType;
      const fallbackNote = dispatch.ok && dispatch.fellBackFrom !== undefined
        ? `Note: Unknown agent type "${dispatch.fellBackFrom}" — using ${resolveType(subagentType) ? subagentType : "the fallback agent config"}.\n\n`
        : "";

      const displayName = getDisplayName(subagentType);
      const customConfig = getAgentConfig(subagentType);

      const resolvedConfig = resolveAgentInvocationConfig(customConfig, params, {
        worktreeAllowed: isWorktreeIsolationEnabled(),
        defaultRunInBackground: getBackgroundByDefault(),
      });

      let model = ctx.model;
      if (resolvedConfig.modelInput) {
        const resolved = resolveModel(resolvedConfig.modelInput, ctx.modelRegistry);
        if (typeof resolved === "string") {
          if (resolvedConfig.modelFromParams) return textResult(resolved);
        } else {
          model = resolved;
        }
      }

      const scopeVerdict = checkModelScope({
        model,
        cwd: ctx.cwd,
        modelRegistry: ctx.modelRegistry,
        callerSupplied: resolvedConfig.modelFromParams,
        agentLabel: customConfig?.displayName ?? subagentType,
        modelInput: resolvedConfig.modelInput,
      });
      if (scopeVerdict.kind === "error") return textResult(scopeVerdict.message);
      if (scopeVerdict.kind === "warn") ctx.ui.notify(scopeVerdict.message, "warning");

      const thinking = resolvedConfig.thinking;
      const inheritContext = resolvedConfig.inheritContext;
      const runInBackground = resolvedConfig.runInBackground;
      const isolated = resolvedConfig.isolated;
      const isolation = resolvedConfig.isolation;

      const outputTranscript = customConfig?.outputTranscript ?? getOutputTranscriptDefault();
      const attachTranscript = (rec: AgentRecord | undefined, agentId: string): void => {
        if (!rec || !outputTranscript) return;
        rec.outputFile = createOutputFilePath(ctx.cwd, agentId, ctx.sessionManager.getSessionId());
        writeInitialEntry(rec.outputFile, agentId, params.prompt as string, ctx.cwd);
      };

      const { modelName, modelId } = model ? describeModel(model) : { modelName: undefined, modelId: undefined };
      const askedModel = ((asked: string | undefined) => {
        if (!asked) return undefined;
        const resolvedAsked = resolveModel(asked, ctx.modelRegistry);
        if (typeof resolvedAsked === "string") return asked;
        return resolvedAsked.provider === model?.provider && resolvedAsked.id === model?.id ? undefined : asked;
      })(resolvedConfig.overridden?.model);
      const effectiveMaxTurns = normalizeMaxTurns(resolvedConfig.maxTurns ?? getDefaultMaxTurns());
      const agentInvocation: AgentInvocation = {
        modelName,
        modelId,
        thinking,
        requestedThinking: resolvedConfig.overridden?.thinking,
        requestedModel: askedModel,
        maxTurns: normalizeMaxTurns(resolvedConfig.maxTurns),
        isolated,
        inheritContext,
        runInBackground,
        isolation,
      };

      const modeLabel = getPromptModeLabel(subagentType);
      const { tags: invocationTags } = buildInvocationTags(agentInvocation);
      const agentTags = modeLabel ? [modeLabel, ...invocationTags] : invocationTags;
      const detailBase = {
        displayName,
        description: params.description as string,
        subagentType,
        modelName,
        tags: agentTags.length > 0 ? agentTags : undefined,
      };

      const detailBaseFor = (rec: AgentRecord | undefined): typeof detailBase => {
        if (!rec?.invocation) return detailBase;
        const type = rec.type;
        const { modelName: recModelName, tags } = buildInvocationTags(rec.invocation);
        const recModeLabel = getPromptModeLabel(type);
        const recTags = recModeLabel ? [recModeLabel, ...tags] : tags;
        return {
          displayName: getDisplayName(type),
          description: rec.description,
          subagentType: type,
          modelName: recModelName,
          tags: recTags.length > 0 ? recTags : undefined,
        };
      };

      if (params.schedule) {
        if (!isSchedulingEnabled()) {
          return textResult("Scheduling is disabled in this project. Enable via /agents → Settings → Scheduling.");
        }
        if (params.resume) {
          return textResult("Cannot combine `schedule` with `resume` — schedules create fresh agents.");
        }
        if (params.inherit_context) {
          return textResult("Cannot combine `schedule` with `inherit_context` — there is no parent conversation at fire time.");
        }
        if (params.run_in_background === false) {
          return textResult("Cannot combine `schedule` with `run_in_background: false` — scheduled jobs always run in background.");
        }
        if (!scheduler.isActive()) {
          return textResult("Scheduler is not active in this session yet. Try again after the session has fully started.");
        }
        try {
          const job = scheduler.addJob({
            name: params.description as string,
            description: params.description as string,
            schedule: params.schedule as string,
            subagent_type: requestedType,
            prompt: params.prompt as string,
            model: params.model as string | undefined,
            thinking,
            max_turns: effectiveMaxTurns,
            isolated,
            isolation,
          });
          const next = scheduler.getNextRun(job.id);
          return textResult(
            `${fallbackNote}Scheduled "${job.name}" (id: ${job.id}, type: ${job.scheduleType}). ` +
            `Next run: ${next ?? "(unknown)"}. ` +
            `Manage via /agents → Scheduled jobs.`,
          );
        } catch (err) {
          return textResult(err instanceof Error ? err.message : String(err));
        }
      }

      if (params.resume) {
        const resumeId = params.resume as string;
        const existing = manager.getRecord(resumeId);
        if (!existing || !isTopLevelAgent(existing)) {
          return textResult(`Agent not found: "${resumeId}". It may have been cleaned up.`);
        }
        if (!existing.session) {
          return textResult(`Agent "${resumeId}" has no active session to resume.`);
        }
        const resumeMaxTurns = resumeTurnLimit(existing, params.max_turns as number | undefined);

        if (runInBackground) {
          const id = existing.id;
          if (existing.status === "running" || existing.status === "queued") {
            return textResult(
              `Agent "${resumeId}" is still ${existing.status} — it can only be resumed once its current run finishes.\n` +
              `Use steer_subagent to send it a message mid-run, or get_subagent_result to wait for it.`,
            );
          }

          const record = await startBackgroundResume(ctx, existing, params.prompt as string | undefined, {
            outputTranscript,
            maxTurns: resumeMaxTurns,
            toolCallId,
          });
          if (!record) {
            return textResult(`Failed to resume agent "${resumeId}".`);
          }

          const isQueued = record.status === "queued";
          return textResult(
            `Agent ${isQueued ? "queued" : "resumed"} in background.\n` +
            `Agent ID: ${id}\n` +
            `Type: ${existing.type}\n` +
            (record.outputFile ? `Output file: ${record.outputFile}\n` : "") +
            (isQueued ? `Position: queued (max ${manager.getMaxConcurrent()} concurrent)\n` : "") +
            `\nYou will be notified when this agent completes.\n` +
            `Use get_subagent_result to retrieve full results, or steer_subagent to send it messages.`,
            { ...detailBaseFor(record), toolUses: record.toolUses, tokens: "", durationMs: 0, status: "background" as const, agentId: id },
          );
        }

        const { state: resumeState, callbacks: resumeCallbacks } = createActivityTracker(resumeMaxTurns);
        resumeState.session = existing.session;
        agentActivity.set(existing.id, resumeState);
        widget.markRunning(existing.id);
        widget.ensureTimer();
        fleet.ensureTimer();
        fleet.update();
        let record: AgentRecord | undefined;
        try {
          record = await manager.resume(resumeId, params.prompt as string | undefined, signal, {
            maxTurns: resumeMaxTurns,
            onTurnEnd: resumeCallbacks.onTurnEnd,
            onToolActivity: resumeCallbacks.onToolActivity,
          });
        } finally {
          agentActivity.delete(existing.id);
          widget.markFinished(existing.id);
          fleet.onAgentFinished(existing.id);
        }
        if (!record) {
          return textResult(`Failed to resume agent "${resumeId}".`);
        }
        if (record.status === "error") {
          return textResult(`Agent failed: ${record.error}${partialOutputSuffix(record)}`, buildDetails(detailBaseFor(record), record, resumeState));
        }
        return textResult(
          record.result?.trim() || "No output.",
          buildDetails(detailBaseFor(record), record, resumeState),
        );
      }

      const backgroundResult = (id: string, record: AgentRecord | undefined) => {
        const isQueued = record?.status === "queued";
        return textResult(
          `${fallbackNote}Agent ${isQueued ? "queued" : "started"} in background.\n` +
          `Agent ID: ${id}\n` +
          `Type: ${displayName}\n` +
          `Description: ${params.description}\n` +
          (record?.outputFile ? `Output file: ${record.outputFile}\n` : "") +
          (isQueued ? `Position: queued (max ${manager.getMaxConcurrent()} concurrent)\n` : "") +
          `\nYou will be notified when this agent completes.\n` +
          `Use get_subagent_result to retrieve full results, or steer_subagent to send it messages.\n` +
          `Do not duplicate this agent's work.`,
          { ...detailBaseFor(record), toolUses: 0, tokens: "", durationMs: 0, status: "background" as const, agentId: id },
        );
      };

      if (runInBackground) {
        const { state: bgState, callbacks: bgCallbacks } = createActivityTracker(effectiveMaxTurns);

        let id: string;
        const origBgOnSession = bgCallbacks.onSessionCreated;
        bgCallbacks.onSessionCreated = (session: unknown) => {
          origBgOnSession(session);
          const rec = manager.getRecord(id);
          if (rec?.outputFile) {
            rec.outputCleanup = streamToOutputFile(session as any, rec.outputFile, id, ctx.cwd);
          }
        };

        id = manager.spawn(pi, ctx, subagentType, params.prompt as string, {
          description: params.description as string,
          name: params.name as string | undefined,
          model,
          maxTurns: effectiveMaxTurns,
          isolated,
          inheritContext,
          thinkingLevel: thinking,
          isBackground: true,
          isolation,
          invocation: agentInvocation,
          rootSessionId: ctx.sessionManager.getSessionId(),
          ...bgCallbacks,
        });

        const joinMode = resolveJoinMode(getDefaultJoinMode(), true);
        const record = manager.getRecord(id);
        if (record && joinMode) {
          record.joinMode = joinMode;
          record.toolCallId = toolCallId;
          attachTranscript(record, id);
        }

        await manager.awaitStartup(id);

        joinTurnGroup(id, joinMode);

        agentActivity.set(id, bgState);
        widget.ensureTimer();
        widget.update();
        fleet.ensureTimer();
        fleet.update();

        pi.events.emit("subagents:created", {
          id,
          type: subagentType,
          description: params.description,
          isBackground: true,
        });

        return backgroundResult(id, record);
      }

      let spinnerFrame = 0;
      const startedAt = Date.now();
      let fgId: string | undefined;
      let handoffId: string | undefined;
      let backgrounded = false;
      let queuedAhead: number | undefined;

      const streamUpdate = () => {
        if (backgrounded) return;
        const fgRecord = fgId ? manager.getRecord(fgId) : undefined;
        const details: AgentDetails = {
          ...detailBaseFor(fgRecord),
          toolUses: fgState.toolUses,
          tokens: fgRecord ? formatLifetimeTokens(fgRecord) : "",
          cost: fgRecord ? getLifetimeCost(fgRecord.lifetimeUsage) : 0,
          turnCount: fgState.turnCount,
          maxTurns: fgState.maxTurns,
          durationMs: Date.now() - startedAt,
          status: "running",
          activity: queuedAhead === undefined
            ? describeActivity(fgState.activeTools, fgState.responseText)
            : `queued — waiting for a foreground slot${queuedAhead > 0 ? ` (${queuedAhead} ahead)` : ""}`,
          spinnerFrame: spinnerFrame % SPINNER.length,
          backgroundHint: handoffId !== undefined && foregroundHandoffs.keys().next().value === handoffId,
        };
        onUpdate?.({
          content: [{ type: "text", text: `${fgState.toolUses} tool uses...` }],
          details: details as unknown as Record<string, unknown>,
        });
      };

      const { state: fgState, callbacks: fgCallbacks } = createActivityTracker(effectiveMaxTurns, streamUpdate);

      const origOnSession = fgCallbacks.onSessionCreated;
      fgCallbacks.onSessionCreated = (session: unknown) => {
        origOnSession(session);
        if (queuedAhead !== undefined) {
          queuedAhead = undefined;
          streamUpdate();
        }
        for (const a of manager.listAgents()) {
          if (a.session === session) {
            fgId = a.id;
            agentActivity.set(a.id, fgState);
            widget.ensureTimer();
            fleet.ensureTimer();
            fleet.update();
            break;
          }
        }
        if (fgId) {
          const rec = manager.getRecord(fgId);
          if (rec?.outputFile) {
            rec.outputCleanup = streamToOutputFile(session as any, rec.outputFile, fgId, ctx.cwd);
          }
        }
      };

      const spinnerInterval = setInterval(() => {
        spinnerFrame++;
        streamUpdate();
      }, 80);

      streamUpdate();

      let wakeBackgrounded!: () => void;
      const handedOff = new Promise<undefined>(resolve => { wakeBackgrounded = () => resolve(undefined); });

      let fgResult: { record: AgentRecord } | undefined;
      try {
        fgResult = await Promise.race([manager.spawnAndWait(pi, ctx, subagentType, params.prompt as string, {
          description: params.description as string,
          name: params.name as string | undefined,
          model,
          maxTurns: effectiveMaxTurns,
          isolated,
          inheritContext,
          thinkingLevel: thinking,
          isolation,
          invocation: agentInvocation,
          signal,
          rootSessionId: ctx.sessionManager.getSessionId(),
          onQueued: (_id, ahead) => { queuedAhead = ahead; streamUpdate(); },
          ...fgCallbacks,
        }, (fgAgentId) => {
          const fgRec = manager.getRecord(fgAgentId);
          attachTranscript(fgRec, fgAgentId);
          handoffId = fgAgentId;
          foregroundHandoffs.set(fgAgentId, () => {
            if (fgRec) {
              fgRec.toolCallId = toolCallId;
              fgRec.joinMode = "async";
            }
            backgrounded = true;
            wakeBackgrounded();
          });
        }), handedOff]);
      } finally {
        clearInterval(spinnerInterval);
        if (handoffId !== undefined) foregroundHandoffs.delete(handoffId);
        if (fgId && !backgrounded) {
          agentActivity.delete(fgId);
          widget.markFinished(fgId);
          fleet.onAgentFinished(fgId);
        }
      }

      if (fgResult === undefined) return backgroundResult(handoffId!, manager.getRecord(handoffId!));
      const record = fgResult.record;
      const tokenText = formatLifetimeTokens(record);
      const details = buildDetails(detailBaseFor(record), record, fgState, { tokens: tokenText });

      if (record.status === "error") {
        return textResult(`${fallbackNote}Agent failed: ${record.error}${partialOutputSuffix(record)}`, details);
      }

      const durationMs = (record.completedAt ?? Date.now()) - record.startedAt;
      const statsParts = [`${record.toolUses} tool uses`];
      if (tokenText) statsParts.push(tokenText);
      if (isShowCostEnabled()) {
        const costText = formatCost(getLifetimeCost(record.lifetimeUsage));
        if (costText) statsParts.push(costText);
      }
      return textResult(
        `${fallbackNote}Agent completed in ${formatMs(durationMs)} (${statsParts.join(", ")})${getForegroundOutcomeNote(record.status)}.\n\n` +
        (record.result?.trim() || "No output."),
        details,
      );
    },
  });
}
