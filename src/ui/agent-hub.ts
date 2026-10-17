/**
 * agent-hub.ts — the unified Agents & Workflows window, pi-subagents data.
 *
 * One window at two frame sizes — the fullscreen twin (`ctx.ui.custom` with
 * `width: "100%"`, `maxHeight: "100%"`) and the popup twin (90 % × 70 %),
 * swapped by `f`. Both draw the same pages at the same size-independent
 * layout; the popup differs in frame size only.
 *
 * - Table view: the page model's window — the roster master (grouped
 *   subagents + workflow runs, identity-only rows, `/` filters, `x` stops with
 *   a two-press arm) beside the current page's detail pane (the selected
 *   agent's conversation or the run's overview, logs). `⏎` descends, `esc`
 *   ascends, `l` opens a log, `p` pauses/resumes, `c` copies.
 * - Activity view (`2`, `⇥`): one line per agent describing what it is doing
 *   right now.
 *
 * Purely a UI layer over the same runtime the fleet list drives: AgentManager
 * records, the activity tracker, workflow runs. All behavior — steering,
 * stopping, markdown modes, cost display, linger semantics — is unchanged.
 */

import { type Component, Input, matchesKey, type ScrollViewScrollbar, type TUI, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { renderAgentRecordName } from "../agent-color.js";
import { type AgentManager, isTopLevelAgent } from "../agent-manager.js";
import { extractText } from "../context.js";
import type { AgentRecord, UIStyle, ViewerMarkdownMode } from "../types.js";
import { getLifetimeCost, getLifetimeTotal, getSessionContextPercent } from "../usage.js";
import {
  buildPhaseGroups,
  currentPhaseIndex,
  displayState,
  elapsedMs,
  flattenRunAgents,
  formatDuration,
  type PhaseGroup,
  runIdentity,
  runStatusMark,
  runStatusWord,
  type WorkflowAgentEntry,
  type WorkflowRunStatus,
} from "../workflow/progress.js";
import type { AgentActivity, Theme } from "./agent-widget.js";
import { buildInvocationTags, describeActivity, fgPreservingNestedStyles, formatCost, formatSessionTokens, getPromptModeLabel } from "./agent-widget.js";
import { ConversationViewer, type ViewerBackgroundAction } from "./conversation-viewer.js";
import { copyRecordResult } from "./copy-result.js";
import type { FleetWorkflow } from "./fleet-list.js";
import { disableTerminalMouse, enableTerminalMouse, parseMouseInput } from "./terminal-mouse.js";
import type { ViewerKeybindings } from "./viewer-keys.js";
import {
  type FooterHint,
  footerBand,
  masterPaneGeometry,
  type PaneBox,
  PI_PANE_BOX,
  paneBodyHeight,
  renderWindow,
  TWO_PANE_MIN_WIDTH,
  UNICODE_PANE_BOX,
  type WindowRow,
  windowInnerWidth,
  windowRange,
} from "./window-frame.js";
import type { WorkflowCardLine } from "./workflow-card.js";
import { clampLine } from "./workflow-card.js";
import {
  agentActions,
  agentRow,
  phaseListRows,
  UNICODE_DIALOG_GLYPHS,
  type WorkflowDialogSource,
} from "./workflow-view.js";

/** How long a settled workflow run lingers in the roster (matches the fleet list). */
const FINISHED_LINGER_MS = 4000;
/** Re-render cadence so elapsed/activity/stats tick while the hub is open. */
const TICK_MS = 200;
/** The legacy activity table's body floor — the hub window derives its body from the frame. */
const MIN_BODY_ROWS = 3;

/** Lifecycle group of an agent for the legacy activity table: 0 active, 1 completed, 2 failed. */
function lifecycleRank(status: AgentRecord["status"]): number {
  switch (status) {
    case "running":
    case "queued":
    case "paused":
      return 0;
    case "completed":
    case "steered":
      return 1;
    // error / aborted / stopped — a stopped run has no result, so it groups
    // with the failures rather than implying it finished.
    default:
      return 2;
  }
}

/**
 * The roster's top-level group headers, in display order. The subagents
 * section is one list in stable launch order — a row's identity never moves,
 * so a settling agent cannot reshuffle the roster under the cursor; workflow
 * runs follow as one section, sorted by launch time.
 */
const ROSTER_SUBAGENTS_LABEL = "SUBAGENTS";
const ROSTER_WORKFLOWS_LABEL = "WORKFLOWS";
/** The run's agent section on W and the run-agent pages' master. */
const RUN_AGENTS_LABEL = "RUNNING WORKFLOW AGENTS";

/** The last non-empty line of a streamed or settled text — the freshest output. */
function lastNonEmptyLine(text: string): string {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim();
    if (line) return line;
  }
  return "";
}

/** Turns taken from the session: one assistant message ≈ one model turn. */
function assistantTurnCount(messages: readonly { role?: string }[] | undefined): number | undefined {
  if (messages === undefined) return undefined;
  const count = messages.filter(m => m.role === "assistant").length;
  return count > 0 ? count : undefined;
}

/**
 * The run-state glyph for a roster workflow row, the same vocabulary the
 * subagent rows use: running `●`, paused `‖`, completed `✓`, failed/killed `✗`.
 */
export function workflowStatusGlyph(status: FleetWorkflow["status"], th: Theme): string {
  const { glyph, role } = runStatusMark(status);
  return th.fg(role, glyph);
}

/** Result of a wheel dispatch — structural subset of pi-tui's mouse types. */
interface HubMouseEvent {
  type: string;
  /** Logical lines; negative scrolls up. */
  wheelDelta?: number;
}

/** The TUI/terminal surface mouse capture needs — structural, version-safe. */
interface MouseTerminalHost {
  mode?: string;
  terminal?: { write?(data: string): void };
}

type HubView = "table" | "activity";

/**
 * The window's pages — the spec's one-window model. `R` is the roster; every
 * other page is a nesting level inside the same frame, reached with `⏎` and
 * left with `esc`, each with the previous view demoted into the left pane.
 *
 * `R` carries the selected item's detail itself: the agent's full conversation
 * when the cursor is on a subagent row, the run's overview when it is on a
 * workflow row. `WA` shows a run agent's conversation, `SL`/`SAL` an agent's
 * event log, `W` a run's phases and agents and `L` the run's event log. `TD` is
 * deliberately absent: an expanded tool-call is a view state of the page it
 * was opened on, never a page of its own.
 */
type HubPage = "R" | "SL" | "W" | "WA" | "SAL" | "L";

/** `esc`'s walk back from a page: one level up, never further. */
const PAGE_PARENT: Record<HubPage, HubPage | undefined> = {
  R: undefined,
  SL: "R",
  W: "R",
  WA: "W",
  SAL: "WA",
  L: "W",
};

/**
 * A page's footer band, as data: the left slot's actions — the readout is
 * computed per render and drops first — and the right slot's hints. The right
 * slot gains the twin toggle (the twin you would get) and the pinned escape
 * anchor, so neither is repeated per page.
 */
interface PageFooterKeys {
  actions: readonly string[];
  hints: readonly string[];
  /** Where `esc` lands, as the band's `Esc <target>` anchor. */
  esc: string;
}

/**
 * The footer's slots, per page — the spec's bottom-controls table, as data.
 * **R**'s agent-row slots are the transcript ones: the roster page shows the
 * conversation itself, so it carries the conversation's keys.
 */
const PAGE_KEYS: Record<HubPage, PageFooterKeys> = {
  R: {
    actions: ["Enter steer", "x stop", "m md"],
    hints: ["PgUp/PgDn", "j scroll", "o expand", "l log", "p pause", "c copy"],
    esc: "close",
  },
  SL: { actions: ["x stop"], hints: ["↑↓ scroll", "c copy tail", "p pause agent"], esc: "back" },
  W: { actions: [], hints: ["↑↓ item", "⏎ agent", "l run log", "s stop run"], esc: "roster" },
  WA: {
    actions: ["Enter steer", "x stop", "m md"],
    hints: ["PgUp/PgDn", "j scroll", "o expand", "l log", "p pause", "c copy"],
    esc: "back",
  },
  SAL: { actions: ["x stop"], hints: ["↑↓ scroll", "c copy tail", "p pause agent"], esc: "back" },
  L: { actions: ["s stop run"], hints: ["↑↓ scroll", "c copy tail"], esc: "back" },
};

/** **R**'s run-row slots: the selected row type decides what the band offers. */
const R_RUN_KEYS: PageFooterKeys = {
  actions: ["⏎ open run", "s stop run", "c copy"],
  hints: ["↑↓ select", "⇥ activity"],
  esc: "close",
};

/**
 * **TD**'s own actions — the expanded tool-call's pair. It replaces the page's
 * markdown hint with them and drops the `o expand` hint: the call is already
 * expanded, and `o collapse` is what undoes it.
 */
const TD_ACTIONS = ["c copy diff", "o collapse"] as const;
const TD_REPLACED_ACTION = "m md";
const TD_DROPPED_HINT = "o expand";

/** The hub window's refuse/single-pane/two-pane thresholds (spec size ladder). */
const HUB_MIN_WIDTH = 40;
const HUB_MIN_ROWS = 10;
/**
 * The rows the hub's window spends on chrome: the top edge, the band rule, the
 * footer row and the bottom edge. The body takes every row left over, one less
 * while the filter row is up; at the 10-row floor that arithmetic already gives
 * the spec's six-row body.
 */
const HUB_CHROME_ROWS = 4;
/**
 * The window's title: the constant ` Agents & Workflows `, which fills the
 * 20-column master cell exactly. The header block, never the title, names the
 * item the right pane is showing.
 */
const HUB_TITLE = " Agents & Workflows ";

/** Log pages open at the newest events: `scrollTail` clamps and re-anchors. */
const LOG_TAIL = Number.MAX_SAFE_INTEGER;
/** How the window refuses a terminal under the ladder. */
export const HUB_SIZE_REFUSAL = "Agent hub needs a terminal ≥ 40×10";

type WorkflowEntry = { kind: "workflow"; workflow: FleetWorkflow };
type AgentEntry = { kind: "agent"; record: AgentRecord };
type HubEntry = WorkflowEntry | AgentEntry;

/**
 * One roster row: either a non-selectable section header or an entry. Headers
 * take a line but no cursor slot, so `selected` stays an index into the
 * selectable rows while the display list carries the headers.
 */
type HubRosterItem = { kind: "header"; label: string } | HubEntry;

/** Minimal UI surface the hub needs from `ctx.ui` (structural subset). */
export type HubUICtx = {
  notify(message: string, type?: "info" | "warning" | "error"): void;
  custom<T>(
    factory: (tui: any, theme: Theme, keybindings: any, done: (result: T) => void) => { render(width: number): string[]; invalidate(): void; dispose?(): void },
    options?: { overlay?: boolean; overlayOptions?: unknown; onHandle?: (handle: unknown) => void },
  ): Promise<T>;
};

/** Run controls the hub's run pages own, by run id. `pause`/`resume` report
 *  whether they landed; `skip`/`retry` report whether the agent could take the
 *  action — one notification site, and no hint without a wire. */
export interface WorkflowRunControls {
  pause(): boolean;
  resume(): boolean;
  /** `index` is the entry's stable `index`, not its row position. */
  skip(index: number): boolean;
  retry(index: number): boolean;
}

/** Everything the hub renders from — the same sources the fleet list uses. */
export interface AgentHubDeps {
  manager: Pick<AgentManager, "listAgents" | "abort" | "steer">;
  agentActivity: Map<string, AgentActivity>;
  /** Whether rows show an estimated cost. Captured once at open time. */
  showCost: boolean;
  /** The user's `viewerMarkdown` setting, for the embedded conversation viewer. */
  viewerMarkdown?: () => ViewerMarkdownMode;
  /** Persist a mode chosen with `m` in the viewer. */
  onViewerMarkdown?: (mode: ViewerMarkdownMode) => void;
  /** Workflow runs, on the same terms as the fleet list. */
  workflows?: () => readonly FleetWorkflow[];
  /**
   * The run's detail for the hub's run pages (**W**, **WA**, **L**). Omitted →
   * the run pages have no pane content and say so; the roster still shows the
   * run.
   */
  workflowRun?: (id: string) => WorkflowDialogSource | undefined;
  /**
   * `s` on a workflow row or page: stop the run. Returns whether it aborted
   * (false when the run was already aborted), and the row/page reports it —
   * one notification site. Omitted → `s` does nothing.
   */
  stopWorkflow?: (id: string) => boolean | undefined;
  /**
   * The run's `p` (pause/resume) and its agents' `s`/`r` (skip/retry), keyed
   * by run id. Omitted → those keys do nothing and the band advertises none of
   * them.
   */
  workflowControls?: (id: string) => WorkflowRunControls | undefined;
  /** Surface stop confirmations. Omitted → silent. */
  notify?: (message: string, type?: "info" | "warning" | "error") => void;
  /**
   * Pause/resume for the `p` key, wired by the extension to the same funnel
   * the `/agents` commands use. `pauseAgent` returns why the pause was
   * refused, so the toast never claims a pause that did not land. Omitted →
   * `p` does nothing.
   */
  pauseAgent?: (id: string) => string | undefined;
  resumeAgent?: (id: string) => boolean;
  /** Pi's fullscreen scrollbar preference, for the embedded conversation viewer. */
  scrollbarMode?: () => ScrollViewScrollbar;
  /**
   * The viewer's `b` for a row's run, supplied by the extension: only it knows
   * which runs have a tool call waiting to be released. Omitted → no `b`.
   */
  backgroundAction?: (record: AgentRecord, notify: (message: string) => void) => ViewerBackgroundAction;
  /** Visual style for window frame rendering (Pi native vs Claude Code). */
  uiStyle?: () => UIStyle;
}

// ---- Roster (module-level so the reopen loop can peek without an instance) ----

/** Live workflow runs, plus recently settled ones (same terms as the fleet list). */
function hubWorkflows(deps: AgentHubDeps): FleetWorkflow[] {
  if (!deps.workflows) return [];
  const now = Date.now();
  return [...deps.workflows()]
    .filter(run =>
      run.status === "running"
      || run.status === "paused"
      || (run.completedAt != null && now - run.completedAt < FINISHED_LINGER_MS)
    )
    .sort((a, b) => a.startedAt - b.startedAt);
}

/**
 * Every top-level agent with a session, earliest-launched first — the hub is
 * the session-wide roster, so finished agents stay listed until the hub
 * closes (unlike the compact fleet widget, which lingers them only briefly).
 */
function hubAgents(deps: AgentHubDeps): AgentRecord[] {
  return deps.manager.listAgents()
    .filter(a => isTopLevelAgent(a) && a.session)
    .sort((a, b) => a.startedAt - b.startedAt);
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
    // aborted / stopped
    default:
      return th.fg("dim", "·");
  }
}

/**
 * The header block's `↳` line: the run name when the page sits inside one,
 * then the canonical model, then whatever invocation tags apply. A record with
 * nothing to say still draws the line — `—` — because the block is exactly
 * three rows on every page and the rule under it never moves.
 */
function invocationSummary(record: AgentRecord, parentName?: string): string {
  const { modelName, modelId, tags } = buildInvocationTags(record.invocation);
  const model = modelId ?? modelName;
  const parts = [...(parentName ? [parentName] : []), ...(model ? [model] : []), ...tags];
  return parts.length > 0 ? parts.join(" · ") : "—";
}

/**
 * The agent header block's two text lines (spec: *the right pane opens with a
 * header block*). Every pane that shows an agent — R's preview, T, SL, WA,
 * SAL — opens with these, then the frame's header rule, then its body.
 *
 * `parentName` is the run the agent belongs to; the run-agent pages lead their
 * `↳` line with it.
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
 * The run header block's two text lines: the run's identity and counters, then
 * where the run currently is. A settled run freezes its clock and reads
 * `↳ <m> phases · <state word>`.
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
 * A right-pane row: content cells, or the marker for the frame's header rule.
 * The rule itself is `renderWindow`'s — a surface never spells its glyphs or
 * its role — so the composer emits a marker where the rule belongs.
 */
type PaneRow = WorkflowCardLine | { kind: "headerRule" };

/** Rows the identity block spends: the header line, the `↳` line, the header rule. */
const IDENTITY_ROWS = 3;

/** The one marker value the composer and `renderHubPage` agree on by identity. */
const HEADER_RULE: PaneRow = { kind: "headerRule" };

const isHeaderRule = (row: PaneRow | undefined): row is { kind: "headerRule" } => row !== undefined && !Array.isArray(row);

/** Overlay geometry for the popup twin — the windowed 90 % × 70 % panel. */
const POPUP_WIDTH_PCT = 90;
const POPUP_HEIGHT_PCT = 70;
/** The rows a host with no terminal reported is assumed to have (bare tests). */
const HUB_FALLBACK_ROWS = 24;
const POPUP_OVERLAY_OPTIONS = { anchor: "center", width: `${POPUP_WIDTH_PCT}%`, maxHeight: `${POPUP_HEIGHT_PCT}%` };
/** Overlay geometry for the full-screen hub. */
const FULLSCREEN_OVERLAY_OPTIONS = {
  anchor: "top-left",
  width: "100%",
  maxHeight: "100%",
  row: 0,
  col: 0,
  margin: 0,
};

/** What `openAgentHub` resolves its per-mode `ui.custom` promise with. */
type HubResult = "toggle" | undefined;

/** State carried across the popup ↔ full-screen reopen cycle. */
interface HubResumeState {
  view: HubView;
  /** Selection index into the (filtered) roster. */
  selected: number;
  filterText: string;
  /** The current page — the reopen is a frame-size change, never a page change. */
  page?: HubPage | undefined;
  /** The page's subject record (R's transcript, SL), kept across the loop back. */
  focusId?: string | undefined;
  /** The run a W/WA/L page is showing; kept across the loop back. */
  runId?: string | undefined;
  /** Cursors and scroll a reopened window picks up where the old one left off. */
  runAgentSel?: number;
  runItemSel?: number;
  logScroll?: number;
  /** The stacked twin's pushed detail pane — a view state that must survive `f`. */
  detailOpen?: boolean;
}

export interface AgentHubInitial {
  /** Start on the roster with this agent selected — its conversation is the
   * pane from the first frame (the fleet Enter-on-agent flow). */
  agentId?: string;
  /**
   * Start on this run's page (**W**) with the run selected on the roster (the
   * fleet Enter-on-run and `/agents → Workflows` flow). A run that settled and
   * was swept falls back to the roster, like a stale `agentId`.
   */
  runId?: string;
  /**
   * Start in the popup twin's frame (90 % × 70 %). Defaults to true when
   * `agentId` or `runId` is given, else false. The frame size is all it
   * decides — the pages, their keys and their content are the same in both
   * twins.
   */
  popup?: boolean;
}

/**
 * Open the agent hub. **The default surface is the full-screen twin** — the
 * window at terminal size, starting on the roster. Given an `agentId` it opens
 * the popup twin (90 % × 70 %) on the roster with that agent selected, which
 * is the fleet list's Enter-on-agent flow: the roster page's right pane is
 * that agent's conversation.
 *
 * pi resolves an overlay's geometry once, at creation, so `f` closes the
 * overlay and reopens it in the other frame; this loop owns that cycle and
 * carries page/selection/filter/scroll state across. Resolves when the hub
 * closes for good.
 */
export async function openAgentHub(ui: HubUICtx, deps: AgentHubDeps, initial?: AgentHubInitial): Promise<undefined> {
  const target = initial?.agentId;
  const runTarget = initial?.runId;
  // Any record the manager knows can be the page's subject — the run-owned
  // children the fleet opens are not roster rows, but they have a transcript.
  // A stale id falls back to the roster, which is always drawable.
  const known = target != null && deps.manager.listAgents().some(a => a.id === target);
  // The menu lists every task of the session, finished runs included, and a
  // run outlives the roster's linger window: what decides openability is the
  // detail source, not the roster row. A run with neither is not openable,
  // and the window falls back to the roster rather than drawing a run page
  // whose source is gone.
  const runSource = runTarget != null ? deps.workflowRun?.(runTarget) : undefined;
  const run = runTarget != null ? hubWorkflows(deps).find(w => w.id === runTarget) : undefined;
  const resume: HubResumeState = {
    view: "table",
    selected: Math.max(0, known ? hubEntryIndex(deps, target) : run ? hubRunIndex(deps, run.id) : 0),
    filterText: "",
    // The popup opens on the roster with the agent selected, or on the run's
    // page; both are the same two-pane window at a different frame size.
    page: runSource ? "W" : "R",
    focusId: known ? target : undefined,
    runId: runSource ? (run?.id ?? runTarget) : undefined,
    // D8: the item cursor starts where the run is, on the current phase row.
    runItemSel: runSource ? currentPhaseIndex(hubRunGroups(deps, runTarget!)) : undefined,
    // A stacked twin opened straight onto an agent opens with its pane
    // pushed — the conversation is what was asked for, not the roster list.
    detailOpen: known ?? false,
  };
  let popup = initial?.popup ?? (target != null || runTarget != null);
  for (;;) {
    const result = await ui.custom<HubResult>(
      (tui, theme, keybindings, done) =>
        new AgentHub(tui, theme, keybindings, done, deps, { popup, resume, onToggle: () => done("toggle") }),
      { overlay: true, overlayOptions: popup ? POPUP_OVERLAY_OPTIONS : FULLSCREEN_OVERLAY_OPTIONS },
    );
    if (result !== "toggle") return undefined;
    popup = !popup;
  }
}

/**
 * The roster index of `agentId` — the order `entries()` draws: the subagents
 * section first (stable launch order), then the runs. `-1` when the agent has
 * no roster row.
 */
function hubEntryIndex(deps: AgentHubDeps, agentId: string): number {
  const entries: HubEntry[] = [
    ...hubAgents(deps).map(record => ({ kind: "agent" as const, record })),
    ...hubWorkflows(deps).map(workflow => ({ kind: "workflow" as const, workflow })),
  ];
  return entries.findIndex(e => e.kind === "agent" && e.record.id === agentId);
}

/**
 * The roster index of `runId` in the same order — the subagents section first,
 * then the runs. `-1` when the run has no roster row.
 */
function hubRunIndex(deps: AgentHubDeps, runId: string): number {
  const entries: HubEntry[] = [
    ...hubAgents(deps).map(record => ({ kind: "agent" as const, record })),
    ...hubWorkflows(deps).map(workflow => ({ kind: "workflow" as const, workflow })),
  ];
  return entries.findIndex(e => e.kind === "workflow" && e.workflow.id === runId);
}

/** The phase groups of a run whose row the window is opening on. */
function hubRunGroups(deps: AgentHubDeps, runId: string): PhaseGroup[] {
  const source = deps.workflowRun?.(runId);
  return source ? buildPhaseGroups(source.progress, source.meta?.phases) : [];
}

export class AgentHub implements Component {
  private view: HubView;
  /** Selection index into the *filtered* roster. */
  private selected = 0;
  private filterText = "";
  private filterInput: Input | undefined;
  /** Two-press confirm guard for the stop key, mirroring the viewer. */
  private stopArmed = false;
  /** The embedded conversation viewer while a transcript page is up. */
  private viewer: ConversationViewer | undefined;
  /** The record id `viewer` was built for — retargets it when focus moves. */
  private viewerId: string | undefined;
  /**
   * The rows the current page's right pane budgeted for its viewer body this
   * frame. The embedded viewer reads it through its `viewportRows` option, so
   * its capacity matches the frame's arithmetic instead of an overlay ceiling.
   */
  private viewerRows = 1;
  /** The record the transcript/log pages are pinned to (their subject). */
  private focusId: string | undefined;
  /** Windowed popup vs full-screen hub; flipped by `f` via the reopen loop. */
  private readonly popup: boolean;
  /** The current page — the roster, or one nesting level below it. */
  private page: HubPage = "R";
  /** The run a W/WA/L page is showing; kept across the loop back. */
  private runId: string | undefined;
  /** Cursor in the run's agent list, on WA/SAL/L. */
  private runAgentSel = 0;
  /** The item cursor on **W**: an index into the run's flattened sequence of
   * phases followed by agents. Separate from the state mark because the two
   * answer different questions — where the run is, and what `⏎` would open. */
  private runItemSel = 0;
  /**
   * The stacked twin's pushed detail pane (40–59 cols): the roster has the
   * full width there, so `⏎` pushes the selected item's pane as a page-sized
   * view. A view state, not a nesting level — it exists only while stacked.
   */
  private detailOpen = false;
  /** The width of the last frame — `⏎`'s stacked-twin decision reads it. */
  private lastWidth: number | undefined;
  /** Log pages' scroll offset, reset when none is up. */
  private logScroll = 0;
  /**
   * The band's readout for a log page: the line count and scroll percent of
   * the log pane as it last rendered. The pane knows them; the band cannot.
   */
  private logReadout: { lines: number; percent: number } | undefined;
  /** Whether the too-small refusal has already been announced. */
  private refused = false;
  /** Shared state object written back on close/toggle so the loop can resume. */
  private readonly resume: HubResumeState;
  /** Resolve the overlay with `"toggle"`, making `openAgentHub` reopen us in the other mode. */
  private readonly onToggle: () => void;
  private readonly tick: ReturnType<typeof setInterval>;
  private disposed = false;
  /** Whether this panel enabled regular-mode mouse reporting (and must restore it). */
  private mouseCaptured = false;

  constructor(
    private tui: TUI,
    private theme: Theme,
    private keybindings: unknown,
    private done: (result: HubResult) => void,
    private deps: AgentHubDeps,
    initial: { popup: boolean; resume: HubResumeState; onToggle: () => void },
  ) {
    this.popup = initial.popup;
    this.resume = initial.resume;
    this.onToggle = initial.onToggle;
    this.view = this.resume.view;
    this.selected = this.resume.selected;
    this.filterText = this.resume.filterText;
    // The reopen carries the page itself: `f` is a frame-size change, so a
    // window resumed on T/W stays there. The viewer is built lazily by
    // `ensureViewer` on the first render of a transcript page.
    this.page = this.resume.page ?? "R";
    this.focusId = this.resume.focusId;
    this.runId = this.resume.runId;
    this.runAgentSel = this.resume.runAgentSel ?? 0;
    this.runItemSel = this.resume.runItemSel ?? 0;
    this.logScroll = this.resume.logScroll ?? 0;
    this.detailOpen = this.resume.detailOpen ?? false;
    // A window resumed with an agent in the roster page's pane builds its
    // viewer now, not on the first render: the page's keys are handled by
    // delegating to the viewer, and input can arrive before the first frame.
    if (this.page === "R" && this.focusId !== undefined) {
      const record = this.deps.manager.listAgents().find(a => a.id === this.focusId);
      if (record?.session) this.ensureViewer(record);
    }
    this.tick = setInterval(() => {
      if (!this.disposed) this.tui.requestRender();
    }, TICK_MS);
    // Regular TUI mode leaves the wheel to the terminal's own scrollback;
    // capture it for the panel's lifetime. No-op in fullscreen, where pi
    // already parses mouse input and calls handleMouse instead.
    this.mouseCaptured = enableTerminalMouse(this.tui as unknown as MouseTerminalHost);
  }

  invalidate(): void { /* no cached render state */ }

  private effectiveStyle(): UIStyle {
    return this.deps.uiStyle?.() ?? "pi";
  }

  private effectiveBox(): PaneBox {
    return this.effectiveStyle() === "pi" ? PI_PANE_BOX : UNICODE_PANE_BOX;
  }

  /**
   * Mouse wheel support, fullscreen route. pi's alt-screen renderer parses
   * mouse input and dispatches wheel events to an overlay's top-level component
   * — this hub. In regular mode nothing arrives here; `handleInput` parses the
   * reports instead (see `terminal-mouse.ts`).
   *
   * The shape is declared locally rather than imported: mouse dispatch landed
   * in pi-tui 0.99 while this extension's peer floor is 0.84, so the method is
   * duck-typed — hosts that support mouse call it, older hosts never do.
   */
  handleMouse(event: HubMouseEvent): { handled?: boolean } | undefined {
    if (event.type !== "wheel") return undefined;
    const delta = event.wheelDelta ?? 0;
    if (delta === 0) return undefined;
    this.applyWheel(delta);
    return { handled: true };
  }

  /**
   * One wheel movement, from whichever route delivered it (fullscreen mouse
   * dispatch, or regular-mode input parsing). The page decides what scrolls:
   * the transcript pages scroll the embedded viewer, the log pages their own
   * window, and every other page moves the roster selection a row per logical
   * line. Consumed by the caller either way: an unhandled wheel would scroll
   * the transcript underneath the overlay.
   */
  private applyWheel(delta: number): void {
    if (this.transcriptPage() && this.viewer) {
      this.viewer.scrollBy(delta);
      this.requestRender();
      return;
    }
    if (this.page === "SL" || this.page === "SAL" || this.page === "L") {
      this.scrollLog(Math.sign(delta) * Math.max(1, Math.round(Math.abs(delta))));
      return;
    }
    const steps = Math.max(1, Math.round(Math.abs(delta)));
    const items = this.entries();
    if (items.length > 0) {
      this.selected = Math.min(items.length - 1, Math.max(0, this.selected + Math.sign(delta) * steps));
      this.stopArmed = false;
      this.requestRender();
    }
  }

  dispose(): void {
    this.disposed = true;
    clearInterval(this.tick);
    this.viewer?.dispose();
    this.viewer = undefined;
    this.viewerId = undefined;
    // Hand the wheel back to the terminal (native scrollback, text selection).
    if (this.mouseCaptured) {
      disableTerminalMouse(this.tui as unknown as MouseTerminalHost);
      this.mouseCaptured = false;
    }
  }

  // ---- Roster ----

  private workflows(): FleetWorkflow[] {
    return hubWorkflows(this.deps);
  }

  private agentRecords(): AgentRecord[] {
    return hubAgents(this.deps);
  }

  private roster(): HubEntry[] {
    return [
      ...this.workflows().map(workflow => ({ kind: "workflow" as const, workflow })),
      ...this.agentRecords().map(record => ({ kind: "agent" as const, record })),
    ];
  }

  /** The filter in force: the live input while it's open, else the applied text. */
  private activeFilter(): string {
    return this.filterInput ? this.filterInput.getValue() : this.filterText;
  }

  private matchesFilter(entry: HubEntry): boolean {
    const q = this.activeFilter().trim().toLowerCase();
    if (!q) return true;
    const hay = entry.kind === "workflow"
      ? `${entry.workflow.name} workflow`
      : `${entry.record.type} ${entry.record.alias ?? ""} ${entry.record.description}`;
    return hay.toLowerCase().includes(q);
  }

  private entries(): HubEntry[] {
    const matching = this.roster().filter(e => this.matchesFilter(e));
    // Stable launch order inside SUBAGENTS: a row's identity never moves, so a
    // settling agent cannot reshuffle the list under the cursor.
    const agents = matching
      .filter((e): e is AgentEntry => e.kind === "agent")
      .sort((a, b) => a.record.startedAt - b.record.startedAt);
    const workflows = matching.filter((e): e is WorkflowEntry => e.kind === "workflow");
    return [...agents, ...workflows];
  }

  /**
   * The roster's display rows: the `SUBAGENTS` section first, its agents in
   * stable launch order (a settling agent never reshuffles the list under the
   * cursor), then the `WORKFLOWS` section. Headers are drawn but never
   * selected — the cursor crosses them seamlessly, which is why the selection
   * index counts entries, not rows.
   */
  private rosterItems(entries: readonly HubEntry[]): HubRosterItem[] {
    const items: HubRosterItem[] = [];
    const agents = entries.filter((e): e is AgentEntry => e.kind === "agent");
    const workflows = entries.filter((e): e is WorkflowEntry => e.kind === "workflow");
    if (agents.length > 0) {
      items.push({ kind: "header", label: ROSTER_SUBAGENTS_LABEL });
      items.push(...agents);
    }
    if (workflows.length > 0) {
      items.push({ kind: "header", label: ROSTER_WORKFLOWS_LABEL });
      items.push(...workflows);
    }
    return items;
  }

  // ---- Key handling ----

  handleInput(data: string): void {
    // Mouse reports first. In regular mode the panel captured mouse reporting,
    // so wheel bytes arrive as input; the chunk is consumed either way so no
    // escape sequence can leak into the editor.
    const mouse = parseMouseInput(data);
    if (mouse.sawMouse) {
      if (mouse.wheelDelta !== 0) this.applyWheel(mouse.wheelDelta);
      return;
    }

    // The filter input owns all keys while open (Enter applies, Esc clears).
    if (this.filterInput) {
      this.filterInput.handleInput(data);
      this.tui.requestRender();
      return;
    }

    // The arrows walk the panes the way they point: left is the parent pane
    // (the one level `esc` pops to — from a run page that is the roster, so
    // the agents are reachable without closing anything), right is the
    // descent `⏎` under the cursor would make. On the transcript panes the
    // arrows fall through to the viewer — its composer's cursor needs them.
    if (matchesKey(data, "left")) {
      if (this.page !== "R" || this.detailOpen) {
        this.popPage();
        return;
      }
    }
    if (matchesKey(data, "right") && (this.page === "W" || (this.page === "R" && (this.runRowSelected() || this.stackedMode())))) {
      this.enterPage(this.entries());
      return;
    }

    // The transcript pages own their keys through the same viewer: **WA**, and
    // **R** while a subagent row is selected — the roster page's right pane is
    // that agent's conversation. `esc` walks back one level via the viewer's
    // `onBack` (on R that is the window's own close); the page keys arrive
    // through its `onUnhandledKey` hook. ↑/↓ belong to the pane beside the
    // transcript — the roster on R, the run's agent list on WA — so the right
    // pane follows the cursor instead of the viewer scrolling under it. A page
    // with no viewer (a record whose session is gone) still closes or pops on
    // the quit keys.
    if (this.transcriptPage()) {
      // While a steer message is being composed the input owns every key —
      // ↑/↓ edit it, they must not move the list under the writer.
      if (this.viewer?.composing) {
        this.viewer.handleInput(data);
        this.tui.requestRender();
        return;
      }
      if (matchesKey(data, "down") || matchesKey(data, "up")) {
        const direction = matchesKey(data, "down") ? 1 : -1;
        if (this.page === "WA") this.moveRunSelection(direction);
        else this.moveRosterSelection(direction);
        return;
      }
      // R is the top page, so the window's own keys stay the roster's even
      // with a conversation in the pane: the activity view, the filter and the
      // close all keep working. `⏎` descends nowhere on an agent row — the
      // transcript is already the pane; the stacked twin pushes it instead.
      if (this.page === "R") {
        // `esc` is the stacked twin's pop when its detail pane is pushed, the
        // window's close otherwise.
        if (matchesKey(data, "escape") || matchesKey(data, "q") || matchesKey(data, "ctrl+c")) { this.popPage(); return; }
        if (matchesKey(data, "1")) { this.view = "table"; this.clampSelection(); this.requestRender(); return; }
        if (matchesKey(data, "2")) { this.view = "activity"; this.requestRender(); return; }
        if (matchesKey(data, "tab")) {
          this.view = this.view === "table" ? "activity" : "table";
          this.clampSelection();
          this.requestRender();
          return;
        }
        if (matchesKey(data, "/")) { this.stopArmed = false; this.openFilter(); return; }
        // In the two-pane twin the viewer's own Enter (the steer composer)
        // owns the key; the stacked twin has one column, so there `⏎` pushes
        // the pane as a full-width page instead.
        if (matchesKey(data, "enter") && this.stackedMode()) { this.enterPage(this.entries()); return; }
      }
      if (this.viewer) {
        this.viewer.handleInput(data);
        this.tui.requestRender();
        return;
      }
      if (this.page === "WA") {
        if (matchesKey(data, "escape") || matchesKey(data, "q") || matchesKey(data, "ctrl+c")) {
          this.popPage();
          return;
        }
        // A run agent whose record has no viewer left still takes the page's
        // run-agent keys, gated exactly like the viewer-backed path — an ungated
        // copy would let `s` skip a done agent.
        if (matchesKey(data, "s")) { this.runAgentKey("skip"); return; }
        if (matchesKey(data, "r")) { this.runAgentKey("retry"); return; }
      }
      // R without a viewer falls through to the roster's own per-row keys.
    }

    // The log pages (SL/SAL/L): scroll, copy, pause, stop, back.
    if ((this.page === "SL" || this.page === "SAL" || this.page === "L") && this.handleLogKey(data)) return;

    // **W**: ↑↓ moves the item cursor across the run's phases and agents, ⏎
    // descends into the agent the cursor addresses.
    if (this.page === "W") {
      if (matchesKey(data, "down")) { this.moveRunItem(1); return; }
      if (matchesKey(data, "up")) { this.moveRunItem(-1); return; }
      if (matchesKey(data, "enter")) { this.enterPage(this.entries()); return; }
      if (matchesKey(data, "l")) { this.pushLogPage(); return; }
      if (matchesKey(data, "s")) { this.stopRun(); return; }
      if (matchesKey(data, "p")) { this.pauseResumeRun(); return; }
      if (matchesKey(data, "c")) { this.copyFocusedResult(); return; }
      if (matchesKey(data, "escape") || matchesKey(data, "q") || matchesKey(data, "ctrl+c")) { this.popPage(); return; }
      if (matchesKey(data, "f")) { this.requestToggle(); return; }
      return;
    }

    if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "q")) {
      this.close();
      return;
    }
    if (matchesKey(data, "1")) { this.view = "table"; this.clampSelection(); this.requestRender(); return; }
    if (matchesKey(data, "2")) { this.view = "activity"; this.requestRender(); return; }
    if (matchesKey(data, "tab")) {
      this.view = this.view === "table" ? "activity" : "table";
      this.clampSelection();
      this.requestRender();
      return;
    }
    // `f` swaps the frame size (popup ⇄ full-screen) and nothing else: the
    // page, its selection and its scroll all cross the reopen.
    if (matchesKey(data, "f")) {
      this.requestToggle();
      return;
    }
    if (matchesKey(data, "/")) {
      this.stopArmed = false;
      this.openFilter();
      return;
    }

    const items = this.entries();
    this.clampSelection();
    // Per-row keys: subagent rows keep the lifecycle bindings, workflow rows
    // get the run's safe set (⏎ / s / c) and nothing that a run cannot take.
    const row = items[this.selected];

    if (matchesKey(data, "down")) {
      this.selected = Math.min(items.length - 1, this.selected + 1);
      this.stopArmed = false;
      this.requestRender();
      return;
    }
    if (matchesKey(data, "up")) {
      this.selected = Math.max(0, this.selected - 1);
      this.stopArmed = false;
      this.requestRender();
      return;
    }
    if (matchesKey(data, "home")) { this.selected = 0; this.stopArmed = false; this.requestRender(); return; }
    if (matchesKey(data, "end")) { this.selected = Math.max(0, items.length - 1); this.stopArmed = false; this.requestRender(); return; }

    if (matchesKey(data, "enter")) {
      this.enterPage(items);
      return;
    }

    if (matchesKey(data, "l")) { this.pushLogPage(); return; }
    if (matchesKey(data, "c") && row?.kind === "workflow") { this.copyFocusedResult(); return; }
    if (matchesKey(data, "s") && row?.kind === "workflow") { this.stopRun(); return; }

    if (matchesKey(data, "x") || matchesKey(data, "k")) {
      this.stopSelected(items);
      return;
    }
    if (matchesKey(data, "p")) {
      this.pauseResumeSelected(items);
      return;
    }
    if (matchesKey(data, "c")) {
      const entry = items[this.selected];
      if (entry?.kind === "agent") {
        const record = this.deps.manager.listAgents().find(a => a.id === entry.record.id) ?? entry.record;
        copyRecordResult(record, (message, type) => this.deps.notify?.(message, type));
      }
      return;
    }

    // Any other key disarms a pending stop.
    if (this.stopArmed) this.stopArmed = false;
    this.requestRender();
  }

  /**
   * The skip/retry availability of **WA**'s current agent — `agentActions`,
   * the inspector's gate, against the run's live status. Both keys are absent
   * from the band when the extension wired no controls for the run.
   */
  private runAgentActionKeys(): { skip: boolean; retry: boolean } {
    const run = this.currentRun();
    if (!run || !this.deps.workflowControls?.(run.id)) return { skip: false, retry: false };
    const entry = this.runAgents()[this.clampRunAgentIndex()];
    return agentActions(entry, run.status);
  }

  /** The run controls for the page's run, when the extension wired any. */
  private pageControls(): WorkflowRunControls | undefined {
    const run = this.currentRun();
    return run === undefined ? undefined : this.deps.workflowControls?.(run.id);
  }

  /**
   * `p` on **W**: pause the run if it is running, resume it if parked — the
   * inspector's pause/resume pair, one key, toggled by the run's status (D4's
   * `‖` already renders the parked state on the roster row). Running agents
   * finish; no new ones start.
   */
  private pauseResumeRun(): void {
    const run = this.currentRun();
    const controls = this.pageControls();
    if (!run || !controls) return;
    if (run.status === "paused") {
      if (controls.resume()) this.deps.notify?.("Resumed.", "info");
    } else if (run.status === "running") {
      // Named rather than implied: "paused" on a run whose agents are still
      // finishing reads as a stronger promise than it is.
      if (controls.pause()) this.deps.notify?.("Paused — running agents finish, no new ones start.", "info");
    }
    this.requestRender();
  }

  /** `s` on **WA**: skip the current run agent, if its `agent()` call is live. */
  private skipRunAgent(): void {
    const controls = this.pageControls();
    const entry = this.runAgents()[this.clampRunAgentIndex()];
    if (!controls || !entry) return;
    if (!controls.skip(entry.index)) {
      this.deps.notify?.("Nothing to skip — that agent has already finished.", "info");
    }
    this.requestRender();
  }

  /** `r` on **WA**: retry the current run agent, while it is running. */
  private retryRunAgent(): void {
    const controls = this.pageControls();
    const entry = this.runAgents()[this.clampRunAgentIndex()];
    if (!controls || !entry) return;
    if (!controls.retry(entry.index)) {
      // The window is exactly "while it is running": before that there is
      // nothing to stop, after it the script has its answer.
      this.deps.notify?.("Only a running agent can be retried.", "info");
    }
    this.requestRender();
  }

  private requestRender(): void {
    this.tui.requestRender();
  }

  /**
   * Whether the right pane is a conversation: **WA**, or **R** whenever the
   * cursor is not on a run row — the roster page shows the selected agent's
   * transcript directly, so it owns the transcript's keys and its band.
   */
  private transcriptPage(): boolean {
    // The viewer owns keys and the wheel only while its pane is the one on
    // screen: never in the activity view, and in the stacked twin only once
    // the pane is pushed (`detailOpen`) — an invisible viewer must not eat
    // the roster's input.
    if (this.view === "activity") return false;
    if (this.stackedMode() && this.page === "R" && !this.detailOpen) return false;
    return this.page === "WA" || (this.page === "R" && !this.runRowSelected());
  }

  /** **R**'s run-row selection: the pane is the run's overview, not a transcript. */
  private runRowSelected(): boolean {
    return this.page === "R" && this.entries()[this.selected]?.kind === "workflow";
  }

  /**
   * The single-pane twin (40–59 cols): the roster has the full width, so `⏎`
   * pushes the selected item's pane instead of showing it beside the list. The
   * last rendered width is the frame's real one — a popup is narrower than the
   * terminal it hangs in, so the terminal's columns alone would misjudge it.
   */
  private stackedMode(): boolean {
    return (this.lastWidth ?? this.tui.terminal?.columns ?? Infinity) < TWO_PANE_MIN_WIDTH;
  }

  /** Write UI state back to the shared resume object for a reopen with the other frame size. */
  private syncResume(): void {
    this.resume.view = this.view;
    this.resume.selected = this.selected;
    this.resume.filterText = this.filterText;
    this.resume.page = this.page;
    this.resume.focusId = this.focusId;
    this.resume.runId = this.runId;
    this.resume.runAgentSel = this.runAgentSel;
    this.resume.runItemSel = this.runItemSel;
    this.resume.logScroll = this.logScroll;
    this.resume.detailOpen = this.detailOpen;
  }

  private close(): void {
    this.syncResume();
    this.dispose();
    this.done(undefined);
  }

  /** `f`: flip the frame size — popup ↔ full-screen, same page. pi sizes
   *  overlays once, so this resolves the overlay with `"toggle"` and
   *  `openAgentHub` reopens us resized, with state carried through the shared
   *  resume object. */
  private requestToggle(): void {
    this.syncResume();
    this.onToggle();
  }

  private clampSelection(): void {
    const max = Math.max(0, this.entries().length - 1);
    if (this.selected > max) this.selected = max;
    if (this.selected < 0) this.selected = 0;
  }

  private openFilter(): void {
    const input = new Input();
    input.focused = true;
    input.onSubmit = () => {
      this.filterText = input.getValue();
      this.filterInput = undefined;
      this.clampSelection();
      this.requestRender();
    };
    input.onEscape = () => {
      this.filterText = "";
      this.filterInput = undefined;
      this.clampSelection();
      this.requestRender();
    };
    this.filterInput = input;
    this.requestRender();
  }

  /**
   * ↑/↓ on **R**: move the roster's selection and let the right pane follow —
   * the conversation for an agent row, the run overview for a run row. The
   * move clamps at the ends; the list is visible next to the user, so wrapping
   * would only break the spatial model. Staying put is a no-op, so scroll
   * position survives a stray keypress at the end of the roster.
   */
  private moveRosterSelection(direction: 1 | -1): void {
    // Steps one ROW at a time, group headers aside — the cursor crosses from
    // SUBAGENTS into WORKFLOWS seamlessly. The pane follows the cursor: an
    // agent row sets the page's subject, a run row clears it (its pane is the
    // run's overview, and ⏎ opens it).
    const items = this.entries();
    const next = Math.min(items.length - 1, Math.max(0, this.selected + direction));
    if (next === this.selected) return;
    this.selected = next;
    const entry = items[next];
    this.focusId = entry?.kind === "agent" ? entry.record.id : undefined;
    this.stopArmed = false;
    this.requestRender();
  }

  /** Two-press stop on the selected agent, mirroring the viewer's `x`. */
  private stopSelected(items: HubEntry[]): void {
    const entry = items[this.selected];
    if (!entry || entry.kind !== "agent") return;
    const record = entry.record;
    const active = record.status === "running" || record.status === "queued";
    if (!active) return;
    if (this.stopArmed) {
      this.stopArmed = false;
      if (this.deps.manager.abort(record.id)) {
        this.deps.notify?.(`Stopped "${record.description}".`, "info");
      }
    } else {
      this.stopArmed = true;
    }
    this.requestRender();
  }

  /**
   * `p`: pause the selected agent if it is active, resume it if paused. One
   * key because the two states are one lifecycle — a paused row is where a
   * pause landed and the only thing a resume starts from. Settled agents stay
   * put: continuing a finished run is `/agents resume`'s job, not a toggle's.
   */
  private pauseResumeSelected(items: HubEntry[]): void {
    const entry = items[this.selected];
    if (entry?.kind !== "agent") return;
    this.pauseResumeAgent(entry.record);
  }

  private pauseResumeAgent(record: AgentRecord): void {
    if (record.status === "running" || record.status === "queued") {
      const why = this.deps.pauseAgent?.(record.id);
      this.deps.notify?.(
        why ? `Cannot pause "${record.description}" — ${why}.` : `Paused "${record.description}".`,
        why ? "warning" : "info",
      );
    } else if (record.status === "paused") {
      const started = this.deps.resumeAgent?.(record.id);
      this.deps.notify?.(
        started ? `Resuming "${record.description}".` : `Cannot resume "${record.description}".`,
        started ? "info" : "warning",
      );
    }
    this.requestRender();
  }

  // ---- Rendering ----

  render(width: number): string[] {
    this.lastWidth = width;
    const terminalRows = this.tui.terminal?.rows ?? HUB_FALLBACK_ROWS;
    if (width < HUB_MIN_WIDTH || terminalRows < HUB_MIN_ROWS) {
      this.refuseSize();
      return [];
    }
    if (this.view === "activity") return this.renderActivityWindow(width, terminalRows);
    return this.renderHubPage(width, terminalRows);
  }

  /**
   * Terminal share the window fills: the popup twin's 70 % (pi resolves the
   * overlay's `maxHeight` at creation and clips whatever is taller), the
   * fullscreen twin's 100 %.
   */
  private viewportPct(): number {
    return this.popup ? POPUP_HEIGHT_PCT : 100;
  }

  /**
   * The window under the ladder: below 40×10 it refuses to open at all — no
   * partial frame, one notification, then the overlay closes. Called from
   * `render`, where the terminal's size is finally known.
   */
  private refuseSize(): void {
    if (this.refused) return;
    this.refused = true;
    this.deps.notify?.(HUB_SIZE_REFUSAL, "warning");
    this.close();
  }

  /**
   * The unified window: the roster (or a run's agent list) on the left, the
   * current page's detail on the right, the constant window title, and the
   * page's own footer band.
   *
   * The detail pane opens with its identity block on every page; on run-agent
   * pages the `↳` line leads with the run name.
   *
   * Two-pane down to {@link TWO_PANE_MIN_WIDTH}, stacked below it: the pane
   * policy is the size ladder's, the columns are the shared window's.
   */
  private renderHubPage(width: number, terminalRows: number): string[] {
    const twoPane = width >= TWO_PANE_MIN_WIDTH;
    // The stacked twin's pushed pane is a view state of the roster page; the
    // two-pane frame already shows the transcript beside the roster.
    if (twoPane) this.detailOpen = false;
    const header: WindowRow[] = [];
    if (this.filterInput || this.filterText) {
      header.push({ kind: "full", cells: [{ text: this.filterLine(windowInnerWidth(width)) }] });
    }
    // The window's chrome is fixed — top edge, band rule, footer, bottom edge —
    // and the filter row is the one row that joins it. The body takes every
    // row the twin's viewport leaves, so the frame fills the overlay exactly: a
    // floor on the body would draw past it, and the six-row floor the spec asks
    // for at 10 rows is what this subtraction already gives.
    const chrome = HUB_CHROME_ROWS + (header.length > 0 ? 1 : 0);
    const bodyRows = paneBodyHeight({
      terminalRows,
      viewportPct: this.viewportPct(),
      chromeRows: chrome,
      min: 1,
      fallbackRows: HUB_FALLBACK_ROWS - HUB_CHROME_ROWS,
    });

    const body: WindowRow[] = [];
    // A log page's readout is captured as its pane renders; clear it so a page
    // without one never shows the last log's numbers.
    this.logReadout = undefined;

    if (!twoPane) {
      // Stacked: one full-width page. `⏎` pushes the right pane's content as
      // its own page; `esc` pops it — the page model unchanged, one column.
      body.push(...this.stackedLines(width - 4, bodyRows));
    } else {
      const panes = masterPaneGeometry(width);
      const left = this.leftPaneLines(panes.listWidth, bodyRows);
      const right = this.rightPaneLines(panes.detailWidth, bodyRows);
      for (let i = 0; i < bodyRows; i++) {
        const rightRow = right[i];
        body.push(isHeaderRule(rightRow)
          ? { kind: "headerRule", left: left[i] }
          : { kind: "split", left: left[i], right: rightRow ?? [] });
      }
    }

    const rows: WindowRow[] = [...header, ...body];
    rows.push({ kind: "band" }, { kind: "full", cells: [{ text: this.pageFooter(windowInnerWidth(width)) }] });

    return paintWindow(
      renderWindow({
        width,
        box: this.effectiveBox(),
        style: this.effectiveStyle(),
        panes: twoPane ? masterPaneGeometry(width) : undefined,
        title: this.effectiveStyle() === "pi" ? undefined : HUB_TITLE,
        rows,
        ellipsis: "…",
      }),
      this.theme,
      this.effectiveStyle(),
    );
  }

  /**
   * The page's footer band: the readout and the page's actions in the left
   * slot, navigation, the page's keys, the twin toggle and the pinned escape
   * anchor in the right. The window's fitter drops whole hints — the readout
   * first — so the band never cuts one in half.
   */
  private pageFooter(width: number): string {
    const keys = this.page === "R" && this.runRowSelected() ? R_RUN_KEYS : PAGE_KEYS[this.page];
    const viewer = this.viewerBand();
    const expanded = this.transcriptPage() && (viewer?.expanded ?? false);
    const actions = expanded
      ? [...keys.actions.filter(action => action !== TD_REPLACED_ACTION), ...TD_ACTIONS]
      : [...keys.actions];
    // The inspector's run controls, migrated onto the pages that own their
    // subjects: `p` toggles the run on **W**, `s`/`r` act on **WA**'s agent —
    // and neither is advertised when the extension wired no controls for the
    // run.
    if (this.page === "W") {
      const run = this.currentRun();
      if (run && this.deps.workflowControls?.(run.id)) {
        if (run.status === "paused") actions.push("p resume run");
        else if (run.status === "running") actions.push("p pause run");
      }
    }
    if (this.page === "WA") {
      const { skip, retry } = this.runAgentActionKeys();
      if (skip) actions.push("s skip");
      if (retry) actions.push("r retry");
    }
    const hints = expanded ? keys.hints.filter(hint => hint !== TD_DROPPED_HINT) : [...keys.hints];
    const armed = this.stopArmed || (viewer?.stopArmed ?? false);

    const left: FooterHint[] = [];
    const readout = this.pageReadout();
    if (readout) left.push({ text: readout, group: "readout" });
    // The armed stop reads on whichever slot the page advertises it in, and
    // sits leftmost among the actions so it outlives them when the band is
    // tight. A page that does not advertise `x` still arms the roster's own.
    if (armed) left.push({ text: "x again to STOP", group: "action" });
    for (const action of actions) {
      if (armed && action === "x stop") continue;
      left.push({ text: action, group: "action" });
    }
    const right: FooterHint[] = [
      ...hints.map((text): FooterHint => ({ text, group: "hint" })),
      { text: `f ${this.popup ? "full" : "popup"}`, group: "hint" },
      // The stacked twin's pushed pane is a view state above the roster, so
      // its escape anchor names the roster it pops back to.
      { text: `Esc ${this.detailOpen ? "roster" : keys.esc}`, group: "hint", pinned: true },
    ];
    const band = footerBand({ width, left, right });
    // The armed stop keeps the error color the old one-line footer gave it.
    return armed ? this.theme.fg("error", band) : band;
  }

  /** The embedded viewer's band state, when a page is showing one. */
  private viewerBand(): { text: string; expanded: boolean; stopArmed: boolean } | undefined {
    return this.transcriptPage() ? this.viewer?.bandReadout() : undefined;
  }

  /**
   * The band's readout — the one hint that is data, not a key. The pages whose
   * pane is a transcript (R's agent selection, WA) read the embedded viewer's
   * line count and scroll percent; the log pages the log they just windowed;
   * **W** the run's counters. R's run-row selection has none — its left slot is
   * actions.
   */
  private pageReadout(): string | undefined {
    if (this.transcriptPage()) return this.viewer?.bandReadout().text || undefined;
    if (this.page === "SL" || this.page === "SAL" || this.page === "L") {
      const log = this.logReadout;
      return log ? `${log.lines} lines · ${log.percent}%` : undefined;
    }
    if (this.page === "W") {
      const run = this.currentRun();
      return run ? this.runReadout(run) : undefined;
    }
    return undefined;
  }

  /** **W**'s readout: the run's counters and how far through its phases it is. */
  private runReadout(run: FleetWorkflow): string {
    const groups = this.runGroups(run.id);
    const parts = [`${run.doneCount}/${run.totalCount} agents`];
    if (groups.length > 0) parts.push(`phase ${currentPhaseIndex(groups) + 1} of ${groups.length}`);
    return parts.join(" · ");
  }

  /** The legacy activity list, still reachable with `2` — the roster's sibling view. */
  private renderActivityWindow(width: number, terminalRows: number): string[] {
    // Its chrome spends SIX rows around the list: the frame's two edges plus
    // title, two dim rules and the one-list footer — two more than a page's
    // band layout (HUB_CHROME_ROWS), so the budget must pay for them or the
    // window draws past the twin's ceiling and pi clips the bottom.
    const rows = paneBodyHeight({
      terminalRows,
      viewportPct: this.viewportPct(),
      chromeRows: HUB_CHROME_ROWS + 2,
      min: MIN_BODY_ROWS,
      fallbackRows: HUB_FALLBACK_ROWS - HUB_CHROME_ROWS,
    });
    return paintWindow(
      renderWindow({
        width,
        box: this.effectiveBox(),
        style: this.effectiveStyle(),
        rows: [
          { kind: "full", cells: [{ text: this.activityTitle(width) }] },
          { kind: "full", cells: [{ text: "─".repeat(width), color: "dim" }] },
          ...this.renderActivity(rows),
          { kind: "full", cells: [{ text: "─".repeat(width), color: "dim" }] },
          { kind: "full", cells: [{ text: `↑↓ select · Enter open · x stop · p pause · 1 agents · f ${this.popup ? "full" : "popup"} · q close` }] },
        ],
        ellipsis: "…",
      }),
      this.theme,
      this.effectiveStyle(),
    );
  }

  private activityTitle(width: number): string {
    const th = this.theme;
    const agents = this.agentRecords();
    const running = agents.filter(a => a.status === "running" || a.status === "queued").length;
    return truncateToWidth(`${th.bold("Agents & Workflows")} ${th.fg("dim", `· activity · ${agents.length} agents · ${running} active`)}`, width);
  }

  private filterLine(width: number): string {
    const th = this.theme;
    if (this.filterInput) {
      // The Input renders its own `> ` prompt; just add the usage hint.
      const field = this.filterInput.render(Math.max(1, width - 2))[0] ?? "";
      return truncateToWidth(field + th.fg("dim", "  (Enter apply · Esc clear)"), width);
    }
    const total = this.roster().length;
    const shown = this.entries().length;
    return truncateToWidth(th.fg("accent", `/ ${this.filterText}`) + th.fg("dim", `  — ${shown}/${total} match${shown === 1 ? "" : "es"}`), width);
  }

  /** The roster's rows for a pane: section headers, windowed on the selection. */
  private rosterLines(width: number, rows: number): WorkflowCardLine[] {
    const items = this.entries();
    this.clampSelection();
    if (items.length === 0) {
      return [clampLine([{ text: this.theme.fg("dim", this.activeFilter() ? "no matches" : "(no agents yet — spawn one to see it here)") }], width)];
    }
    // The display list carries the section headers; the selection counts only
    // the rows, so `selAt` finds the selection's row position under the headers.
    const display = this.rosterItems(items);
    const selectedEntry = items[this.selected];
    const selAt = Math.max(0, display.findIndex(item => item.kind !== "header" && item === selectedEntry));
    const slice = windowRange(selAt, display.length, rows);

    const lines: WorkflowCardLine[] = [];
    for (let i = 0; i < rows; i++) {
      const item = display[slice.start + i];
      if (!item) { lines.push([]); continue; }
      if (item.kind === "header") {
        lines.push([{ text: item.label, color: "dim", bold: true }]);
        continue;
      }
      const isSelected = item === selectedEntry;
      lines.push(clampLine([{
        text: this.renderEntry(item, isSelected, width),
        ...(isSelected ? { bg: "selectedBg" as const } : {}),
      }], width));
    }
    return lines;
  }

  // ---- Pages (the one window) ----

  /** The left pane: the parent level for whichever page is up. */
  private leftPaneLines(width: number, rows: number): WorkflowCardLine[] {
    const isPi = this.effectiveStyle() === "pi";
    if (isPi && rows >= 3) {
      const titleLine = clampLine([{ text: "Agents & Workflows", bold: true }], width);
      const sepLine = clampLine([{ text: "─".repeat(width), color: "dim" }], width);
      const innerRows = rows - 2;
      const content = this.page === "WA" || this.page === "SAL" || this.page === "L"
        ? this.runLeftLines(width, innerRows)
        : this.rosterLines(width, innerRows);
      return [titleLine, sepLine, ...content];
    }
    switch (this.page) {
      case "WA":
      case "SAL":
      case "L":
        return this.runLeftLines(width, rows);
      default:
        return this.rosterLines(width, rows);
    }
  }

  /** The right pane: the selected item's detail, per page. Identity is composed in front of it. */
  private rightPaneLines(width: number, rows: number): PaneRow[] {
    switch (this.page) {
      case "R": {
        // The roster page carries its own detail: the selected agent's
        // conversation, or the run's overview for a workflow row.
        const entry = this.entries()[this.selected];
        return entry?.kind === "workflow"
          ? this.runPreviewLines(entry.workflow, width, rows)
          : this.transcriptLines(width, rows);
      }
      case "WA":
        return this.transcriptLines(width, rows);
      case "SL":
      case "SAL":
        return this.agentLogPageLines(width, rows);
      case "W":
        return this.runPaneLines(width, rows);
      case "L":
        return this.runLogPageLines(width, rows);
    }
  }

  /**
   * The run overview **R** shows for a selected workflow row (spec R2): the run
   * header block, the phases with the current one carrying the `❯`, and the
   * hint onto the run page.
   */
  private runPreviewLines(run: FleetWorkflow, width: number, rows: number): PaneRow[] {
    const source = this.runSource(run.id);
    const groups = source ? buildPhaseGroups(source.progress, source.meta?.phases) : [];
    const body: PaneRow[] = [];
    if (groups.length > 0) {
      body.push(clampLine([{ text: "PHASES", color: "muted", bold: true }], width));
      body.push(...phaseListRows({
        groups,
        selectedPhase: currentPhaseIndex(groups),
        capacity: Math.max(0, this.bodyRows(rows, true) - body.length),
        width,
        glyphs: UNICODE_DIALOG_GLYPHS,
      }));
    }
    return this.identityPane(
      runHeaderLines({ run, groups, width, th: this.theme }),
      body,
      this.noteLine("(⏎ opens the run page)", width),
    );
  }

  /**
   * The transcript pages' right pane (**R** with a subagent row, **WA**): the
   * selected agent's full conversation, through the same `ConversationViewer`
   * the popup shows — user, thinking, assistant, tool-call, diff and streaming
   * blocks, with `o`/`ctrl+o` expanding a tool-call in place (a view state,
   * never a page). An agent whose session is gone still gets its identity
   * block: the pane never draws the previous subject's body under the new
   * subject's name.
   */
  private transcriptLines(width: number, rows: number): PaneRow[] {
    const record = this.focusedRecord();
    if (!record) return [clampLine([{ text: this.theme.fg("dim", "no agent selected") }], width)];
    if (!record.session) {
      // No conversation to draw: drop a viewer built for another subject, so
      // the band cannot report the previous agent's readout.
      this.viewer?.dispose();
      this.viewer = undefined;
      this.viewerId = undefined;
      return this.identityPane(
        this.agentIdentity(record, width),
        [this.noteLine(`transcript unavailable — agent is ${record.status}`, width)],
      );
    }
    const viewer = this.ensureViewer(record);
    if (!viewer) return [];
    const capacity = this.bodyRows(rows, false);
    // The frame budgeted this many rows for the body; the viewer renders
    // exactly that many and the host wraps them in the identity block.
    this.viewerRows = capacity;
    const body: PaneRow[] = viewer.render(width).map((text): PaneRow => [{ text }]);
    return this.identityPane(this.agentIdentity(record, width), padLines(body, capacity));
  }

  /**
   * **W**: the run's phases followed by its agents — the level the next `⏎`
   * descends into. Rows come from the inspector's own builders. The `❯` on a
   * phase is the state mark (where the run is); the item cursor is drawn only
   * where it sits, and the row where the two coincide carries one glyph.
   */
  private runPaneLines(width: number, rows: number): PaneRow[] {
    const run = this.currentRun();
    if (!run) return [clampLine([{ text: this.theme.fg("dim", "run detail unavailable") }], width)];
    const identity = runHeaderLines({ run, groups: this.runGroups(run.id), width, th: this.theme });
    const source = this.runSource(run.id);
    if (!source) return this.identityPane(identity, [this.noteLine("run detail unavailable", width)]);
    const capacity = this.bodyRows(rows, false);
    const glyphs = UNICODE_DIALOG_GLYPHS;
    const groups = buildPhaseGroups(source.progress, source.meta?.phases);
    const entries = flattenRunAgents(source.progress, source.meta?.phases);
    const mark = this.runPhaseMark(groups);
    const item = this.clampRunItemIndex(groups, entries);
    const agentSel = item >= groups.length ? item - groups.length : undefined;
    const lines: PaneRow[] = [clampLine([{ text: "PHASES", color: "muted", bold: true }], width)];
    // The phase list windows into what is left beside its own header and a
    // reserved RUNNING WORKFLOW AGENTS block (blank + header + one agent
    // row), so a long phase list can no longer push the agents off the pane's
    // bottom.
    const phaseCapacity = Math.max(0, capacity - 4);
    lines.push(
      ...phaseListRows({
        groups,
        selectedPhase: mark,
        cursor: item < groups.length ? item : undefined,
        capacity: phaseCapacity,
        width,
        glyphs,
      }),
    );
    lines.push([]);
    lines.push(clampLine([{ text: RUN_AGENTS_LABEL, color: "muted", bold: true }], width));
    // With the cursor on a phase row there is no agent cursor to draw; the
    // list still windows around wherever it last was.
    const selection = agentSel ?? this.clampRunAgentIndex();
    const slice = windowRange(selection, entries.length, Math.max(1, capacity - lines.length));
    if (entries.length === 0) lines.push(clampLine([{ text: `   ${WORKFLOW_NO_AGENTS}`, color: "dim" }], width));
    for (let i = slice.start; i < slice.end; i++) {
      lines.push(
        ...agentRow({
          entry: entries[i],
          selected: i === agentSel,
          compact: false,
          width,
          glyphs,
          runStatus: source.task.status,
          spinnerFrame: 0,
          now: Date.now(),
          live: this.runAgentLive(entries[i], source.task.status),
        }),
      );
    }
    return this.identityPane(identity, padLines(lines, capacity));
  }

  /** The phases' state mark for the pane being drawn, refreshed from the run. */
  private runPhaseMark(groups: readonly PhaseGroup[]): number {
    return currentPhaseIndex(groups);
  }

  /**
   * A running run agent's live facts: turn count and tokens from its record
   * and activity, and its last output line. Only a live agent has them — and a
   * parked run's children are live, so their tail keeps streaming too.
   */
  private runAgentLive(
    entry: WorkflowAgentEntry,
    runStatus: WorkflowRunStatus,
  ): { turns?: number; tokens?: number; tail?: string } | undefined {
    if (entry.recordId === undefined) return undefined;
    const state = displayState(entry, runStatus);
    if (state !== "running" && state !== "paused") return undefined;
    const record = this.deps.manager.listAgents().find(a => a.id === entry.recordId);
    const activity = this.deps.agentActivity.get(entry.recordId);
    if (record === undefined && activity === undefined) return undefined;
    return {
      // Run-owned children get no activity tracker (the fleet registers
      // those only for its own spawns), so the turn count falls back to the
      // session: one assistant message ≈ one completed model turn.
      turns: activity?.turnCount ?? assistantTurnCount(record?.session?.messages),
      tokens: record ? getLifetimeTotal(record.lifetimeUsage) : entry.tokens,
      tail: this.runAgentTail(record, activity),
    };
  }

  /**
   * The running agent's last output line. While a tool runs, the tool
   * summary is the live thing; while text streams, its last line. Between
   * turns nothing streams and the activity's text is empty — the newest
   * output is pulled from the session instead, exactly how the main window's
   * agent tree derives its line (`getLastAssistantText`), widened to tool
   * results: while the next turn waits they are the freshest output there
   * is, which is why the walk must not stop at the last assistant text.
   */
  private runAgentTail(record: AgentRecord | undefined, activity: AgentActivity | undefined): string {
    const tools = activity?.activeTools ?? new Map<string, string>();
    if (tools.size > 0) return describeActivity(tools, activity?.responseText);
    const streamed = lastNonEmptyLine(activity?.responseText ?? "");
    if (streamed) return streamed;
    const messages = record?.session?.messages ?? [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (message.role !== "assistant" && message.role !== "toolResult") continue;
      const line = lastNonEmptyLine(extractText(message.content as unknown[]));
      if (line) return line;
    }
    return "thinking…";
  }

  /** The phase groups of the named run, or none when its detail source is gone. */
  private runGroups(id: string): PhaseGroup[] {
    const source = this.runSource(id);
    return source ? buildPhaseGroups(source.progress, source.meta?.phases) : [];
  }

  /**
   * The run's agent list, with the run's phases beside it on **L** (above) and
   * on the run-agent pages (beneath) — the parent level those pages demote into
   * the left cell. The phases carry the run's state mark on every one of them.
   */
  private runLeftLines(width: number, rows: number): WorkflowCardLine[] {
    const source = this.runSource();
    if (!source) return [clampLine([{ text: this.theme.fg("dim", "run detail unavailable") }], width)];
    const glyphs = UNICODE_DIALOG_GLYPHS;
    const groups = buildPhaseGroups(source.progress, source.meta?.phases);
    const mark = this.runPhaseMark(groups);
    const entries = flattenRunAgents(source.progress, source.meta?.phases);
    const selection = this.clampRunAgentIndex();
    const lines: WorkflowCardLine[] = [];
    const heading = (title: string) => clampLine([{ text: title, color: "muted", bold: true }], width);
    // On L the phases lead the run's agents; on the run-agent pages they sit
    // beneath them, reserved so a long agent list cannot push them off.
    const phaseFirst = this.page === "L";
    if (phaseFirst && groups.length > 0) {
      lines.push(heading("PHASES"));
      lines.push(
        ...phaseListRows({ groups, selectedPhase: mark, capacity: Math.max(0, rows - lines.length - 2), width, glyphs }),
      );
      if (lines.length < rows) lines.push([]);
    }
    const phaseBlock = groups.length > 0 ? groups.length + 2 : 0;
    if (entries.length === 0) {
      lines.push(clampLine([{ text: `   ${WORKFLOW_NO_AGENTS}`, color: "dim" }], width));
    } else {
      if (phaseFirst && groups.length > 0) lines.push(heading(RUN_AGENTS_LABEL));
      const capacity = Math.max(1, phaseFirst ? rows - lines.length : rows - phaseBlock - lines.length);
      const slice = windowRange(selection, entries.length, capacity);
      for (let i = slice.start; i < slice.end; i++) {
        const isSelected = i === selection;
        const rows = agentRow({
          entry: entries[i],
          selected: isSelected,
          compact: this.page !== "L",
          width,
          glyphs,
          runStatus: source.task.status,
          spinnerFrame: 0,
          now: Date.now(),
          // No live tail here: the 18-column master clamps it to noise —
          // the run page's wide pane carries the live facts.
        });
        if (isSelected) {
          lines.push(...rows.map(r => r.map(seg => ({ ...seg, bg: "selectedBg" as const }))));
        } else {
          lines.push(...rows);
        }
      }
    }
    if (!phaseFirst && groups.length > 0) {
      if (lines.length < rows) lines.push([]);
      lines.push(heading("PHASES"));
      lines.push(...phaseListRows({ groups, selectedPhase: mark, capacity: Math.max(0, rows - lines.length), width, glyphs }));
    }
    return lines;
  }

  /** The run log: the events the run's progress entries carry, timestamped. */
  private runLogLines(width: number, rows: number): PaneRow[] {
    const run = this.currentRun();
    const source = run ? this.runSource(run.id) : undefined;
    if (!run || !source) return [clampLine([{ text: this.theme.fg("dim", "run detail unavailable") }], width)];
    const active = source.task.status === "running" || source.task.status === "paused";
    const lines: WorkflowCardLine[] = [
      clampLine([{ text: `${stamp(run.startedAt)} run start: ${run.totalCount} agent${run.totalCount === 1 ? "" : "s"}`, color: "muted" }], width),
    ];
    for (const entry of flattenRunAgents(source.progress, source.meta?.phases)) {
      const state = displayState(entry, source.task.status);
      if (entry.startedAt != null) {
        lines.push(clampLine([{ text: `${stamp(entry.startedAt)} ${entry.label} spawned${entry.phaseTitle ? ` (${entry.phaseTitle})` : ""}`, color: "dim" }], width));
      }
      if (state === "running") lines.push(clampLine([{ text: `${stamp(entry.lastProgressAt ?? Date.now())} ${entry.label} still running`, color: "dim" }], width));
      if (state === "paused") lines.push(clampLine([{ text: `${stamp(entry.lastProgressAt ?? Date.now())} ${entry.label} still running (run paused)`, color: "dim" }], width));
      if (state === "done") {
        const at = entry.startedAt != null && entry.durationMs != null ? entry.startedAt + entry.durationMs : Date.now();
        lines.push(clampLine([{ text: `${stamp(at)} ${entry.label} done${entry.resultPreview ? ` — ${entry.resultPreview}` : ""}`, color: "success" }], width));
      }
      if (state === "failed" || state === "blocked") {
        lines.push(clampLine([{ text: `${stamp(entry.lastProgressAt ?? Date.now())} ${entry.label} failed${entry.error ? ` — ${entry.error}` : ""}`, color: "error" }], width));
      }
      if (state === "skipped") lines.push(clampLine([{ text: `${stamp(entry.lastProgressAt ?? Date.now())} ${entry.label} skipped`, color: "dim" }], width));
    }
    if (!active) lines.push(clampLine([{ text: `${stamp(run.completedAt ?? Date.now())} run ${runStatusWord(run.status)}`, color: "muted" }], width));
    return padLines(this.scrollTail(lines, this.logScroll, rows), rows);
  }

  /**
   * An agent's event log — the compact timestamped companion to the
   * transcript, from what the record and its live activity know: spawn, turns,
   * tool calls, completion with tokens and cost. The trailing line is the live
   * activity (`describeActivity`), which is where the removed `❞` strip's
   * information lives now.
   */
  private agentLogLines(width: number, rows: number): PaneRow[] {
    const record = this.focusedRecord();
    if (!record) return [clampLine([{ text: this.theme.fg("dim", "no agent selected") }], width)];
    const activity = this.deps.agentActivity.get(record.id);
    const lines: WorkflowCardLine[] = [
      clampLine([{ text: `${stamp(record.startedAt)} spawn  ${record.alias ?? record.handle ?? record.type} · ${record.description}`, color: "muted" }], width),
    ];
    for (let turn = 1; turn <= (activity?.turnCount ?? 0); turn++) {
      lines.push(clampLine([{ text: `${stamp(record.startedAt)} turn ${turn} start`, color: "dim" }], width));
    }
    if (record.toolUses > 0) {
      lines.push(clampLine([{ text: `${stamp(record.startedAt)} tools  ${record.toolUses} call${record.toolUses === 1 ? "" : "s"}`, color: "dim" }], width));
    }
    if (activity?.responseText) {
      lines.push(clampLine([{ text: `${stamp(Date.now())} note   ${activity.responseText.split("\n")[0] ?? ""}`, color: "dim" }], width));
    }
    if (record.status === "running" || record.status === "queued" || record.status === "paused") {
      const doing = activity ? describeActivity(activity.activeTools, activity.responseText) : "thinking…";
      lines.push(clampLine([{ text: `${stamp(Date.now())} still ${record.status} — ${doing}`, color: "dim" }], width));
    }
    if (record.completedAt != null) {
      const done = record.status === "completed" || record.status === "steered";
      lines.push(clampLine([{ text: `${stamp(record.completedAt)} ${done ? "done" : record.status}${record.error ? ` — ${record.error}` : ""}`, color: done ? "success" : "error" }], width));
      const tokens = getLifetimeTotal(record.lifetimeUsage);
      const cost = this.deps.showCost ? formatCost(getLifetimeCost(record.lifetimeUsage)) : "";
      lines.push(clampLine([{ text: `${stamp(record.completedAt)} usage  ${tokens} tokens${cost ? ` · ${cost}` : ""}`, color: "dim" }], width));
    }
    return padLines(this.scrollTail(lines, this.logScroll, rows), rows);
  }

  /**
   * An agent's event-log page (**SL**, **SAL**): the identity block, the
   * frame's header rule, then the log.
   */
  private agentLogPageLines(width: number, rows: number): PaneRow[] {
    const record = this.focusedRecord();
    if (!record) return [clampLine([{ text: this.theme.fg("dim", "no agent selected") }], width)];
    return this.identityPane(this.agentIdentity(record, width), this.agentLogLines(width, this.bodyRows(rows, false)));
  }

  /** The run log page (**L**): the run's identity block, the rule, the events. */
  private runLogPageLines(width: number, rows: number): PaneRow[] {
    const run = this.currentRun();
    if (!run) return [clampLine([{ text: this.theme.fg("dim", "run detail unavailable") }], width)];
    const identity = runHeaderLines({ run, groups: this.runGroups(run.id), width, th: this.theme });
    return this.identityPane(identity, this.runLogLines(width, this.bodyRows(rows, false)));
  }

  /** Rows a pane has left for its body, the identity block and a closing note removed. */
  private bodyRows(rows: number, note: boolean): number {
    return Math.max(1, rows - IDENTITY_ROWS - (note ? 1 : 0));
  }

  /**
   * A pane's content: the identity block, the frame's header rule, the body,
   * then an optional closing note (a preview's `⏎` hint). Identity is composed
   * here, outside the body: the body is windowed to the rows it is handed, and
   * identity must never be trimmed by that windowing.
   */
  private identityPane(identity: WorkflowCardLine[], body: readonly PaneRow[], note?: WorkflowCardLine): PaneRow[] {
    return [...identity, HEADER_RULE, ...body, ...(note ? [note] : [])];
  }

  /** The agent header block for whichever record the page is showing. */
  private agentIdentity(record: AgentRecord, width: number): WorkflowCardLine[] {
    return agentHeaderLines({
      record,
      activity: this.deps.agentActivity.get(record.id),
      width,
      th: this.theme,
      parentName: this.page === "WA" || this.page === "SAL" ? this.currentRun()?.name : undefined,
    });
  }

  /** A dim one-line note closing a pane. */
  private noteLine(text: string, width: number): WorkflowCardLine {
    return clampLine([{ text, color: "dim" }], width);
  }

  /**
   * The stacked single-pane page (40–59 cols): the current page's own content
   * at full width. On the roster `⏎` pushes the selected item's pane (a view
   * state of the page, not a page: `esc` pops it); the pages below the roster
   * are their right pane by definition.
   */
  private stackedLines(width: number, rows: number): WindowRow[] {
    const lines: PaneRow[] = this.page === "R"
      ? (this.detailOpen ? this.rightPaneLines(width, rows) : this.rosterLines(width, rows))
      : this.rightPaneLines(width, rows);
    const content = lines.length > 0 ? lines : this.leftPaneLines(width, rows);
    // Fill the body like the two-pane loop does: a short pane would leave
    // stale rows visible below the bottom edge.
    const padded = content.slice(0, rows);
    for (let i = padded.length; i < rows; i++) padded.push([]);
    return padded.map(row => (isHeaderRule(row) ? { kind: "headerRule" } : { kind: "full", cells: row }));
  }

  /** The viewer for `record`, rebuilt only when the target changes. */
  private ensureViewer(record: AgentRecord): ConversationViewer | undefined {
    // `focusId` tracks the roster's selection; the viewer is cached against
    // the record it was BUILT for — `focusedRecord()` derives from focusId,
    // so comparing against focusId would degenerate to `if (this.viewer)` and
    // never retarget when the selection moves (P9 review blocker).
    if (this.viewer && this.viewerId === record.id) return this.viewer;
    if (!record.session) return undefined;
    this.viewer?.dispose();
    this.viewerId = record.id;
    this.viewer = new ConversationViewer(
      this.tui,
      record.session,
      record,
      this.deps.agentActivity.get(record.id),
      this.theme,
      result => this.done(result),
      () => {
        if (this.deps.manager.abort(record.id)) {
          this.deps.notify?.(`Stopped "${record.description}".`, "info");
        }
      },
      this.keybindings as ViewerKeybindings | undefined,
      message => this.deps.manager.steer(record.id, message),
      this.deps.showCost,
      this.deps.viewerMarkdown,
      this.deps.onViewerMarkdown,
      this.deps.scrollbarMode?.() ?? "auto",
      this.deps.backgroundAction?.(record, message => this.deps.notify?.(message, "info")),
      {
        // The page's frame draws the identity block and the footer band, so
        // the viewer contributes body rows only — one identity block per pane.
        identity: false,
        footer: false,
        viewportRows: () => this.viewerRows,
        onBack: () => this.popPage(),
        backHint: () => "↑↓ scroll · esc back · f full",
        scrollHint: () => "PgUp/PgDn · Shift+↑↓ · j/k scroll",
        frameless: () => true,
        onUnhandledKey: data => this.pageUnhandledKey(data),
        uiStyle: () => this.effectiveStyle(),
      },
    );
    return this.viewer;
  }

  /** The viewer keys that belong to the PAGE, not to the viewer. */
  private pageUnhandledKey(data: string): boolean {
    // Anything but the stop key disarms a pending stop — the viewer hands
    // every key it sees through here first, so this covers its own scrolling
    // keys too, which the hub never sees again.
    if (!matchesKey(data, "k") && !matchesKey(data, "x") && this.stopArmed) this.stopArmed = false;
    if (matchesKey(data, "l")) { this.pushLogPage(); return true; }
    if (matchesKey(data, "f")) { this.requestToggle(); return true; }
    if (matchesKey(data, "c")) { this.copyFocusedResult(); return true; }
    if (matchesKey(data, "p")) { this.pauseResumeFocused(); return true; }
    if (this.page === "WA" && matchesKey(data, "s")) { this.runAgentKey("skip"); return true; }
    if (this.page === "WA" && matchesKey(data, "r")) { this.runAgentKey("retry"); return true; }
    if (matchesKey(data, "k") || matchesKey(data, "x")) { this.stopFocused(); return true; }
    return false;
  }

  /** A run-agent key, gated the way the inspector gated skip/retry. */
  private runAgentKey(kind: "skip" | "retry"): void {
    const actions = this.runAgentActionKeys();
    if (kind === "skip" ? actions.skip : actions.retry) {
      if (kind === "skip") this.skipRunAgent();
      else this.retryRunAgent();
    }
  }

  /** One step in the run's agent list — `WA`'s left pane. */
  private moveRunSelection(delta: 1 | -1): void {
    if (this.runAgents().length === 0) return;
    const next = Math.min(this.runAgents().length - 1, Math.max(0, this.clampRunAgentIndex() + delta));
    if (next === this.runAgentSel) return;
    this.runAgentSel = next;
    // A new agent is a new page subject: the viewer rebuilds on the next
    // render, and an armed stop must not carry over to it.
    this.stopArmed = false;
    if (this.page === "WA") this.focusId = undefined;
    this.requestRender();
  }

  /**
   * One step in **W**'s item sequence — the phases, then the run's agents.
   * Leaving the phases for the agents also moves the agent cursor, since that
   * is the row `⏎` opens and the pages below remember.
   */
  private moveRunItem(delta: 1 | -1): void {
    const groups = this.pageGroups();
    const entries = this.runAgents();
    const length = groups.length + entries.length;
    if (length === 0) return;
    const next = Math.min(length - 1, Math.max(0, this.clampRunItemIndex(groups, entries) + delta));
    if (next === this.runItemSel) return;
    this.runItemSel = next;
    if (next >= groups.length) this.runAgentSel = next - groups.length;
    this.stopArmed = false;
    this.requestRender();
  }

  /** `s`: stop the run the cursor is on (workflow rows only — refusal rules). */
  private stopRun(): void {
    const run = this.page === "W" || this.page === "L" ? this.currentRun() : this.entries()[this.selected]?.kind === "workflow" ? (this.entries()[this.selected] as { workflow: FleetWorkflow }).workflow : undefined;
    if (!run || (run.status !== "running" && run.status !== "paused")) return;
    this.runId = run.id;
    if (this.deps.stopWorkflow?.(run.id)) {
      this.deps.notify?.(`Stopped workflow "${run.name}".`, "info");
    }
    this.requestRender();
  }

  /**
   * The log pages' keys: scroll, copy, pause, stop the focused agent, stop the
   * run, expand, back. `k` stays scroll-up here (the roster and transcript
   * pages are where it aliases `x`); any other key disarms a pending stop.
   */
  private handleLogKey(data: string): boolean {
    const down = matchesKey(data, "down") || matchesKey(data, "j");
    const up = matchesKey(data, "up") || matchesKey(data, "k");
    if (down || up) { this.stopArmed = false; this.scrollLog(down ? 1 : -1); return true; }
    if (matchesKey(data, "c")) { this.stopArmed = false; this.copyFocusedResult(); return true; }
    if (matchesKey(data, "p")) { this.stopArmed = false; this.pauseResumeFocused(); return true; }
    if (matchesKey(data, "s") && this.page === "L") { this.stopArmed = false; this.stopRun(); return true; }
    if (matchesKey(data, "x") && (this.page === "SL" || this.page === "SAL")) { this.stopFocused(); return true; }
    if (matchesKey(data, "f")) { this.stopArmed = false; this.requestToggle(); return true; }
    if (matchesKey(data, "escape") || matchesKey(data, "q")) { this.stopArmed = false; this.popPage(); return true; }
    return false;
  }

  /** `⏎` at the page level: `R` opens the selected run, `W` its agent page. */
  private enterPage(items: HubEntry[]): void {
    this.stopArmed = false;
    if (this.page === "R") {
      const entry = items[this.selected];
      if (entry?.kind === "workflow") {
        this.runId = entry.workflow.id;
        this.runAgentSel = 0;
        // D8: both marks start where the run is — the state mark on the
        // current phase and the item cursor on that same phase row.
        this.runItemSel = currentPhaseIndex(this.runGroups(entry.workflow.id));
        this.page = "W";
        this.requestRender();
        return;
      }
      // An agent row descends nowhere: the roster page's pane is already the
      // conversation. The stacked twin has one column, so there `⏎` pushes
      // that pane as a full-width page — a view state `esc` pops.
      if (this.stackedMode() && (entry?.kind === "agent" || this.focusedRecord())) {
        this.detailOpen = true;
        this.requestRender();
      }
      return;
    }
    if (this.page === "W") {
      const record = this.selectedItemRecord();
      if (!record?.session) {
        this.deps.notify?.("That agent has no conversation to open.", "info");
        return;
      }
      // WA's subject is the run's agent cursor: make it the agent the item
      // cursor addressed — the row it sits on, or the phase row's first
      // agent — so the page opens what ⏎ promised.
      const index = this.itemAgentIndex();
      if (index !== undefined) this.runAgentSel = index;
      this.page = "WA";
      this.requestRender();
    }
  }

  /** `esc`: exactly one nesting level up — or out of the stacked twin's pushed pane. */
  private popPage(): void {
    if (this.page === "R" && this.detailOpen) {
      this.detailOpen = false;
      this.stopArmed = false;
      this.requestRender();
      return;
    }
    if (this.page === "R") { this.close(); return; }
    const from = this.page;
    this.page = PAGE_PARENT[from]!;
    this.logScroll = 0;
    this.stopArmed = false;
    // Back on the roster the pointer is what the right pane follows; deeper, the
    // pinned record stays the page's subject.
    if (this.page === "R") {
      this.focusId = this.rosterRecordForCurrent()?.id;
    }
    if (this.page === "W") {
      // The item cursor follows the agent WA was showing, so the ❯ the run
      // page draws is the row ⏎ would reopen.
      this.runItemSel = this.pageGroups().length + this.clampRunAgentIndex();
    }
    this.requestRender();
  }

  /** The record a page is showing — the page's focus, whatever the roster cursor does. */
  private focusedRecord(): AgentRecord | undefined {
    const fresh = (id: string | undefined) => (id === undefined ? undefined : this.deps.manager.listAgents().find(a => a.id === id));
    if (this.page === "R") {
      // The seeded subject (kept in step by ↑↓, cleared on run rows) is the
      // pane's subject — a swept record the window was opened on by id keeps
      // its identity and note even though no row addresses it; the cursor's
      // row stands in only when nothing was seeded.
      const entry = this.entries()[this.selected];
      return fresh(this.focusId) ?? (entry?.kind === "agent" ? fresh(entry.record.id) ?? entry.record : undefined);
    }
    if (this.page === "SL") return fresh(this.focusId);
    if (this.page === "WA" || this.page === "SAL") return this.selectedRunRecord();
    // W / L: the run's most recently active agent — the subject the run pages'
    // copy and pause keys act on (nothing here is a page's own identity).
    const source = this.runSource() ?? EMPTY_RUN_SOURCE;
    const entries = flattenRunAgents(source.progress, source.meta?.phases);
    const live = entries.filter(e => {
      const state = displayState(e, source.task.status);
      return state === "running" || state === "paused";
    });
    return fresh((live.at(-1) ?? entries.at(-1))?.recordId);
  }

  /** The roster row under the cursor, when it is an agent. */
  private rosterRecordForCurrent(): AgentRecord | undefined {
    const entry = this.entries()[this.selected];
    if (entry?.kind !== "agent") return undefined;
    return this.deps.manager.listAgents().find(a => a.id === entry.record.id) ?? entry.record;
  }

  /** The run the page is on, live. */
  private currentRun(): FleetWorkflow | undefined {
    if (this.runId === undefined) return undefined;
    const roster = this.workflows().find(w => w.id === this.runId);
    if (roster) return roster;
    // The menu can still open a run that left the roster (finished long
    // ago): rebuild its row facts from the task so W keeps its name, state
    // glyph and frozen clock instead of drawing an empty identity.
    const source = this.runSource();
    if (!source) return undefined;
    const agents = flattenRunAgents(source.progress, source.meta?.phases);
    return {
      id: this.runId,
      name: source.task.workflowName ?? this.runId,
      status: source.task.status,
      doneCount: agents.filter(a => a.state === "done").length,
      totalCount: source.agentCount ?? agents.length,
      startedAt: source.task.startTime,
      completedAt: source.task.endTime,
      tokens: 0,
    };
  }

  /** The run's detail source — the named run's, or the current page's. */
  private runSource(id?: string): WorkflowDialogSource | undefined {
    const runId = id ?? this.runId;
    return runId === undefined ? undefined : this.deps.workflowRun?.(runId);
  }

  private clampRunAgentIndex(): number {
    const max = Math.max(0, this.runAgents().length - 1);
    this.runAgentSel = Math.min(Math.max(0, this.runAgentSel), max);
    return this.runAgentSel;
  }

  /** The phase groups of the page's run, live. */
  private pageGroups(): PhaseGroup[] {
    const source = this.runSource() ?? EMPTY_RUN_SOURCE;
    return buildPhaseGroups(source.progress, source.meta?.phases);
  }

  /** Clamp **W**'s item cursor into `phases ++ agents`. */
  private clampRunItemIndex(
    groups: readonly PhaseGroup[] = this.pageGroups(),
    entries: readonly WorkflowAgentEntry[] = this.runAgents(),
  ): number {
    const max = Math.max(0, groups.length + entries.length - 1);
    this.runItemSel = Math.min(Math.max(0, this.runItemSel), max);
    return this.runItemSel;
  }

  /**
   * The agent **W**'s item cursor addresses, as an index into the run's
   * flattened agents: the row itself on an agent row, and on a phase row the
   * first agent of that phase (nothing, when the phase has none).
   */
  private itemAgentIndex(): number | undefined {
    const groups = this.pageGroups();
    const entries = this.runAgents();
    const item = this.clampRunItemIndex(groups, entries);
    if (item >= groups.length) return item - groups.length < entries.length ? item - groups.length : undefined;
    if (groups[item].agents.length === 0) return undefined;
    let offset = 0;
    for (let i = 0; i < item; i++) offset += groups[i].agents.length;
    return offset;
  }

  /** The record **W**'s item cursor opens. */
  private selectedItemRecord(): AgentRecord | undefined {
    const index = this.itemAgentIndex();
    const recordId = index === undefined ? undefined : this.runAgents()[index]?.recordId;
    return recordId === undefined ? undefined : this.deps.manager.listAgents().find(a => a.id === recordId);
  }

  /** The run's agents, flattened across phases, in run order. */
  private runAgents(): readonly WorkflowAgentEntry[] {
    const source = this.runSource() ?? EMPTY_RUN_SOURCE;
    return flattenRunAgents(source.progress, source.meta?.phases);
  }

  /** The record behind the run's selected agent row. */
  private selectedRunRecord(): AgentRecord | undefined {
    const recordId = this.runAgents()[this.clampRunAgentIndex()]?.recordId;
    return recordId === undefined ? undefined : this.deps.manager.listAgents().find(a => a.id === recordId);
  }

  /** `l`: to the log page one level below the current one (an agent row opens SL). */
  private pushLogPage(): void {
    if (this.page === "R") {
      // A run row has no agent log — its detail is the run page, opened with ⏎.
      if (!this.transcriptPage()) return;
      const record = this.focusedRecord();
      if (!record) return;
      this.focusId = record.id;
      this.page = "SL";
    } else if (this.page === "WA") {
      this.page = "SAL";
    } else if (this.page === "W") {
      this.page = "L";
    } else {
      return;
    }
    // Entering a log page is navigation: the armed stop must not survive it.
    this.stopArmed = false;
    // Log pages open at the newest events; the first render clamps the
    // seed down to the tail window.
    this.logScroll = LOG_TAIL;
    this.requestRender();
  }

  private copyFocusedResult(): void {
    const record = this.focusedRecord();
    if (record) copyRecordResult(record, (message, type) => this.deps.notify?.(message, type));
  }

  private pauseResumeFocused(): void {
    const record = this.focusedRecord();
    if (record) this.pauseResumeAgent(record);
  }

  /**
   * `x` on a page showing one agent — **R** and **WA** (the transcript pages),
   * **SL** and **SAL** (the logs): two-press, exactly like the roster's
   * `stopSelected` — the first press arms and the band says `x again to STOP`,
   * the second aborts. Any other key disarms (see `pageUnhandledKey` and
   * `handleLogKey`).
   */
  private stopFocused(): void {
    const record = this.focusedRecord();
    if (!record || (record.status !== "running" && record.status !== "queued")) return;
    if (!this.stopArmed) {
      this.stopArmed = true;
      this.requestRender();
      return;
    }
    this.stopArmed = false;
    if (this.deps.manager.abort(record.id)) {
      this.deps.notify?.(`Stopped "${record.description}".`, "info");
    }
    this.requestRender();
  }

  /** One scroll step inside a log page, clamped at the ends. */
  private scrollLog(delta: number): void {
    this.logScroll = Math.max(0, this.logScroll + delta);
    this.requestRender();
  }

  /**
   * The window of log lines the pane shows, from `offset` toward the tail —
   * and the readout the band reports for it, which is exactly this window.
   */
  private scrollTail(lines: readonly WorkflowCardLine[], offset: number, rows: number): WorkflowCardLine[] {
    const max = Math.max(0, lines.length - rows);
    const start = Math.max(0, Math.min(offset, max));
    // Re-anchor a tail seed (or an offset gone stale after a resize).
    if (offset > max) this.logScroll = start;
    this.logReadout = {
      lines: lines.length,
      percent: lines.length <= rows ? 100 : Math.round(((start + rows) / lines.length) * 100),
    };
    return lines.slice(start, start + rows);
  }

  /**
   * One roster row: the cursor, the state glyph and the name, plus a run row's
   * `<done>/<total>` counter flush right. Identity only: the master cell is 18
   * columns, so a description, live activity or stats tail could never survive
   * here — the detail pane's header and preview carry them.
   */
  private renderEntry(entry: HubEntry, selected: boolean, width: number): string {
    const th = this.theme;
    const marker = selected ? th.fg("accent", "❯") : " ";
    if (entry.kind === "workflow") {
      const wf = entry.workflow;
      const glyph = workflowStatusGlyph(wf.status, th);
      const name = selected ? th.fg("text", wf.name) : th.fg("muted", wf.name);
      // The counter is the run row's one datum: it is measured first and the
      // name truncates into the columns left of it, so the counter is never
      // the side that gets cut.
      const counter = `${wf.doneCount}/${wf.totalCount}`;
      const prefix = `${marker} ${glyph} `;
      return finishRow(
        `${prefix}${name}`,
        visibleWidth(prefix),
        selected ? th.fg("text", counter) : th.fg("dim", counter),
        width,
      );
    }
    const record = entry.record;
    const glyph = statusGlyph(record.status, th);
    const name = renderAgentRecordName(record, th, selected
      ? { fallbackColor: "text", bold: true }
      : { fallbackColor: "muted" });
    // Clamp here rather than in the caller's clampLine overflow path, which
    // strips the row's colors when a long collision handle overflows the cell.
    return truncateToWidth(`${marker} ${glyph} ${name}`, width, "…");
  }

  private renderActivity(bodyRows: number): WindowRow[] {
    const th = this.theme;
    const lines: WindowRow[] = [];
    // This view keeps its legacy lifecycle order (active → completed →
    // failed); the roster itself is launch-stable, so re-rank agents here only.
    const items = [...this.entries()].sort((a, b) => {
      if (a.kind !== "agent" || b.kind !== "agent") return 0;
      return lifecycleRank(a.record.status) - lifecycleRank(b.record.status)
        || a.record.startedAt - b.record.startedAt;
    });
    if (items.length === 0) {
      lines.push(fullRow(th.fg("dim", "(nothing running)")));
      return lines;
    }
    for (let i = 0; i < bodyRows; i++) {
      const entry = items[i];
      if (!entry) { lines.push(fullRow("")); continue; }
      if (entry.kind === "workflow") {
        const wf = entry.workflow;
        lines.push(fullRow(
          `${th.fg("muted", "workflow")} ${wf.name}  ${th.fg("dim", `${wf.doneCount}/${wf.totalCount} agents · ${wf.status}`)}`,
        ));
        continue;
      }
      const record = entry.record;
      const act = this.deps.agentActivity.get(record.id);
      const doing = act
        ? describeActivity(act.activeTools, act.responseText)
        : record.status === "running" ? "thinking…" : record.status;
      const turns = act?.maxTurns ? ` · turn ${act.turnCount}/${act.maxTurns}` : act ? ` · turn ${act.turnCount}` : "";
      const line = `${statusGlyph(record.status, th)} ${renderAgentRecordName(record, th, {})}  ${th.fg(record.status === "running" ? "text" : "dim", doing)}${th.fg("dim", turns)}`;
      lines.push(fullRow(line));
    }
    return lines;
  }

}

/** One full-width window row, from content this surface has already shaped. */
function fullRow(text: string): WindowRow {
  return { kind: "full", cells: [{ text }] };
}

/** `HH:MM:SS` — the log pages' event rows are timestamps first. */
function stamp(ms: number): string {
  return new Date(ms).toTimeString().slice(0, 8);
}

/** A run source with nothing in it, for pages whose run has been swept. */
const EMPTY_RUN_SOURCE: WorkflowDialogSource = {
  progress: [],
  task: { status: "completed", startTime: 0 },
  agentCount: 0,
};

/** The inspector's empty-agents copy, so both surfaces say it the same way. */
const WORKFLOW_NO_AGENTS = "No agents";

/** A pane's lines, cut or padded to the body height so both cells stay level. */
function padLines(lines: readonly PaneRow[], rows: number): PaneRow[] {
  const out = lines.slice(0, rows);
  while (out.length < rows) out.push([]);
  return out;
}

/**
 * Paint the shared window's cells with this surface's theme. Content the
 * surface styled itself arrives as a colourless cell and passes through
 * untouched; the bars, rules and labels the window contributes arrive with a
 * role colour and are painted here. Styling only — the layout is the window's.
 */
function paintWindow(lines: readonly WorkflowCardLine[], th: Theme, uiStyle?: UIStyle): string[] {
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
function finishRow(left: string, minWidth: number, right: string, width: number): string {
  const rightW = visibleWidth(right);
  const maxLeft = Math.max(minWidth, width - rightW - 1);
  const leftClamped = truncateToWidth(left, maxLeft, "…");
  const gap = Math.max(1, width - visibleWidth(leftClamped) - rightW);
  return truncateToWidth(leftClamped + " ".repeat(gap) + right, width);
}
