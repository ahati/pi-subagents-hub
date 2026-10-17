/**
 * viewer-renderers.ts — Detailed-log (omp-style) tool rendering for ConversationViewer.
 */

import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { extractText } from "../../context.js";
import type { ViewerMarkdownMode } from "../../types.js";
import type { Theme } from "../agent-widget.js";
import {
  capResult,
  describeToolArgs,
  ERROR_PREVIEW_LINES,
  LIVE_OUTPUT_LINES,
  RESULT_PREVIEW_LINES,
  THINKING_PREVIEW_LINES,
  type ToolRenderers,
  truncationNote,
} from "./viewer-types.js";

let fallbackCallId = 0;

export interface ViewerRenderDeps {
  theme: Theme;
  expanded: boolean;
  markdownMode: ViewerMarkdownMode;
  callComponentCache: WeakMap<object, { component: unknown }>;
  resultComponentCache: WeakMap<object, { component: unknown }>;
  toolExecState: Map<string, Record<string, unknown>>;
  builtinRenderers?: Record<string, ToolRenderers>;
  onInvalidate: () => void;
  rawLines: (text: string, width: number, dim: boolean) => string[];
  markdownLines: (msg: any, text: string, width: number, dim: boolean) => string[];
}

export function resolveRenderers(
  session: AgentSession,
  builtinRenderers: Record<string, ToolRenderers> | undefined,
  toolName: string,
): ToolRenderers | undefined {
  let def: any;
  try {
    def = session.getToolDefinition?.(toolName);
  } catch {
    def = undefined;
  }
  const builtin = builtinRenderers?.[toolName];
  const merged: ToolRenderers = {
    renderCall: def?.renderCall ?? builtin?.renderCall,
    renderResult: def?.renderResult ?? builtin?.renderResult,
  };
  if (!merged.renderCall && !merged.renderResult) return undefined;
  return merged;
}

function getExecState(toolExecState: Map<string, Record<string, unknown>>, toolCallId: string): Record<string, unknown> {
  let state = toolExecState.get(toolCallId);
  if (!state) {
    state = {};
    toolExecState.set(toolCallId, state);
  }
  return state;
}

function createRenderContext(
  toolCallId: string,
  args: unknown,
  deps: ViewerRenderDeps,
  over: Partial<Record<string, unknown>> = {},
): any {
  return {
    args,
    toolCallId,
    invalidate: () => deps.onInvalidate(),
    lastComponent: undefined,
    state: undefined,
    cwd: process.cwd(),
    executionStarted: true,
    argsComplete: true,
    isPartial: false,
    expanded: deps.expanded,
    showImages: true,
    isError: false,
    ...over,
  };
}

export function richCallLines(
  call: { id?: string; toolUseId?: string },
  args: unknown,
  renderers: ToolRenderers,
  width: number,
  deps: ViewerRenderDeps,
): string[] | undefined {
  if (!renderers.renderCall) return undefined;
  try {
    const callId = String(call.id ?? call.toolUseId ?? `call-${++fallbackCallId}`);
    const state = getExecState(deps.toolExecState, callId);
    const entry = deps.callComponentCache.get(call as object);
    const component = renderers.renderCall(args, deps.theme, createRenderContext(callId, args, deps, {
      state,
      lastComponent: entry?.component,
    }));
    deps.callComponentCache.set(call as object, { component });
    const lines = (component as { render?(w: number): string[] })?.render?.(width);
    return Array.isArray(lines) && lines.length > 0 ? lines : undefined;
  } catch {
    return undefined;
  }
}

export function richResultLines(
  msg: any,
  callArgs: unknown,
  renderers: ToolRenderers,
  width: number,
  deps: ViewerRenderDeps,
): string[] | undefined {
  if (!renderers.renderResult) return undefined;
  try {
    const isError = !!msg.isError;
    const callId = String(msg.toolCallId ?? "result");
    const state = getExecState(deps.toolExecState, callId);
    const entry = deps.resultComponentCache.get(msg);
    const result = { content: msg.content, details: msg.details, isError };
    const component = renderers.renderResult(
      result,
      { expanded: deps.expanded, isPartial: false },
      deps.theme,
      createRenderContext(callId, callArgs, deps, {
        state,
        lastComponent: entry?.component,
        isError,
      }),
    );
    deps.resultComponentCache.set(msg, { component });
    const lines = (component as { render?(w: number): string[] })?.render?.(width);
    return Array.isArray(lines) && lines.length > 0 ? lines : undefined;
  } catch {
    return undefined;
  }
}

export function toolCallLines(
  call: { name?: string; toolName?: string; arguments?: unknown; input?: unknown; id?: string; toolUseId?: string },
  width: number,
  session: AgentSession,
  deps: ViewerRenderDeps,
): string[] {
  const th = deps.theme;
  const name = call.name ?? call.toolName ?? "unknown";
  const argsValue = call.arguments ?? call.input;
  const renderers = resolveRenderers(session, deps.builtinRenderers, name);
  const rich = renderers ? richCallLines(call as any, argsValue, renderers, width, deps) : undefined;
  if (rich) return rich;
  const args = describeToolArgs(argsValue);
  const head = `${th.fg("accent", "⏺")} ${th.bold(name)}${args ? th.fg("dim", `(${args})`) : ""}`;
  return [truncateToWidth(head, width)];
}

export function liveOutputLines(partial: string, width: number, theme: Theme): string[] {
  const th = theme;
  const all = partial.split("\n");
  const kept = all.slice(-LIVE_OUTPUT_LINES);
  const lines = kept.map(l => th.fg("dim", `    ${l}`));
  if (all.length > kept.length) {
    lines.unshift(th.fg("dim", `    … ${all.length - kept.length} earlier lines`));
  }
  return lines.map(l => truncateToWidth(l, width));
}

export function toolResultLines(
  msg: any,
  callArgs: unknown,
  width: number,
  session: AgentSession,
  deps: ViewerRenderDeps,
): string[] {
  const th = deps.theme;
  const isError = !!msg.isError;
  const raw = extractText(msg.content).trim();

  const toolName = msg.toolName ?? "";
  const renderers = toolName ? resolveRenderers(session, deps.builtinRenderers, toolName) : undefined;
  const rich = renderers ? richResultLines(msg, callArgs, renderers, width, deps) : undefined;
  if (rich) return rich;

  const indent = "    ";
  const bodyWidth = Math.max(1, width - indent.length - 2);

  if (isError) {
    const lines = [truncateToWidth(th.fg("error", "  ✗ error"), width)];
    if (!raw) return lines;
    const { text, elided } = capResult(raw);
    const body = wrapTextWithAnsi(text, bodyWidth);
    for (const l of body.slice(0, ERROR_PREVIEW_LINES)) {
      lines.push(truncateToWidth(th.fg("dim", indent + l), width));
    }
    const hidden = body.length - ERROR_PREVIEW_LINES + (elided > 0 ? 1 : 0);
    if (hidden > 0) lines.push(truncateToWidth(th.fg("dim", `${indent}… +${hidden} more lines`), width));
    return lines;
  }

  const mode = deps.markdownMode;
  if (mode === "all" || mode === "off" || deps.expanded) {
    const { text, elided } = capResult(raw);
    if (!text) return [truncateToWidth(th.fg("dim", "  ✓ (no output)"), width)];
    const lines = [truncateToWidth(th.fg("success", "  ✓"), width)];
    lines.push(...(mode === "all" ? deps.markdownLines(msg, text, width, true) : deps.rawLines(text, width, true)));
    if (elided) lines.push(truncateToWidth(th.fg("dim", truncationNote(elided)), width));
    return lines;
  }

  if (!raw) return [truncateToWidth(th.fg("dim", "  ✓ (no output)"), width)];
  const { text } = capResult(raw);
  const lines = [truncateToWidth(th.fg("success", "  ✓"), width)];
  const body = wrapTextWithAnsi(text, bodyWidth);
  for (const l of body.slice(0, RESULT_PREVIEW_LINES)) {
    lines.push(truncateToWidth(th.fg("dim", indent + l), width));
  }
  if (body.length > RESULT_PREVIEW_LINES) {
    lines.push(truncateToWidth(th.fg("dim", `${indent}… +${body.length - RESULT_PREVIEW_LINES} lines (o/ctrl+o for full)`), width));
  }
  return lines;
}

export function thinkingLines(text: string, width: number, theme: Theme): string[] {
  const th = theme;
  if (!text.trim()) return [];
  const lines = [truncateToWidth(th.fg("muted", "  ✻ thinking"), width)];
  const body = wrapTextWithAnsi(text.trim(), Math.max(1, width - 4));
  for (const l of body.slice(0, THINKING_PREVIEW_LINES)) {
    lines.push(truncateToWidth(th.fg("dim", "  " + l), width));
  }
  if (body.length > THINKING_PREVIEW_LINES) {
    lines.push(truncateToWidth(th.fg("dim", `  … +${body.length - THINKING_PREVIEW_LINES} lines`), width));
  }
  return lines;
}
