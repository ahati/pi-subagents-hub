/**
 * hub-panes.ts — Roster, run preview, and run list pane builders for AgentHub.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { renderAgentRecordName } from "../../agent-color.js";
import { extractText } from "../../context.js";
import type { AgentRecord, UIStyle } from "../../types.js";
import { getLifetimeTotal } from "../../usage.js";
import {
  buildPhaseGroups,
  currentPhaseIndex,
  displayState,
  flattenRunAgents,
  type PhaseGroup,
  type WorkflowAgentEntry,
  type WorkflowRunStatus,
} from "../../workflow/progress.js";
import type { ActiveToolCall, AgentActivity, Theme } from "../agent-widget.js";
import { describeActivity } from "../agent-widget.js";
import type { FleetWorkflow } from "../fleet-list.js";
import { type WindowRow, windowRange } from "../window-frame.js";
import { clampLine, type WorkflowCardLine } from "../workflow-card.js";
import {
  agentRow,
  phaseListRows,
  UNICODE_DIALOG_GLYPHS,
  type WorkflowDialogSource,
} from "../workflow-view.js";
import {
  finishRow,
  runHeaderLines,
  statusGlyph,
  workflowStatusGlyph,
} from "./hub-headers.js";
import {
  type AgentHubDeps,
  assistantTurnCount,
  fullRow,
  HEADER_RULE,
  type HubEntry,
  type HubPage,
  type HubRosterItem,
  lastNonEmptyLine,
  lifecycleRank,
  type PaneRow,
  padLines,
  ROSTER_SUBAGENTS_LABEL,
  ROSTER_WORKFLOWS_LABEL,
  RUN_AGENTS_LABEL,
  WORKFLOW_NO_AGENTS,
} from "./hub-types.js";

export interface HubPaneHost {
  deps: AgentHubDeps;
  theme: Theme;
  page: HubPage;
  effectiveStyle(): UIStyle;
  bodyRows(rows: number, note: boolean): number;
  runSource(id?: string): WorkflowDialogSource | undefined;
  currentRun(): FleetWorkflow | undefined;
  runAgents(): readonly WorkflowAgentEntry[];
  clampRunAgentIndex(): number;
  clampRunItemIndex(groups?: readonly PhaseGroup[], entries?: readonly WorkflowAgentEntry[]): number;
}

export function identityPane(
  identity: WorkflowCardLine[],
  body: readonly PaneRow[],
  note?: WorkflowCardLine,
): PaneRow[] {
  return [...identity, HEADER_RULE, ...body, ...(note ? [note] : [])];
}

export function noteLine(text: string, width: number): WorkflowCardLine {
  return clampLine([{ text, color: "dim" }], width);
}

export function runGroups(host: HubPaneHost, id: string): PhaseGroup[] {
  const source = host.runSource(id);
  return source ? buildPhaseGroups(source.progress, source.meta?.phases) : [];
}

export function runPhaseMark(groups: readonly PhaseGroup[]): number {
  return currentPhaseIndex(groups);
}

export function runAgentLive(
  host: HubPaneHost,
  entry: WorkflowAgentEntry,
  runStatus: WorkflowRunStatus,
): { turns?: number; tokens?: number; tail?: string } | undefined {
  if (entry.recordId === undefined) return undefined;
  const state = displayState(entry, runStatus);
  if (state !== "running" && state !== "paused") return undefined;
  const record = host.deps.manager.listAgents().find(a => a.id === entry.recordId);
  const activity = host.deps.agentActivity.get(entry.recordId);
  if (record === undefined && activity === undefined) return undefined;
  return {
    turns: activity?.turnCount ?? assistantTurnCount(record?.session?.messages),
    tokens: record ? getLifetimeTotal(record.lifetimeUsage) : entry.tokens,
    tail: runAgentTail(record, activity),
  };
}

export function runAgentTail(record: AgentRecord | undefined, activity: AgentActivity | undefined): string {
  const tools = activity?.activeTools ?? new Map<string, ActiveToolCall>();
  if (tools.size > 0) return describeActivity(tools, activity?.responseText);
  const streamed = lastNonEmptyLine(activity?.responseText ?? "");
  if (streamed) return streamed;
  // Between turns (or untracked) — walk the transcript newest-first. An
  // assistant message contributes its last line; a tool result its first
  // contentful line (the head names what it did — the tail is whatever the
  // output ended on: `}` of pretty-printed JSON, a truncation marker, a frame).
  const messages = record?.session?.messages ?? [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.role !== "assistant" && message.role !== "toolResult") continue;
    const text = extractText(message.content as unknown[]);
    if (message.role === "assistant") {
      const line = lastNonEmptyLine(text);
      if (line) return line;
    } else {
      for (const line of text.split("\n")) {
        const trimmed = line.trim();
        if (trimmed && /\w/.test(trimmed)) return trimmed;
      }
    }
  }
  return "thinking…";
}

export function buildRunPreviewLines(
  run: FleetWorkflow,
  width: number,
  rows: number,
  host: HubPaneHost,
): PaneRow[] {
  const source = host.runSource(run.id);
  const groups = source ? buildPhaseGroups(source.progress, source.meta?.phases) : [];
  const body: PaneRow[] = [];
  if (groups.length > 0) {
    body.push(clampLine([{ text: "PHASES", color: "muted", bold: true }], width));
    body.push(...phaseListRows({
      groups,
      selectedPhase: currentPhaseIndex(groups),
      capacity: Math.max(0, host.bodyRows(rows, true) - body.length),
      width,
      glyphs: UNICODE_DIALOG_GLYPHS,
    }));
  }
  return identityPane(
    runHeaderLines({ run, groups, width, th: host.theme }),
    body,
    noteLine("(⏎ opens the run page)", width),
  );
}

export function buildRunPaneLines(
  width: number,
  rows: number,
  host: HubPaneHost,
): PaneRow[] {
  const run = host.currentRun();
  if (!run) return [clampLine([{ text: host.theme.fg("dim", "run detail unavailable") }], width)];
  const identity = runHeaderLines({ run, groups: runGroups(host, run.id), width, th: host.theme });
  const source = host.runSource(run.id);
  if (!source) return identityPane(identity, [noteLine("run detail unavailable", width)]);
  const capacity = host.bodyRows(rows, false);
  const glyphs = UNICODE_DIALOG_GLYPHS;
  const groups = buildPhaseGroups(source.progress, source.meta?.phases);
  const entries = flattenRunAgents(source.progress, source.meta?.phases);
  const mark = runPhaseMark(groups);
  const item = host.clampRunItemIndex(groups, entries);
  const agentSel = item >= groups.length ? item - groups.length : undefined;
  const lines: PaneRow[] = [clampLine([{ text: "PHASES", color: "muted", bold: true }], width)];
  const phaseCapacity = Math.max(0, capacity - 4);
  lines.push(
    ...phaseListRows({
      groups,
      selectedPhase: mark,
      cursor: item < groups.length ? item : undefined,
      capacity: phaseCapacity,
      width,
      glyphs,
    }),
  );
  lines.push([]);
  lines.push(clampLine([{ text: RUN_AGENTS_LABEL, color: "muted", bold: true }], width));
  const selection = agentSel ?? host.clampRunAgentIndex();
  const slice = windowRange(selection, entries.length, Math.max(1, capacity - lines.length));
  if (entries.length === 0) lines.push(clampLine([{ text: `   ${WORKFLOW_NO_AGENTS}`, color: "dim" }], width));
  for (let i = slice.start; i < slice.end; i++) {
    lines.push(
      ...agentRow({
        entry: entries[i],
        selected: i === agentSel,
        compact: false,
        width,
        glyphs,
        runStatus: source.task.status,
        spinnerFrame: 0,
        now: Date.now(),
        live: runAgentLive(host, entries[i], source.task.status),
      }),
    );
  }
  return identityPane(identity, padLines(lines, capacity));
}

export function buildRunLeftLines(
  width: number,
  rows: number,
  host: HubPaneHost,
): WorkflowCardLine[] {
  const source = host.runSource();
  if (!source) return [clampLine([{ text: host.theme.fg("dim", "run detail unavailable") }], width)];
  const glyphs = UNICODE_DIALOG_GLYPHS;
  const groups = buildPhaseGroups(source.progress, source.meta?.phases);
  const mark = runPhaseMark(groups);
  const entries = flattenRunAgents(source.progress, source.meta?.phases);
  const selection = host.clampRunAgentIndex();
  const lines: WorkflowCardLine[] = [];
  const heading = (title: string) => clampLine([{ text: title, color: "muted", bold: true }], width);
  const phaseFirst = host.page === "L";
  if (phaseFirst && groups.length > 0) {
    lines.push(heading("PHASES"));
    lines.push(
      ...phaseListRows({ groups, selectedPhase: mark, capacity: Math.max(0, rows - lines.length - 2), width, glyphs }),
    );
    if (lines.length < rows) lines.push([]);
  }
  const phaseBlock = groups.length > 0 ? groups.length + 2 : 0;
  if (entries.length === 0) {
    lines.push(clampLine([{ text: `   ${WORKFLOW_NO_AGENTS}`, color: "dim" }], width));
  } else {
    if (phaseFirst && groups.length > 0) lines.push(heading(RUN_AGENTS_LABEL));
    const capacity = Math.max(1, phaseFirst ? rows - lines.length : rows - phaseBlock - lines.length);
    const slice = windowRange(selection, entries.length, capacity);
    for (let i = slice.start; i < slice.end; i++) {
      const isSelected = i === selection;
      const rows = agentRow({
        entry: entries[i],
        selected: isSelected,
        compact: host.page !== "L",
        width,
        glyphs,
        runStatus: source.task.status,
        spinnerFrame: 0,
        now: Date.now(),
      });
      if (isSelected) {
        lines.push(...rows.map(r => r.map(seg => ({ ...seg, bg: "selectedBg" as const }))));
      } else {
        lines.push(...rows);
      }
    }
  }
  if (!phaseFirst && groups.length > 0) {
    if (lines.length < rows) lines.push([]);
    lines.push(heading("PHASES"));
    lines.push(...phaseListRows({ groups, selectedPhase: mark, capacity: Math.max(0, rows - lines.length), width, glyphs }));
  }
  return lines;
}

export function renderEntry(entry: HubEntry, selected: boolean, width: number, th: Theme): string {
  const marker = selected ? th.fg("accent", "❯") : " ";
  if (entry.kind === "workflow") {
    const wf = entry.workflow;
    const glyph = workflowStatusGlyph(wf.status, th);
    const name = selected ? th.fg("text", wf.name) : th.fg("muted", wf.name);
    const counter = `${wf.doneCount}/${wf.totalCount}`;
    const prefix = `${marker} ${glyph} `;
    return finishRow(
      `${prefix}${name}`,
      visibleWidth(prefix),
      selected ? th.fg("text", counter) : th.fg("dim", counter),
      width,
    );
  }
  const record = entry.record;
  const glyph = statusGlyph(record.status, th);
  const name = renderAgentRecordName(record, th, selected
    ? { fallbackColor: "text", bold: true }
    : { fallbackColor: "muted" });
  return truncateToWidth(`${marker} ${glyph} ${name}`, width, "…");
}

export function buildRosterLines(
  width: number,
  rows: number,
  items: readonly HubEntry[],
  selected: number,
  activeFilter: string,
  th: Theme,
): WorkflowCardLine[] {
  if (items.length === 0) {
    return [clampLine([{ text: th.fg("dim", activeFilter ? "no matches" : "(no agents yet — spawn one to see it here)") }], width)];
  }
  const display: HubRosterItem[] = [];
  const agents = items.filter((e): e is HubEntry & { kind: "agent" } => e.kind === "agent");
  const workflows = items.filter((e): e is HubEntry & { kind: "workflow" } => e.kind === "workflow");
  if (agents.length > 0) {
    display.push({ kind: "header", label: ROSTER_SUBAGENTS_LABEL });
    display.push(...agents);
  }
  if (workflows.length > 0) {
    display.push({ kind: "header", label: ROSTER_WORKFLOWS_LABEL });
    display.push(...workflows);
  }

  const selectedEntry = items[selected];
  const selAt = Math.max(0, display.findIndex(item => item.kind !== "header" && item === selectedEntry));
  const slice = windowRange(selAt, display.length, rows);

  const lines: WorkflowCardLine[] = [];
  for (let i = 0; i < rows; i++) {
    const item = display[slice.start + i];
    if (!item) { lines.push([]); continue; }
    if (item.kind === "header") {
      lines.push([{ text: item.label, color: "dim", bold: true }]);
      continue;
    }
    const isSelected = item === selectedEntry;
    lines.push(clampLine([{
      text: renderEntry(item, isSelected, width, th),
      ...(isSelected ? { bg: "selectedBg" as const } : {}),
    }], width));
  }
  return lines;
}

export function buildActivityTitle(width: number, agents: readonly AgentRecord[], th: Theme): string {
  const running = agents.filter(a => a.status === "running" || a.status === "queued").length;
  return truncateToWidth(`${th.bold("Agents & Workflows")} ${th.fg("dim", `· activity · ${agents.length} agents · ${running} active`)}`, width);
}

export function buildActivityLines(
  bodyRows: number,
  items: readonly HubEntry[],
  agentActivity: Map<string, AgentActivity>,
  th: Theme,
): WindowRow[] {
  const lines: WindowRow[] = [];
  const sorted = [...items].sort((a, b) => {
    if (a.kind !== "agent" || b.kind !== "agent") return 0;
    return lifecycleRank(a.record.status) - lifecycleRank(b.record.status)
      || a.record.startedAt - b.record.startedAt;
  });
  if (sorted.length === 0) {
    lines.push(fullRow(th.fg("dim", "(nothing running)")));
    return lines;
  }
  for (let i = 0; i < bodyRows; i++) {
    const entry = sorted[i];
    if (!entry) { lines.push(fullRow("")); continue; }
    if (entry.kind === "workflow") {
      const wf = entry.workflow;
      lines.push(fullRow(
        `${th.fg("muted", "workflow")} ${wf.name}  ${th.fg("dim", `${wf.doneCount}/${wf.totalCount} agents · ${wf.status}`)}`,
      ));
      continue;
    }
    const record = entry.record;
    const act = agentActivity.get(record.id);
    const doing = act
      ? describeActivity(act.activeTools, act.responseText)
      : record.status === "running" ? "thinking…" : record.status;
    const turns = act?.maxTurns ? ` · turn ${act.turnCount}/${act.maxTurns}` : act ? ` · turn ${act.turnCount}` : "";
    const line = `${statusGlyph(record.status, th)} ${renderAgentRecordName(record, th, {})}  ${th.fg(record.status === "running" ? "text" : "dim", doing)}${th.fg("dim", turns)}`;
    lines.push(fullRow(line));
  }
  return lines;
}
