/**
 * The window frame the agent hub draws through.
 *
 * One surface — `╭───╮` edges, padded `│ content │` rows, a two-pane split
 * whose three bars partition the width exactly, a footer that drops its least
 * useful hints rather than cutting one in half, and a body height derived from
 * the overlay's share of the terminal. `window-frame.ts` is that geometry
 * once; these tests pin the primitives and pin that the hub actually renders
 * through them, so a hand-rolled copy cannot grow back unnoticed.
 */
import { readdirSync, readFileSync } from "node:fs";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import {
  ASCII_PANE_BOX,
  type FooterHint,
  FRAME_BARS,
  footerBand,
  frameEdge,
  frameRow,
  leftPaneWidth,
  MASTER_LIST_WIDTH,
  masterPaneGeometry,
  PI_PANE_BOX,
  paneBodyHeight,
  paneGeometry,
  paneRightWidth,
  paneRule,
  type RuleCell,
  renderWindow,
  splitEdge,
  UNICODE_PANE_BOX,
  WINDOW_CHROME_ROWS,
} from "../src/ui/window-frame.js";
import type { WorkflowCardLine } from "../src/ui/workflow-card.js";


describe("pane geometry", () => {
  it("partitions the width between the three bars and both cells", () => {
    for (const width of [30, 60, 100, 137]) {
      for (const pad of [0, 1]) {
        const left = leftPaneWidth(width, 18, pad);
        const right = paneRightWidth(width, left, pad);
        // `│` pad cell pad `│` pad cell pad `│`
        expect(left + right + FRAME_BARS + 4 * pad, `w=${width} pad=${pad}`).toBe(width);
      }
    }
  });

  it("gives the left cell a third at most, and the right its last column", () => {
    for (const width of [8, 12, 20, 55]) {
      const left = leftPaneWidth(width, 18);
      const available = Math.max(2, width - FRAME_BARS);
      expect(left).toBeGreaterThanOrEqual(1);
      expect(left).toBeLessThanOrEqual(Math.floor(available / 3));
      expect(paneRightWidth(width, left)).toBeGreaterThanOrEqual(1);
    }
    // Comfortable widths take the cap, not a share of the terminal.
    expect(leftPaneWidth(100, 18)).toBe(18);
    expect(leftPaneWidth(200, 18)).toBe(18);
  });
});

describe("master pane geometry", () => {
  it("pins the hub's master at 18 content columns at every two-pane width", () => {
    expect(MASTER_LIST_WIDTH).toBe(18);
    for (const width of [60, 100, 120]) {
      expect(masterPaneGeometry(width).listWidth, `w=${width}`).toBe(MASTER_LIST_WIDTH);
    }
    // The inspector's own policy still gives way at the tightest two-pane
    // width; the hub's pin is what keeps its divider in one column.
    expect(paneGeometry(60).listWidth).toBeLessThan(MASTER_LIST_WIDTH);
  });

  it("gives the master cell way rather than tearing a narrow window", () => {
    const panes = masterPaneGeometry(12);
    expect(panes.listWidth).toBeLessThan(MASTER_LIST_WIDTH);
    expect(1 + panes.leftCellWidth + 1 + panes.rightCellWidth + 1).toBe(12);
  });

  it("partitions the width between the three bars and both cells", () => {
    for (const width of [12, 24, 60, 100, 137]) {
      for (const pad of [0, 1]) {
        const panes = masterPaneGeometry(width, pad);
        expect(panes.listWidth + panes.detailWidth + FRAME_BARS + 4 * pad, `w=${width} pad=${pad}`).toBe(width);
      }
    }
  });
});

describe("window chrome", () => {
  it("draws edges corner to corner in either glyph tier", () => {
    expect(frameEdge(12, UNICODE_PANE_BOX, "top")).toBe(`╭${"─".repeat(10)}╮`);
    expect(frameEdge(12, UNICODE_PANE_BOX, "bottom")).toBe(`╰${"─".repeat(10)}╯`);
    expect(frameEdge(6, ASCII_PANE_BOX, "top")).toBe("+----+");
    expect(frameEdge(1, UNICODE_PANE_BOX, "top")).toBe("╭╮");
  });

  it("pads a content row to exactly the width, bars in their columns", () => {
    const plain = (s: string) => s;
    const row = frameRow(20, "hello", UNICODE_PANE_BOX, plain);
    expect(row).toBe(`│ hello${" ".repeat(11)} │`);
    expect(row.length).toBe(20);
    // Overlong content is clamped inside the bars; the row never wraps.
    const long = frameRow(20, "x".repeat(50), UNICODE_PANE_BOX, plain, "~");
    expect(visibleWidth(long)).toBe(20);
    expect(stripTerminalSequences(long).endsWith(" │")).toBe(true);
    expect(stripTerminalSequences(long)).toContain("~");
  });

  it("puts a tee where the two panes meet, title included", () => {
    const top = splitEdge(24, 8, UNICODE_PANE_BOX, "top", " Agents ");
    expect(top).toBe(`╭ Agents ┬${"─".repeat(13)}╮`);
    expect(top.length).toBe(24);
    const bottom = splitEdge(24, 8, UNICODE_PANE_BOX, "bottom");
    expect(bottom).toBe(`╰${"─".repeat(8)}┴${"─".repeat(13)}╯`);
    expect(bottom.length).toBe(24);
  });

  it("names a single-pane window on its top edge, where it has no tee to hang a title on", () => {
    const titled = frameEdge(40, UNICODE_PANE_BOX, "top", " Agents & Workflows ");
    expect(titled).toBe(`╭ Agents & Workflows ${"─".repeat(18)}╮`);
    expect(visibleWidth(titled)).toBe(40);
    // An untitled edge is unchanged: the title is optional, not a second shape.
    expect(frameEdge(12, UNICODE_PANE_BOX, "top", "")).toBe(frameEdge(12, UNICODE_PANE_BOX, "top"));
  });
});

describe("the header rule row", () => {
  const text = (line: WorkflowCardLine) => line.map(segment => segment.text).join("");

  it("fills the detail cell, the cell's pad columns as inset, the master cell carrying on", () => {
    const panes = masterPaneGeometry(120);
    const lines = renderWindow({
      width: 120,
      box: UNICODE_PANE_BOX,
      panes,
      title: " Agents & Workflows ",
      rows: [
        { kind: "split", left: [{ text: "SUBAGENTS" }], right: [{ text: "● explore" }] },
        { kind: "split", left: [{ text: "❯ ● explore" }], right: [{ text: "  ↳ model" }] },
        { kind: "headerRule", left: [{ text: "  ○ audit" }] },
        { kind: "split", left: [], right: [{ text: "body" }] },
      ],
    });
    // `│` + the whole master cell + `│` + the detail cell + `│`.
    expect(text(lines[3])).toBe(`│ ${"  ○ audit".padEnd(18)} │ ${"─".repeat(95)} │`);
    expect(visibleWidth(text(lines[3]))).toBe(120);
  });

  it("spans a single-pane window's row, the window's own inset either side", () => {
    const lines = renderWindow({
      width: 40,
      box: UNICODE_PANE_BOX,
      title: " Agents & Workflows ",
      rows: [{ kind: "headerRule" }],
    });
    expect(text(lines[0])).toBe(`╭ Agents & Workflows ${"─".repeat(18)}╮`);
    expect(text(lines[1])).toBe(`│ ${"─".repeat(36)} │`);
    expect(visibleWidth(text(lines[1]))).toBe(40);
  });
});

describe("the band rule row", () => {
  const text = (line: WorkflowCardLine) => line.map(segment => segment.text).join("");

  it("carries the `┴` the divider ends at, with a plain bottom edge below", () => {
    const panes = masterPaneGeometry(120);
    const lines = renderWindow({
      width: 120,
      box: UNICODE_PANE_BOX,
      panes,
      title: " Agents & Workflows ",
      rows: [
        { kind: "split", left: [{ text: "❯ ● explore" }], right: [{ text: "body" }] },
        { kind: "band" },
        { kind: "full", cells: [{ text: "⏎ transcript" }] },
      ],
    });
    expect(text(lines[0]!)).toBe(`╭ Agents & Workflows ┬${"─".repeat(97)}╮`);
    expect(text(lines[1]!)).toBe(`│${" ❯ ● explore".padEnd(20)}│${" body".padEnd(97)}│`);
    // The whole inner width, the `┴` in the divider's column — index 21 at 120.
    expect(text(lines[2]!)).toBe(`│ ${"─".repeat(19)}┴${"─".repeat(96)} │`);
    expect(text(lines[2]!).indexOf("┴")).toBe(21);
    expect(text(lines[3]!)).toBe(`│ ${"⏎ transcript".padEnd(116)} │`);
    // Plain: the divider terminates at the band, so no tee dangles under it.
    expect(text(lines[4]!)).toBe(`╰${"─".repeat(118)}╯`);
    for (const line of lines) expect(visibleWidth(text(line))).toBe(120);
  });

  it("spans a single-pane window, where there is no divider to meet", () => {
    const lines = renderWindow({
      width: 40,
      box: UNICODE_PANE_BOX,
      rows: [{ kind: "band" }, { kind: "full", cells: [{ text: "left" }] }],
    });
    expect(text(lines[1]!)).toBe(`│ ${"─".repeat(36)} │`);
    expect(text(lines.at(-1)!)).toBe(`╰${"─".repeat(38)}╯`);
  });
});

describe("pane rules", () => {
  const cellText = (cell: RuleCell) => cell.lead + (cell.title ?? "") + cell.rule;
  const line = (rule: { leftTee: string; left: RuleCell; tee: string; right: RuleCell; rightTee: string }) =>
    rule.leftTee + cellText(rule.left) + rule.tee + cellText(rule.right) + rule.rightTee;

  it("draws the two cells between their bars, one tee where the panes meet", () => {
    const titled = paneRule({
      leftWidth: 18,
      rightWidth: 79,
      box: UNICODE_PANE_BOX,
      leftTitle: "Phases",
      rightTitle: "Verify \u00b7 1 agent",
    });
    expect(line(titled)).toBe(`\u251c Phases ${"\u2500".repeat(10)}\u252c Verify \u00b7 1 agent ${"\u2500".repeat(61)}\u2524`);
    expect(visibleWidth(line(titled))).toBe(100);
    // Untitled: the whole line is rule, and the pane bar is the plain vertical.
    const plain = paneRule({ leftWidth: 18, rightWidth: 79, box: UNICODE_PANE_BOX });
    expect(line(plain)).toBe(`\u251c${"\u2500".repeat(18)}\u2502${"\u2500".repeat(79)}\u2524`);
    expect(plain.left.title).toBeUndefined();
    expect(plain.tee).toBe("\u2502");
  });

  it("swaps the whole rule for the ASCII tier, one column per glyph", () => {
    const titled = paneRule({
      leftWidth: 18,
      rightWidth: 79,
      box: ASCII_PANE_BOX,
      leftTitle: "Phases",
      rightTitle: "Verify \u00b7 1 agent",
    });
    expect(line(titled)).toBe(`+ Phases ${"-".repeat(10)}+ Verify \u00b7 1 agent ${"-".repeat(61)}+`);
    expect(visibleWidth(line(titled))).toBe(100);
    expect(line(paneRule({ leftWidth: 18, rightWidth: 79, box: ASCII_PANE_BOX })))
      .toBe(`+${"-".repeat(18)}|${"-".repeat(79)}+`);
  });

  it("fills each cell to its own width, odd and even, titled or not", () => {
    for (const width of [2, 3, 5, 16, 17, 18, 19, 80, 81]) {
      for (const title of [undefined, "Phases", "a title far too long for any cell"]) {
        for (const titlePadding of ["outside", "inside"] as const) {
          const cell = paneRule({ leftWidth: width, rightWidth: 79, box: UNICODE_PANE_BOX, leftTitle: title, titlePadding }).left;
          expect(visibleWidth(cellText(cell)), `w=${width} title=${title} ${titlePadding}`).toBe(width);
        }
      }
    }
  });

  it("reads a title's padding one of two ways when it has to cut it", () => {
    // The one column the inspector's two render paths have always differed by:
    // `outside` cuts the title and keeps the space either side of it, `inside`
    // cuts ` title ` as one string, so the leading pad gives way first.
    const outside = paneRule({
      leftWidth: 18, rightWidth: 79, box: UNICODE_PANE_BOX, leftTitle: "Verify \u00b7 2 agents", titlePadding: "outside",
    });
    expect(cellText(outside.left)).toBe(" Verify \u00b7 2 agen\u2026 ");
    const inside = paneRule({
      leftWidth: 18, rightWidth: 79, box: UNICODE_PANE_BOX, leftTitle: "Verify \u00b7 2 agents", titlePadding: "inside",
    });
    expect(cellText(inside.left)).toBe("  Verify \u00b7 2 age\u2026\u2500");
    // Both readings are exact: only the bytes differ, never the column count.
    for (const cell of [outside.left, inside.left]) expect(visibleWidth(cellText(cell))).toBe(18);
  });

  it("keeps the rule's bars in this module alone", () => {
    // A surface that grew a second rule would have to reach for the box's tee
    // fields to pick its bars; the byte-pinned rule lines in the dialog suites
    // catch a copy that hardcodes the glyphs instead.
    const dir = new URL("../src/ui/", import.meta.url);
    const files = readdirSync(dir).filter(name => name.endsWith(".ts") && name !== "window-frame.ts");
    expect(files.length).toBeGreaterThan(5);
    // Reading a bar off a box, or defining one: what a second rule needs.
    const ownRule = /(\bbox\.(?:leftTee|topTee|rightTee|bottomTee)|\b(?:leftTee|topTee|rightTee|bottomTee):)/;
    for (const file of files) {
      expect(readFileSync(new URL(file, dir), "utf-8"), `${file} draws its own rule`).not.toMatch(ownRule);
    }
  });
});

describe("body height basis", () => {
  it("subtracts the window's own chrome from the overlay's share", () => {
    expect(paneBodyHeight({ terminalRows: 40, viewportPct: 70, chromeRows: WINDOW_CHROME_ROWS, min: 6, fallbackRows: 22 }))
      .toBe(Math.floor((40 * 70) / 100) - WINDOW_CHROME_ROWS);
    expect(paneBodyHeight({ terminalRows: 40, viewportPct: 100, chromeRows: WINDOW_CHROME_ROWS, min: 6, fallbackRows: 22 }))
      .toBe(33);
  });

  it("floors at the minimum and falls back when the host reports no rows", () => {
    expect(paneBodyHeight({ terminalRows: 8, viewportPct: 70, chromeRows: WINDOW_CHROME_ROWS, min: 6, fallbackRows: 22 })).toBe(6);
    expect(paneBodyHeight({ terminalRows: undefined, viewportPct: 70, chromeRows: WINDOW_CHROME_ROWS, min: 6, fallbackRows: 22 })).toBe(22);
  });
});

describe("the footer band", () => {
  const readout = (text: string): FooterHint => ({ text, group: "readout" });
  const action = (text: string): FooterHint => ({ text, group: "action" });
  const hint = (text: string, pinned = false): FooterHint => ({ text, group: "hint", pinned });
  const left = [readout("9 lines · 100%"), action("Enter steer"), action("x stop"), action("m md")];
  const right = [hint("PgUp/PgDn"), hint("j scroll"), hint("f full"), hint("Esc roster", true)];
  const band = (width: number) => footerBand({ width, left, right });
  const LEFT_FULL = "9 lines · 100% · Enter steer · x stop · m md";
  const RIGHT_FULL = "PgUp/PgDn · j scroll · f full · Esc roster";

  it("puts the left slot at the start and the right slot flush to the last column", () => {
    expect(band(200)).toBe(`${LEFT_FULL}${" ".repeat(200 - LEFT_FULL.length - RIGHT_FULL.length)}${RIGHT_FULL}`);
    expect(visibleWidth(band(200))).toBe(200);
    // A pair that only just fits keeps the spec's two columns between slots
    // (the readout included: 44 + 2 + 42).
    expect(band(88)).toBe(`${LEFT_FULL}  ${RIGHT_FULL}`);
    expect(visibleWidth(band(88))).toBe(88);
  });

  it("drops whole hints: the readout, then the left actions, then the right hints", () => {
    expect(band(89)).toBe(`9 lines · 100% · Enter steer · x stop · m md   ${RIGHT_FULL}`);
    expect(band(73)).toBe(`Enter steer · x stop · m md    ${RIGHT_FULL}`);
    expect(band(72)).toBe(`Enter steer · x stop · m md   ${RIGHT_FULL}`);
    expect(band(65)).toBe(`Enter steer · x stop   ${RIGHT_FULL}`);
    expect(band(54)).toBe(`${" ".repeat(12)}${RIGHT_FULL}`);
    // The right slot next, right-to-left, skipping the pinned escape anchor.
    expect(band(43)).toBe(` PgUp/PgDn · j scroll · f full · Esc roster`);
    expect(band(34)).toBe(` PgUp/PgDn · j scroll · Esc roster`);
    expect(band(21)).toBe(`${" ".repeat(11)}Esc roster`);
    expect(band(10)).toBe("Esc roster");
  });

  it("never cuts a hint in half, down to the last width that fits one", () => {
    const hints = ["9 lines", "100%", "Enter steer", "x stop", "m md", "PgUp/PgDn", "j scroll", "f full", "Esc roster"];
    for (let width = 10; width <= 200; width++) {
      const line = band(width);
      // A cut hint leaves its opening characters behind without the whole text
      // — the fitter must have dropped it instead, separator and all.
      for (const hintText of hints) {
        const fragment = hintText.slice(0, hintText.length - 1);
        if (line.includes(fragment)) expect(line, `w=${width}: ${JSON.stringify(hintText)}`).toContain(hintText);
      }
      expect(line.includes(" · ") && line.trimStart().startsWith("·"), `w=${width}`).toBe(false);
    }
  });
});

/* ------------------------------------------------------------------------- *
 * The spec's frames render through the fitter
 * ------------------------------------------------------------------------- */

describe("the spec's frames' footer bands", () => {
  // The bands `docs/hub-ui-spec.md`'s frames carry, at the band's 116
  // content columns (a 120-column window). The frames hold these exact strings,
  // so a change to the fitter — or to a page's slots — fails here first.
  const readout = (text: string): FooterHint => ({ text, group: "readout" });
  const action = (text: string): FooterHint => ({ text, group: "action" });
  const hint = (text: string, pinned = false): FooterHint => ({ text, group: "hint", pinned });
  const cases: Array<[string, string, FooterHint[], FooterHint[]]> = [
    ["R1", "Enter steer · x stop · m md          PgUp/PgDn · j scroll · o expand · l log · p pause · c copy · f full · Esc close", [ readout("705 lines · 100%"), action("Enter steer"), action("x stop"), action("m md") ], [ hint("PgUp/PgDn"), hint("j scroll"), hint("o expand"), hint("l log"), hint("p pause"), hint("c copy"), hint("f full"), hint("Esc close", true) ]],
    ["R2", "⏎ open run · s stop run · c copy                                         ↑↓ select · ⇥ activity · f full · Esc close", [ action("⏎ open run"), action("s stop run"), action("c copy") ], [ hint("↑↓ select"), hint("⇥ activity"), hint("f full"), hint("Esc close", true) ]],
    ["TD", "Enter steer · x stop · c copy diff              PgUp/PgDn · j scroll · l log · p pause · c copy · f full · Esc close", [ readout("701 lines · 100%"), action("Enter steer"), action("x stop"), action("c copy diff"), action("o collapse") ], [ hint("PgUp/PgDn"), hint("j scroll"), hint("l log"), hint("p pause"), hint("c copy"), hint("f full"), hint("Esc close", true) ]],
    ["SL", "42 lines · 100% · x stop                                 ↑↓ scroll · c copy tail · p pause agent · f full · Esc back", [ readout("42 lines · 100%"), action("x stop") ], [ hint("↑↓ scroll"), hint("c copy tail"), hint("p pause agent"), hint("f full"), hint("Esc back", true) ]],
    ["W", "3/5 agents · phase 2 of 4 · p pause run             ↑↓ item · ⏎ agent · l run log · s stop run · f full · Esc roster", [ readout("3/5 agents · phase 2 of 4"), action("p pause run") ], [ hint("↑↓ item"), hint("⏎ agent"), hint("l run log"), hint("s stop run"), hint("f full"), hint("Esc roster", true) ]],
    ["WA", "Enter steer · x stop · m md · s skip  PgUp/PgDn · j scroll · o expand · l log · p pause · c copy · f full · Esc back", [ readout("705 lines · 100%"), action("Enter steer"), action("x stop"), action("m md"), action("s skip"), action("r retry") ], [ hint("PgUp/PgDn"), hint("j scroll"), hint("o expand"), hint("l log"), hint("p pause"), hint("c copy"), hint("f full"), hint("Esc back", true) ]],
    ["SAL", "7 lines · 100% · x stop                                  ↑↓ scroll · c copy tail · p pause agent · f full · Esc back", [ readout("7 lines · 100%"), action("x stop") ], [ hint("↑↓ scroll"), hint("c copy tail"), hint("p pause agent"), hint("f full"), hint("Esc back", true) ]],
    ["L", "11 lines · 64% · s stop run                                              ↑↓ scroll · c copy tail · f full · Esc back", [ readout("11 lines · 64%"), action("s stop run") ], [ hint("↑↓ scroll"), hint("c copy tail"), hint("f full"), hint("Esc back", true) ]],
  ];

  it("render whole and flush right in every frame", () => {
    for (const [name, expected, left, right] of cases) {
      expect(footerBand({ width: 116, left, right }), name).toBe(expected);
      expect(visibleWidth(expected), name).toBe(116);
    }
  });
});

describe("Pi-native window chrome", () => {
  const text = (line: WorkflowCardLine) => line.map(segment => segment.text).join("");

  it("draws edge-to-edge horizontal borders with no box corners", () => {
    expect(frameEdge(12, PI_PANE_BOX, "top")).toBe("─".repeat(12));
    expect(frameEdge(12, PI_PANE_BOX, "bottom")).toBe("─".repeat(12));
    expect(splitEdge(24, 8, PI_PANE_BOX, "top", " Agents ")).toBe(`─ Agents ┬${"─".repeat(14)}`);
    expect(splitEdge(24, 8, PI_PANE_BOX, "bottom")).toBe(`─${"─".repeat(8)}┴${"─".repeat(14)}`);
  });

  it("renders a split window with horizontal edges, divider between panes, and space margins", () => {
    const panes = masterPaneGeometry(60);
    const lines = renderWindow({
      width: 60,
      box: PI_PANE_BOX,
      style: "pi",
      panes,
      title: " Agents ",
      rows: [
        { kind: "split", left: [{ text: "● explore" }], right: [{ text: "details" }] },
        { kind: "band" },
        { kind: "full", cells: [{ text: "footer" }] },
      ],
    });

    // Top border is edge-to-edge horizontal rule with tee
    expect(text(lines[0])).toBe(`─ Agents ${"─".repeat(12)}┬${"─".repeat(38)}`);
    expect(visibleWidth(text(lines[0]))).toBe(60);

    // Split content row: space margin on left, pane divider in middle, space margin on right (no │ on edges)
    expect(text(lines[1]).startsWith(" ")).toBe(true);
    expect(text(lines[1]).endsWith(" ")).toBe(true);
    expect(text(lines[1])).not.toMatch(/^│/);
    expect(text(lines[1])).not.toMatch(/│$/);
    expect(text(lines[1])).toContain("│"); // inner divider
    expect(visibleWidth(text(lines[1]))).toBe(60);

    // Band row: horizontal rule with ┴ aligned with top ┬
    expect(text(lines[2])).toBe(`${"─".repeat(21)}┴${"─".repeat(38)}`);
    expect(visibleWidth(text(lines[2]))).toBe(60);

    // Full row: space margins, no outer │
    expect(text(lines[3]).startsWith(" ")).toBe(true);
    expect(text(lines[3]).endsWith(" ")).toBe(true);
    expect(text(lines[3])).not.toContain("│");
    expect(visibleWidth(text(lines[3]))).toBe(60);

    // Bottom border is clean horizontal rule across whole width
    expect(text(lines[4])).toBe("─".repeat(60));
    expect(visibleWidth(text(lines[4]))).toBe(60);
  });

  it("preserves outer vertical rails and corners when UNICODE_PANE_BOX is passed, even with style: pi", () => {
    const panes = masterPaneGeometry(60);
    const lines = renderWindow({
      width: 60,
      box: UNICODE_PANE_BOX,
      style: "pi",
      panes,
      title: " Agents ",
      rows: [
        { kind: "split", left: [{ text: "● explore" }], right: [{ text: "details" }] },
        { kind: "band" },
        { kind: "full", cells: [{ text: "footer" }] },
      ],
    });

    // Top border has rounded corners
    expect(text(lines[0])).toBe(`╭ Agents ${"─".repeat(12)}┬${"─".repeat(37)}╮`);
    expect(visibleWidth(text(lines[0]))).toBe(60);

    // Split content row: outer │ rails preserved
    expect(text(lines[1]).startsWith("│")).toBe(true);
    expect(text(lines[1]).endsWith("│")).toBe(true);
    expect(visibleWidth(text(lines[1]))).toBe(60);

    // Band row: outer │ rails preserved
    expect(text(lines[2]).startsWith("│")).toBe(true);
    expect(text(lines[2]).endsWith("│")).toBe(true);
    expect(text(lines[2])).toContain("┴");
    expect(visibleWidth(text(lines[2]))).toBe(60);

    // Full row: outer │ rails preserved
    expect(text(lines[3]).startsWith("│")).toBe(true);
    expect(text(lines[3]).endsWith("│")).toBe(true);
    expect(visibleWidth(text(lines[3]))).toBe(60);

    // Bottom border has rounded corners
    expect(text(lines[4])).toBe(`╰${"─".repeat(58)}╯`);
    expect(visibleWidth(text(lines[4]))).toBe(60);
  });
});

describe("segment background propagation", () => {
  it("propagates selectedBg across padding in split pane cells", () => {
    const lines = renderWindow({
      width: 60,
      box: PI_PANE_BOX,
      style: "pi",
      panes: { leftCellWidth: 20, pad: 1 },
      rows: [
        {
          kind: "split",
          left: [{ text: "selected agent", bg: "selectedBg" }],
          right: [{ text: "details" }],
        },
      ],
    });

    const splitRow = lines[1];
    // Leading space, text segment, and trailing padding of the left cell should all have bg: "selectedBg"
    const leftCellSegments = splitRow.slice(1, 4);
    expect(leftCellSegments[0]).toEqual({ text: " ", bg: "selectedBg" });
    expect(leftCellSegments[1]).toMatchObject({ text: "selected agent", bg: "selectedBg" });
    expect(leftCellSegments[2]?.bg).toBe("selectedBg");
  });

  it("propagates selectedBg across padding in full rows", () => {
    const lines = renderWindow({
      width: 60,
      box: PI_PANE_BOX,
      style: "pi",
      rows: [
        {
          kind: "full",
          cells: [{ text: "selected item", bg: "selectedBg" }],
        },
      ],
    });

    const fullRow = lines[1];
    expect(fullRow[1]).toEqual({ text: " ", bg: "selectedBg" });
    expect(fullRow[2]).toMatchObject({ text: "selected item", bg: "selectedBg" });
    expect(fullRow[3]?.bg).toBe("selectedBg");
  });
});

