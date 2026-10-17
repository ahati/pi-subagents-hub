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

import { type AgentSession, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { type Component, type Focusable, Input, Markdown, type MarkdownOptions, type MarkdownTheme, matchesKey, type OverlayOptions, ScrollView, type ScrollViewScrollbar, stripTerminalSequences, type TUI, type TuiMouseEvent, type TuiMouseEventResult, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { renderAgentRecordName } from "../agent-color.js";
import { extractText } from "../context.js";
import type { AgentRecord, UIStyle, ViewerMarkdownMode } from "../types.js";
import { getLifetimeCost, getLifetimeTotal, getSessionContextPercent } from "../usage.js";
import type { Theme } from "./agent-widget.js";
import { type AgentActivity, buildInvocationTags, describeActivity, fgPreservingNestedStyles, formatCost, formatDuration, formatSessionTokens, getPromptModeLabel } from "./agent-widget.js";
import { createViewerKeys, type ViewerKeybindings, type ViewerKeys } from "./viewer-keys.js";

const MIN_VIEWPORT = 3;
/** Rows the composer spends: its input row and its `Enter send · Esc cancel` hint. */
const COMPOSER_ROWS = 2;
/** Height ceiling shared by the overlay's `maxHeight` and the viewer's internal viewport cap. */
export const VIEWPORT_HEIGHT_PCT = 70;
const SCROLLBAR_WIDTH = 1;

/** Follow the active renderer, not a setting that may require a restart. */
export function getConversationOverlayOptions(tui: Pick<TUI, "mode">): OverlayOptions {
  return tui.mode === "fullscreen"
    ? { anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0 }
    : { anchor: "center", width: "90%", maxHeight: `${VIEWPORT_HEIGHT_PCT}%` };
}

/**
 * Optional behavior overrides for a viewer embedded in a larger surface (the
 * agent hub). All fields optional; a standalone viewer (the windowed overlay)
 * constructs with none of them and behaves exactly as before.
 */
export interface ConversationViewerOptions {
  /**
   * Height ceiling as a percentage of the terminal, shared by the overlay's
   * `maxHeight` and the internal viewport cap. A function is re-read on every
   * render, so a host that resizes itself (the hub's popup ↔ full-screen
   * toggle) can change the viewer's viewport live. Defaults to
   * `VIEWPORT_HEIGHT_PCT`.
   */
  maxHeightPct?: number | (() => number);
  /**
   * Content rows the host has left for this viewer. An embedded host knows
   * this exactly — its frame's own arithmetic produced it — so it replaces the
   * `maxHeightPct` ceiling instead of stacking with it. A function is re-read
   * on every render, so a resizing host drags the viewport along.
   */
  viewportRows?: number | (() => number);
  /**
   * The viewer's own header block — the header line, the `↳` line and the rule
   * under them. `false` suppresses all three for a host that composes identity
   * in its own frame (which then owns the rule too); a prebuilt block replaces
   * the two text rows. Defaults to the viewer's own block.
   */
  identity?: readonly string[] | false;
  /**
   * The viewer's own footer row and the rule above it. `false` for a host that
   * draws its own footer band; the composer still renders its own rows, so
   * steering stays possible. Defaults to drawn (the standalone overlay keeps
   * its clickable footer).
   */
  footer?: boolean;
  /**
   * When set, Esc/Ctrl+C/Q return to the parent surface by calling this instead
   * of resolving `done` (which would close the whole overlay). The quit keys
   * become "back" keys; the parent decides how to actually close.
   */
  onBack?: () => void;
  /** Footer text for the back key when `onBack` is set. A function is re-read
   *  on every render. Defaults to `"Esc back"`. */
  backHint?: string | (() => string);
  /**
   * Footer text for the scroll keys, when the host repurposes the viewer's
   * defaults. A function is re-read on every render. Defaults to
   * `"↑↓ scroll · PgUp/PgDn or Shift+↑↓"` — accurate only while ↑/↓ really
   * scroll, so a host that intercepts them (the hub's agent list) supplies its
   * own.
   */
  scrollHint?: string | (() => string);
  /**
   * Render without the `╭─╮` frame and side borders — content rows only,
   * padded to the full render width. For a host that embeds the viewer inside
   * its own overall frame (the hub window, whose border spans the roster
   * master too). A function is re-read on every render, so the host
   * can fall back to the framed box when it drops the side pane on narrow
   * terminals. Defaults to framed.
   */
  frameless?: boolean | (() => boolean);
  /**
   * UI chrome style:
   * - "pi": edge-to-edge horizontal borders (DynamicBorder), no outer │ rails.
   * - "claude": Claude Code rounded boxes (╭─╮ / │ │ / ╰─╯).
   * Defaults to "pi".
   */
  uiStyle?: UIStyle | (() => UIStyle);
  /**
   * Called for every key the viewer itself does not handle (after the composer,
   * which always wins while open). Return `true` to consume the key — this is
   * how the hub binds `f` without forking the viewer's key map.
   */
  onUnhandledKey?: (data: string) => boolean;
}

/**
 * Cap on a single tool result or bash output before the viewer elides the rest.
 *
 * The cap is not cosmetic — it bounds render cost. `buildContentLines()` runs on
 * every render *and* on every scroll key (`handleInput` calls it to compute
 * `maxScroll`), so an uncapped 200 KB result costs ~6 ms per keystroke to parse
 * as Markdown, against ~0.5 ms once capped and effectively nothing on a cache
 * hit (best of 5, width 76). 16 KB is roughly a screenful at every terminal size
 * and still ~30x the 500 characters this replaces, which was small enough to cut
 * most real results mid-sentence.
 */
export const RESULT_MAX_CHARS = 16_000;

/** The `b` affordance: whether this run can be handed to the background now, and the handoff. */
export interface ViewerBackgroundAction {
  available(): boolean;
  send(): void;
}

/** Cycle order for the viewer's `m` key. */
const MARKDOWN_MODES: readonly ViewerMarkdownMode[] = ["off", "assistant", "all"];

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

/** Fallback toolCallId for rich renderers when a call block carries no id. */
let fallbackCallId = 0;

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

/** Footer labels — short, because the idle footer is already full at 80 columns. */
const MARKDOWN_MODE_LABELS: Record<ViewerMarkdownMode, string> = {
  off: "raw",
  assistant: "md",
  all: "md+",
};

/**
 * Both options keep the renderer from *rewriting* source that only looks like
 * Markdown: without them `3) a / 7) b / 9) c` comes back renumbered `3. 4. 5.`
 * and backslash escapes are normalized away. Neither is a safe edit to make to
 * a tool's output, and both are cheap to switch off.
 */
const MARKDOWN_OPTIONS: MarkdownOptions = {
  preserveOrderedListMarkers: true,
  preserveBackslashEscapes: true,
};

/**
 * Pi's own Markdown theme when this process has one, else a theme built from the
 * viewer's `Theme`.
 *
 * Preferring pi's is what buys syntax-highlighted code fences (it carries a
 * `highlightCode`), and it keeps this surface consistent with the notification
 * renderer, which uses the same source. It has to be *probed* rather than
 * try/caught around the call: `getMarkdownTheme()` returns arrow functions that
 * read pi's global theme lazily, so an uninitialized theme throws inside
 * `render()` — long after this returns — and takes the overlay with it. That is
 * the case in tests and any embedded session that never called `initTheme()`.
 */
function resolveMarkdownTheme(th: Theme): MarkdownTheme {
  try {
    const piTheme = getMarkdownTheme();
    piTheme.heading("probe");
    return piTheme;
  } catch {
    return fallbackMarkdownTheme(th);
  }
}

/**
 * `Theme` carries only `fg` and `bold`, so the three remaining styles are
 * written as raw SGR. Rendering them as plain text instead would silently drop
 * `*emphasis*`'s markers with nothing in their place, turning a formatting
 * change into a content change.
 */
function fallbackMarkdownTheme(th: Theme): MarkdownTheme {
  const sgr = (on: number, off: number) => (text: string) => `\x1b[${on}m${text}\x1b[${off}m`;
  return {
    heading: text => th.bold(th.fg("accent", text)),
    link: text => th.fg("accent", text),
    linkUrl: text => th.fg("muted", text),
    code: text => th.fg("muted", text),
    codeBlock: text => th.fg("muted", text),
    codeBlockBorder: text => th.fg("dim", text),
    quote: text => th.fg("muted", text),
    quoteBorder: text => th.fg("dim", text),
    hr: text => th.fg("dim", text),
    listBullet: text => th.fg("accent", text),
    bold: text => th.bold(text),
    italic: sgr(3, 23),
    underline: sgr(4, 24),
    strikethrough: sgr(9, 29),
  };
}

/**
 * Tool renderers, as merged onto a definition: pi's main window does exactly
 * this merge (`withBuiltInRenderers(toolName, session.getToolDefinition(name))`).
 */
interface ToolRenderers {
  renderCall?: (args: any, theme: any, context: any) => unknown;
  renderResult?: (result: any, options: any, theme: any, context: any) => unknown;
}

let builtinRenderersPromise: Promise<Record<string, ToolRenderers> | undefined> | undefined;

/**
 * pi's built-in tool renderers (diffs, syntax-highlighted reads, command
 * blocks…) live in an internal module that the package's exports map does not
 * expose — the main window merges them over tool definitions at render time.
 * For main-window-quality rendering in this panel we locate that module
 * best-effort: pi's entry script is on argv and the module sits at a stable
 * path relative to the package root. Any failure (packaged binary, layout
 * change, unusual host) → undefined, and the viewer keeps its own text
 * rendering for built-ins. Extension tools render richly regardless, through
 * the session's own definitions.
 */
function loadBuiltinRenderers(): Promise<Record<string, ToolRenderers> | undefined> {
  builtinRenderersPromise ??= (async () => {
    try {
      const { dirname, join, resolve } = await import("node:path");
      const { readFile, realpath } = await import("node:fs/promises");
      const entry = process.argv[1];
      if (!entry) return undefined;
      let dir = dirname(await realpath(resolve(entry)));
      for (let i = 0; i < 10; i++) {
        try {
          const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
          if (pkg?.name === "@earendil-works/pi-coding-agent") {
            const mod = await import(join(dir, "dist", "core", "tools", "renderers", "index.js"));
            const all = mod?.createAllToolRenderers?.();
            return typeof all === "object" && all ? (all as Record<string, ToolRenderers>) : undefined;
          }
        } catch {
          // no package.json here — keep walking up
        }
        const parent = dirname(dir);
        if (parent === dir) return undefined;
        dir = parent;
      }
      return undefined;
    } catch {
      return undefined;
    }
  })();
  return builtinRenderersPromise;
}

/**
 * Cap `text` at `RESULT_MAX_CHARS`, reporting the elision separately rather than
 * appending it.
 *
 * Separately because the notice is the viewer's chrome, not the tool's output.
 * Appended into the string it becomes content: a cut landing inside a fenced
 * code block — likely, on exactly the large `ctx_execute` results this is for —
 * renders the notice as a line of source inside the fence.
 */
function capResult(text: string): { text: string; elided: number } {
  if (text.length <= RESULT_MAX_CHARS) return { text, elided: 0 };
  return {
    text: text.slice(0, RESULT_MAX_CHARS),
    elided: text.length - RESULT_MAX_CHARS,
  };
}

/**
 * `999` · `1.5k` · `8.4M` — a magnitude cue, not an exact count, past 1000.
 *
 * The bracket is chosen against the *rounded* value, so 999,999 reads `1M`
 * rather than the `1000.0k` a naive `< 1e6` test produces.
 */
function humanCount(n: number): string {
  if (n < 1_000) return `${n}`;
  const thousands = n < 999_950;
  const value = thousands ? n / 1_000 : n / 1_000_000;
  return `${value.toFixed(1).replace(/\.0$/, "")}${thousands ? "k" : "M"}`;
}

function truncationNote(elided: number): string {
  return `... (truncated, ${humanCount(elided)} more character${elided === 1 ? "" : "s"})`;
}

export class ConversationViewer implements Component, Focusable {
  private scrollOffset = 0;
  private autoScroll = true;
  focused = false;
  /**
   * The fullscreen observer (scrollbar, mouse, jump marker, clickable footer)
   * is the STANDALONE viewer's fullscreen-mode shape. An embedded viewer —
   * the hub's transcript pages — renders rows inside its host's frame no matter what
   * mode pi runs in, so `options` opts out.
   */
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
  /** Two-press confirm guard for the stop key, so a stray key can't kill the agent. */
  private stopArmed = false;
  /**
   * What the last frame rendered: the transcript's line count and scroll
   * percent, read by a host that draws its own footer band (`bandReadout`).
   */
  private bandState: { lines: number; percent: number } | undefined;
  /**
   * Rich-tool-output expansion, pi's `app.tools.expand` toggle. The rich
   * renderers draw their own "ctrl+o to expand" hints while collapsed; this
   * is the flag their key toggles. Viewer-local — it resets on reopen — and
   * text-fallback blocks keep `m` as their full-output affordance.
   */
  private expanded = false;
  private keys: ViewerKeys;
  /** Steering composer — present while the user is typing a message to the agent. */
  private composer: Input | undefined;

  /** Whether the steering composer is open — its keys must not be stolen. */
  get composing(): boolean {
    return this.composer !== undefined;
  }
  /** Resolved once: pi's Markdown theme is fixed for the life of the process. */
  private readonly markdownTheme: MarkdownTheme;
  /** Set by the `m` key. Wins over the setting so `m` works without a persist hook. */
  private markdownModeOverride: ViewerMarkdownMode | undefined;
  /**
   * One `Markdown` per message, so its own text/width cache does the work. A
   * fresh instance per render would re-parse the whole transcript on every
   * keystroke — the component caches, but only across calls to the same object.
   * Weak so a compacted-away message doesn't pin its render.
   */
  private readonly markdownCache = new WeakMap<object, { md: Markdown; text: string; failed?: boolean }>();
  /**
   * Rich tool-renderer components, keyed per call/result object. The stored
   * component is passed back to the renderer as `lastComponent` on the next
   * frame — renderers reuse or rebuild it as they see fit (pi's edit renderer
   * clears and refills the same Container, for instance).
   */
  private readonly callComponentCache = new WeakMap<object, { component: unknown }>();
  private readonly resultComponentCache = new WeakMap<object, { component: unknown }>();
  /**
   * Shared per-execution renderer state (`ToolRenderContext.state`), keyed by
   * toolCallId. The main window passes one plain object per tool execution to
   * every renderCall/renderResult and lets the renderer own its contents — the
   * edit renderer, for one, caches its call component and computed diff there
   * and reads them back on the result render. Without this, renderers silently
   * degrade to their no-state output (that is why edit hunks went missing).
   */
  private readonly toolExecState = new Map<string, Record<string, unknown>>();
  /**
   * Live tool output while a call runs, keyed by toolCallId: the latest
   * `tool_execution_update`'s text, tail-capped. Rendered under the pending
   * call in place of the static "awaiting result" line; dropped on
   * `tool_execution_end`, when the real result message takes over.
   */
  private readonly partials = new Map<string, string>();
  /** Most a stored partial keeps — bash output can stream megabytes. */
  private static readonly PARTIAL_CAP = 100_000;
  /**
   * Cache for `buildContentLines` — the transcript is O(messages) to rebuild
   * (Markdown re-render, ANSI truncation of every line) yet unchanged between
   * session events: a 5000-message agent measured ~1.3 s per rebuild, and the
   * hub's 200 ms tick kept one in flight on every frame, which read as a
   * freeze on close. Rebuilt only when a session event dirties it, or when a
   * key input changes (width, status, markdown mode, expand, message count).
   * Streaming stays live: every delta fires a session event, which dirties.
   */
  private contentCache: { key: string; lines: string[] } | undefined;
  private contentDirty = true;
  /** Built-in tool renderers, best-effort — see `loadBuiltinRenderers`. */
  private builtinRenderers: Record<string, ToolRenderers> | undefined;

  constructor(
    private tui: TUI,
    private session: AgentSession,
    private record: AgentRecord,
    private activity: AgentActivity | undefined,
    private theme: Theme,
    private done: (result: undefined) => void,
    /** Abort the agent shown here. Omitted → no stop affordance (e.g. read-only history). */
    private onStop?: () => void,
    /** User keybindings from `ctx.ui.custom()`. Omitted → hardcoded defaults. */
    keybindings?: ViewerKeybindings,
    /** Send a steering message to the agent. Omitted → no compose affordance. */
    private onSteer?: (message: string) => void,
    /**
     * Whether the header shows an estimated cost after the token count. Read
     * once, at construction: the overlay is opened from a menu, so the setting
     * cannot change while it is on screen.
     */
    private showCost = false,
    /**
     * The current `viewerMarkdown` setting. Read live rather than captured,
     * unlike `showCost`: `m` changes it while the overlay is on screen.
     * Omitted → `assistant`.
     */
    private viewerMarkdown?: () => ViewerMarkdownMode,
    /**
     * Persist a mode chosen with `m`, so the key and `/agents → Settings` mean
     * the same thing. Omitted → `m` still cycles, viewer-locally.
     */
    private onMarkdownMode?: (mode: ViewerMarkdownMode) => void,
    /** Pi's fullscreen scrollbar preference, captured when the observer opens. */
    scrollbarMode: ScrollViewScrollbar = "auto",
    /**
     * Hand this run to the background. `available` is read live — it turns
     * false the instant the handoff lands or the run ends. Omitted → no `b`
     * affordance (history views).
     */
    private onBackground?: ViewerBackgroundAction,
    /** Embedded-mode overrides — see `ConversationViewerOptions`. */
    private options?: ConversationViewerOptions,
  ) {
    this.fullscreen = !options && tui.mode === "fullscreen";
    this.markdownTheme = resolveMarkdownTheme(theme);
    this.keys = createViewerKeys(keybindings);
    this.scrollView = new ScrollView({
      render: width => this.buildContentLines(width),
      invalidate: () => {},
    }, { follow: "end", scrollbar: this.fullscreen ? scrollbarMode : "hidden" });
    // Rich built-in tool rendering arrives asynchronously (module discovery);
    // until then calls/results render as text, and one repaint upgrades them.
    void loadBuiltinRenderers().then(renderers => {
      if (renderers && !this.closed) {
        this.builtinRenderers = renderers;
        this.contentDirty = true; // text fallbacks upgrade to rich renderers
        this.tui.requestRender();
      }
    });
    this.unsubscribe = session.subscribe(event => {
      if (this.closed) return;
      // Any transcript change — a new message, a streaming delta, a tool
      // partial — invalidates the cached content lines below.
      this.contentDirty = true;
      // Capture streaming tool output so a running call can show it live.
      if (event.type === "tool_execution_update") {
        const content = (event.partialResult as { content?: unknown } | undefined)?.content;
        const text = Array.isArray(content) ? extractText(content as any) : "";
        this.partials.set(event.toolCallId, text.length > ConversationViewer.PARTIAL_CAP ? text.slice(-ConversationViewer.PARTIAL_CAP) : text);
      } else if (event.type === "tool_execution_end") {
        this.partials.delete(event.toolCallId);
      }
      // Count messages that arrived while the reader was scrolled away, so the
      // jump marker can say how many (fullscreen observer only).
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
    // While composing a steer message, the input owns all keys (Enter sends,
    // Esc cancels — both wired in openComposer()). Editing keys flow through.
    if (this.composer) {
      this.composer.handleInput(data);
      this.tui.requestRender();
      return;
    }

    // Host-surface keys (the hub's `f` toggle). Consumed before the viewer's
    // own bindings so the host never fights them; the composer above still wins
    // while it is open, so typing "f" into a steer message types an "f".
    if (this.options?.onUnhandledKey?.(data)) {
      this.tui.requestRender();
      return;
    }

    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "q")) {
      // Embedded in a parent surface (agent hub): the quit keys go "back" and
      // the parent keeps the overlay open. Standalone: they close it.
      if (this.options?.onBack) {
        this.options.onBack();
        return;
      }
      this.closed = true;
      this.done(undefined);
      return;
    }

    // Enter opens the steering composer (only while the agent can still be
    // steered) — then type + Enter sends, Esc or an empty submit returns. When
    // not steerable, fall through so the key still disarms a pending stop.
    if (matchesKey(data, "enter") && this.canSteer()) {
      this.stopArmed = false;
      this.openComposer();
      return;
    }

    // Hand a live foreground run to the background. Single press, unlike stop:
    // the transition is one-way but keeps the agent working, so a stray key
    // costs a notification rather than the run.
    if (matchesKey(data, "b") && this.canSendToBackground()) {
      this.stopArmed = false;
      this.onBackground?.send();
      this.tui.requestRender();
      return;
    }

    // Stop/abort the agent (only while it can still be stopped). Two-press:
    // first "x" arms, second confirms — any other key disarms.
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

    // Cycle raw → assistant-only → everything. The escape hatch that makes
    // Markdown rendering safe to default on: a result the renderer reshapes
    // (a diff, an indented log, a `#`-commented script) is one key from verbatim.
    if (matchesKey(data, "m")) {
      this.stopArmed = false;
      const next = MARKDOWN_MODES[(MARKDOWN_MODES.indexOf(this.markdownMode()) + 1) % MARKDOWN_MODES.length];
      this.markdownModeOverride = next;
      this.onMarkdownMode?.(next);
      this.tui.requestRender();
      return;
    }
    // Expand/collapse rich tool output. Resolved through the user's
    // app.tools.expand binding, so a remap stays in step with the hints the
    // renderers print (their keyHint resolves the same binding).
    if (this.keys.expand(data)) {
      this.stopArmed = false;
      this.expanded = !this.expanded;
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
    // Embedded viewers take wheel input from their host (scrollBy below);
    // only the fullscreen observer owns the pointer.
    if (!this.fullscreen) return { handled: false };
    // Every cell belongs to this observer. Even unused clicks/drags must not
    // fall through to Pi's transcript selection, scrolling, or editor.
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
        // A track click still pages, but holding it can grab the thumb too.
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
    if (!this.fullscreen && width < 6) return []; // too narrow for any meaningful rendering
    if (this.fullscreen && width <= SCROLLBAR_WIDTH + 1) return Array.from({ length: rows }, () => " ".repeat(Math.max(0, width)));
    const th = this.theme;
    // Frameless: the host (the hub window) draws the overall border
    // spanning its own panes, so this viewer contributes content rows only —
    // no `╭─╮` top/bottom, no side `│`; every line pads to the full width.
    const frameless = this.framelessNow();
    const isPi = this.uiStyleNow() === "pi";
    const innerW = this.fullscreen ? this.scrollView.getContentWidth(width - 1) : frameless ? width : width - 4; // border + padding
    this.lastInnerW = innerW;
    const lines: string[] = [];
    const footerActions: { label: string; key: string }[] = [];

    const pad = (s: string, len: number) => {
      const vis = visibleWidth(s);
      return s + " ".repeat(Math.max(0, len - vis));
    };
    const row = (content: string, scrollbar?: string): string => {
      if (this.fullscreen) {
        const contentWidth = width - 1 - (scrollbar ? SCROLLBAR_WIDTH : 0);
        return " " + truncateToWidth(content, contentWidth, scrollbar ? "" : "...", true) + (scrollbar ?? "");
      }
      if (frameless) return truncateToWidth(pad(content, innerW), innerW, "...", true);
      if (isPi) return "  " + truncateToWidth(pad(content, innerW), innerW, "...", true) + "  ";
      return th.fg("border", "│") + " " + truncateToWidth(pad(content, innerW), innerW, "...", true) + " " + th.fg("border", "│");
    };
    const hrTop = th.fg("border", isPi ? "─".repeat(width) : `╭${"─".repeat(width - 2)}╮`);
    const hrBot = th.fg("border", isPi ? "─".repeat(width) : `╰${"─".repeat(width - 2)}╯`);
    const hrMid = row(th.fg("dim", "─".repeat(innerW)));

    if (!this.fullscreen && !frameless) lines.push(hrTop);
    // Header block — suppressed (or replaced) when the host composes identity
    // in its own frame, so exactly one identity block is ever drawn.
    const identity = this.identityBlock();
    if (identity.length > 0) {
      for (const line of identity) lines.push(row(line));
      lines.push(hrMid);
    }

    // Content area — the fullscreen observer scrolls a ScrollView over the
    // (cached) content lines; every other mode slices them itself.
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
    // The readout the host's band reads: the same window the viewer's own
    // footer reports, kept here because the band renders outside this method.
    const readout = contentLines.length <= viewportHeight
      ? 100
      : Math.round(((visibleStart + viewportHeight) / contentLines.length) * 100);
    this.bandState = { lines: contentLines.length, percent: readout };
    const visible = contentLines.slice(visibleStart, visibleStart + viewportHeight);
    // Match Pi's scrollbar geometry: rounded size, at least two rows when available.
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

    // Keep the divider pinned above the footer, with the jump control centered
    // inside it. Neither scrolling nor new messages change its position.
    if (this.fullscreen && !this.scrollView.isFollowingEnd && maxScroll > 0 && rows >= this.chromeLines()) {
      const text = this.newMessages > 0
        ? `${this.newMessages} new message${this.newMessages === 1 ? "" : "s"}`
        : "Jump to latest message";
      const label = truncateToWidth(`[ ↓ ${text} · Ctrl+End ]`, innerW, "…");
      const labelWidth = visibleWidth(label);
      const padding = Math.floor((innerW - labelWidth) / 2);
      this.latestTarget = { row: lines.length, start: padding + 1, end: padding + 1 + labelWidth };
      lines.push(row(th.fg("dim", "─".repeat(padding)) + th.fg("accent", label) + th.fg("dim", "─".repeat(innerW - padding - labelWidth))));
    } else if (this.footerShown()) {
      // The rule above the footer belongs to the footer; a host that draws its
      // own band draws its own band rule.
      lines.push(hrMid);
    }
    if (this.composer) {
      // Composer row: the Input renders its own `> ` prompt and cursor.
      this.composer.focused = this.focused;
      lines.push(row(this.composer.render(innerW)[0] ?? ""));
      footerActions.push({ label: "Enter send", key: "\r" }, { label: "Esc cancel", key: "\x1b" });
      const composeHint = th.fg("dim", "Enter send · Esc cancel");
      const composeLeft = th.fg("accent", "✎ steer");
      const composeGap = Math.max(1, innerW - visibleWidth(composeLeft) - visibleWidth(composeHint));
      lines.push(row(composeLeft + " ".repeat(composeGap) + composeHint));
    } else if (this.footerShown()) {
      // Actions on the left, navigation on the right. The scroll hint keeps its
      // full key list so the less-obvious bindings stay discoverable; it leads
      // the right group so "Esc close" is the only part that truncates first.
      const sep = th.fg("dim", " · ");
      if (this.canSteer()) footerActions.push({ label: "Enter steer", key: "\r" });
      // Single press, unlike stop: handing off keeps the agent working.
      if (this.canSendToBackground()) footerActions.push({ label: "b bg", key: "b" });
      if (this.isStoppable()) {
        footerActions.push({ label: this.stopArmed ? "x again to STOP" : "x stop", key: "x" });
      }
      // Abbreviated (`raw`/`md`/`md+`) because the idle footer is already full
      // at 80 columns with steer + stop present, and this group has no
      // degradation step below "drop the line-count readout".
      footerActions.push({ label: `m ${MARKDOWN_MODE_LABELS[this.markdownMode()]}`, key: "m" });
      const actions = footerActions.map(a => th.fg(a.key === "x" && this.stopArmed ? "error" : "dim", a.label));
      const quitLabel = this.options?.onBack ? this.backHintText() : "Esc close";
      footerActions.push({ label: quitLabel, key: "\x1b" });
      const footerRight = this.fullscreen
        ? th.fg("dim", `↑↓ scroll · PgUp/PgDn or Shift+↑↓ · ${quitLabel}`)
        : th.fg("dim", `${this.scrollHintText()} · ${this.backHintText()}`);

      // Prepend the line-count/scroll-% readout only when there's spare width —
      // it's the first thing dropped so it never crowds out the hints.
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
    // Keep the footer on screen even in a terminal shorter than the chrome.
    const footer = lines.pop() ?? row("");
    const output = rows > 0 ? [...lines.slice(0, rows - 1), footer] : [];
    const footerText = stripTerminalSequences(footer);
    for (const action of footerActions) {
      const index = footerText.indexOf(action.label);
      if (index < 0) continue; // a clipped label is not a clickable control
      const start = visibleWidth(footerText.slice(0, index));
      this.footerTargets.push({ start, end: start + visibleWidth(action.label), key: action.key });
    }
    return output;
  }

  /** Whether the host asked for content-only rows (no frame of our own). */
  private framelessNow(): boolean {
    const flag = this.options?.frameless;
    return typeof flag === "function" ? flag() : !!flag;
  }

  /** UI style: "pi" or "claude". Defaults to "pi". */
  private uiStyleNow(): UIStyle {
    const style = this.options?.uiStyle;
    return typeof style === "function" ? style() : (style ?? "pi");
  }

  /** Whether the viewer draws its own footer row (and the rule above it). */
  private footerShown(): boolean {
    return this.options?.footer !== false;
  }

  /**
   * The rows of the viewer's own header block: the header line and the `↳`
   * line. Suppressed (`false`) or replaced (a prebuilt block) when the host's
   * frame composes identity itself — exactly one identity block per pane.
   */
  private identityBlock(): readonly string[] {
    const identity = this.options?.identity;
    if (identity === false) return [];
    if (Array.isArray(identity)) return identity;
    return this.ownIdentityLines();
  }

  /** The viewer's own header line and `↳` line, when it draws them itself. */
  private ownIdentityLines(): [string, string] {
    const th = this.theme;
    const modeLabel = getPromptModeLabel(this.record.type);
    const modeTag = modeLabel ? ` ${th.fg("dim", `(${modeLabel})`)}` : "";
    const statusIcon = this.record.status === "running"
      ? th.fg("accent", "●")
      : this.record.status === "completed"
        ? th.fg("success", "✓")
        : this.record.status === "error"
          ? th.fg("error", "✗")
          : th.fg("dim", "○");
    const headerParts: string[] = [formatDuration(this.record.startedAt, this.record.completedAt)];
    const toolUses = this.activity?.toolUses ?? this.record.toolUses;
    if (toolUses > 0) headerParts.unshift(`${toolUses} tool${toolUses === 1 ? "" : "s"}`);
    // Spend from the record, context from the live session: the record is the
    // only total that survives the agent finishing and the only one carrying a
    // nested child's spend.
    const tokens = getLifetimeTotal(this.record.lifetimeUsage);
    if (tokens > 0) {
      const percent = getSessionContextPercent(this.activity?.session);
      headerParts.push(formatSessionTokens(tokens, percent, th, this.record.compactionCount));
    }
    const cost = this.showCost ? formatCost(getLifetimeCost(this.record.lifetimeUsage)) : "";
    if (cost) headerParts.push(cost);
    return [
      `${statusIcon} ${renderAgentRecordName(this.record, th, { bold: true })}${modeTag}  ${th.fg("muted", this.record.description)} ${th.fg("dim", "·")} ${fgPreservingNestedStyles(th, "dim", headerParts.join(" · "))}`,
      this.invocationLine(),
    ];
  }

  /** Stoppable only when a stop handler exists and the agent is still active. */
  private isStoppable(): boolean {
    return !!this.onStop && (this.record.status === "running" || this.record.status === "queued");
  }

  /** The mode in force: an `m` press, else the setting, else the default. */
  private markdownMode(): ViewerMarkdownMode {
    return this.markdownModeOverride ?? this.viewerMarkdown?.() ?? "assistant";
  }

  /** Footer text for the quit/back key. */
  private backHintText(): string {
    if (!this.options?.onBack) return "Esc close";
    const hint = this.options.backHint;
    return (typeof hint === "function" ? hint() : hint) ?? "Esc back";
  }

  /** Footer text for the scroll keys; hosts that repurpose ↑/↓ override it. */
  private scrollHintText(): string {
    const hint = this.options?.scrollHint;
    return (typeof hint === "function" ? hint() : hint) ?? "↑↓ scroll · PgUp/PgDn or Shift+↑↓";
  }

  /** Wrap `text` literally — the pre-Markdown path, and the fallback from it. */
  private rawLines(text: string, width: number, dim: boolean): string[] {
    const lines = wrapTextWithAnsi(text, width);
    return dim ? lines.map(l => this.theme.fg("dim", l)) : lines;
  }

  /** Render `text` as Markdown, reusing this message's component instance. */
  private markdownLines(msg: AgentSession["messages"][number], text: string, width: number, dim: boolean): string[] {
    let entry = this.markdownCache.get(msg);
    if (!entry) {
      entry = {
        md: new Markdown(
          text,
          0,
          0,
          this.markdownTheme,
          // Keeps result prose visually receded, the way the raw path's
          // per-line `fg("dim", …)` did. Fenced code is the exception and is
          // left alone deliberately: pi's theme highlights it with its own
          // colors, which this would otherwise flatten.
          dim ? { color: (t: string) => this.theme.fg("dim", t) } : undefined,
          MARKDOWN_OPTIONS,
        ),
        text,
      };
      this.markdownCache.set(msg, entry);
    } else if (entry.text !== text) {
      // Streaming: the message object is stable, its text grows. A failed
      // prefix remains unsafe after append-only deltas, so retry only when the
      // content was replaced or truncated.
      const shouldRetry = !text.startsWith(entry.text);
      entry.md.setText(text);
      entry.text = text;
      if (shouldRetry) entry.failed = false;
    }
    if (entry.failed) return this.rawLines(text, width, dim);

    try {
      return entry.md.render(width);
    } catch {
      // The parser is recursive and this is arbitrary tool output: ~54 nested
      // blockquotes overflow the stack, and no amount of fuzzing proves that is
      // the only such input. `render()` is on the TUI's critical path, so a
      // throw here takes the overlay down for content the literal path shows
      // fine — degrade to that instead, and remember, since the throw would
      // otherwise repeat on every render and every scroll key.
      entry.failed = true;
      return this.rawLines(text, width, dim);
    }
  }

  /** Steerable only when a steer handler exists and the agent is still active. */
  private canSteer(): boolean {
    return !!this.onSteer && (this.record.status === "running" || this.record.status === "queued");
  }

  /**
   * Asked of the owner rather than derived from the record: only the caller
   * blocked on this run knows it can let go of it, and `blocking` alone also
   * matches spawns nobody can hand off (the agent generator).
   */
  private canSendToBackground(): boolean {
    return this.onBackground?.available() === true;
  }

  /** Open the inline steering composer and route subsequent input to it. */
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

  invalidate(): void { /* no cached state to clear */ }

  /**
   * Scroll by `delta` logical lines (positive = down). Mouse-wheel input from
   * the host funnels here; the keyboard path keeps its own handling because it
   * also owns the page/home/end semantics. Returns whether anything moved —
   * a wheel event at either end is still consumed by the caller so it cannot
   * fall through and scroll the view underneath the overlay.
   *
   * Auto-follow resumes only when the bottom is reached, mirroring `↓`/`End`:
   * scrolling up pauses it, scrolling back to the end re-arms it.
   */
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

  /**
   * What a host's own footer band reads from this viewer: the transcript
   * readout the viewer's footer shows (`<N> lines · <P>%`), whether rich tool
   * output is expanded, and whether `x` is armed. The viewer keeps its own
   * footer until the host owns it; this is the same state, exposed.
   */
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
    this.scrollView.setScrollbar("hidden"); // clears Pi's auto-hide timer
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }
  }

  // ---- Private ----

  private viewportHeight(): number {
    if (this.fullscreen) return Math.max(0, this.tui.terminal.rows - this.chromeLines());
    // A host that knows its frame's arithmetic hands the body budget in
    // directly (the hub's page panes); it replaces the overlay-ceiling
    // approximation rather than stacking with it.
    const explicit = this.options?.viewportRows;
    const rows = typeof explicit === "function" ? explicit() : explicit;
    // The host's budget covers everything the viewer emits — the composer
    // rows included — so they come out of the window here; the percentage
    // path already pays for them through chromeLines().
    if (rows !== undefined) return Math.max(1, Math.floor(rows) - (this.composer ? COMPOSER_ROWS : 0));
    // Cap mirrors the overlay's maxHeight — otherwise the viewer would render
    // more lines than the overlay shows and clip the footer. A function option
    // is re-read per render so a resizing host drags the viewport along.
    const opt = this.options?.maxHeightPct;
    const pct = typeof opt === "function" ? opt() : opt ?? VIEWPORT_HEIGHT_PCT;
    const maxRows = Math.floor((this.tui.terminal.rows * pct) / 100);
    return Math.max(MIN_VIEWPORT, maxRows - this.chromeLines());
  }

  /**
   * Rows the viewer emits around its content in the current mode — the
   * capacity basis `viewportHeight` subtracts. Counted from what `render`
   * actually draws and what the host suppressed, never from a fixed constant:
   * the frameless path has no border rows, and a host that composes identity
   * and draws its own band gets content rows only.
   */
  private chromeLines(): number {
    const framed = !this.fullscreen && !this.framelessNow();
    const identity = this.identityBlock().length;
    const borders = framed ? 2 : 0;
    const identityRule = identity > 0 ? 1 : 0;
    if (!this.footerShown()) {
      // Only the composer can still contribute chrome to a footerless host.
      return borders + identity + identityRule + (this.composer ? COMPOSER_ROWS : 0);
    }
    return borders + identity + identityRule + 1 + (this.composer ? COMPOSER_ROWS : 1);
  }

  /**
   * The header block's `↳` metadata row. Always drawn — it is one of the
   * header block's three rows, so the content below it starts at the same
   * place whether or not this record carries an invocation. With no tag to
   * show it reads `—` rather than collapsing the block.
   */
  private invocationLine(): string {
    // Canonical id here, short label everywhere else: this overlay is opened to
    // inspect one agent and has the width for it, and two providers can serve
    // models whose short names read alike.
    const { modelName, modelId, tags } = buildInvocationTags(this.record.invocation);
    const model = modelId ?? modelName;
    const parts = [...(model ? [model] : []), ...tags];
    return this.theme.fg("dim", `  ↳ ${parts.length > 0 ? parts.join(" · ") : "—"}`);
  }

  // ---- Detailed-log rendering (omp-style) ----

  /**
   * Renderers for a tool, merged the way the main window merges them: the
   * session's own definition wins per hook, built-ins fill the gaps. Anything
   * unavailable (host restrictions, unknown tool) → undefined → text fallback.
   */
  private resolveRenderers(toolName: string): ToolRenderers | undefined {
    let def: any;
    try {
      def = this.session.getToolDefinition?.(toolName);
    } catch {
      def = undefined;
    }
    const builtin = this.builtinRenderers?.[toolName];
    const merged: ToolRenderers = {
      renderCall: def?.renderCall ?? builtin?.renderCall,
      renderResult: def?.renderResult ?? builtin?.renderResult,
    };
    if (!merged.renderCall && !merged.renderResult) return undefined;
    return merged;
  }

  /** ToolRenderContext for a renderer call — every field the hooks may read. */
  private renderContext(toolCallId: string, args: unknown, over: Partial<Record<string, unknown>> = {}): any {
    return {
      args,
      toolCallId,
      // A renderer's async fill (pi's edit diff preview, say) lands between
      // frames and has no session event to dirty the content-lines cache —
      // this hook is its channel. Re-invoking every frame used to be the only
      // way those previews ever showed; now invalidation is explicit.
      invalidate: () => {
        this.contentDirty = true;
        this.tui.requestRender();
      },
      lastComponent: undefined,
      state: undefined,
      cwd: process.cwd(),
      executionStarted: true,
      argsComplete: true,
      isPartial: false,
      expanded: this.expanded,
      showImages: true,
      isError: false,
      ...over,
    };
  }

  private execState(toolCallId: string): Record<string, unknown> {
    let state = this.toolExecState.get(toolCallId);
    if (!state) {
      state = {};
      this.toolExecState.set(toolCallId, state);
    }
    return state;
  }

  /**
   * Try the tool's own `renderCall` component (cached per call object). Returns
   * undefined when no renderer is available or it throws — the caller falls
   * back to the plain `⏺ name(args)` line.
   */
  private richCallLines(call: { id?: string; toolUseId?: string }, args: unknown, renderers: ToolRenderers, width: number): string[] | undefined {
    if (!renderers.renderCall) return undefined;
    try {
      const callId = String(call.id ?? call.toolUseId ?? `call-${++fallbackCallId}`);
      const state = this.execState(callId);
      const entry = this.callComponentCache.get(call as object);
      // Re-invoke the renderer EVERY frame, exactly like pi's tool-execution:
      // renderers are written to be called repeatedly with their previous
      // component (the edit renderer computes its diff async and rebuilds its
      // children on a later frame — skipping the call freezes it mid-preview).
      const component = renderers.renderCall(args, this.theme, this.renderContext(callId, args, {
        state,
        lastComponent: entry?.component,
      }));
      this.callComponentCache.set(call as object, { component });
      const lines = (component as { render?(w: number): string[] })?.render?.(width);
      return Array.isArray(lines) && lines.length > 0 ? lines : undefined;
    } catch {
      // Renderers are host components running against arbitrary content; a
      // throw here must degrade to the text line, not take the overlay down.
      return undefined;
    }
  }

  /**
   * Try the tool's own `renderResult` component (cached per result message).
   * Same contract as `richCallLines`: undefined → text fallback.
   */
  private richResultLines(msg: any, callArgs: unknown, renderers: ToolRenderers, width: number): string[] | undefined {
    if (!renderers.renderResult) return undefined;
    try {
      const isError = !!msg.isError;
      const callId = String(msg.toolCallId ?? "result");
      const state = this.execState(callId);
      const entry = this.resultComponentCache.get(msg);
      // Same every-frame contract as richCallLines — renderers own their
      // component updates; the viewer only supplies lastComponent and state.
      const result = { content: msg.content, details: msg.details, isError };
      const component = renderers.renderResult(
        result,
        { expanded: this.expanded, isPartial: false },
        this.theme,
        this.renderContext(callId, callArgs, {
          state,
          lastComponent: entry?.component,
          isError,
        }),
      );
      this.resultComponentCache.set(msg, { component });
      const lines = (component as { render?(w: number): string[] })?.render?.(width);
      return Array.isArray(lines) && lines.length > 0 ? lines : undefined;
    } catch {
      return undefined;
    }
  }

  /** Tool call line: `⏺ name(key-args)` — the call is the anchor of its log entry. */
  private toolCallLines(call: { name?: string; toolName?: string; arguments?: unknown; input?: unknown; id?: string; toolUseId?: string }, width: number): string[] {
    const th = this.theme;
    const name = call.name ?? call.toolName ?? "unknown";
    const argsValue = call.arguments ?? call.input;
    const renderers = this.resolveRenderers(name);
    const rich = renderers ? this.richCallLines(call as any, argsValue, renderers, width) : undefined;
    if (rich) return rich;
    const args = describeToolArgs(argsValue);
    const head = `${th.fg("accent", "⏺")} ${th.bold(name)}${args ? th.fg("dim", `(${args})`) : ""}`;
    return [truncateToWidth(head, width)];
  }

  /**
   * A running tool's streamed output, under its call: the tail — the part
   * still being written — capped at a few lines, dim like the placeholder it
   * replaces. Kept plain on purpose: the call above is already rendered with
   * the tool's own renderer where one exists, and a rich partial would
   * re-render (and re-parse) on every `tool_execution_update`.
   */
  private liveOutputLines(partial: string, width: number): string[] {
    const th = this.theme;
    const all = partial.split("\n");
    const kept = all.slice(-LIVE_OUTPUT_LINES);
    const lines = kept.map(l => th.fg("dim", `    ${l}`));
    if (all.length > kept.length) {
      lines.unshift(th.fg("dim", `    … ${all.length - kept.length} earlier lines`));
    }
    return lines.map(l => truncateToWidth(l, width));
  }

  /**
   * Result rendered under its call: `✓`/`✗` plus a preview. `assistant` mode
   * (the default) shows the first lines and an elision note; `all` shows the
   * full result as Markdown; `off` shows it raw — the old escape hatches keep
   * working, just per-call instead of per-block.
   */
  private toolResultLines(msg: any, callArgs: unknown, width: number): string[] {
    const th = this.theme;
    const isError = !!msg.isError;
    const raw = extractText(msg.content).trim();

    // Rich path first: the tool's own result component (diffs, command output
    // blocks…), exactly what the main transcript shows for this tool. Call args
    // ride along — renderers like edit read them for the diff context.
    const toolName = msg.toolName ?? "";
    const renderers = toolName ? this.resolveRenderers(toolName) : undefined;
    const rich = renderers ? this.richResultLines(msg, callArgs, renderers, width) : undefined;
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

    const mode = this.markdownMode();
    if (mode === "all" || mode === "off" || this.expanded) {
      // Full result, exactly as the legacy block rendered it.
      const { text, elided } = capResult(raw);
      if (!text) return [truncateToWidth(th.fg("dim", "  ✓ (no output)"), width)];
      const lines = [truncateToWidth(th.fg("success", "  ✓"), width)];
      lines.push(...(mode === "all" ? this.markdownLines(msg, text, width, true) : this.rawLines(text, width, true)));
      if (elided) lines.push(truncateToWidth(th.fg("dim", truncationNote(elided)), width));
      return lines;
    }

    if (!raw) return [truncateToWidth(th.fg("dim", "  ✓ (no output)"), width)];
    // Preview: cap first (a huge single line is still expensive to wrap), then
    // take the first lines. The elision note names the `m` escape hatch.
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

  /** Thinking block: receded `✻ thinking` preview, capped like results. */
  private thinkingLines(text: string, width: number): string[] {
    const th = this.theme;
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

  private buildContentLines(width: number): string[] {
    if (width <= 0) return [];

    // Cached between session events: a clean render reuses the lines instead
    // of re-walking the whole transcript. The key carries every input that
    // changes output without a session event (scrolling is not in it — it only
    // picks a different slice of the same lines) plus a cheap signature of the
    // last message, so a transcript whose tail grew WITHOUT an event (a test
    // mutating `messages` directly; production deltas always fire one) still
    // busts the cache at O(last message) instead of O(transcript).
    const key = `${width}|${this.record.status}|${this.markdownMode()}|${this.expanded}|${this.session.messages.length}|${this.lastMessageSignature()}`;
    if (!this.contentDirty && this.contentCache?.key === key) {
      return this.contentCache.lines;
    }

    const lines = this.buildContentLinesUncached(width);
    this.contentCache = { key, lines };
    this.contentDirty = false;
    return lines;
  }

  /** Cheap growth signal for the newest message: block kinds and text sizes. */
  private lastMessageSignature(): string {
    const messages = this.session.messages;
    const last = messages[messages.length - 1];
    if (!last) return "empty";
    const content = (last as { content?: unknown }).content;
    if (typeof content === "string") return `s:${content.length}`;
    if (!Array.isArray(content)) return "other";
    let size = 0;
    for (const c of content) {
      if (c?.type === "text") size += c.text?.length ?? 0;
      else if (c?.type === "thinking") size += c.thinking?.length ?? 0;
      else size += 1; // toolCall and friends: presence, not size
    }
    return `${size}`;
  }

  private buildContentLinesUncached(width: number): string[] {
    if (width <= 0) return [];

    const th = this.theme;
    // Stream the in-flight assistant message live: pi keeps the partial in
    // `state.streamingMessage` until the turn's step completes and the final
    // message lands in `messages` — so it is never listed twice. Without
    // content yet there is nothing to draw but the working indicator below.
    const streaming = this.session.state?.streamingMessage;
    const completed = this.session.messages;
    const messages = streaming?.role === "assistant"
      ? [...completed, streaming as (typeof completed)[number]]
      : completed;
    const streamingRef = streaming?.role === "assistant" ? streaming : undefined;
    const lines: string[] = [];

    if (messages.length === 0) {
      lines.push(th.fg("dim", "(waiting for first message...)"));
      return lines;
    }

    const mode = this.markdownMode();

    // Detailed-log association (omp-style): pair each tool result with its call
    // so the outcome renders directly beneath the call — instead of calls as
    // bare names and results as detached blocks. Results left unconsumed (no
    // matching call rendered) fall back to the legacy standalone block.
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
        if (id !== undefined && consumedResults.has(id)) continue; // already under its call
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
        // Streaming, nothing legible yet: show the working state pi's own
        // transcript shows, instead of a bare header over an empty block.
        if (msg === streamingRef && !msg.content.some(c => (c.type === "text" && c.text.trim()) || (c as any).type === "thinking" || c.type === "toolCall")) {
          lines.push(truncateToWidth(th.fg("dim", "  ✻ thinking…"), width));
        }
        // Text, thinking and tool calls render in content order (consecutive
        // text blocks join, matching the old joined-text behavior).
        let textRun: string[] = [];
        const flushText = () => {
          if (textRun.length === 0) return;
          const text = textRun.join("\n").trim();
          textRun = [];
          if (text) {
            lines.push(...(mode === "off"
              ? this.rawLines(text, width, false)
              : this.markdownLines(msg, text, width, false)));
          }
        };
        for (const c of msg.content) {
          if (c.type === "text" && c.text) {
            textRun.push(c.text);
          } else if ((c as any).type === "thinking") {
            flushText();
            lines.push(...this.thinkingLines((c as any).thinking ?? "", width));
          } else if (c.type === "toolCall") {
            flushText();
            const callId = (c as any).id ?? (c as any).toolUseId;
            const callArgs = (c as any).arguments ?? (c as any).input;
            lines.push(...this.toolCallLines(c as any, width));
            const result = typeof callId === "string" ? resultById.get(callId) : undefined;
            if (result) {
              consumedResults.add(callId as string);
              lines.push(...this.toolResultLines(result, callArgs, width));
            } else if (this.record.status === "running" || this.record.status === "queued") {
              // Still executing: show the streamed output so far, tail-first —
              // the part a running command is writing right now — and fall
              // back to the placeholder until the first update arrives.
              const partial = typeof callId === "string" ? this.partials.get(callId)?.trim() : undefined;
              if (partial) {
                lines.push(...this.liveOutputLines(partial, width));
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
          ? this.markdownLines(msg, text, width, true)
          : this.rawLines(text, width, true)));
        if (elided) lines.push(truncateToWidth(th.fg("dim", truncationNote(elided)), width));
      } else if ((msg as any).role === "bashExecution") {
        const bash = msg as any;
        if (needsSeparator) lines.push(th.fg("dim", "───"));
        lines.push(truncateToWidth(th.fg("muted", `  $ ${bash.command}`), width));
        if (bash.output?.trim()) {
          // Same cap as a tool result, never Markdown: command output is the one
          // thing here that is definitionally not authored as Markdown.
          const { text, elided } = capResult(bash.output.trim());
          lines.push(...this.rawLines(text, width, true));
          if (elided) lines.push(truncateToWidth(th.fg("dim", truncationNote(elided)), width));
        }
      } else {
        continue;
      }
      needsSeparator = true;
    }

    // Streaming indicator for running agents — the live tail, as the last
    // content row (no blank spacer: the body's tail is where the eye lands).
    if (this.record.status === "running" && this.activity) {
      const act = describeActivity(this.activity.activeTools, this.activity.responseText);
      lines.push(truncateToWidth(th.fg("accent", "▍ ") + th.fg("dim", act), width));
    }

    // Clamp every line to width — but skip the ANSI-aware walk for lines that
    // already fit: that walk is the single most expensive step per rebuild
    // (measured 74% of profile), and most lines come out of the Markdown/
    // wrap paths already at or under width.
    return lines.map(l => (visibleWidth(l) <= width ? l : truncateToWidth(l, width)));
  }
}
