/**
 * viewer-compact.ts — The original flat transcript rendering (`viewerStyle: "compact"`).
 *
 * Hand-rolled string lines: `[User]` / `[Assistant]` labels, `───` separators,
 * dim thinking previews, `⏺ name(args)` call lines and capped tool output.
 * Assistant text renders as Markdown; everything else stays verbatim. The
 * default (`chat`) rendering composes pi's main-screen components instead —
 * see `viewer-content.ts`.
 *
 * Adapted from the pre-component renderer, minus the `viewerMarkdown` mode
 * (fixed to its old default, `assistant`) and with tool renderers resolved
 * through pi's extension chain like the chat path.
 */

import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  Markdown,
  type MarkdownOptions,
  type MarkdownTheme,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { extractText } from "../../context.js";
import type { AgentRecord } from "../../types.js";
import type { AgentActivity, Theme } from "../agent-widget.js";
import { describeActivity } from "../agent-widget.js";
import { resolveRenderers } from "./viewer-renderers.js";
import type { ToolRenderers } from "./viewer-types.js";

/** Cap on a single tool result or bash output before the viewer elides the rest. */
const RESULT_MAX_CHARS = 16_000;
/** Detailed-log sizing: result preview lines, error preview lines, thinking preview lines. */
const RESULT_PREVIEW_LINES = 4;
const ERROR_PREVIEW_LINES = 10;
const THINKING_PREVIEW_LINES = 6;
/** Lines of a running tool's streamed output shown under its call. */
const LIVE_OUTPUT_LINES = 4;

/**
 * Tool-argument keys worth showing on a call line, most identifying first —
 * the command run, the path touched, the pattern searched. Anything stringy
 * beyond these falls back to the first string value present.
 */
const CALL_ARG_KEYS = [
  "command", "path", "file_path", "filePath", "pattern", "query", "url",
  "skill", "name", "description", "prompt",
] as const;

/** `ls -la\nsrc` → `ls -la src`, truncated to a call-line-friendly length. */
function oneLine(text: string, max = 60): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max - 1) + "…" : flat;
}

/** The one argument that says what this call does, for the `⏺ name(...)` line. */
function describeToolArgs(args: unknown): string {
  if (args == null) return "";
  if (typeof args !== "object") return oneLine(String(args));
  const obj = args as Record<string, unknown>;
  for (const key of CALL_ARG_KEYS) {
    const v = obj[key];
    if (typeof v === "string" && v.trim()) return oneLine(v);
    if (typeof v === "number" || typeof v === "boolean") return `${key}: ${v}`;
  }
  for (const v of Object.values(obj)) {
    if (typeof v === "string" && v.trim()) return oneLine(v);
  }
  return "";
}

/** `999` · `1.5k` · `8.4M` — a magnitude cue, not an exact count, past 1000. */
function humanCount(n: number): string {
  if (n < 1_000) return `${n}`;
  const thousands = n < 999_950;
  const value = thousands ? n / 1_000 : n / 1_000_000;
  return `${value.toFixed(1).replace(/\.0$/, "")}${thousands ? "k" : "M"}`;
}

function truncationNote(elided: number): string {
  return `... (truncated, ${humanCount(elided)} more character${elided === 1 ? "" : "s"})`;
}

/**
 * Cap `text` at `RESULT_MAX_CHARS`, reporting the elision separately rather than
 * appending it.
 */
function capResult(text: string): { text: string; elided: number } {
  if (text.length <= RESULT_MAX_CHARS) return { text, elided: 0 };
  return {
    text: text.slice(0, RESULT_MAX_CHARS),
    elided: text.length - RESULT_MAX_CHARS,
  };
}

/** Both options keep the renderer from *rewriting* source that only looks like Markdown. */
const MARKDOWN_OPTIONS: MarkdownOptions = {
  preserveOrderedListMarkers: true,
  preserveBackslashEscapes: true,
};

export interface MarkdownCacheEntry {
  md: Markdown;
  text: string;
  failed?: boolean;
}

/**
 * Per-viewer render state for the compact path. The WeakMaps survive rebuilds
 * (streamed Markdown grows in place, renderer components keep state); the exec
 * map is keyed by toolCallId, which nothing weakly holds, so it lives here and
 * dies with the viewer.
 */
export interface CompactRenderState {
  markdown: WeakMap<object, MarkdownCacheEntry>;
  callComponents: WeakMap<object, { component: unknown }>;
  resultComponents: WeakMap<object, { component: unknown }>;
  toolExecState: Map<string, Record<string, unknown>>;
}

export function createCompactRenderState(): CompactRenderState {
  return {
    markdown: new WeakMap(),
    callComponents: new WeakMap(),
    resultComponents: new WeakMap(),
    toolExecState: new Map(),
  };
}

export interface CompactTranscriptContext {
  session: AgentSession;
  record: AgentRecord;
  activity: AgentActivity | undefined;
  theme: Theme;
  markdownTheme: MarkdownTheme;
  /** Live tool output by toolCallId, fed by `tool_execution_update` events. */
  partials: Map<string, string>;
  builtinRenderers?: Record<string, ToolRenderers>;
  expanded: boolean;
  /** Called when a tool renderer invalidates its component — the line cache must rebuild. */
  invalidate: () => void;
  state: CompactRenderState;
}

function wrapRawLines(text: string, width: number, dim: boolean, theme: Theme): string[] {
  const lines = wrapTextWithAnsi(text, width);
  return dim ? lines.map(l => theme.fg("dim", l)) : lines;
}

function renderMarkdownLines(
  msg: object,
  text: string,
  width: number,
  markdown: WeakMap<object, MarkdownCacheEntry>,
  markdownTheme: MarkdownTheme,
  theme: Theme,
): string[] {
  let entry = markdown.get(msg);
  if (!entry) {
    entry = {
      md: new Markdown(
        text,
        0,
        0,
        markdownTheme,
        undefined,
        MARKDOWN_OPTIONS,
      ),
      text,
    };
    markdown.set(msg, entry);
  } else if (entry.text !== text) {
    const shouldRetry = !text.startsWith(entry.text);
    entry.md.setText(text);
    entry.text = text;
    if (shouldRetry) entry.failed = false;
  }
  if (entry.failed) return wrapRawLines(text, width, false, theme);

  try {
    return entry.md.render(width);
  } catch {
    entry.failed = true;
    return wrapRawLines(text, width, false, theme);
  }
}

interface RenderDeps {
  theme: Theme;
  expanded: boolean;
  session: AgentSession;
  builtinRenderers?: Record<string, ToolRenderers>;
  onInvalidate: () => void;
  state: CompactRenderState;
  markdownTheme: MarkdownTheme;
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
  deps: RenderDeps,
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

let fallbackCallId = 0;

function richCallLines(
  call: { id?: string; toolUseId?: string },
  args: unknown,
  renderers: ToolRenderers,
  width: number,
  deps: RenderDeps,
): string[] | undefined {
  if (!renderers.renderCall) return undefined;
  try {
    const callId = String(call.id ?? call.toolUseId ?? `call-${++fallbackCallId}`);
    const state = getExecState(deps.state.toolExecState, callId);
    const entry = deps.state.callComponents.get(call as object);
    const component = renderers.renderCall(args, deps.theme, createRenderContext(callId, args, deps, {
      state,
      lastComponent: entry?.component,
    }));
    deps.state.callComponents.set(call as object, { component });
    const lines = (component as { render?(w: number): string[] })?.render?.(width);
    return Array.isArray(lines) && lines.length > 0 ? lines : undefined;
  } catch {
    return undefined;
  }
}

function richResultLines(
  msg: any,
  callArgs: unknown,
  renderers: ToolRenderers,
  width: number,
  deps: RenderDeps,
): string[] | undefined {
  if (!renderers.renderResult) return undefined;
  try {
    const isError = !!msg.isError;
    const callId = String(msg.toolCallId ?? "result");
    const state = getExecState(deps.state.toolExecState, callId);
    const entry = deps.state.resultComponents.get(msg);
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
    deps.state.resultComponents.set(msg, { component });
    const lines = (component as { render?(w: number): string[] })?.render?.(width);
    return Array.isArray(lines) && lines.length > 0 ? lines : undefined;
  } catch {
    return undefined;
  }
}

function toolCallLines(
  call: { name?: string; toolName?: string; arguments?: unknown; input?: unknown; id?: string; toolUseId?: string },
  width: number,
  deps: RenderDeps,
): string[] {
  const th = deps.theme;
  const name = call.name ?? call.toolName ?? "unknown";
  const argsValue = call.arguments ?? call.input;
  const renderers = resolveRenderers(deps.session, deps.builtinRenderers, name);
  const rich = renderers ? richCallLines(call as any, argsValue, renderers, width, deps) : undefined;
  if (rich) return rich;
  const args = describeToolArgs(argsValue);
  const head = `${th.fg("accent", "⏺")} ${th.bold(name)}${args ? th.fg("dim", `(${args})`) : ""}`;
  return [truncateToWidth(head, width)];
}

function liveOutputLines(partial: string, width: number, theme: Theme): string[] {
  const th = theme;
  const all = partial.split("\n");
  const kept = all.slice(-LIVE_OUTPUT_LINES);
  const lines = kept.map(l => th.fg("dim", `    ${l}`));
  if (all.length > kept.length) {
    lines.unshift(th.fg("dim", `    … ${all.length - kept.length} earlier lines`));
  }
  return lines.map(l => truncateToWidth(l, width));
}

function toolResultLines(
  msg: any,
  callArgs: unknown,
  width: number,
  deps: RenderDeps,
): string[] {
  const th = deps.theme;
  const isError = !!msg.isError;
  const raw = extractText(msg.content).trim();

  const toolName = msg.toolName ?? "";
  const renderers = toolName ? resolveRenderers(deps.session, deps.builtinRenderers, toolName) : undefined;
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

  // Expanded (o/ctrl+o) shows the whole capped result; collapsed shows a preview.
  if (deps.expanded) {
    const { text, elided } = capResult(raw);
    if (!text) return [truncateToWidth(th.fg("dim", "  ✓ (no output)"), width)];
    const lines = [truncateToWidth(th.fg("success", "  ✓"), width)];
    lines.push(...wrapRawLines(text, width, true, th));
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

function thinkingLines(text: string, width: number, theme: Theme): string[] {
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

/**
 * Build the compact transcript as flat styled lines. Same message walk as the
 * chat path — decoration is render-time only and never touches message content.
 */
export function buildCompactTranscript(width: number, ctx: CompactTranscriptContext): string[] {
  if (width <= 0) return [];

  const { session, record, activity, theme: th, partials, state, markdownTheme } = ctx;
  const deps: RenderDeps = {
    theme: th,
    expanded: ctx.expanded,
    session,
    builtinRenderers: ctx.builtinRenderers,
    onInvalidate: ctx.invalidate,
    state,
    markdownTheme,
  };

  const streaming = session.state?.streamingMessage;
  const completed = session.messages;
  const messages = streaming?.role === "assistant"
    ? [...completed, streaming as (typeof completed)[number]]
    : completed;
  const streamingRef = streaming?.role === "assistant" ? streaming : undefined;
  const lines: string[] = [];

  if (messages.length === 0) {
    lines.push(th.fg("dim", "(waiting for first message...)"));
    return lines;
  }

  const resultById = new Map<string, any>();
  for (const msg of messages) {
    if (msg.role === "toolResult") {
      const id = (msg as any).toolCallId;
      if (typeof id === "string") resultById.set(id, msg);
    }
  }
  const consumedResults = new Set<string>();

  let needsSeparator = false;
  for (const msg of messages) {
    if (msg.role === "toolResult") {
      const id = (msg as any).toolCallId as string | undefined;
      if (id !== undefined && consumedResults.has(id)) continue;
    }
    if (msg.role === "user") {
      const text = typeof msg.content === "string"
        ? msg.content
        : extractText(msg.content);
      if (!text.trim()) continue;
      if (needsSeparator) lines.push(th.fg("dim", "───"));
      lines.push(th.fg("accent", "[User]"));
      for (const line of wrapTextWithAnsi(text.trim(), width)) {
        lines.push(line);
      }
    } else if (msg.role === "assistant") {
      if (needsSeparator) lines.push(th.fg("dim", "───"));
      lines.push(th.bold("[Assistant]"));
      if (msg === streamingRef && !msg.content.some(c => (c.type === "text" && c.text.trim()) || (c as any).type === "thinking" || c.type === "toolCall")) {
        lines.push(truncateToWidth(th.fg("dim", "  ✻ thinking…"), width));
      }
      let textRun: string[] = [];
      const flushText = () => {
        if (textRun.length === 0) return;
        const text = textRun.join("\n").trim();
        textRun = [];
        if (text) {
          lines.push(...renderMarkdownLines(msg, text, width, state.markdown, markdownTheme, th));
        }
      };
      for (const c of msg.content) {
        if (c.type === "text" && c.text) {
          textRun.push(c.text);
        } else if ((c as any).type === "thinking") {
          flushText();
          lines.push(...thinkingLines((c as any).thinking ?? "", width, th));
        } else if (c.type === "toolCall") {
          flushText();
          const callId = (c as any).id ?? (c as any).toolUseId;
          const callArgs = (c as any).arguments ?? (c as any).input;
          lines.push(...toolCallLines(c as any, width, deps));
          const result = typeof callId === "string" ? resultById.get(callId) : undefined;
          if (result) {
            consumedResults.add(callId as string);
            lines.push(...toolResultLines(result, callArgs, width, deps));
          } else if (record.status === "running" || record.status === "queued") {
            const partial = typeof callId === "string" ? partials.get(callId)?.trim() : undefined;
            if (partial) {
              lines.push(...liveOutputLines(partial, width, th));
            } else {
              lines.push(truncateToWidth(th.fg("dim", "  ○ awaiting result"), width));
            }
          }
        }
      }
      flushText();
    } else if (msg.role === "toolResult") {
      const { text, elided } = capResult(extractText(msg.content).trim());
      if (!text) continue;
      if (needsSeparator) lines.push(th.fg("dim", "───"));
      lines.push(th.fg("dim", "[Result]"));
      lines.push(...wrapRawLines(text, width, true, th));
      if (elided) lines.push(truncateToWidth(th.fg("dim", truncationNote(elided)), width));
    } else if ((msg as any).role === "bashExecution") {
      const bash = (msg as any) as { command?: string; output?: string };
      if (needsSeparator) lines.push(th.fg("dim", "───"));
      lines.push(truncateToWidth(th.fg("muted", `  $ ${bash.command}`), width));
      if (bash.output?.trim()) {
        const { text, elided } = capResult(bash.output.trim());
        lines.push(...wrapRawLines(text, width, true, th));
        if (elided) lines.push(truncateToWidth(th.fg("dim", truncationNote(elided)), width));
      }
    } else {
      continue;
    }
    needsSeparator = true;
  }

  if (record.status === "running" && activity) {
    const act = describeActivity(
      activity.activeTools,
      activity.responseText,
      activity.lastTool,
      activity.lastActivity === "tool",
    );
    lines.push(truncateToWidth(th.fg("accent", "▍ ") + th.fg("dim", act), width));
  }

  return lines.map(l => (visibleWidth(l) <= width ? l : truncateToWidth(l, width)));
}
