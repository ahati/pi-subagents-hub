import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { defineTool, type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import type { AgentManager } from "../agent-manager.js";
import { SUBAGENT_TOOL_NAMES } from "../agent-runner.js";
import type { CompletionOutbox } from "../completion-outbox.js";
import { textResult, WORKFLOW_FILE_FLAG } from "../entry/renderers.js";
import { sessionTaskDir } from "../output-file.js";
import type { AgentWidget } from "../ui/agent-widget.js";
import type { FleetList, FleetWorkflow } from "../ui/fleet-list.js";
import { renderWorkflowCard } from "../ui/workflow-card.js";
import { decideWorkflowCollision } from "../workflow/collisions.js";
import { WORKFLOW_ENTRY_TYPE, type WorkflowEntryData, workflowEntryData } from "../workflow/entry.js";
import { createWorkflowHost } from "../workflow/host.js";
import { appendJournal, readJournal, type WorkflowJournalEntry } from "../workflow/journal.js";
import { extractMeta, type WorkflowMeta, workflowCallName } from "../workflow/meta.js";
import { elapsedMs } from "../workflow/progress.js";
import { runWorkflow } from "../workflow/runtime.js";
import { resolveWorkflowScript } from "../workflow/saved.js";
import {
  completeWorkflowTask,
  createWorkflowTask,
  failWorkflowTask,
  formatWorkflowNotification,
  resolveResumeTarget,
  updateWorkflowProgressBatch,
  type WorkflowTask,
  workflowResultText,
  workflowRunId,
} from "../workflow/task.js";
import { fullWorkflowToolDescription } from "../workflow/tool-description.js";
import { buildCompactTypeListText, buildTypeListText } from "./agent-tool-schema.js";

export interface WorkflowToolDeps {
  pi: ExtensionAPI;
  manager: AgentManager;
  workflowTasks: Map<string, WorkflowTask>;
  widget: AgentWidget;
  fleet: FleetList;
  outbox: CompletionOutbox;
  isWorkflowsEnabled: () => boolean;
  isWorkflowsPinned: () => boolean;
  setWorkflowsDisabledByCollision: () => void;
  isWorktreeIsolationEnabled: () => boolean;
  isSchedulingEnabled: () => boolean;
}

export function fleetWorkflows(workflowTasks: Map<string, WorkflowTask>): FleetWorkflow[] {
  return [...workflowTasks.values()].map(task => ({
    id: task.id,
    name: task.meta?.name ?? task.workflowName ?? task.id,
    status: task.status,
    doneCount: task.doneCount,
    totalCount: task.agentCount,
    startedAt: task.startTime,
    ...(task.endTime !== undefined ? { completedAt: task.endTime } : {}),
    tokens: task.totalTokens,
  }));
}

export async function runWorkflowTask(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  manager: AgentManager,
  task: WorkflowTask,
): Promise<void> {
  try {
    const result = await runWorkflow({
      script: task.script,
      args: task.args,
      signal: task.abortController.signal,
      host: createWorkflowHost({
        pi,
        ctx,
        manager,
        signal: task.abortController.signal,
        rootSessionId: ctx.sessionManager.getSessionId(),
        workflowId: task.id,
      }),
      onProgress: entries => updateWorkflowProgressBatch(task, entries),
      onControl: control => { task.control = control; },
      journal: {
        ...(task.replay !== undefined ? { entries: task.replay } : {}),
        ...(task.journalPath !== undefined
          ? { append: (entry: WorkflowJournalEntry) => appendJournal(task.journalPath!, entry) }
          : {}),
      },
    });
    completeWorkflowTask(task, result);
  } catch (err) {
    failWorkflowTask(task, err instanceof Error ? err.message : String(err));
  }
}

export function notifyWorkflowFinished(
  task: WorkflowTask,
  widget: AgentWidget,
  fleet: FleetList,
  outbox: CompletionOutbox,
): void {
  widget.update();
  fleet.update();
  const result = workflowResultText(task);
  const message = {
    content: formatWorkflowNotification(task),
    details: {
      id: task.id,
      description: `Workflow ${task.workflowName ?? task.id}`,
      status: task.status === "completed" ? "completed" as const : task.status === "killed" ? "stopped" as const : "error" as const,
      toolUses: task.totalToolCalls,
      turnCount: 0,
      totalTokens: task.totalTokens,
      durationMs: elapsedMs(task, Date.now()),
      error: task.error,
      resultPreview: result.length > 500 ? `${result.slice(0, 500)}…` : result,
    },
  };
  outbox.add({ ids: [task.id], build: () => message });
}

export function createWorkflowTool(deps: WorkflowToolDeps) {
  const {
    pi,
    manager,
    workflowTasks,
    widget,
    fleet,
    outbox,
    isWorktreeIsolationEnabled,
    isSchedulingEnabled,
  } = deps;

  const isolationGuideline = isWorktreeIsolationEnabled()
    ? `\n- Use isolation: "worktree" to give the agent its own git worktree (safe parallel file modifications); leave it unset, or pass "off", for none. The worktree is removed when the agent finishes; if it made changes, they are committed to a branch and the branch is named in the result.`
    : "";

  const scheduleGuideline = isSchedulingEnabled()
    ? `\n- Use \`schedule\` only when the user explicitly asked for scheduled / recurring / delayed execution (e.g. "every Monday", "in an hour"). Don't auto-schedule from vague intent like "monitor X" — run once now or ask.`
    : "";

  const renderToolDescriptionTemplate = (template: string): string => {
    const vars: Record<string, () => string> = {
      typeList: buildTypeListText,
      compactTypeList: buildCompactTypeListText,
      agentDir: getAgentDir,
      isolationGuideline: () => isolationGuideline,
      scheduleGuideline: () => scheduleGuideline,
    };
    return template.replace(/\{\{(\w+)\}\}/g, (raw, name: string) => {
      if (vars[name]) return vars[name]();
      console.warn(`[pi-subagents-hub] agent-tool-description.md: unknown placeholder ${raw} left as-is`);
      return raw;
    });
  };

  return defineTool({
    name: SUBAGENT_TOOL_NAMES.WORKFLOW,
    label: "SubagentWorkflow",
    description: renderToolDescriptionTemplate(fullWorkflowToolDescription),
    promptSnippet: "Run a deterministic script that orchestrates many subagents",
    promptGuidelines: [
      "Use SubagentWorkflow when the number of agents depends on something discovered at runtime, when work flows through stages, or when findings should be independently verified. Use Agent for one delegated task or a handful you can name up front.",
      "Prefer `pipeline` over `parallel` — a barrier costs wall-clock whenever the stages are unevenly sized.",
      "A workflow runs in the background and notifies you when it finishes — do not poll or sleep waiting for it.",
    ],
    parameters: Type.Object({
      script: Type.Optional(
        Type.String({
          maxLength: 524288,
          description: "Inline workflow source. Must begin with `export const meta = { name, description }`.",
        }),
      ),
      scriptPath: Type.Optional(
        Type.String({
          description:
            "Path to a workflow script file, absolute or relative to the project. Takes precedence over `script` — this is how you re-run an edited workflow.",
        }),
      ),
      name: Type.Optional(
        Type.String({
          description:
            "Name of a saved workflow — `<name>.js` in .pi/workflows/, .agents/workflows/ or the user's agent dir. Lowest precedence: `scriptPath` and `script` both win over it.",
        }),
      ),
      args: Type.Optional(
        Type.Any({
          description: "Exposed to the script as the global `args`, verbatim. Must be JSON-shaped.",
        }),
      ),
      resumeFromRunId: Type.Optional(
        Type.String({
          pattern: "^wf_[a-z0-9-]{6,}$",
          description:
            "Run id of an earlier workflow in this session. Its unchanged leading agent() calls return their recorded results instantly; the first changed or failed call, and everything after it, runs live. Same script and args is usually, but not always, a full cache hit — calls are numbered in the order they arrive, so a pipeline() that interleaves differently the second time misses from that point on.",
        }),
      ),
      title: Type.Optional(
        Type.String({ description: "Ignored — set the workflow title in the script's `meta` block." }),
      ),
      description: Type.Optional(
        Type.String({ description: "Ignored — set the workflow description in the script's `meta` block." }),
      ),
    }),

    renderCall(args, theme) {
      return new Text(
        `${theme.fg("toolTitle", "▸ ")}${theme.bold(theme.fg("toolTitle", "SubagentWorkflow"))}  ${theme.fg("muted", workflowCallName(args))}`,
        0,
        0,
      );
    },

    renderResult(result, _options, theme, renderContext) {
      const text = result.content[0]?.type === "text" ? result.content[0].text : "";
      const taskId = (result.details as { taskId?: string } | undefined)?.taskId;
      const task = taskId !== undefined ? workflowTasks.get(taskId) : undefined;
      if (renderContext.isError || !task) return new Text(text, 0, 0);
      return renderWorkflowCard(
        {
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
          totalTokens: task.totalTokens,
        },
        theme,
      );
    },

    execute: async (toolCallId, params, _signal, _onUpdate, ctx) => {
      const resumeFrom = resolveResumeTarget(params.resumeFromRunId, workflowTasks);
      if (resumeFrom !== undefined && !resumeFrom.ok) return textResult(resumeFrom.message);

      const resolved = resolveWorkflowScript(
        params.script === undefined && params.scriptPath === undefined && params.name === undefined
          && resumeFrom !== undefined
          ? { scriptPath: resumeFrom.scriptPath }
          : params,
        ctx.cwd,
      );
      if (!resolved.ok) return textResult(resolved.message);

      let meta: WorkflowMeta;
      try {
        meta = extractMeta(resolved.script).meta;
      } catch (err) {
        return textResult(err instanceof Error ? err.message : String(err));
      }

      const runId = workflowRunId();
      let savedPath: string | undefined;
      let journalPath: string | undefined;
      try {
        const dir = sessionTaskDir(ctx.cwd, ctx.sessionManager.getSessionId());
        savedPath = join(dir, `${runId}.workflow.js`);
        writeFileSync(savedPath, resolved.script, "utf-8");
        journalPath = join(dir, `${runId}.workflow.jsonl`);
      } catch (err) {
        savedPath = undefined;
        journalPath = undefined;
        console.warn(`[pi-subagents-hub] could not persist workflow script: ${err instanceof Error ? err.message : String(err)}`);
      }

      const replay = resumeFrom !== undefined ? readJournal(resumeFrom.journalPath) : undefined;

      const task = createWorkflowTask({
        id: runId,
        script: resolved.script,
        scriptPath: resolved.scriptPath ?? savedPath,
        args: params.args,
        meta,
        toolCallId,
        ...(journalPath !== undefined ? { journalPath } : {}),
        ...(replay !== undefined && replay.length > 0 ? { replay, resumedFrom: resumeFrom!.runId } : {}),
      });
      workflowTasks.set(runId, task);
      widget.update();
      fleet.update();

      void runWorkflowTask(pi, ctx, manager, task).then(() => notifyWorkflowFinished(task, widget, fleet, outbox));

      return {
        content: [{
          type: "text" as const,
          text:
            `Workflow "${meta.name}" started in the background.\n` +
            `Task ID: ${runId}\n` +
            (task.scriptPath ? `Script: ${task.scriptPath}\n` : "") +
            (task.resumedFrom !== undefined
              ? `Resuming ${task.resumedFrom}: ${task.replay?.length ?? 0} recorded call(s) available to replay.\n`
              : params.resumeFromRunId !== undefined
                ? `Nothing to replay from ${params.resumeFromRunId} — every agent runs live.\n`
                : "") +
            `\nYou will be notified when it finishes — do NOT poll or sleep waiting for it.\n` +
            `To iterate, edit the script file and call SubagentWorkflow again with scriptPath.`,
        }],
        details: { taskId: runId },
      };
    },
  });
}

export function resolveWorkflowCollisions(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  workflowToolDescription: string,
  deps: {
    isWorkflowsEnabled: () => boolean;
    isWorkflowsPinned: () => boolean;
    setWorkflowsDisabledByCollision: () => void;
    updateUi: () => void;
  },
  state: { collisionsChecked: boolean },
): void {
  if (state.collisionsChecked) return;
  state.collisionsChecked = true;

  const warn = (message: string) => {
    if (ctx.hasUI) ctx.ui.notify(message, "warning");
    else console.warn(`[pi-subagents-hub] ${message}`);
  };

  try {
    if (!deps.isWorkflowsEnabled()) return;

    const verdict = decideWorkflowCollision({
      tools: pi.getAllTools(),
      ownDescription: workflowToolDescription,
      pinned: deps.isWorkflowsPinned(),
    });
    if (verdict.kind === "none") return;
    if (verdict.kind === "report") {
      warn(verdict.message);
      return;
    }

    deps.setWorkflowsDisabledByCollision();
    deps.updateUi();
    warn(verdict.message);

    if (!verdict.withdraw) return;
    const active = pi.getActiveTools();
    if (active.includes(SUBAGENT_TOOL_NAMES.WORKFLOW)) {
      pi.setActiveTools(active.filter(name => name !== SUBAGENT_TOOL_NAMES.WORKFLOW));
    }
  } catch {
    // getAllTools/setActiveTools are unavailable in some hosts
  }
}

export function runWorkflowFlag(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  manager: AgentManager,
  workflowTasks: Map<string, WorkflowTask>,
  widget: AgentWidget,
  fleet: FleetList,
  isWorkflowsEnabled: () => boolean,
  state: { workflowFlagHandled: boolean },
): void {
  if (state.workflowFlagHandled) return;
  const flag = pi.getFlag(WORKFLOW_FILE_FLAG);
  if (flag === undefined || flag === false) return;
  state.workflowFlagHandled = true;

  const report = (message: string, level: "info" | "warning") => {
    if (ctx.hasUI) ctx.ui.notify(message, level);
    else console.warn(`[pi-subagents-hub] ${message}`);
  };

  if (!isWorkflowsEnabled()) {
    report(
      `--${WORKFLOW_FILE_FLAG} ignored: workflows are off. Turn them on in /agents → Settings → Workflows, ` +
        'or set `"workflowsEnabled": true` in .pi/subagents.json.',
      "warning",
    );
    return;
  }

  if (typeof flag !== "string" || flag.trim() === "") {
    report(`--${WORKFLOW_FILE_FLAG} needs a path: --${WORKFLOW_FILE_FLAG}=<path>`, "warning");
    return;
  }

  const path = isAbsolute(flag.trim()) ? flag.trim() : join(ctx.cwd, flag.trim());
  let script: string;
  try {
    script = readFileSync(path, "utf-8");
  } catch (err) {
    report(`Could not read ${path}: ${err instanceof Error ? err.message : String(err)}`, "warning");
    return;
  }

  let meta: WorkflowMeta | undefined;
  try {
    meta = extractMeta(script).meta;
  } catch (err) {
    report(err instanceof Error ? err.message : String(err), "warning");
    return;
  }

  const task = createWorkflowTask({ id: workflowRunId(), script, scriptPath: path, meta });
  workflowTasks.set(task.id, task);
  widget.update();
  fleet.update();
  report(`Running workflow ${meta.name}…`, "info");

  void runWorkflowTask(pi, ctx, manager, task).then(() => {
    pi.appendEntry<WorkflowEntryData>(WORKFLOW_ENTRY_TYPE, workflowEntryData(task));
    pi.sendMessage({
      customType: "workflow-result",
      content: formatWorkflowNotification(task),
      display: false,
    }, { deliverAs: "nextTurn" });
    widget.update();
    fleet.update();
  });
}
