/**
 * hub-headers.ts — Header lines, status glyphs, and window painting for AgentHub.
 */

import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { renderAgentRecordName } from "../../agent-color.js";
import type { AgentRecord, UIStyle } from "../../types.js";
import { getLifetimeTotal, getSessionContextPercent } from "../../usage.js";
import {
  elapsedMs,
  formatDuration,
  type PhaseGroup,
  runIdentity,
  runStatusMark,
} from "../../workflow/progress.js";
import type { AgentActivity, Theme } from "../agent-widget.js";
import {
  buildInvocationTags,
  fgPreservingNestedStyles,
  formatSessionTokens,
  getPromptModeLabel,
} from "../agent-widget.js";
import type { FleetWorkflow } from "../fleet-list.js";
import { clampLine, type WorkflowCardLine } from "../workflow-card.js";

/**
 * The run-state glyph for a roster workflow row.
 */
export function workflowStatusGlyph(status: FleetWorkflow["status"], th: Theme): string {
  const { glyph, role } = runStatusMark(status);
  return th.fg(role, glyph);
}

export function statusGlyph(status: AgentRecord["status"], th: Theme): string {
  switch (status) {
    case "running":
      return th.fg("accent", "●");
    case "completed":
      return th.fg("success", "✓");
    case "steered":
      return th.fg("accent", "✓");
    case "error":
      return th.fg("error", "✗");
    case "queued":
      return th.fg("dim", "○");
    case "paused":
      return th.fg("dim", "‖");
    default:
      return th.fg("dim", "·");
  }
}

/**
 * The header block's `↳` line: the run name when the page sits inside one,
 * then the canonical model, then whatever invocation tags apply.
 */
export function invocationSummary(record: AgentRecord, parentName?: string): string {
  const { modelName, modelId, tags } = buildInvocationTags(record.invocation);
  const model = modelId ?? modelName;
  const parts = [...(parentName ? [parentName] : []), ...(model ? [model] : []), ...tags];
  return parts.length > 0 ? parts.join(" · ") : "—";
}

/**
 * The agent header block's two text lines.
 */
export function agentHeaderLines(input: {
  record: AgentRecord;
  activity: AgentActivity | undefined;
  width: number;
  th: Theme;
  parentName?: string;
}): WorkflowCardLine[] {
  const { activity, parentName, record, th, width } = input;
  const mode = getPromptModeLabel(record.type);
  const tools = activity?.toolUses ?? record.toolUses;
  const elapsed = formatDuration(elapsedMs({ startTime: record.startedAt, endTime: record.completedAt }, Date.now()));
  const tokens = getLifetimeTotal(record.lifetimeUsage);
  const stats: string[] = [];
  if (tools > 0) stats.push(`${tools} tool${tools === 1 ? "" : "s"}`);
  stats.push(`${elapsed} (${record.status})`);
  if (tokens > 0) stats.push(formatSessionTokens(tokens, getSessionContextPercent(activity?.session), th, record.compactionCount));
  return [
    clampLine([
      { text: `${statusGlyph(record.status, th)} ${renderAgentRecordName(record, th, { bold: true })}${mode ? th.fg("dim", ` (${mode})`) : ""}` },
      { text: `  ${record.description}`, color: "muted" },
      { text: ` · ${fgPreservingNestedStyles(th, "dim", stats.join(" · "))}` },
    ], width),
    clampLine([{ text: th.fg("dim", `  ↳ ${invocationSummary(record, parentName)}`) }], width),
  ];
}

/**
 * The run header block's two text lines.
 */
export function runHeaderLines(input: {
  run: FleetWorkflow;
  groups: readonly PhaseGroup[];
  width: number;
  th: Theme;
  now?: number;
}): WorkflowCardLine[] {
  const { groups, run, th, width } = input;
  const identity = runIdentity({
    name: run.name,
    status: run.status,
    groups,
    doneCount: run.doneCount,
    totalCount: run.totalCount,
    elapsedMs: elapsedMs({ startTime: run.startedAt, endTime: run.completedAt }, input.now ?? Date.now()),
  });
  return [
    clampLine([
      { text: `${workflowStatusGlyph(run.status, th)} ${th.bold(identity.name)}` },
      { text: `  ${identity.details}`, color: "dim" },
    ], width),
    clampLine([{ text: th.fg("dim", `  ↳ ${identity.subtext}`) }], width),
  ];
}

/**
 * Paint the shared window's cells with this surface's theme.
 */
export function paintWindow(lines: readonly WorkflowCardLine[], th: Theme, uiStyle?: UIStyle): string[] {
  const isPi = uiStyle === "pi";
  const defaultBg = isPi ? "toolPendingBg" : undefined;
  return lines.map(line => {
    return line
      .map(segment => {
        let text = segment.bold ? th.bold(segment.text) : segment.text;
        if (segment.color) text = th.fg(segment.color, text);
        const bg = segment.bg ?? defaultBg;
        if (bg && typeof (th as any).bg === "function") {
          text = (th as any).bg(bg, text);
          if (typeof (th as any).getBgAnsi === "function") {
            const bgAnsi = (th as any).getBgAnsi(bg);
            if (bgAnsi && text.includes("\x1b[0m")) {
              text = text.replaceAll("\x1b[0m", `\x1b[0m${bgAnsi}`);
            }
          }
        }
        return text;
      })
      .join("");
  });
}

/** Left cell + a right-aligned tail, truncated hard so lines never wrap. */
export function finishRow(left: string, minWidth: number, right: string, width: number): string {
  const rightW = visibleWidth(right);
  const maxLeft = Math.max(minWidth, width - rightW - 1);
  const leftClamped = truncateToWidth(left, maxLeft, "…");
  const gap = Math.max(1, width - visibleWidth(leftClamped) - rightW);
  return truncateToWidth(leftClamped + " ".repeat(gap) + right, width);
}
