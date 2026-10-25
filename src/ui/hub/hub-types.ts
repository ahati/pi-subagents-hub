/**
 * hub-types.ts — Types, interfaces, constants, and basic formatting helpers for AgentHub.
 */

import type { ScrollViewScrollbar } from "@earendil-works/pi-tui";
import type { AgentManager } from "../../agent-manager.js";
import type { AgentRecord, UIStyle } from "../../types.js";
import type { AgentActivity, Theme } from "../agent-widget.js";
import type { ViewerBackgroundAction } from "../conversation-viewer.js";
import type { FleetWorkflow } from "../fleet-list.js";
import type { WindowRow } from "../window-frame.js";
import type { WorkflowCardLine } from "../workflow-card.js";
import type { WorkflowDialogSource } from "../workflow-view.js";

/** How long a settled workflow run lingers in the roster (matches the fleet list). */
export const FINISHED_LINGER_MS = 4000;
/** Re-render cadence so elapsed/activity/stats tick while the hub is open. */
export const TICK_MS = 200;
/** The legacy activity table's body floor — the hub window derives its body from the frame. */
export const MIN_BODY_ROWS = 3;

/**
 * The roster's top-level group headers, in display order.
 */
export const ROSTER_SUBAGENTS_LABEL = "SUBAGENTS";
export const ROSTER_WORKFLOWS_LABEL = "WORKFLOWS";
/** The run's agent section on W and the run-agent pages' master. */
export const RUN_AGENTS_LABEL = "RUNNING WORKFLOW AGENTS";

export type HubView = "table" | "activity";

/**
 * The window's pages — the spec's one-window model.
 */
export type HubPage = "R" | "SL" | "W" | "WA" | "SAL" | "L";

/** `esc`'s walk back from a page: one level up, never further. */
export const PAGE_PARENT: Record<HubPage, HubPage | undefined> = {
  R: undefined,
  SL: "R",
  W: "R",
  WA: "W",
  SAL: "WA",
  L: "W",
};

/**
 * A page's footer band, as data.
 */
export interface PageFooterKeys {
  actions: readonly string[];
  hints: readonly string[];
  /** Where `esc` lands, as the band's `Esc <target>` anchor. */
  esc: string;
}

/**
 * The footer's slots, per page.
 */
export const PAGE_KEYS: Record<HubPage, PageFooterKeys> = {
  R: {
    actions: ["Enter steer", "x stop", "m md"],
    hints: ["PgUp/PgDn", "j scroll", "o expand", "l log", "p pause", "c copy"],
    esc: "close",
  },
  SL: { actions: ["x stop"], hints: ["↑↓ scroll", "c copy tail", "p pause agent"], esc: "back" },
  W: { actions: [], hints: ["↑↓ item", "PgUp/PgDn item", "⏎ agent", "l run log", "s stop run"], esc: "roster" },
  WA: {
    actions: ["Enter steer", "x stop", "m md"],
    hints: ["PgUp/PgDn", "j scroll", "o expand", "l log", "p pause", "c copy"],
    esc: "back",
  },
  SAL: { actions: ["x stop"], hints: ["↑↓ scroll", "c copy tail", "p pause agent"], esc: "back" },
  L: { actions: ["s stop run"], hints: ["↑↓ scroll", "c copy tail"], esc: "back" },
};

/** **R**'s run-row slots: the selected row type decides what the band offers. */
export const R_RUN_KEYS: PageFooterKeys = {
  actions: ["⏎ open run", "s stop run", "c copy"],
  hints: ["↑↓ select", "⇥ activity"],
  esc: "close",
};

export const TD_ACTIONS = ["c copy diff", "o collapse"] as const;
export const TD_REPLACED_ACTION = "m md";
export const TD_DROPPED_HINT = "o expand";

/** The hub window's refuse/single-pane/two-pane thresholds (spec size ladder). */
export const HUB_MIN_WIDTH = 40;
export const HUB_MIN_ROWS = 10;
export const HUB_CHROME_ROWS = 4;
export const HUB_TITLE = " Agents & Workflows ";

export const LOG_TAIL = Number.MAX_SAFE_INTEGER;
export const HUB_SIZE_REFUSAL = "Agent hub needs a terminal ≥ 40×10";

export const IDENTITY_ROWS = 3;

/** Overlay geometry for the popup twin — the windowed 90 % × 70 % panel. */
export const POPUP_WIDTH_PCT = 90;
export const POPUP_HEIGHT_PCT = 70;
export const HUB_FALLBACK_ROWS = 24;
export const POPUP_OVERLAY_OPTIONS = { anchor: "center", width: `${POPUP_WIDTH_PCT}%`, maxHeight: `${POPUP_HEIGHT_PCT}%` };
export const FULLSCREEN_OVERLAY_OPTIONS = {
  anchor: "top-left",
  width: "100%",
  maxHeight: "100%",
  row: 0,
  col: 0,
  margin: 0,
};

export const WORKFLOW_NO_AGENTS = "No agents";

export const EMPTY_RUN_SOURCE: WorkflowDialogSource = {
  progress: [],
  task: { status: "completed", startTime: 0 },
  agentCount: 0,
};

export type WorkflowEntry = { kind: "workflow"; workflow: FleetWorkflow };
export type AgentEntry = {
  kind: "agent";
  record: AgentRecord;
  depth?: number;
  isLastChild?: boolean;
  childCount?: number;
  parentRecord?: AgentRecord;
};
export type HubEntry = WorkflowEntry | AgentEntry;

export type HubRosterItem = { kind: "header"; label: string } | HubEntry;

export type PaneRow = WorkflowCardLine | { kind: "headerRule" };
export const HEADER_RULE: PaneRow = { kind: "headerRule" };

export const isHeaderRule = (row: PaneRow | undefined): row is { kind: "headerRule" } =>
  row !== undefined && !Array.isArray(row);

export interface HubMouseEvent {
  type: string;
  button?: string;
  x?: number;
  y?: number;
  wheelDelta?: number;
}

export interface MouseTerminalHost {
  mode?: string;
  terminal?: { write?(data: string): void };
}

export type HubUICtx = {
  notify(message: string, type?: "info" | "warning" | "error"): void;
  custom<T>(
    factory: (tui: any, theme: Theme, keybindings: any, done: (result: T) => void) => {
      render(width: number): string[];
      invalidate(): void;
      dispose?(): void;
    },
    options?: { overlay?: boolean; overlayOptions?: unknown; onHandle?: (handle: unknown) => void },
  ): Promise<T>;
};

export interface WorkflowRunControls {
  pause(): boolean;
  resume(): boolean;
  skip(index: number): boolean;
  retry(index: number): boolean;
}

export interface AgentHubDeps {
  manager: Pick<AgentManager, "listAgents" | "abort" | "steer">;
  agentActivity: Map<string, AgentActivity>;
  showCost: boolean;
  workflows?: () => readonly FleetWorkflow[];
  workflowRun?: (id: string) => WorkflowDialogSource | undefined;
  stopWorkflow?: (id: string) => boolean | undefined;
  workflowControls?: (id: string) => WorkflowRunControls | undefined;
  notify?: (message: string, type?: "info" | "warning" | "error") => void;
  pauseAgent?: (id: string) => string | undefined;
  resumeAgent?: (id: string) => boolean;
  scrollbarMode?: () => ScrollViewScrollbar;
  backgroundAction?: (record: AgentRecord, notify: (message: string) => void) => ViewerBackgroundAction;
  uiStyle?: () => UIStyle;
}

export interface HubResumeState {
  view: HubView;
  selected: number;
  filterText: string;
  page?: HubPage | undefined;
  focusId?: string | undefined;
  runId?: string | undefined;
  runAgentSel?: number;
  runItemSel?: number;
  logScroll?: number;
  detailOpen?: boolean;
  scopeStack?: string[];
  listWidth?: number;
}

export interface AgentHubInitial {
  agentId?: string;
  runId?: string;
  popup?: boolean;
}

export type HubResult = "toggle" | undefined;

/** Lifecycle group of an agent for the legacy activity table: 0 active, 1 completed, 2 failed. */
export function lifecycleRank(status: AgentRecord["status"]): number {
  switch (status) {
    case "running":
    case "queued":
    case "paused":
      return 0;
    case "completed":
    case "steered":
      return 1;
    default:
      return 2;
  }
}

/** The last non-empty line of a streamed or settled text — the freshest output. */
export function lastNonEmptyLine(text: string): string {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line) return line;
  }
  return "";
}

/**
 * The last line that actually says something: structured children end their
 * output with a JSON payload, so the literal last line is `}` — or a ``` fence.
 * Skips lines without word characters and fence markers.
 */
export function lastContentfulLine(text: string): string {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line && /\w/.test(line) && !line.startsWith("```")) return line;
  }
  return "";
}

/** Turns taken from the session: one assistant message ≈ one model turn. */
export function assistantTurnCount(messages: readonly { role?: string }[] | undefined): number | undefined {
  if (messages === undefined) return undefined;
  const count = messages.filter(m => m.role === "assistant").length;
  return count > 0 ? count : undefined;
}

/** One full-width window row, from content this surface has already shaped. */
export function fullRow(text: string): WindowRow {
  return { kind: "full", cells: [{ text }] };
}

/** `HH:MM:SS` — the log pages' event rows are timestamps first. */
export function stamp(ms: number): string {
  return new Date(ms).toTimeString().slice(0, 8);
}

/** A pane's lines, cut or padded to the body height so both cells stay level. */
export function padLines(lines: readonly PaneRow[], rows: number): PaneRow[] {
  const out = lines.slice(0, rows);
  while (out.length < rows) out.push([]);
  return out;
}
