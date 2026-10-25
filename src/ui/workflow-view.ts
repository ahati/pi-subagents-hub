/**
 * workflow-view.ts — the run/agent row vocabulary shared by the hub's run pages.
 *
 * This is what survives of the retired `/agents → Workflows` inspector
 * (`WorkflowDialog`): the pieces the hub's **W** and **WA** pages read. The window
 * itself is gone — every path that opened it opens the agent hub on page **W**
 * instead — so nothing here draws a frame, routes a key or talks to the
 * runtime. The hub composes these rows into its own panes.
 *
 * Two builders, one source: `phaseListRows` draws a run's phase plan (the
 * finished phases carry a tick, the unfinished ones their number) and
 * `agentRow` draws one of the run's agents in whichever list holds it — the
 * same rows the inspector's panes drew, so the hub does not re-derive them.
 *
 * **The glyphs are not the card's glyphs.** `workflow-card.ts` keys off the raw
 * entry `state`; these rows key off the *derived* `displayState(entry, runStatus)`
 * and split cases the card cannot see — skipped, blocked, queued and
 * interrupted all render as a plain `✗` or `⟳` inline but are distinct here,
 * and a row of a parked run reads `‖` where the card draws a live spinner.
 * `◌` (U+25CC) appears only in this file, and a running row animates a spinner
 * where the card draws a static `⟳`.
 */

import { visibleWidth } from "@earendil-works/pi-tui";
import type { WorkflowMeta } from "../workflow/meta.js";
import {
  displayState,
  formatDuration,
  type PhaseGroup,
  type WorkflowAgentEntry,
  type WorkflowDisplayState,
  type WorkflowEntry,
  type WorkflowRunStatus,
} from "../workflow/progress.js";
import { SPINNER } from "./agent-widget.js";
import { windowRange } from "./window-frame.js";
import {
  clampLine,
  formatCompactTokens,
  formatModel,
  REPLAYED_ANNOTATION,
  type WorkflowCardColor,
  type WorkflowCardLine,
  type WorkflowCardSegment,
  type WorkflowCardTask,
} from "./workflow-card.js";

/** Everything the hub reads about a run, so its run pages can be driven from a stub. */
export interface WorkflowDialogSource {
  progress: readonly WorkflowEntry[];
  task: WorkflowCardTask;
  meta?: WorkflowMeta;
  /** Agents the runtime has scheduled, which can exceed those that reported. */
  agentCount?: number;
}

/* ------------------------------------------------------------------------- *
 * Glyphs
 * ------------------------------------------------------------------------- */

export interface WorkflowDialogGlyphs {
  tick: string;
  cross: string;
  /** `◌` — queued or interrupted. The card has no row that draws this. */
  queued: string;
  /** `‖` — a live row of a parked run, the roster's pause mark. */
  paused: string;
  /** `figures.pointer` — the selected row in either pane. */
  pointer: string;
  /** Running rows cycle these. */
  spinner: readonly string[];
}

export const UNICODE_DIALOG_GLYPHS: WorkflowDialogGlyphs = {
  // The tick and the cross are the hub roster's `✓`/`✗` — one lifecycle
  // vocabulary across the pages; the pause mark is the roster's `‖` for the
  // same reason. The spinner and `◌` stay this module's: a running row
  // animates here and the hub has no roster row that draws `◌`.
  tick: "✓",
  cross: "✗",
  queued: "◌",
  paused: "‖",
  pointer: "❯",
  spinner: SPINNER,
};

/**
 * The recovered dialog mapping — keyed on the *display* state.
 *
 * Claude Code's `permission` colour has no pi equivalent; a blocked agent is
 * waiting on the user, so it maps to `warning` (selection maps to `accent`).
 */
export function dialogRowGlyph(
  state: WorkflowDisplayState,
  glyphs: WorkflowDialogGlyphs,
  spinnerFrame = 0,
): WorkflowCardSegment {
  switch (state) {
    case "done":
      return { text: glyphs.tick, color: "success" };
    case "failed":
      return { text: glyphs.cross, color: "error" };
    case "skipped":
      return { text: glyphs.cross, color: "dim" };
    case "blocked":
      return { text: glyphs.cross, color: "warning" };
    case "queued":
    case "interrupted":
      return { text: glyphs.queued, color: "dim" };
    case "paused":
      return { text: glyphs.paused, color: "dim" };
    case "running":
      return { text: glyphs.spinner[spinnerFrame % glyphs.spinner.length], color: "dim" };
  }
}

/* ------------------------------------------------------------------------- *
 * Row pieces
 * ------------------------------------------------------------------------- */

/**
 * The `·`-separated annotations between an agent's label and its stats.
 *
 * These say *why* a row looks the way it does — a retry and its cause, a cache
 * hit replayed from the resume journal, how long a queued agent has been
 * waiting. The stat tail (agentType, model, tokens, tool calls, duration) is the
 * card's and is appended after.
 */
export function subStatusAnnotations(
  entry: WorkflowAgentEntry,
  state: WorkflowDisplayState,
  now: number,
): string[] {
  const parts: string[] = [];
  if (entry.isolation) parts.push(entry.isolation);
  if (entry.cached) parts.push(REPLAYED_ANNOTATION);
  if (entry.lastAttemptReason) {
    parts.push(entry.lastAttemptReason === "user-retry" ? "user retry" : entry.lastAttemptReason);
  }
  if (entry.attempt != null && entry.attempt > 1) parts.push(`attempt ${entry.attempt}`);
  if (state === "paused") parts.push("run paused");
  if (
    (state === "queued" || state === "paused") &&
    entry.queuedAt != null &&
    entry.startedAt == null
  ) {
    parts.push(`waiting ${formatDuration(Math.max(0, now - entry.queuedAt))}`);
  }
  return parts;
}

const lineWidth = (line: WorkflowCardLine) => line.reduce((sum, s) => sum + visibleWidth(s.text), 0);

/** Place `right` flush to `width`, cutting `left` first so the stats survive. */
function rightAlign(left: WorkflowCardLine, right: WorkflowCardLine, width: number): WorkflowCardLine {
  const rightWidth = lineWidth(right);
  const clampedLeft = clampLine(left, Math.max(0, width - rightWidth - 1));
  const gap = Math.max(1, width - lineWidth(clampedLeft) - rightWidth);
  return clampLine([...clampedLeft, { text: " ".repeat(gap) }, ...right], width);
}

/**
 * The phases pane's rows: one per group, windowed around the selection, with a
 * finished phase showing its tick and an unfinished one its number.
 *
 * Shared by the hub's run page (**W**) and its run preview: one builder, one
 * surface family, no drift.
 */
export function phaseListRows(options: {
  groups: readonly PhaseGroup[];
  /** The state mark: the phase the run is on. */
  selectedPhase: number;
  /**
   * The item cursor's phase row, when the cursor is on a phase — **W**'s
   * flattened phases+agents walk. Where it coincides with the state mark the
   * row still carries one `❯`: they are two reasons for the same glyph.
   */
  cursor?: number;
  capacity: number;
  width: number;
  glyphs: WorkflowDialogGlyphs;
}): WorkflowCardLine[] {
  const { groups, selectedPhase, cursor, capacity, width, glyphs } = options;
  const rows: WorkflowCardLine[] = [];
  const digits = String(groups.length).length;
  const visible = windowRange(cursor ?? selectedPhase, groups.length, capacity);
  for (let i = visible.start; i < Math.min(visible.end, groups.length); i++) {
    const group = groups[i];
    const selected = i === selectedPhase || i === cursor;
    const color: WorkflowCardColor =
      selected ? "accent"
      : group.status === "done" ? "success"
      : group.status === "failed" ? "error"
      : "dim";
    // An unfinished phase shows its number where a finished one shows a glyph —
    // so the list doubles as a numbered plan of the run.
    const glyph =
      group.status === "done" ? glyphs.tick
      : group.status === "failed" ? glyphs.cross
      : String(i + 1);
    rows.push(
      rightAlign(
        [
          { text: " " },
          { text: selected ? glyphs.pointer : " ", color: "accent" },
          { text: " " },
          { text: glyph.padStart(digits), color },
          { text: " " },
          { text: group.title, color },
        ],
        group.totalCount === 0 ? [{ text: "— ", color: "dim" }] : [{ text: `${group.doneCount}/${group.totalCount} `, color }],
        width,
      ),
    );
  }
  return rows;
}

/**
 * The agent list's visible slice, windowed in **rendered rows** rather than
 * entries: a live agent spends two lines (its `↳` tail), so an entry count
 * window overflows the pane and `padLines` silently cuts the list's bottom —
 * the cursor row with it. The slice here is derived from each entry's row
 * cost, keeps the selection's rows fully visible, and follows the tail when
 * no agent is under the cursor (the phase rows), so agents a run schedules
 * late scroll in as they appear.
 */
export function agentEntryWindow(options: {
  entries: readonly WorkflowAgentEntry[];
  /** Rendered lines an entry spends — the wide pane's live tail makes two. */
  rowsOf(entry: WorkflowAgentEntry, index: number): number;
  /** The entry the cursor sits on; undefined follows the tail. */
  selection: number | undefined;
  capacity: number;
}): { start: number; end: number } {
  const { entries, rowsOf } = options;
  const capacity = Math.max(1, options.capacity);
  if (entries.length === 0) return { start: 0, end: 0 };
  const rows = entries.map(rowsOf);
  const total = rows.reduce((sum, n) => sum + n, 0);
  if (total <= capacity) return { start: 0, end: entries.length };
  /** Rows above each entry's head line. */
  const head: number[] = [];
  let above = 0;
  for (const n of rows) {
    head.push(above);
    above += n;
  }
  let startRow: number;
  const selection = options.selection;
  if (selection === undefined || selection >= entries.length) {
    startRow = total - capacity;
  } else {
    // Center the selection's own rows — `windowRange`'s rule, one level down —
    // clamped so the head line always survives even a one-row pane.
    const selHead = head[selection];
    startRow = Math.max(0, Math.min(
      selHead - Math.floor((capacity - rows[selection]) / 2),
      total - capacity,
      selHead,
    ));
  }
  // Whole entries only: skip the one straddling the window's top, cut before
  // the one that would straddle its bottom. A head at or after `startRow`
  // never splits, and the selection's head is past the top by the clamp.
  let start = head.findIndex(h => h >= startRow);
  if (start < 0) start = entries.length - 1;
  let end = start;
  let used = 0;
  while (end < entries.length && used + rows[end] <= capacity) {
    used += rows[end];
    end++;
  }
  return { start, end };
}

/**
 * Which of the per-agent actions the selected row can currently take.
 *
 * The window for both is the one in which the agent's `agent()` call is still
 * unanswered — through a park too: the run holds new launches behind its gate
 * but leaves running children alive, and both keys stay meaningful on a live
 * child. Skip covers that whole window; retry needs a child to stop and start
 * again, so it begins only once one exists — a queued row has none. Once the
 * call has settled its value is already the script's, and there is nothing
 * either key could change.
 */
export function agentActions(entry: WorkflowAgentEntry | undefined, runStatus: WorkflowRunStatus): { skip: boolean; retry: boolean } {
  if (entry === undefined || (runStatus !== "running" && runStatus !== "paused")) {
    return { skip: false, retry: false };
  }
  if (entry.state === "done" || entry.state === "error") return { skip: false, retry: false };
  return { skip: true, retry: entry.startedAt != null || entry.queuedAt === undefined };
}

/** The row for one agent, as it appears in whichever pane is listing agents. */
export function agentRow(options: {
  entry: WorkflowAgentEntry;
  selected: boolean;
  compact: boolean;
  width: number;
  glyphs: WorkflowDialogGlyphs;
  runStatus: WorkflowRunStatus;
  spinnerFrame: number;
  now: number;
  /** Live facts for a running agent with a record: shown on the wide panes. */
  live?: { turns?: number; tokens?: number; tail?: string };
}): WorkflowCardLine[] {
  const { entry, selected, glyphs, width } = options;
  const display = displayState(entry, options.runStatus);
  const head: WorkflowCardLine = [
    { text: " " },
    { text: selected ? glyphs.pointer : " ", color: "accent" },
    { text: " " },
    dialogRowGlyph(display, glyphs, options.spinnerFrame),
    { text: " " },
    { text: entry.label, color: selected ? "accent" : undefined },
  ];
  // The narrow pane holds the label and nothing else; there is no room for a
  // stat tail, and clamping one would just spend columns on a truncated word.
  if (options.compact) return [clampLine(head, width)];

  const model = formatModel(entry);
  if (model) head.push({ text: ` ${model}`, color: "dim" });
  for (const part of [...subStatusAnnotations(entry, display, options.now), ...rowStatSegments(entry)]) {
    head.push({ text: " · ", color: "dim" }, { text: part, color: "dim" });
  }
  // The duration sits flush right, so a column of rows reads as a column of
  // durations rather than as ragged text. A running agent's live turn count
  // and tokens ride the same right-aligned block.
  const live = options.live;
  const parts: string[] = [];
  if (live?.turns !== undefined && live.turns > 0) parts.push(`turn ${live.turns}`);
  if (live?.tokens) parts.push(`${formatCompactTokens(live.tokens)} tok`);
  if (entry.durationMs) parts.push(formatDuration(entry.durationMs));
  else if (live && entry.startedAt != null && options.now > entry.startedAt) {
    // A running agent's clock is still going: settled rows carry durationMs,
    // live ones derive it from their start.
    parts.push(formatDuration(options.now - entry.startedAt));
  }
  const tail: WorkflowCardLine = parts.length > 0 ? [{ text: `${parts.join(" · ")} `, color: "dim" }] : [];
  const headRow = tail.length > 0 ? rightAlign(head, tail, width) : clampLine(head, width);
  // The live tail's last output line, one dim line under the head — a `↳`
  // continuation of the row, the same glyph the identity block uses.
  if (!live?.tail) return [headRow];
  return [headRow, clampLine([{ text: "      ↳ ", color: "dim" }, { text: live.tail, color: "dim" }], width)];
}

/** The agent row's dot-separated tail. The model is not in it — it leads. */
function rowStatSegments(entry: WorkflowAgentEntry): string[] {
  return entry.tokens ? [`${formatCompactTokens(entry.tokens)} tok`] : [];
}
