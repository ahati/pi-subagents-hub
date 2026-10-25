/**
 * viewer-content.ts — Transcript component building for ConversationViewer.
 *
 * Composes pi's main-screen message components (AssistantMessageComponent,
 * UserMessageComponent, ToolExecutionComponent, BashExecutionComponent) into a
 * Container — the same tree the main window renders, fed from the child
 * session's messages. The viewer owns the component caches (keyed by message
 * object, so renderer state and expansion survive rebuilds); this module maps
 * messages onto them.
 *
 * Decoration is render-time only: nothing here touches message content, so the
 * model-visible transcript is exactly what the child session recorded.
 */

import type { AgentSession } from "@earendil-works/pi-coding-agent";
import {
  AssistantMessageComponent,
  BashExecutionComponent,
  ToolExecutionComponent,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  type MarkdownTheme,
  Text,
  type TUI,
} from "@earendil-works/pi-tui";
import { extractText } from "../../context.js";
import type { AgentRecord } from "../../types.js";
import type { AgentActivity, Theme } from "../agent-widget.js";
import { describeActivity } from "../agent-widget.js";
import { resolveRenderers } from "./viewer-renderers.js";
import { type ToolRenderers } from "./viewer-types.js";

/** Components must not emit pi's shell-prompt zones inside an overlay. */
const SHELL_ZONE = /\x1b\]133;[A-C]\x07/g;

export function stripShellZones(line: string): string {
  return line.replace(SHELL_ZONE, "");
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

/** What a reused ToolExecutionComponent has already been fed, so a rebuild only pushes deltas. */
interface ToolFeed {
  final: boolean;
  partial: string | undefined;
}

export interface TranscriptContext {
  tui: TUI;
  session: AgentSession;
  record: AgentRecord;
  activity: AgentActivity | undefined;
  theme: Theme;
  markdownTheme: MarkdownTheme;
  /** Live tool output by toolCallId, fed by `tool_execution_update` events. */
  partials: Map<string, string>;
  builtinRenderers?: Record<string, ToolRenderers>;
  expanded: boolean;
  /** Called when a tool renderer invalidates its component — the viewer's line cache must rebuild. */
  invalidate: () => void;
  assistantComponents: WeakMap<object, AssistantMessageComponent>;
  toolComponents: WeakMap<object, ToolExecutionComponent>;
  toolFeeds: WeakMap<object, ToolFeed>;
}

export interface TranscriptBuild {
  container: Container;
  toolComponents: ToolExecutionComponent[];
  bashComponents: BashExecutionComponent[];
}

/**
 * Map the session's messages onto pi's main-screen components. Pure mapping —
 * every component is cached by its message object and only fed deltas on
 * rebuild, so renderer state (diff previews, expansion) survives frames.
 */
export function buildTranscript(ctx: TranscriptContext): TranscriptBuild {
  const container = new Container();
  const toolComponents: ToolExecutionComponent[] = [];
  const bashComponents: BashExecutionComponent[] = [];
  const { session, record, activity, theme: th, partials } = ctx;

  const streaming = session.state?.streamingMessage;
  const completed = session.messages;
  const messages = streaming?.role === "assistant"
    ? [...completed, streaming as (typeof completed)[number]]
    : completed;
  const streamingRef = streaming?.role === "assistant" ? streaming : undefined;

  if (messages.length === 0) {
    container.addChild(new Text(th.fg("dim", "(waiting for first message...)"), 0, 0));
    return { container, toolComponents, bashComponents };
  }

  const running = record.status === "running" || record.status === "queued";
  const resultById = new Map<string, any>();
  for (const msg of messages) {
    if (msg.role === "toolResult") {
      const id = (msg as any).toolCallId;
      if (typeof id === "string") resultById.set(id, msg);
    }
  }
  const consumedResults = new Set<string>();

  for (const msg of messages) {
    if (msg.role === "toolResult") {
      const id = (msg as any).toolCallId as string | undefined;
      if (id !== undefined && consumedResults.has(id)) continue;
    }

    if (msg.role === "user") {
      const text = typeof msg.content === "string" ? msg.content : extractText(msg.content);
      if (!text.trim()) continue;
      const entry = new Container();
      entry.addChild(new Text(th.fg("accent", "[User]"), 0, 0));
      entry.addChild(new UserMessageComponent(text.trim(), ctx.markdownTheme, 0));
      container.addChild(entry);
    } else if (msg.role === "assistant") {
      const assistant = assistantComponent(ctx, msg, msg === streamingRef);
      container.addChild(assistant);
      if (msg === streamingRef && msg.content.length === 0) {
        container.addChild(new Text(th.fg("dim", "  ✻ thinking…"), 0, 0));
      }
      for (const c of msg.content) {
        if (c.type !== "toolCall") continue;
        const callId = (c as any).id ?? (c as any).toolUseId;
        const comp = toolComponent(ctx, c as any);
        feedTool(ctx, comp, c as any, callId, resultById.get(callId), consumedResults, running, partials);
        container.addChild(comp);
        toolComponents.push(comp);
      }
    } else if (msg.role === "toolResult") {
      // Orphan: a result whose call is not in the transcript (pre-compaction).
      // Plain text, like pi's own result fallback — a result is arbitrary bytes.
      const text = extractText(msg.content).trim();
      if (!text) continue;
      const entry = new Container();
      entry.addChild(new Text(th.fg("dim", "[Result]"), 0, 0));
      for (const line of text.split("\n")) entry.addChild(new Text(th.fg("dim", line), 0, 0));
      container.addChild(entry);
    } else if ((msg as any).role === "bashExecution") {
      const bash = msg as any;
      const comp = new BashExecutionComponent(bash.command ?? "", ctx.tui, bash.excludeFromContext === true, 0);
      if (bash.output) comp.appendOutput(bash.output);
      comp.setComplete(bash.exitCode, false);
      if (ctx.expanded) comp.setExpanded(true);
      container.addChild(comp);
      bashComponents.push(comp);
    }
  }

  if (record.status === "running" && activity) {
    const act = describeActivity(
      activity.activeTools,
      activity.responseText,
      activity.lastTool,
      activity.lastActivity === "tool",
    );
    container.addChild(new Text(th.fg("accent", "▍ ") + th.fg("dim", act), 0, 0));
  }

  return { container, toolComponents, bashComponents };
}

type AssistantSessionMessage = Extract<AgentSession["messages"][number], { role: "assistant" }>;

function assistantComponent(ctx: TranscriptContext, msg: AssistantSessionMessage, isStreaming: boolean): AssistantMessageComponent {
  const existing = ctx.assistantComponents.get(msg);
  if (existing) {
    // Constructor already built the content; only a reused component needs the delta.
    existing.updateContent(msg, isStreaming);
    return existing;
  }
  const comp = new AssistantMessageComponent(msg, false, ctx.markdownTheme);
  ctx.assistantComponents.set(msg, comp);
  return comp;
}

/** The renderer-pair argument `ToolExecutionComponent` accepts, as our loose `ToolRenderers` meets it at this boundary. */
type ToolRendererArg = ConstructorParameters<typeof ToolExecutionComponent>[4];

let fallbackCallId = 0;

function toolComponent(ctx: TranscriptContext, call: { name?: string; toolName?: string; arguments?: unknown; input?: unknown; id?: string; toolUseId?: string }): ToolExecutionComponent {
  const existing = ctx.toolComponents.get(call);
  if (existing) return existing;
  const name = call.name ?? call.toolName ?? "unknown";
  const args = call.arguments ?? call.input;
  const callId = String(call.id ?? call.toolUseId ?? `call-${++fallbackCallId}`);
  // The call has, by definition of being in the transcript, started and its
  // arguments are complete — what pi's live context would report mid-stream.
  // `ui` must NOT prototype from pi's proxied extension TUI (`Object.create`
  // here once made pi's current-TUI resolution land back on this shadow, and
  // a renderer's ctx.invalidate() recursed requestRender until the stack
  // blew). These components only ever call `ui.requestRender`, so a
  // standalone object routed at the viewer's invalidation is enough — same
  // shape as the pre-component fake context, which was re-entrancy-safe.
  const toolUi = { requestRender: () => ctx.invalidate() } as unknown as TUI;
  const comp = new ToolExecutionComponent(
    name,
    callId,
    args,
    { showImages: true },
    resolveRenderers(ctx.session, ctx.builtinRenderers, name) as ToolRendererArg,
    toolUi,
    process.cwd(),
  );
  comp.markExecutionStarted();
  comp.setArgsComplete();
  if (ctx.expanded) comp.setExpanded(true);
  ctx.toolComponents.set(call, comp);
  return comp;
}

function feedTool(
  ctx: TranscriptContext,
  comp: ToolExecutionComponent,
  call: { id?: string; toolUseId?: string },
  callId: unknown,
  result: any,
  consumedResults: Set<string>,
  running: boolean,
  partials: Map<string, string>,
): void {
  let feed = ctx.toolFeeds.get(call);
  if (!feed) {
    feed = { final: false, partial: undefined };
    ctx.toolFeeds.set(call, feed);
  }
  if (result) {
    if (typeof callId === "string") consumedResults.add(callId);
    if (!feed.final) {
      comp.updateResult({ content: result.content, details: result.details, isError: !!result.isError }, false);
      feed.final = true;
    }
    return;
  }
  if (!running) return;
  const partial = typeof callId === "string" ? partials.get(callId)?.trim() : undefined;
  if (partial && partial !== feed.partial) {
    comp.updateResult({ content: [{ type: "text", text: partial }], isError: false }, true);
    feed.partial = partial;
  }
}
