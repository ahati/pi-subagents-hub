/**
 * window-frame.ts — the window chrome the agent hub draws
 * (`agent-hub.ts`, roster and chat pane).
 *
 * A `╭───╮` / `╰───╯` box, content rows
 * `│ content │`, and a two-pane split whose three bars partition the width
 * exactly. The arithmetic used to live in four hand-rolled copies — the hub's
 * roster strings, its chat pane, and the retired inspector's segment and log
 * paths — so it drifted silently. This module is that arithmetic, once:
 *
 * - {@link paneRightWidth} is the bar-partition invariant
 *   (`│` + cell + `│` + cell + `│` = width).
 * - {@link frameEdge} and {@link frameRow} are the window's edges and its
 *   padded content row.
 * - {@link footerBand} is the two-slot band: the readout and the page's
 *   actions on the left, navigation and keys with the escape anchor on the
 *   right, fitted whole-hint by whole-hint.
 * - {@link paneBodyHeight} is the height basis, in viewport percent.
 * - {@link paneRule} is the titled rule between the panes: `├ ─ Phases ─┬─ …
 *   ─┤`, whose cells fill their pane widths the way the rows do.
 * - {@link paneGeometry} and {@link renderWindow} are the window itself: the
 *   split the hub's ` Agents ` pane established, and the row assembly (edges,
 *   full-width rows, pane rows, titled rules, the band rule, seams) both
 *   surfaces render through. A surface contributes CONTENT — cells, hints,
 *   pane bodies — and the window decides where it goes. Neither overlay does
 *   column math.
 * - {@link windowRange} is the list windowing rule: the visible slice that
 *   keeps the selection centered and clamps at both ends.
 *
 * The hub gates on {@link TWO_PANE_MIN_WIDTH} and pins its list column.
 */

import { stripTerminalSequences, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { UIStyle } from "../types.js";
import { clampLine, type WorkflowCardLine, type WorkflowCardSegment } from "./workflow-card.js";

/** The bars that separate the cells of a two-pane row: `│ a │ b │`. */
export const FRAME_BARS = 3;

/**
 * Below this total width a surface drops its side pane rather than squeezing
 * both cells to unreadable. The hub's two-pane ladder uses it.
 */
export const TWO_PANE_MIN_WIDTH = 60;

/**
 * The box-drawing glyphs of the window. Both surfaces swap the whole set for
 * ASCII together, so no cell mixes tiers.
 */
export interface PaneBox {
  topLeft: string;
  topRight: string;
  bottomLeft: string;
  bottomRight: string;
  horizontal: string;
  vertical: string;
  topTee: string;
  bottomTee: string;
  /** The window's rule ends: `├` / `┤`. */
  leftTee: string;
  rightTee: string;
}

export const UNICODE_PANE_BOX: PaneBox = {
  topLeft: "╭",
  topRight: "╮",
  bottomLeft: "╰",
  bottomRight: "╯",
  horizontal: "─",
  vertical: "│",
  topTee: "┬",
  bottomTee: "┴",
  leftTee: "├",
  rightTee: "┤",
};

/** Native Pi style: edge-to-edge horizontal rules, clean tees, horizontal ends. */
export const PI_PANE_BOX: PaneBox = {
  topLeft: "─",
  topRight: "─",
  bottomLeft: "─",
  bottomRight: "─",
  horizontal: "─",
  vertical: "│",
  topTee: "┬",
  bottomTee: "┴",
  leftTee: "─",
  rightTee: "─",
};

/** The ASCII tier, one column per glyph so the bars stay aligned either way. */
export const ASCII_PANE_BOX: PaneBox = {
  topLeft: "+",
  topRight: "+",
  bottomLeft: "+",
  bottomRight: "+",
  horizontal: "-",
  vertical: "|",
  topTee: "+",
  bottomTee: "+",
  leftTee: "+",
  rightTee: "+",
};

/**
 * The right cell's width, given the left cell's.
 *
 * The invariant every pane row depends on: the three bars plus the two cells
 * total exactly `width`, with `pad` padding columns inside each cell. Both
 * callers derive the right cell from the left one rather than picking two
 * widths, which is what keeps the middle bar in one column across a
 * surface's levels.
 */
export function paneRightWidth(width: number, leftWidth: number, pad = 0): number {
  return Math.max(1, width - leftWidth - FRAME_BARS - 4 * pad);
}

/**
 * Inner width of a left pane that holds short labels.
 *
 * Fixed rather than proportional at usable sizes: the left cell holds a phase
 * title or an agent label and the right holds everything that needs room, so
 * a share of a wide terminal would only pad it. It gives way on a narrow one —
 * capped at a third of the cells so the right keeps twice as much, and at
 * `available - 1` so the right never loses its last column and the frame
 * cannot tear.
 */
export function leftPaneWidth(width: number, maxLeft = 18, pad = 0): number {
  const available = Math.max(2, width - FRAME_BARS - 4 * pad);
  return Math.max(1, Math.min(maxLeft, Math.floor(available / 3), available - 1));
}

/**
 * The window's top or bottom edge: `╭───╮` / `╰───╯` across the whole width.
 *
 * An optional `title` names the window in it — `╭ Agents & Workflows ─╮` — the
 * way {@link splitEdge} names the master pane. A single-pane window has no tee
 * to hang a title on, so the edge carries it instead.
 */
export function frameEdge(width: number, box: PaneBox, side: "top" | "bottom", title = ""): string {
  const left = side === "top" ? box.topLeft : box.bottomLeft;
  const right = side === "top" ? box.topRight : box.bottomRight;
  return `${left}${title}${box.horizontal.repeat(Math.max(0, width - 2 - visibleWidth(title)))}${right}`;
}

/**
 * A top or bottom edge with a tee where the two panes meet:
 * `╭ Agents ──┬────╮` / `╰──────────┴────╯`. `leftCellWidth` is the whole left
 * cell — padding included, so it matches what a pane row spends before its
 * bar — and an optional `leftCell` names the pane on the top edge; the rest of
 * both cells is rule.
 */
export function splitEdge(
  width: number,
  leftCellWidth: number,
  box: PaneBox,
  side: "top" | "bottom",
  leftCell = "",
): string {
  const [corner, tee, end] = side === "top"
    ? [box.topLeft, box.topTee, box.topRight]
    : [box.bottomLeft, box.bottomTee, box.bottomRight];
  const left = leftCellWidth - visibleWidth(leftCell);
  const right = Math.max(0, width - leftCellWidth - FRAME_BARS);
  return `${corner}${leftCell}${box.horizontal.repeat(Math.max(0, left))}${tee}${box.horizontal.repeat(right)}${end}`;
}

/**
 * The columns a full-width row has for content: the frame's bars and its one
 * padding column each side, removed once, here, rather than by each surface.
 */
export function windowInnerWidth(width: number): number {
  return Math.max(0, width - 4);
}

/**
 * One padded content row: `│ content │`, the content clamped to `width - 4`
 * so the bars stay in their columns and the row never wraps. `border` stylizes
 * the bars, which each surface does with its own theme.
 */
export function frameRow(
  width: number,
  content: string,
  box: PaneBox,
  border: (s: string) => string,
  ellipsis = "…",
): string {
  const inner = windowInnerWidth(width);
  const clamped = truncateToWidth(content, inner, ellipsis, true);
  const gap = Math.max(0, inner - visibleWidth(clamped));
  return `${border(box.vertical)} ${clamped}${" ".repeat(gap + 1)}${border(box.vertical)}`;
}

/**
 * One cell of a rule: ` Title ─────` — the three regions unstyled, so each
 * surface themes them its own way (the hub's panes want a segment per region).
 */
export interface RuleCell {
  /** The single column between the cell's bar and the title. */
  lead: string;
  /** The title, cut to the cell; absent when the cell carries no title. */
  title?: string;
  /** The space closing the title's region and the rule out to the cell width. */
  rule: string;
}

/**
 * Where a title's padding sits when the title has to be cut to fit:
 * `outside` cuts the title alone and keeps the space either side of it,
 * `inside` cuts ` title ` as one string, so a title that overruns eats its own
 * leading column. Both fill the cell exactly; the retired inspector's segment
 * levels did the first and its log level the second, and both are pinned
 * byte-for-byte by their tests.
 */
export type RuleTitlePadding = "outside" | "inside";

/** One titled cell, cut to `width` with the ellipsis rather than left to overrun. */
function titledRuleCell(width: number, title: string, box: PaneBox, ellipsis: string, padding: RuleTitlePadding): RuleCell {
  // A cell this narrow has room for neither title nor rule; the bar padding
  // alone is all that fits, and it is what the segment path used to clamp to.
  if (width <= 1) return { lead: " ".repeat(Math.max(0, width)), rule: "" };
  const measured = padding === "inside" ? ` ${title} ` : title;
  const shown = stripTerminalSequences(truncateToWidth(measured, width - 2, ellipsis));
  const tail = padding === "outside" ? 1 : 0;
  return {
    lead: " ",
    title: shown,
    rule: `${" ".repeat(tail)}${box.horizontal.repeat(Math.max(0, width - 1 - visibleWidth(shown) - tail))}`,
  };
}

/**
 * The window's rule with the panes' titles in it:
 * `├ ─ Phases ─┬─ Verify · 1 agent ─┤`.
 *
 * `├` and `┤` close the line and the cells fill their pane widths exactly, so
 * the bars stay in the columns the rows above and below put them in. The tee
 * where the cells meet is `┬` when either cell is titled and the pane `│` when
 * neither is — the shape the hub titles its master cell in.
 */
export function paneRule(options: {
  leftWidth: number;
  rightWidth: number;
  box: PaneBox;
  leftTitle?: string;
  rightTitle?: string;
  ellipsis?: string;
  titlePadding?: RuleTitlePadding;
}): { leftTee: string; left: RuleCell; tee: string; right: RuleCell; rightTee: string } {
  const { box, leftTitle, leftWidth, rightWidth } = options;
  const ellipsis = options.ellipsis ?? "…";
  const padding = options.titlePadding ?? "outside";
  const plain = (width: number): RuleCell => ({ lead: "", rule: box.horizontal.repeat(Math.max(0, width)) });
  if (leftTitle === undefined && options.rightTitle === undefined) {
    return { leftTee: box.leftTee, left: plain(leftWidth), tee: box.vertical, right: plain(rightWidth), rightTee: box.rightTee };
  }
  return {
    leftTee: box.leftTee,
    left: leftTitle === undefined ? plain(leftWidth) : titledRuleCell(leftWidth, leftTitle, box, ellipsis, padding),
    tee: box.topTee,
    right: options.rightTitle === undefined ? plain(rightWidth) : titledRuleCell(rightWidth, options.rightTitle, box, ellipsis, padding),
    rightTee: box.rightTee,
  };
}

/**
 * One hint of the footer band, with the tier it drops in.
 *
 * The band's left slot is the readout and the page's live actions, its right
 * slot navigation and the page's keys; the two are fitted as whole hints, and
 * the group says what goes first when they do not both fit. `pinned` marks a
 * hint the band keeps while anything else is left — the escape anchor.
 */
export interface FooterHint {
  text: string;
  group: "readout" | "action" | "hint";
  pinned?: boolean;
}

/**
 * The footer band, fitted to `width`: the left slot at the start, the right
 * slot flush to the last column, at least two columns between them.
 *
 * Hints drop whole — never cut — in the order the spec gives: the readout
 * first (it is the one hint the page can live without), then the left actions
 * right-to-left, then the right hints right-to-left, skipping any pinned
 * anchor. Only a single hint wider than the line is truncated.
 */
export function footerBand(options: {
  width: number;
  left?: readonly FooterHint[];
  right?: readonly FooterHint[];
  joiner?: string;
}): string {
  const width = Math.max(0, options.width);
  const joiner = options.joiner ?? " · ";
  const left = [...(options.left ?? [])];
  const right = [...(options.right ?? [])];
  const text = (hints: readonly FooterHint[]) => hints.map(hint => hint.text).join(joiner);
  const fits = () => {
    const l = text(left);
    const r = text(right);
    return visibleWidth(l) + visibleWidth(r) + (l !== "" && r !== "" ? 2 : 0) <= width;
  };
  while (!fits()) {
    const at = left.findIndex(hint => hint.group === "readout");
    if (at < 0) break;
    left.splice(at, 1);
  }
  while (!fits()) {
    const at = lastDroppable(left, hint => hint.group === "action");
    if (at < 0) break;
    left.splice(at, 1);
  }
  while (!fits()) {
    const at = lastDroppable(right, () => true);
    if (at < 0) break;
    right.splice(at, 1);
  }
  const l = text(left);
  const r = text(right);
  // The right slot is flush to the last column; the two slots keep at least
  // the two columns between them, and a slot on its own takes the whole line.
  const pad = Math.max(l !== "" && r !== "" ? 2 : 0, width - visibleWidth(l) - visibleWidth(r));
  const line = `${l}${" ".repeat(pad)}${r}`;
  return visibleWidth(line) > width ? truncateToWidth(line, width) : line;
}

/** The last hint of a slot the fitter may give up, or -1 when none is left. */
function lastDroppable(hints: readonly FooterHint[], match: (hint: FooterHint) => boolean): number {
  for (let i = hints.length - 1; i >= 0; i--) {
    if (!hints[i].pinned && match(hints[i])) return i;
  }
  return -1;
}

/**
 * The frame's reference chrome count for a window whose body falls under
 * `viewportPct` of the terminal: edges, header rows, rules and the footer.
 * The hub derives its own from the rows it draws (`HUB_CHROME_ROWS`), so
 * this is the pinned baseline {@link paneBodyHeight} is tested against, not a
 * live basis.
 */
export const WINDOW_CHROME_ROWS = 7;

/* ------------------------------------------------------------------------- *
 * The window component
 * ------------------------------------------------------------------------- */

/**
 * Content columns of the master (left) list cell — the hub's ` Agents ` pane.
 * Fixed, not proportional: the cell holds a name and the detail pane holds
 * everything that needs room.
 */
export const MASTER_LIST_WIDTH = 18;

/** One padding column inside each pane cell, so content reads clear of the bars. */
export const PANE_PADDING = 1;

/**
 * The split both overlays draw: one master cell, one detail cell, three bars.
 *
 * `listWidth` and `detailWidth` are the cells' *content* columns; each cell
 * adds `pad` columns either side, and {@link leftCellWidth} is the whole
 * master cell — which is where the top edge's tee and the middle bars land.
 * The invariant `1 + leftCellWidth + 1 + rightCellWidth + 1 = width` is
 * {@link paneRightWidth}'s, applied here rather than a second time.
 */
export interface PaneGeometry {
  /** Content columns of the master cell. */
  listWidth: number;
  /** Content columns of the detail cell. */
  detailWidth: number;
  /** The whole master cell: padding included. */
  leftCellWidth: number;
  /** The whole detail cell: padding included. */
  rightCellWidth: number;
  /** Padding columns inside each cell. */
  pad: number;
}

/**
 * The master/detail split at `width`. The hub takes its pane columns from
 * here, so the divider stays in one column across every window it draws.
 *
 * The master cell gives way on a narrow terminal the way {@link leftPaneWidth}
 * says: capped at a third of the cells, so the detail pane keeps twice the
 * room, and at least one column for itself. That is what stops a 12-column
 * window tearing when its two cells cannot both be full width.
 */
export function paneGeometry(width: number, listWidth = MASTER_LIST_WIDTH, pad = PANE_PADDING): PaneGeometry {
  return geometryForList(width, leftPaneWidth(width, listWidth, pad), pad);
}

/**
 * The hub's split: the master cell is pinned at {@link MASTER_LIST_WIDTH}
 * content columns at every two-pane width.
 *
 * The roster is identity — cursor, state glyph, name — so its cell is exactly
 * the 18 columns the spec gives it and the detail pane takes every column left
 * over. {@link paneGeometry}'s third-of-the-cells cap would shave the master to
 * 17 at 60 columns — the two-pane floor — before the two agree again from 61
 * up; that proportional policy
 * stays exported for the frame's own tests; nothing in src calls it.
 */
export function masterPaneGeometry(width: number, pad = PANE_PADDING): PaneGeometry {
  const available = Math.max(2, width - FRAME_BARS - 4 * pad);
  const list = Math.max(1, Math.min(MASTER_LIST_WIDTH, available - 1));
  return geometryForList(width, list, pad);
}

/** Both splits' cells, from the master cell's content columns. */
function geometryForList(width: number, list: number, pad: number): PaneGeometry {
  const leftCellWidth = list + 2 * pad;
  const rightCellWidth = paneRightWidth(width, list, pad) + 2 * pad;
  return { listWidth: list, detailWidth: rightCellWidth - 2 * pad, leftCellWidth, rightCellWidth, pad };
}

/**
 * One row of a window, as content: the surface says what, the window says
 * where. `full` spans the frame's inner width, `split` puts a master cell
 * beside a detail cell, `titles` is the rule that names them, `band` the rule
 * above the footer (whose `┴` the divider ends at), and `headerRule` the rule
 * the detail pane opens with — `left` carries on the master cell beside it,
 * since the panes flow independently.
 */
export type WindowRow =
  | { kind: "full"; cells: WorkflowCardLine }
  | { kind: "split"; left?: WorkflowCardLine; right?: WorkflowCardLine }
  | { kind: "headerRule"; left?: WorkflowCardLine }
  | { kind: "titles"; left?: string; right?: string; padding?: RuleTitlePadding }
  | { kind: "band" };

/** Measured width of a cell line. */
const lineWidth = (line: WorkflowCardLine) => line.reduce((sum, segment) => sum + visibleWidth(segment.text), 0);

/**
 * One pane cell, padded to `cellWidth` exactly: `pad` columns, the clamped
 * content, then the space that fills the rest. A cell is never wider than its
 * column and never narrower, which is what keeps the bars vertical.
 */
function paneCell(line: WorkflowCardLine | undefined, cellWidth: number, pad: number, ellipsis: string): WorkflowCardLine {
  const inner = Math.max(0, cellWidth - 2 * pad);
  const clamped = clampLine(line ?? [], inner, ellipsis);
  const gap = Math.max(0, inner - lineWidth(clamped));
  const bg = clamped.find(seg => seg.bg)?.bg;
  return [{ text: " ".repeat(pad), bg }, ...clamped, { text: " ".repeat(gap + pad), bg }];
}

/**
 * The header rule: one full cell of rule under the detail pane's identity
 * block, the cell's pad columns kept as inset. It lives here rather than in a
 * surface because the glyphs and the dim role are the frame's — a surface only
 * says which row the identity block ends on.
 */
function headerRuleCell(cellWidth: number, pad: number, box: PaneBox): WorkflowCardLine {
  const inner = Math.max(0, cellWidth - 2 * pad);
  return [
    { text: " ".repeat(pad) },
    { text: box.horizontal.repeat(inner), color: "dim" },
    { text: " ".repeat(pad) },
  ];
}

/**
 * The band rule: the full-width rule the panes end at, with `┴` in the
 * divider's column when the window is split. The bottom edge below a banded
 * window is plain — the divider terminates here.
 */
function bandRuleLine(inner: number, box: PaneBox, teeAt: number | undefined): WorkflowCardLine {
  if (inner <= 0) return [];
  if (teeAt === undefined || teeAt < 0 || teeAt >= inner) {
    return [{ text: box.horizontal.repeat(inner), color: "dim" }];
  }
  return [
    { text: box.horizontal.repeat(teeAt), color: "dim" },
    { text: box.bottomTee, color: "dim" },
    { text: box.horizontal.repeat(inner - teeAt - 1), color: "dim" },
  ];
}

/** One titled region of a rule, with the window's style roles. */
function ruleCell(cell: RuleCell): WorkflowCardLine {
  return cell.title === undefined
    ? [{ text: cell.rule, color: "border" }]
    : [{ text: cell.lead, color: "dim" }, { text: cell.title, color: "muted", bold: true }, { text: cell.rule, color: "border" }];
}

/**
 * The window, from the rows a surface contributed.
 *
 * Draws the `╭─┬─╮` / `╰─┴─╯` edges (split when `panes` is given, plain
 * otherwise — both titled: the split edge carries `title` in the master's
 * cell, the plain edge carries it in the edge itself), every row in between, and nothing else: the caller owns
 * the content and the order, this owns the columns. That is the whole contract
 * — the hub's roster, preview and transcript panes are all calls to this
 * function with different rows.
 */
export function renderWindow(options: {
  width: number;
  box: PaneBox;
  rows: readonly WindowRow[];
  /** Absent → a single-pane window: no split bars, no tee. */
  panes?: PaneGeometry;
  /** The window's name — in a split window it names the master pane's cell
 * (the hub's constant ` Agents & Workflows `); in a single-pane window it is
 * drawn into the top edge itself. */
  title?: string;
  ellipsis?: string;
  style?: UIStyle;
}): WorkflowCardLine[] {
  const { width, box, panes } = options;
  const isPi = (options.style === "pi" || options.style === undefined) && (box === PI_PANE_BOX || box.topLeft === "─");
  const ellipsis = options.ellipsis ?? "…";
  const edge = (text: string): WorkflowCardSegment => ({ text, color: "border" });
  const outerLeft: WorkflowCardSegment[] = isPi ? [{ text: " " }] : [edge(box.vertical)];
  const outerRight: WorkflowCardSegment[] = isPi ? [{ text: " " }] : [edge(box.vertical)];
  const bar = [edge(box.vertical)];
  const rightCell = panes ? width - panes.leftCellWidth - FRAME_BARS : width - 2;
  const lines: WorkflowCardLine[] = [];

  const titleOf = (cellWidth: number) => stripTerminalSequences(truncateToWidth(options.title ?? "", cellWidth, ellipsis));
  lines.push([edge(panes
    ? splitEdge(width, panes.leftCellWidth, box, "top", titleOf(panes.leftCellWidth))
    : frameEdge(width, box, "top", titleOf(Math.max(0, width - 2))))]);

  for (const item of options.rows) {
    switch (item.kind) {
      case "full": {
        const inner = windowInnerWidth(width);
        const clamped = clampLine(item.cells, inner, ellipsis);
        const gap = Math.max(0, inner - lineWidth(clamped));
        const bg = clamped.find(seg => seg.bg)?.bg;
        lines.push([...outerLeft, { text: " ", bg }, ...clamped, { text: " ".repeat(gap + 1), bg }, ...outerRight]);
        break;
      }
      case "split":
        lines.push(panes
          ? [
              ...outerLeft,
              ...paneCell(item.left, panes.leftCellWidth, panes.pad, ellipsis),
              ...bar,
              ...paneCell(item.right, rightCell, panes.pad, ellipsis),
              ...outerRight,
            ]
          : [...outerLeft, ...paneCell(item.left ?? item.right, width - 2, 0, ellipsis), ...outerRight]);
        break;
      case "headerRule":
        lines.push(panes
          ? [
              ...outerLeft,
              ...paneCell(item.left, panes.leftCellWidth, panes.pad, ellipsis),
              ...bar,
              ...headerRuleCell(rightCell, panes.pad, box),
              ...outerRight,
            ]
          : [...outerLeft, ...headerRuleCell(width - 2, PANE_PADDING, box), ...outerRight]);
        break;
      case "titles": {
        // One rule, whether there are one or two cells to title: the pane `│`
        // becomes a `┬` as soon as a title needs a cell to sit in.
        const rule = paneRule({
          leftWidth: panes ? panes.leftCellWidth : width - 2,
          rightWidth: panes ? rightCell : 0,
          box,
          leftTitle: item.left,
          rightTitle: item.right,
          ellipsis,
          titlePadding: item.padding ?? "outside",
        });
        const tee = edge(item.left !== undefined || item.right !== undefined ? box.topTee : box.vertical);
        const leftTee = edge(isPi ? box.horizontal : rule.leftTee);
        const rightTee = edge(isPi ? box.horizontal : rule.rightTee);
        lines.push(panes
          ? [leftTee, ...ruleCell(rule.left), tee, ...ruleCell(rule.right), rightTee]
          : [leftTee, ...ruleCell(rule.left), rightTee]);
        break;
      }
      case "band":
        lines.push(isPi && panes
          ? bandRuleLine(width, box, panes.leftCellWidth + 1)
          : [
              ...outerLeft,
              { text: " " },
              ...bandRuleLine(windowInnerWidth(width), box, panes ? panes.leftCellWidth - 1 : undefined),
              { text: " " },
              ...outerRight,
            ]);
        break;
    }
  }

  // A banded window's bottom edge is plain: the band row carries the `┴` the
  // divider ends at, so a second one below it would dangle.
  const banded = options.rows.some(row => row.kind === "band");
  lines.push([edge(panes && !banded ? splitEdge(width, panes.leftCellWidth, box, "bottom") : frameEdge(width, box, "bottom"))]);
  return lines;
}

/**
 * The visible slice of a list, centered on `selected` and clamped at both
 * ends: the selection stays on screen and the list never leaves a blank row
 * where a row could be. The hub's roster and run panes both window this way,
 * so a long list reads the same on every page.
 */
export function windowRange(selected: number, total: number, height: number): { start: number; end: number } {
  const rows = Math.max(0, height);
  const visible = Math.min(rows, total);
  const start = Math.max(0, Math.min(selected - Math.floor(rows / 2), total - visible));
  return { start, end: start + visible };
}

/**
 * Rows a window may draw between its edges, from the share of the terminal its
 * overlay occupies.
 *
 * `chromeRows` is what the window spends on its own frame — borders, headers,
 * rules, the footer — so the whole window lands under the same viewport
 * ceiling the overlay host clips at, rather than losing its bottom edge to it.
 */
export function paneBodyHeight(options: {
  terminalRows: number | undefined;
  viewportPct: number;
  chromeRows: number;
  min: number;
  fallbackRows: number;
}): number {
  const { terminalRows } = options;
  if (terminalRows === undefined) return options.fallbackRows;
  return Math.max(
    options.min,
    Math.floor((terminalRows * options.viewportPct) / 100) - options.chromeRows,
  );
}
