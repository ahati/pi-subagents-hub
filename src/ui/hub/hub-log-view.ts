/**
 * hub-log-view.ts — Run log and agent event log page builders for AgentHub.
 */

import type { AgentRecord } from "../../types.js";
import { getLifetimeCost, getLifetimeTotal } from "../../usage.js";
import {
  displayState,
  flattenRunAgents,
  runStatusWord,
} from "../../workflow/progress.js";
import { describeActivity, formatCost } from "../agent-widget.js";

import { clampLine, type WorkflowCardLine } from "../workflow-card.js";
import { runHeaderLines } from "./hub-headers.js";
import { type HubPaneHost, identityPane, runGroups } from "./hub-panes.js";
import {
  type PaneRow,
  padLines,
  stamp,
} from "./hub-types.js";

export interface HubLogHost extends HubPaneHost {
  logScroll: number;
  setLogScroll(offset: number): void;
  setLogReadout(readout: { lines: number; percent: number } | undefined): void;
  focusedRecord(): AgentRecord | undefined;
  agentIdentity(record: AgentRecord, width: number): WorkflowCardLine[];
}

export function scrollTail(
  lines: readonly WorkflowCardLine[],
  offset: number,
  rows: number,
  host: HubLogHost,
): WorkflowCardLine[] {
  const max = Math.max(0, lines.length - rows);
  const start = Math.max(0, Math.min(offset, max));
  if (offset > max) host.setLogScroll(start);
  host.setLogReadout({
    lines: lines.length,
    percent: lines.length <= rows ? 100 : Math.round(((start + rows) / lines.length) * 100),
  });
  return lines.slice(start, start + rows);
}

export function buildRunLogLines(width: number, rows: number, host: HubLogHost): PaneRow[] {
  const run = host.currentRun();
  const source = run ? host.runSource(run.id) : undefined;
  if (!run || !source) return [clampLine([{ text: host.theme.fg("dim", "run detail unavailable") }], width)];
  const active = source.task.status === "running" || source.task.status === "paused";
  const lines: WorkflowCardLine[] = [
    clampLine([{ text: `${stamp(run.startedAt)} run start: ${run.totalCount} agent${run.totalCount === 1 ? "" : "s"}`, color: "muted" }], width),
  ];
  for (const entry of flattenRunAgents(source.progress, source.meta?.phases)) {
    const state = displayState(entry, source.task.status);
    if (entry.startedAt != null) {
      lines.push(clampLine([{ text: `${stamp(entry.startedAt)} ${entry.label} spawned${entry.phaseTitle ? ` (${entry.phaseTitle})` : ""}`, color: "dim" }], width));
    }
    if (state === "running") lines.push(clampLine([{ text: `${stamp(entry.lastProgressAt ?? Date.now())} ${entry.label} still running`, color: "dim" }], width));
    if (state === "paused") lines.push(clampLine([{ text: `${stamp(entry.lastProgressAt ?? Date.now())} ${entry.label} still running (run paused)`, color: "dim" }], width));
    if (state === "done") {
      const at = entry.startedAt != null && entry.durationMs != null ? entry.startedAt + entry.durationMs : Date.now();
      lines.push(clampLine([{ text: `${stamp(at)} ${entry.label} done${entry.resultPreview ? ` — ${entry.resultPreview}` : ""}`, color: "success" }], width));
    }
    if (state === "failed" || state === "blocked") {
      lines.push(clampLine([{ text: `${stamp(entry.lastProgressAt ?? Date.now())} ${entry.label} failed${entry.error ? ` — ${entry.error}` : ""}`, color: "error" }], width));
    }
    if (state === "skipped") lines.push(clampLine([{ text: `${stamp(entry.lastProgressAt ?? Date.now())} ${entry.label} skipped`, color: "dim" }], width));
  }
  if (!active) lines.push(clampLine([{ text: `${stamp(run.completedAt ?? Date.now())} run ${runStatusWord(run.status)}`, color: "muted" }], width));
  return padLines(scrollTail(lines, host.logScroll, rows, host), rows);
}

export function buildAgentLogLines(width: number, rows: number, host: HubLogHost): PaneRow[] {
  const record = host.focusedRecord();
  if (!record) return [clampLine([{ text: host.theme.fg("dim", "no agent selected") }], width)];
  const activity = host.deps.agentActivity.get(record.id);
  const lines: WorkflowCardLine[] = [
    clampLine([{ text: `${stamp(record.startedAt)} spawn  ${record.alias ?? record.handle ?? record.type} · ${record.description}`, color: "muted" }], width),
  ];
  for (let turn = 1; turn <= (activity?.turnCount ?? 0); turn++) {
    lines.push(clampLine([{ text: `${stamp(record.startedAt)} turn ${turn} start`, color: "dim" }], width));
  }
  if (record.toolUses > 0) {
    lines.push(clampLine([{ text: `${stamp(record.startedAt)} tools  ${record.toolUses} call${record.toolUses === 1 ? "" : "s"}`, color: "dim" }], width));
  }
  if (activity?.responseText) {
    lines.push(clampLine([{ text: `${stamp(Date.now())} note   ${activity.responseText.split("\n")[0] ?? ""}`, color: "dim" }], width));
  }
  if (record.status === "running" || record.status === "queued" || record.status === "paused") {
    const doing = activity ? describeActivity(activity.activeTools, activity.responseText) : "thinking…";
    lines.push(clampLine([{ text: `${stamp(Date.now())} still ${record.status} — ${doing}`, color: "dim" }], width));
  }
  if (record.completedAt != null) {
    const done = record.status === "completed" || record.status === "steered";
    lines.push(clampLine([{ text: `${stamp(record.completedAt)} ${done ? "done" : record.status}${record.error ? ` — ${record.error}` : ""}`, color: done ? "success" : "error" }], width));
    const tokens = getLifetimeTotal(record.lifetimeUsage);
    const cost = host.deps.showCost ? formatCost(getLifetimeCost(record.lifetimeUsage)) : "";
    lines.push(clampLine([{ text: `${stamp(record.completedAt)} usage  ${tokens} tokens${cost ? ` · ${cost}` : ""}`, color: "dim" }], width));
  }
  return padLines(scrollTail(lines, host.logScroll, rows, host), rows);
}

export function buildAgentLogPageLines(width: number, rows: number, host: HubLogHost): PaneRow[] {
  const record = host.focusedRecord();
  if (!record) return [clampLine([{ text: host.theme.fg("dim", "no agent selected") }], width)];
  return identityPane(host.agentIdentity(record, width), buildAgentLogLines(width, host.bodyRows(rows, false), host));
}

export function buildRunLogPageLines(width: number, rows: number, host: HubLogHost): PaneRow[] {
  const run = host.currentRun();
  if (!run) return [clampLine([{ text: host.theme.fg("dim", "run detail unavailable") }], width)];
  const identity = runHeaderLines({ run, groups: runGroups(host, run.id), width, th: host.theme });
  return identityPane(identity, buildRunLogLines(width, host.bodyRows(rows, false), host));
}
