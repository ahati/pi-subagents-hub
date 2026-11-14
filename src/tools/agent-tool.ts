import { type AgentSession, defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type AgentManager, isTopLevelAgent } from "../agent-manager.js";
import { AGENT_RECORD_ENTRY_TYPE, type AgentRecordEntryData, agentRecordEntryData, findAgentRecordEntry, reopenTarget } from "../agent-record-entry.js";
import { getDefaultMaxTurns, normalizeMaxTurns, SUBAGENT_TOOL_NAMES } from "../agent-runner.js";
import { getAgentConfig, getAvailableTypes, resolveSpawnType, resolveType } from "../agent-types.js";
import { generateDockerName } from "../docker-names.js";
import { buildDetails, createActivityTracker, formatLifetimeTokens, textResult } from "../entry/renderers.js";
import { resolveAgentInvocationConfig, resolveJoinMode } from "../invocation-config.js";
import { gateOf } from "../manager/manager-types.js";
import { describeModel, resolveModel } from "../model-resolver.js";
import { checkModelScope } from "../model-scope.js";
import { createOutputFilePath, ensureOutputFile, getOutputTranscriptDefault, streamToOutputFile, writeInitialEntry } from "../output-file.js";
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

/** UI and presentation services required by the Agent tool for status updates and widgets. */
export interface AgentToolPresentationDeps {
  agentActivity: Map<string, AgentActivity>;
  widget: AgentWidget;
  fleet: FleetList;
  isShowCostEnabled: () => boolean;
  getToolDescriptionMode: () => ToolDescriptionMode;
}

/** Execution, scheduling, and lifecycle services required to spawn or resume subagents. */
export interface AgentToolSpawnDeps {
  pi: ExtensionAPI;
  manager: AgentManager;
  scheduler: SubagentScheduler;
  foregroundHandoffs: Map<string, () => void>;
  reloadCustomAgents: () => void;
  getBackgroundByDefault: () => boolean;
  isSchedulingEnabled: () => boolean;
  isWorktreeIsolationEnabled: () => boolean;
  getDefaultJoinMode: () => JoinMode;
  resumeTurnLimit: (record: AgentRecord, explicit?: number) => number | undefined;
  startBackgroundResume: (
    ctx: ExtensionContext,
    existing: AgentRecord,
    prompt: string | undefined,
    opts: { outputTranscript: boolean; maxTurns?: number; toolCallId?: string },
  ) => Promise<AgentRecord | undefined>;
  joinTurnGroup: (id: string, joinMode: JoinMode | undefined) => void;
  resolveAgentRef: (ref: string) => AgentRecord | undefined;
}

/** Composite dependencies for creating the Agent tool (satisfies ISP via segregated sub-interfaces). */
export interface AgentToolDeps extends AgentToolPresentationDeps, AgentToolSpawnDeps {}

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
    resolveAgentRef,
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
      // Names Explore only when it can be spawned, as Claude Code does (#330).
      // Read at registration, like the type list in the description.
      `For broad codebase exploration or research, spawn Agent with an appropriate subagent_type${getAvailableTypes().includes("Explore") ? " (e.g. Explore)" : ""}. Otherwise use direct tools (read, grep, find) when the target is already known.`,
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

    execute: async (toolCallId, callParams, signal, onUpdate, ctx) => {
      widget.setUICtx(ctx.ui as UICtx);
      reloadCustomAgents();

      // A resume whose record is gone — evicted ten minutes after it finished,
      // or lost to a reload or restart — reopens the agent from the session's
      // saved record of it, under the same id, as Claude Code resumes from the
      // transcript on disk. This is an ordinary spawn carrying a session file,
      // like the `@handle` path's, so it runs through the spawn branches below
      // and picks up the widget, fleet row, transcript, join batching and
      // completion notification unchanged. Only the prompt, the turn budget and
      // run_in_background carry over from the call: like a live resume, it
      // ignores `subagent_type`, model and the rest, and runs under the agent
      // type's current definition.
      // `schedule` is left to its own branch, which refuses the combination.
      const resumeRef = callParams.resume;
      const liveExisting = resumeRef !== undefined ? resolveAgentRef(resumeRef) : undefined;
      const saved = resumeRef !== undefined && !callParams.schedule
        && liveExisting === undefined
        ? findAgentRecordEntry(ctx, resumeRef, true)
        : undefined;
      let reopenOptions: { resumeSessionFile: string; reclaim: { id: string; handle?: string; alias?: string } } | undefined;
      if (saved !== undefined) {
        const reopen = reopenTarget(saved.type, saved.sessionFile, saved.worktreeLost);
        if (!reopen.ok) return textResult(`Agent "${resumeRef}" cannot be resumed — ${reopen.reason}.`);
        reopenOptions = {
          resumeSessionFile: reopen.sessionFile,
          reclaim: { id: saved.id, handle: saved.handle, alias: saved.alias },
        };
      }
      const params: typeof callParams = saved === undefined ? callParams : {
        prompt: callParams.prompt,
        description: saved.description,
        name: saved.alias,
        subagent_type: saved.type,
        run_in_background: callParams.run_in_background,
        max_turns: callParams.max_turns,
        isolation: undefined,
        schedule: undefined,
      };

      const autoNamed = !params.name || params.name.trim() === "";
      if (autoNamed && !params.resume) {
        params.name = generateDockerName(manager.takenHandles?.());
      }

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

      let model: any = reopenOptions !== undefined ? undefined : ctx.model;
      if (reopenOptions !== undefined) {
        if (saved?.modelId) {
          const slash = saved.modelId.indexOf("/");
          const exact = slash !== -1
            ? ctx.modelRegistry?.find?.(saved.modelId.slice(0, slash), saved.modelId.slice(slash + 1))
            : undefined;
          if (exact) {
            model = exact;
          } else {
            const resolved = resolveModel(saved.modelId, ctx.modelRegistry);
            if (typeof resolved !== "string") model = resolved;
          }
        }
      } else if (resolvedConfig.modelInput) {
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
        callerSupplied: reopenOptions === undefined && resolvedConfig.modelFromParams,
        agentLabel: customConfig?.displayName ?? subagentType,
        modelInput: reopenOptions === undefined ? resolvedConfig.modelInput : saved?.modelId,
      });
      if (scopeVerdict.kind === "error") return textResult(scopeVerdict.message);
      if (scopeVerdict.kind === "warn") ctx.ui.notify(scopeVerdict.message, "warning");

      const thinking = reopenOptions !== undefined
        ? (saved?.thinking && saved.thinking !== "off" ? saved.thinking : undefined)
        : resolvedConfig.thinking;
      const inheritContext = resolvedConfig.inheritContext;
      const runInBackground = resolvedConfig.runInBackground;
      const isolated = resolvedConfig.isolated;
      const isolation = resolvedConfig.isolation;

      const outputTranscript = customConfig?.outputTranscript ?? getOutputTranscriptDefault();
      const attachTranscript = (rec: AgentRecord | undefined, agentId: string): void => {
        if (!rec || !outputTranscript) return;
        rec.outputFile = createOutputFilePath(ctx.cwd, agentId, ctx.sessionManager.getSessionId());
        // A reopened agent keeps its id, so this is the transcript its earlier
        // runs wrote: append to it, as a live resume does, never truncate it.
        if (reopenOptions) ensureOutputFile(rec.outputFile);
        else writeInitialEntry(rec.outputFile, agentId, params.prompt as string, ctx.cwd);
      };
      // Where a reopened agent's transcript stream starts: past the turns the
      // reopened session already holds, so its new prompt is written once and
      // the old turns are not written again. A spawn starts from its prompt.
      const transcriptAnchor = (session: AgentSession): number | undefined =>
        reopenOptions ? session.messages.length : undefined;

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
        // Neither is applied to a reopened conversation (runAgent, the
        // manager), so neither is shown.
        inheritContext: reopenOptions ? undefined : inheritContext,
        runInBackground,
        isolation: reopenOptions ? undefined : isolation,
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
        const resumeRef = params.resume as string;
        const existing = resolveAgentRef(resumeRef);
        if (!existing || !isTopLevelAgent(existing)) {
          return textResult(`Agent not found: "${resumeRef}". It may have been cleaned up.`);
        }
        const resumeId = existing.id;
        if (!existing.session) {
          return textResult(`Agent "${resumeRef}" has no active session to resume.`);
        }
        const resumeMaxTurns = resumeTurnLimit(existing, params.max_turns as number | undefined);
        const gated = gateOf(existing)?.closed;
        if (!gated && (existing.status === "running" || existing.status === "queued")) {
          return textResult(
            `Agent "${resumeRef}" is still ${existing.status} — it can only be resumed once its current run finishes.\n` +
            `Use steer_subagent to send it a message mid-run, or get_subagent_result to wait for it.`,
          );
        }

        if (runInBackground) {
          const id = existing.id;

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
        // A foreground resume settles inline, never through the completion
        // callback, so persist its outcome here: get_subagent_result must find
        // this run's result, not the earlier run's, once the live record is gone.
        pi.appendEntry<AgentRecordEntryData>(AGENT_RECORD_ENTRY_TYPE, agentRecordEntryData(record));
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
        const agentName = record?.alias || params.name;
        return textResult(
          `${fallbackNote}Agent ${isQueued ? "queued" : reopenOptions ? "resumed from its saved session" : "started"} in background.\n` +
          `Agent ID: ${id}\n` +
          (agentName ? `Agent Name: ${agentName}\n` : "") +
          `Type: ${displayName}\n` +
          `Description: ${params.description}\n` +
          (record?.outputFile ? `Output file: ${record.outputFile}\n` : "") +
          (isQueued ? `Position: queued (max ${manager.getMaxConcurrent()} concurrent)\n` : "") +
          `\nYou will be notified when this agent completes.\n` +
          `Use get_subagent_result to retrieve full results, or steer_subagent to send it messages.\n` +
          (agentName ? `To resume this agent later, pass its name or ID to Agent with resume: "${agentName}".\n` : "") +
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
            rec.outputCleanup = streamToOutputFile(session as any, rec.outputFile, id, ctx.cwd, transcriptAnchor(session as AgentSession));
          }
        };

        id = manager.spawn(pi, ctx, subagentType, params.prompt as string, {
          description: params.description as string,
          name: params.name as string | undefined,
          autoNamed,
          model,
          maxTurns: effectiveMaxTurns,
          isolated,
          inheritContext,
          thinkingLevel: thinking,
          isBackground: true,
          isolation,
          invocation: agentInvocation,
          rootSessionId: ctx.sessionManager.getSessionId(),
          ...reopenOptions,
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
            ? describeActivity(fgState.activeTools, fgState.responseText, fgState.lastTool, fgState.lastActivity === "tool")
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
            rec.outputCleanup = streamToOutputFile(session as any, rec.outputFile, fgId, ctx.cwd, transcriptAnchor(session as AgentSession));
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
          autoNamed,
          model,
          maxTurns: effectiveMaxTurns,
          isolated,
          inheritContext,
          thinkingLevel: thinking,
          isolation,
          invocation: agentInvocation,
          signal,
          rootSessionId: ctx.sessionManager.getSessionId(),
          ...reopenOptions,
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
      const agentName = record.alias || params.name;
      const agentHeader = agentName ? `Agent: ${agentName}\n` : "";
      return textResult(
        `${fallbackNote}Agent completed in ${formatMs(durationMs)} (${statsParts.join(", ")})${getForegroundOutcomeNote(record.status)}.\n` +
        (agentHeader ? `${agentHeader}\n` : "\n") +
        (record.result?.trim() || "No output."),
        details,
      );
    },
  });
}
