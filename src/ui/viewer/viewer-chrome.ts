/**
 * viewer-chrome.ts — Header, footer, and viewport layout calculations for ConversationViewer.
 */

import { renderAgentRecordName } from "../../agent-color.js";
import type { AgentRecord, UIStyle, ViewerStyle } from "../../types.js";
import { getLifetimeCost, getLifetimeTotal, getSessionContextPercent } from "../../usage.js";
import type { AgentActivity, Theme } from "../agent-widget.js";
import {
  buildInvocationTags,
  fgPreservingNestedStyles,
  formatCost,
  formatDuration,
  formatSessionTokens,
  getPromptModeLabel,
} from "../agent-widget.js";
import {
  COMPOSER_ROWS,
  type ConversationViewerOptions,
  MIN_VIEWPORT,
  VIEWPORT_HEIGHT_PCT,
} from "./viewer-types.js";

export function isFrameless(options?: ConversationViewerOptions): boolean {
  const flag = options?.frameless;
  return typeof flag === "function" ? flag() : !!flag;
}

export function getUiStyle(options?: ConversationViewerOptions): UIStyle {
  const style = options?.uiStyle;
  return typeof style === "function" ? style() : (style ?? "pi");
}

export function getViewerStyleOption(options?: ConversationViewerOptions): ViewerStyle {
  const style = options?.viewerStyle;
  return typeof style === "function" ? style() : (style ?? "chat");
}

export function isFooterShown(options?: ConversationViewerOptions): boolean {
  return options?.footer !== false;
}

export function buildInvocationLine(record: AgentRecord, theme: Theme): string {
  const { modelName, modelId, tags } = buildInvocationTags(record.invocation);
  const model = modelId ?? modelName;
  const parts = [...(model ? [model] : []), ...tags];
  return theme.fg("dim", `  ↳ ${parts.length > 0 ? parts.join(" · ") : "—"}`);
}

export function buildOwnIdentityLines(
  record: AgentRecord,
  activity: AgentActivity | undefined,
  theme: Theme,
  showCost: boolean,
): [string, string] {
  const th = theme;
  const modeLabel = getPromptModeLabel(record.type);
  const modeTag = modeLabel ? ` ${th.fg("dim", `(${modeLabel})`)}` : "";
  const statusIcon = record.status === "running"
    ? th.fg("accent", "●")
    : record.status === "completed"
      ? th.fg("success", "✓")
      : record.status === "error"
        ? th.fg("error", "✗")
        : th.fg("dim", "○");
  const headerParts: string[] = [formatDuration(record.startedAt, record.completedAt)];
  const toolUses = activity?.toolUses ?? record.toolUses;
  if (toolUses > 0) headerParts.unshift(`${toolUses} tool${toolUses === 1 ? "" : "s"}`);
  const tokens = getLifetimeTotal(record.lifetimeUsage);
  if (tokens > 0) {
    const percent = getSessionContextPercent(activity?.session);
    headerParts.push(formatSessionTokens(tokens, percent, th, record.compactionCount));
  }
  const cost = showCost ? formatCost(getLifetimeCost(record.lifetimeUsage)) : "";
  if (cost) headerParts.push(cost);
  return [
    `${statusIcon} ${renderAgentRecordName(record, th, { bold: true })}${modeTag}  ${th.fg("muted", record.description)} ${th.fg("dim", "·")} ${fgPreservingNestedStyles(th, "dim", headerParts.join(" · "))}`,
    buildInvocationLine(record, theme),
  ];
}

export function resolveIdentityBlock(
  options: ConversationViewerOptions | undefined,
  record: AgentRecord,
  activity: AgentActivity | undefined,
  theme: Theme,
  showCost: boolean,
): readonly string[] {
  const identity = options?.identity;
  if (identity === false) return [];
  if (Array.isArray(identity)) return identity;
  return buildOwnIdentityLines(record, activity, theme, showCost);
}

export function computeChromeLines(
  fullscreen: boolean,
  options: ConversationViewerOptions | undefined,
  identityCount: number,
  composing: boolean,
): number {
  const framed = !fullscreen && !isFrameless(options);
  const borders = framed ? 2 : 0;
  const identityRule = identityCount > 0 ? 1 : 0;
  if (!isFooterShown(options)) {
    return borders + identityCount + identityRule + (composing ? COMPOSER_ROWS : 0);
  }
  return borders + identityCount + identityRule + 1 + (composing ? COMPOSER_ROWS : 1);
}

export function computeViewportHeight(
  terminalRows: number,
  fullscreen: boolean,
  options: ConversationViewerOptions | undefined,
  chromeLines: number,
  composing: boolean,
): number {
  if (fullscreen) return Math.max(0, terminalRows - chromeLines);
  const explicit = options?.viewportRows;
  const rows = typeof explicit === "function" ? explicit() : explicit;
  if (rows !== undefined) return Math.max(1, Math.floor(rows) - (composing ? COMPOSER_ROWS : 0));
  const opt = options?.maxHeightPct;
  const pct = typeof opt === "function" ? opt() : opt ?? VIEWPORT_HEIGHT_PCT;
  const maxRows = Math.floor((terminalRows * pct) / 100);
  return Math.max(MIN_VIEWPORT, maxRows - chromeLines);
}
