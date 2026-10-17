/**
 * viewer-content.ts — Transcript line building, Markdown rendering, and text caching for ConversationViewer.
 */

import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  Markdown,
  type MarkdownTheme,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { extractText } from "../../context.js";
import type { AgentRecord, ViewerMarkdownMode } from "../../types.js";
import type { AgentActivity, Theme } from "../agent-widget.js";
import { describeActivity } from "../agent-widget.js";
import {
  liveOutputLines,
  thinkingLines,
  toolCallLines,
  toolResultLines,
  type ViewerRenderDeps,
} from "./viewer-renderers.js";
import {
  capResult,
  MARKDOWN_OPTIONS,
  truncationNote,
} from "./viewer-types.js";

export interface MarkdownCacheEntry {
  md: Markdown;
  text: string;
  failed?: boolean;
}

export function wrapRawLines(text: string, width: number, dim: boolean, theme: Theme): string[] {
  const lines = wrapTextWithAnsi(text, width);
  return dim ? lines.map(l => theme.fg("dim", l)) : lines;
}

export function renderMarkdownLines(
  msg: AgentSession["messages"][number],
  text: string,
  width: number,
  dim: boolean,
  markdownCache: WeakMap<object, MarkdownCacheEntry>,
  markdownTheme: MarkdownTheme,
  theme: Theme,
): string[] {
  let entry = markdownCache.get(msg);
  if (!entry) {
    entry = {
      md: new Markdown(
        text,
        0,
        0,
        markdownTheme,
        dim ? { color: (t: string) => theme.fg("dim", t) } : undefined,
        MARKDOWN_OPTIONS,
      ),
      text,
    };
    markdownCache.set(msg, entry);
  } else if (entry.text !== text) {
    const shouldRetry = !text.startsWith(entry.text);
    entry.md.setText(text);
    entry.text = text;
    if (shouldRetry) entry.failed = false;
  }
  if (entry.failed) return wrapRawLines(text, width, dim, theme);

  try {
    return entry.md.render(width);
  } catch {
    entry.failed = true;
    return wrapRawLines(text, width, dim, theme);
  }
}

export function computeLastMessageSignature(session: AgentSession): string {
  const messages = session.messages;
  const last = messages[messages.length - 1];
  if (!last) return "empty";
  const content = (last as { content?: unknown }).content;
  if (typeof content === "string") return `s:${content.length}`;
  if (!Array.isArray(content)) return "other";
  let size = 0;
  for (const c of content) {
    if (c?.type === "text") size += c.text?.length ?? 0;
    else if (c?.type === "thinking") size += c.thinking?.length ?? 0;
    else size += 1;
  }
  return `${size}`;
}

export interface ContentBuilderContext {
  session: AgentSession;
  record: AgentRecord;
  activity: AgentActivity | undefined;
  theme: Theme;
  mode: ViewerMarkdownMode;
  partials: Map<string, string>;
  renderDeps: ViewerRenderDeps;
}

export function buildContentLinesUncached(width: number, ctx: ContentBuilderContext): string[] {
  if (width <= 0) return [];

  const { session, record, activity, theme: th, mode, partials, renderDeps } = ctx;
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
          lines.push(...(mode === "off"
            ? renderDeps.rawLines(text, width, false)
            : renderDeps.markdownLines(msg, text, width, false)));
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
          lines.push(...toolCallLines(c as any, width, session, renderDeps));
          const result = typeof callId === "string" ? resultById.get(callId) : undefined;
          if (result) {
            consumedResults.add(callId as string);
            lines.push(...toolResultLines(result, callArgs, width, session, renderDeps));
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
      lines.push(...(mode === "all"
        ? renderDeps.markdownLines(msg, text, width, true)
        : renderDeps.rawLines(text, width, true)));
      if (elided) lines.push(truncateToWidth(th.fg("dim", truncationNote(elided)), width));
    } else if ((msg as any).role === "bashExecution") {
      const bash = msg as any;
      if (needsSeparator) lines.push(th.fg("dim", "───"));
      lines.push(truncateToWidth(th.fg("muted", `  $ ${bash.command}`), width));
      if (bash.output?.trim()) {
        const { text, elided } = capResult(bash.output.trim());
        lines.push(...renderDeps.rawLines(text, width, true));
        if (elided) lines.push(truncateToWidth(th.fg("dim", truncationNote(elided)), width));
      }
    } else {
      continue;
    }
    needsSeparator = true;
  }

  if (record.status === "running" && activity) {
    const act = describeActivity(activity.activeTools, activity.responseText);
    lines.push(truncateToWidth(th.fg("accent", "▍ ") + th.fg("dim", act), width));
  }

  return lines.map(l => (visibleWidth(l) <= width ? l : truncateToWidth(l, width)));
}
