/**
 * viewer-types.ts — Types, interfaces, constants, and theme/renderer resolution for ConversationViewer.
 */

import { readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import type {
  MarkdownTheme,
  OverlayOptions,
  TUI,
} from "@earendil-works/pi-tui";
import type { UIStyle } from "../../types.js";
import type { Theme } from "../agent-widget.js";

export const MIN_VIEWPORT = 3;
/** Rows the composer spends: its input row and its `Enter send · Esc cancel` hint. */
export const COMPOSER_ROWS = 2;
/** Height ceiling shared by the overlay's `maxHeight` and the viewer's internal viewport cap. */
export const VIEWPORT_HEIGHT_PCT = 70;
export const SCROLLBAR_WIDTH = 1;

/** The `b` affordance: whether this run can be handed to the background now, and the handoff. */
export interface ViewerBackgroundAction {
  available(): boolean;
  send(): void;
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

/** Follow the active renderer, not a setting that may require a restart. */
export function getConversationOverlayOptions(tui: Pick<TUI, "mode">): OverlayOptions {
  return tui.mode === "fullscreen"
    ? { anchor: "top-left", width: "100%", maxHeight: "100%", margin: 0 }
    : { anchor: "center", width: "90%", maxHeight: `${VIEWPORT_HEIGHT_PCT}%` };
}

/**
 * Tool renderers, as merged onto a definition: the loose shape the viewer passes
 * to `ToolExecutionComponent` (pi's own adds `renderShell`).
 */
export interface ToolRenderers {
  renderShell?: unknown;
  renderCall?: (args: any, theme: any, context: any) => unknown;
  renderResult?: (result: any, options: any, theme: any, context: any) => unknown;
}

/**
 * Pi's own Markdown theme when this process has one, else a theme built from the
 * viewer's `Theme`.
 */
export function resolveMarkdownTheme(th: Theme): MarkdownTheme {
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
 * written as raw SGR.
 */
export function fallbackMarkdownTheme(th: Theme): MarkdownTheme {
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

let builtinRenderersPromise: Promise<Record<string, ToolRenderers> | undefined> | undefined;

/**
 * pi's built-in tool renderers (diffs, syntax-highlighted reads, command
 * blocks…) live in an internal module that the package's exports map does not
 * expose — the main window merges them over tool definitions at render time.
 */
export function loadBuiltinRenderers(): Promise<Record<string, ToolRenderers> | undefined> {
  builtinRenderersPromise ??= (async () => {
    try {
      const entry = process.argv[1];
      if (!entry) return undefined;
      let dir = dirname(await realpath(resolve(entry)));
      for (let i = 0; i < 10; i++) {
        try {
          const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
          if (pkg?.name === "@earendil-works/pi-coding-agent") {
            const rendererPath = pathToFileURL(join(dir, "dist", "core", "tools", "renderers", "index.js")).href;
            const mod = await import(rendererPath);
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
