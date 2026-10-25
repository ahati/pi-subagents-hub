/**
 * conversation-viewer.ts — Live conversation overlay for viewing agent sessions.
 *
 * Displays a scrollable, live-updating view of an agent's conversation.
 * Subscribes to session events for real-time streaming updates.
 *
 * Two hosts, two modes:
 *   - Standalone (FleetView, /agents): pi's fullscreen TUI mode renders it
 *     edge-to-edge with a ScrollView scrollbar, mouse handling and clickable
 *     footer controls; regular mode keeps the windowed floating overlay.
 *   - Embedded (`ConversationViewerOptions`, the agent hub's transcript pages):
 *     content-only rows inside the host's frame, host-driven scrolling, no
 *     fullscreen machinery — even when pi itself runs fullscreen.
 */

import {
  type AgentSession,
  AssistantMessageComponent,
  BashExecutionComponent,
  ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  type Focusable,
  Input,
  type MarkdownTheme,
  matchesKey,
  ScrollView,
  type ScrollViewScrollbar,
  stripTerminalSequences,
  type TUI,
  type TuiMouseEvent,
  type TuiMouseEventResult,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { extractText } from "../context.js";
import type { AgentRecord } from "../types.js";
import type { AgentActivity, Theme } from "./agent-widget.js";
import {
  computeChromeLines,
  computeViewportHeight,
  getUiStyle,
  isFooterShown,
  isFrameless,
  resolveIdentityBlock,
} from "./viewer/viewer-chrome.js";
import {
  buildTranscript,
  computeLastMessageSignature,
  stripShellZones,
  type TranscriptBuild,
} from "./viewer/viewer-content.js";
import {
  type ConversationViewerOptions,
  loadBuiltinRenderers,
  resolveMarkdownTheme,
  SCROLLBAR_WIDTH,
  type ToolRenderers,
  type ViewerBackgroundAction,
} from "./viewer/viewer-types.js";
import { createViewerKeys, type ViewerKeybindings, type ViewerKeys } from "./viewer-keys.js";

export * from "./viewer/viewer-types.js";

export class ConversationViewer implements Component, Focusable {
  private scrollOffset = 0;
  private autoScroll = true;
  focused = false;
  private readonly fullscreen: boolean;
  private viewport: { width: number; top: number; height: number; maxScroll: number; thumbTop: number; thumbHeight: number } | undefined;
  private scrollbarGrabOffset: number | undefined;
  private footerTargets: { start: number; end: number; key: string }[] = [];
  private latestTarget: { row: number; start: number; end: number } | undefined;
  private newMessages = 0;
  private readonly scrollView: ScrollView;
  private unsubscribe: (() => void) | undefined;
  private lastInnerW = 0;
  private closed = false;
  private stopArmed = false;
  private bandState: { lines: number; percent: number } | undefined;
  private expanded = false;
  private keys: ViewerKeys;
  private composer: Input | undefined;

  get composing(): boolean {
    return this.composer !== undefined;
  }
  private readonly markdownTheme: MarkdownTheme;
  private readonly assistantComponents = new WeakMap<object, AssistantMessageComponent>();
  private readonly toolComponentsByCall = new WeakMap<object, ToolExecutionComponent>();
  private readonly toolFeeds = new WeakMap<object, { final: boolean; partial: string | undefined }>();
  private toolComponents: ToolExecutionComponent[] = [];
  private bashComponents: BashExecutionComponent[] = [];
  private readonly partials = new Map<string, string>();
  private static readonly PARTIAL_CAP = 100_000;
  private contentCache: { key: string; lines: string[] } | undefined;
  private contentDirty = true;
  private builtinRenderers: Record<string, ToolRenderers> | undefined;

  constructor(
    private tui: TUI,
    private session: AgentSession,
    private record: AgentRecord,
    private activity: AgentActivity | undefined,
    private theme: Theme,
    private done: (result: undefined) => void,
    private onStop?: () => void,
    keybindings?: ViewerKeybindings,
    private onSteer?: (message: string) => void,
    private showCost = false,
    scrollbarMode: ScrollViewScrollbar = "auto",
    private onBackground?: ViewerBackgroundAction,
    private options?: ConversationViewerOptions,
  ) {
    this.fullscreen = !options && tui.mode === "fullscreen";
    this.markdownTheme = resolveMarkdownTheme(theme);
    this.keys = createViewerKeys(keybindings);
    this.scrollView = new ScrollView({
      render: width => this.buildContentLines(width),
      invalidate: () => {},
    }, { follow: "end", scrollbar: this.fullscreen ? scrollbarMode : "hidden" });

    void loadBuiltinRenderers().then(renderers => {
      if (renderers && !this.closed) {
        this.builtinRenderers = renderers;
        this.contentDirty = true;
        this.tui.requestRender();
      }
    });

    this.unsubscribe = session.subscribe(event => {
      if (this.closed) return;
      this.contentDirty = true;
      if (event.type === "tool_execution_update") {
        const content = (event.partialResult as { content?: unknown } | undefined)?.content;
        const text = Array.isArray(content) ? extractText(content as any) : "";
        this.partials.set(event.toolCallId, text.length > ConversationViewer.PARTIAL_CAP ? text.slice(-ConversationViewer.PARTIAL_CAP) : text);
      } else if (event.type === "tool_execution_end") {
        this.partials.delete(event.toolCallId);
      }
      if (this.fullscreen && !this.scrollView.isFollowingEnd && event.type === "message_start" && ["user", "assistant", "toolResult", "bashExecution"].includes(event.message.role)) {
        this.newMessages++;
      }
      this.tui.requestRender();
    });
  }

  handleInput(data: string): void {
    if (this.closed) return;
    if (this.fullscreen && (matchesKey(data, "ctrl+end") || (!this.composer && matchesKey(data, "end")))) {
      this.jumpToLatest();
      return;
    }
    if (this.composer) {
      this.composer.handleInput(data);
      this.tui.requestRender();
      return;
    }

    if (this.options?.onUnhandledKey?.(data)) {
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "q")) {
      if (this.options?.onBack) {
        this.options.onBack();
        return;
      }
      this.closed = true;
      this.done(undefined);
      return;
    }

    if (matchesKey(data, "enter") && this.canSteer()) {
      this.stopArmed = false;
      this.openComposer();
      return;
    }

    if (matchesKey(data, "b") && this.canSendToBackground()) {
      this.stopArmed = false;
      this.onBackground?.send();
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "x")) {
      if (this.isStoppable()) {
        if (this.stopArmed) {
          this.stopArmed = false;
          this.onStop?.();
        } else {
          this.stopArmed = true;
        }
        this.tui.requestRender();
      }
      return;
    }

    if (this.keys.expand(data)) {
      this.stopArmed = false;
      this.expanded = !this.expanded;
      for (const comp of this.toolComponents) comp.setExpanded(this.expanded);
      for (const comp of this.bashComponents) comp.setExpanded(this.expanded);
      this.contentDirty = true;
      this.tui.requestRender();
      return;
    }
    if (this.stopArmed) this.stopArmed = false;

    const totalLines = this.buildContentLines(this.lastInnerW).length;
    const viewportHeight = this.viewportHeight();
    if (this.fullscreen) {
      this.scrollView.updateLayout(totalLines, viewportHeight, () => {
        if (!this.closed) this.tui.requestRender();
      });
      if (this.keys.scrollUp(data)) this.scrollView.scrollBy(-1);
      else if (this.keys.scrollDown(data)) this.scrollView.scrollBy(1);
      else if (this.keys.pageUp(data)) this.scrollView.scrollBy(-viewportHeight);
      else if (this.keys.pageDown(data)) this.scrollView.scrollBy(viewportHeight);
      else if (matchesKey(data, "home")) this.scrollView.scrollToStart();
      return;
    }
    const maxScroll = Math.max(0, totalLines - viewportHeight);

    if (this.keys.scrollUp(data)) {
      this.scrollOffset = Math.max(0, this.scrollOffset - 1);
      this.autoScroll = this.scrollOffset >= maxScroll;
    } else if (this.keys.scrollDown(data)) {
      this.scrollOffset = Math.min(maxScroll, this.scrollOffset + 1);
      this.autoScroll = this.scrollOffset >= maxScroll;
    } else if (this.keys.pageUp(data)) {
      this.scrollOffset = Math.max(0, this.scrollOffset - viewportHeight);
      this.autoScroll = false;
    } else if (this.keys.pageDown(data)) {
      this.scrollOffset = Math.min(maxScroll, this.scrollOffset + viewportHeight);
      this.autoScroll = this.scrollOffset >= maxScroll;
    } else if (matchesKey(data, "home")) {
      this.scrollOffset = 0;
      this.autoScroll = false;
    } else if (matchesKey(data, "end")) {
      this.scrollOffset = maxScroll;
      this.autoScroll = true;
    }
  }

  private jumpToLatest(): void {
    this.scrollView.scrollToEnd();
    this.newMessages = 0;
    this.stopArmed = false;
    this.tui.requestRender();
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult {
    if (!this.fullscreen) return { handled: false };
    if (this.closed || !this.viewport) return { handled: true, render: false };
    const view = this.viewport;
    const onScrollbar = this.scrollView.scrollbar !== "hidden" && event.x >= view.width - SCROLLBAR_WIDTH && event.x < view.width && event.y >= view.top && event.y < view.top + view.height;
    if (event.type === "move") {
      this.scrollView.setScrollbarActive(onScrollbar);
      return { handled: true, render: false };
    }
    if (event.type === "wheel") {
      this.stopArmed = false;
      this.scrollView.scrollBy(event.wheelDelta ?? 0);
      return { handled: true, render: true };
    }
    if (event.type === "release") {
      const wasDragging = this.scrollbarGrabOffset !== undefined;
      this.scrollbarGrabOffset = undefined;
      this.scrollView.setScrollbarActive(onScrollbar);
      return { handled: true, render: wasDragging };
    }
    if (event.type === "drag" && this.scrollbarGrabOffset !== undefined) {
      const travel = view.height - view.thumbHeight;
      const position = Math.max(0, Math.min(travel, event.y - view.top - this.scrollbarGrabOffset));
      this.scrollView.scrollTo(travel > 0 ? Math.round(position / travel * view.maxScroll) : 0);
      return { handled: true, render: true };
    }
    if (event.type === "press" && event.button === "left") {
      this.scrollbarGrabOffset = undefined;
      this.scrollView.setScrollbarActive(onScrollbar);
      if (this.latestTarget && event.y === this.latestTarget.row && event.x >= this.latestTarget.start && event.x < this.latestTarget.end) {
        this.jumpToLatest();
        return { handled: true, render: true };
      }
      if (event.y === this.tui.terminal.rows - 1) {
        const target = this.footerTargets.find(t => event.x >= t.start && event.x < t.end);
        if (target) {
          this.handleInput(target.key);
          return { handled: true, render: true };
        }
      }
      this.stopArmed = false;
      if (this.composer && event.y === this.tui.terminal.rows - 2) {
        this.composer.handleMouse({ ...event, x: event.x - 1, y: 0, width: this.lastInnerW, height: 1 });
        return { handled: true, render: true };
      }
      if (onScrollbar && view.maxScroll > 0) {
        const y = event.y - view.top;
        if (y >= view.thumbTop && y < view.thumbTop + view.thumbHeight) {
          this.scrollbarGrabOffset = y - view.thumbTop;
          return { handled: true, capture: true, render: true };
        }
        this.scrollView.scrollBy(y < view.thumbTop ? -view.height : view.height);
        this.scrollbarGrabOffset = Math.floor(view.thumbHeight / 2);
        return { handled: true, capture: true, render: true };
      }
      return { handled: true, render: true };
    }
    return { handled: true, render: false };
  }

  render(width: number): string[] {
    this.footerTargets = [];
    this.latestTarget = undefined;
    this.viewport = undefined;
    const rows = Math.max(0, this.tui.terminal.rows);
    if (!this.fullscreen && width < 6) return [];
    if (this.fullscreen && width <= SCROLLBAR_WIDTH + 1) return Array.from({ length: rows }, () => " ".repeat(Math.max(0, width)));
    const th = this.theme;
    const frameless = isFrameless(this.options);
    const isPi = getUiStyle(this.options) === "pi";
    const innerW = this.fullscreen ? this.scrollView.getContentWidth(width - 1) : frameless ? width : isPi ? width - 2 : width - 4;
    this.lastInnerW = innerW;
    const lines: string[] = [];
    const footerActions: { label: string; key: string }[] = [];

    const pad = (s: string, len: number) => {
      const vis = visibleWidth(s);
      return s + " ".repeat(Math.max(0, len - vis));
    };
    const applyBg = (text: string): string => {
      if (typeof (th as any).bg === "function") {
        text = (th as any).bg("toolPendingBg", text);
        if (typeof (th as any).getBgAnsi === "function") {
          const bgAnsi = (th as any).getBgAnsi("toolPendingBg");
          if (bgAnsi && text.includes("\x1b[0m")) {
            text = text.replaceAll("\x1b[0m", `\x1b[0m${bgAnsi}`);
          }
        }
      }
      return text;
    };
    const row = (content: string, scrollbar?: string): string => {
      if (this.fullscreen) {
        const contentWidth = width - 1 - (scrollbar ? SCROLLBAR_WIDTH : 0);
        return " " + truncateToWidth(content, contentWidth, scrollbar ? "" : "...", true) + (scrollbar ?? "");
      }
      if (frameless) return truncateToWidth(pad(content, innerW), innerW, "...", true);
      if (isPi) {
        return applyBg(" " + truncateToWidth(pad(content, innerW), innerW, "...", true) + " ");
      }
      return th.fg("border", "│") + " " + truncateToWidth(pad(content, innerW), innerW, "...", true) + " " + th.fg("border", "│");
    };
    const hrTop = isPi
      ? applyBg(th.fg("border", "\u2594".repeat(width)))
      : th.fg("border", `╭${"─".repeat(width - 2)}╮`);
    const hrBot = isPi
      ? applyBg(th.fg("border", "\u2581".repeat(width)))
      : th.fg("border", `╰${"─".repeat(width - 2)}╯`);
    const hrMid = row(th.fg("dim", "─".repeat(innerW)));

    if (!this.fullscreen && !frameless) lines.push(hrTop);
    const identity = resolveIdentityBlock(this.options, this.record, this.activity, this.theme, this.showCost);
    if (identity.length > 0) {
      for (const line of identity) lines.push(row(line));
      lines.push(hrMid);
    }

    const contentLines = this.fullscreen ? this.scrollView.render(width - 1) : this.buildContentLines(innerW);
    const viewportHeight = this.viewportHeight();
    const maxScroll = Math.max(0, contentLines.length - viewportHeight);
    if (this.fullscreen) {
      this.scrollView.updateLayout(contentLines.length, viewportHeight, () => {
        if (!this.closed) this.tui.requestRender();
      });
      if (this.scrollView.isFollowingEnd) this.newMessages = 0;
    } else if (this.autoScroll) {
      this.scrollOffset = maxScroll;
    }

    const visibleStart = this.fullscreen ? this.scrollView.scrollTop : Math.min(this.scrollOffset, maxScroll);
    const readout = contentLines.length <= viewportHeight
      ? 100
      : Math.round(((visibleStart + viewportHeight) / contentLines.length) * 100);
    this.bandState = { lines: contentLines.length, percent: readout };
    const visible = contentLines.slice(visibleStart, visibleStart + viewportHeight);
    const thumbHeight = Math.min(viewportHeight, Math.max(2, Math.round(viewportHeight * viewportHeight / Math.max(1, contentLines.length))));
    const thumbTop = maxScroll > 0 ? Math.round(visibleStart / maxScroll * (viewportHeight - thumbHeight)) : 0;
    this.viewport = { width, top: lines.length, height: viewportHeight, maxScroll, thumbTop, thumbHeight };

    for (let i = 0; i < viewportHeight; i++) {
      let scrollbar: string | undefined;
      if (this.fullscreen && this.scrollView.isScrollbarVisible) {
        const onThumb = i >= thumbTop && i < thumbTop + thumbHeight;
        if (onThumb) {
          scrollbar = th.fg("scrollbarThumb", this.scrollView.isScrollbarActive ? "█" : "┃");
        } else {
          scrollbar = th.fg("scrollbarTrack", "│");
        }
      }
      lines.push(row(visible[i] ?? "", scrollbar));
    }

    if (this.fullscreen && !this.scrollView.isFollowingEnd && maxScroll > 0 && rows >= this.chromeLines()) {
      const text = this.newMessages > 0
        ? `${this.newMessages} new message${this.newMessages === 1 ? "" : "s"}`
        : "Jump to latest message";
      const label = truncateToWidth(`[ ↓ ${text} · Ctrl+End ]`, innerW, "…");
      const labelWidth = visibleWidth(label);
      const padding = Math.floor((innerW - labelWidth) / 2);
      this.latestTarget = { row: lines.length, start: padding + 1, end: padding + 1 + labelWidth };
      lines.push(row(th.fg("dim", "─".repeat(padding)) + th.fg("accent", label) + th.fg("dim", "─".repeat(innerW - padding - labelWidth))));
    } else if (isFooterShown(this.options)) {
      lines.push(hrMid);
    }
    if (this.composer) {
      this.composer.focused = this.focused;
      lines.push(row(this.composer.render(innerW)[0] ?? ""));
      footerActions.push({ label: "Enter send", key: "\r" }, { label: "Esc cancel", key: "\x1b" });
      const composeHint = th.fg("dim", "Enter send · Esc cancel");
      const composeLeft = th.fg("accent", "✎ steer");
      const composeGap = Math.max(1, innerW - visibleWidth(composeLeft) - visibleWidth(composeHint));
      lines.push(row(composeLeft + " ".repeat(composeGap) + composeHint));
    } else if (isFooterShown(this.options)) {
      const sep = th.fg("dim", " · ");
      if (this.canSteer()) footerActions.push({ label: "Enter steer", key: "\r" });
      if (this.canSendToBackground()) footerActions.push({ label: "b bg", key: "b" });
      if (this.isStoppable()) {
        footerActions.push({ label: this.stopArmed ? "x again to STOP" : "x stop", key: "x" });
      }
      const actions = footerActions.map(a => th.fg(a.key === "x" && this.stopArmed ? "error" : "dim", a.label));
      const quitLabel = this.options?.onBack ? this.backHintText() : "Esc close";
      footerActions.push({ label: quitLabel, key: "\x1b" });
      const footerRight = this.fullscreen
        ? th.fg("dim", `↑↓ scroll · PgUp/PgDn or Shift+↑↓ · ${quitLabel}`)
        : th.fg("dim", `${this.scrollHintText()} · ${this.backHintText()}`);

      const count = th.fg("dim", `${contentLines.length} lines · ${readout}%`);
      const withCount = [count, ...actions].join(sep);
      const footerLeft = visibleWidth(withCount) + visibleWidth(footerRight) + 1 <= innerW
        ? withCount
        : actions.join(sep);

      const footerGap = Math.max(1, innerW - visibleWidth(footerLeft) - visibleWidth(footerRight));
      lines.push(row(footerLeft + " ".repeat(footerGap) + footerRight));
    }
    if (!this.fullscreen) {
      if (!frameless) lines.push(hrBot);
      return lines;
    }
    const footer = lines.pop() ?? row("");
    const output = rows > 0 ? [...lines.slice(0, rows - 1), footer] : [];
    const footerText = stripTerminalSequences(footer);
    for (const action of footerActions) {
      const index = footerText.indexOf(action.label);
      if (index < 0) continue;
      const start = visibleWidth(footerText.slice(0, index));
      this.footerTargets.push({ start, end: start + visibleWidth(action.label), key: action.key });
    }
    return output;
  }

  private isStoppable(): boolean {
    return !!this.onStop && (this.record.status === "running" || this.record.status === "queued");
  }

  private backHintText(): string {
    if (!this.options?.onBack) return "Esc close";
    const hint = this.options.backHint;
    return (typeof hint === "function" ? hint() : hint) ?? "Esc back";
  }

  private scrollHintText(): string {
    const hint = this.options?.scrollHint;
    return (typeof hint === "function" ? hint() : hint) ?? "↑↓ scroll · PgUp/PgDn or Shift+↑↓";
  }

  private canSteer(): boolean {
    return !!this.onSteer && (this.record.status === "running" || this.record.status === "queued");
  }

  private canSendToBackground(): boolean {
    return this.onBackground?.available() === true;
  }

  private openComposer(): void {
    const input = new Input();
    input.focused = true;
    input.onSubmit = (value: string) => {
      const message = value.trim();
      this.composer = undefined;
      if (message) this.onSteer?.(message);
      this.tui.requestRender();
    };
    input.onEscape = () => {
      this.composer = undefined;
      this.tui.requestRender();
    };
    this.composer = input;
    this.tui.requestRender();
  }

  invalidate(): void {}

  scrollBy(delta: number): boolean {
    if (!Number.isFinite(delta) || delta === 0 || this.composer) return false;
    const totalLines = this.buildContentLines(this.lastInnerW).length;
    const viewportHeight = this.viewportHeight();
    const maxScroll = Math.max(0, totalLines - viewportHeight);
    const next = Math.min(maxScroll, Math.max(0, this.scrollOffset + delta));
    if (next === this.scrollOffset) return false;
    this.scrollOffset = next;
    this.autoScroll = this.scrollOffset >= maxScroll;
    return true;
  }

  bandReadout(): { text: string; expanded: boolean; stopArmed: boolean } {
    const band = this.bandState;
    return {
      text: band ? `${band.lines} lines · ${band.percent}%` : "",
      expanded: this.expanded,
      stopArmed: this.stopArmed,
    };
  }

  dispose(): void {
    this.closed = true;
    this.scrollView.setScrollbar("hidden");
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }
  }

  private viewportHeight(): number {
    return computeViewportHeight(
      this.tui.terminal.rows,
      this.fullscreen,
      this.options,
      this.chromeLines(),
      this.composing,
    );
  }

  private chromeLines(): number {
    const identityCount = resolveIdentityBlock(
      this.options,
      this.record,
      this.activity,
      this.theme,
      this.showCost,
    ).length;
    return computeChromeLines(this.fullscreen, this.options, identityCount, this.composing);
  }

  private buildContentLines(width: number): string[] {
    if (width <= 0) return [];

    const key = `${width}|${this.record.status}|${this.session.messages.length}|${computeLastMessageSignature(this.session)}`;
    if (!this.contentDirty && this.contentCache?.key === key) {
      return this.contentCache.lines;
    }

    const build: TranscriptBuild = buildTranscript({
      tui: this.tui,
      session: this.session,
      record: this.record,
      activity: this.activity,
      theme: this.theme,
      markdownTheme: this.markdownTheme,
      partials: this.partials,
      builtinRenderers: this.builtinRenderers,
      expanded: this.expanded,
      invalidate: () => {
        this.contentDirty = true;
        this.tui.requestRender();
      },
      assistantComponents: this.assistantComponents,
      toolComponents: this.toolComponentsByCall,
      toolFeeds: this.toolFeeds,
    });
    this.toolComponents = build.toolComponents;
    this.bashComponents = build.bashComponents;
    const lines = build.container.render(width).map(stripShellZones);
    this.contentCache = { key, lines };
    this.contentDirty = false;
    return lines;
  }
}
