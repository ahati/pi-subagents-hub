import * as piHost from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { AgentManager } from "../src/agent-manager.js";
import type { AgentRecord } from "../src/types.js";
import {
  AgentHub,
  type AgentHubDeps,
  HUB_SIZE_REFUSAL,
  type HubUICtx,
  openAgentHub,
  statusGlyph,
  type WorkflowRunControls,
  workflowStatusGlyph,
} from "../src/ui/agent-hub.js";
import type { AgentActivity } from "../src/ui/agent-widget.js";
import type { FleetWorkflow } from "../src/ui/fleet-list.js";
import { MASTER_LIST_WIDTH, PANE_PADDING } from "../src/ui/window-frame.js";
import type { WorkflowDialogSource } from "../src/ui/workflow-view.js";
import type { WorkflowAgentEntry } from "../src/workflow/progress.js";

const ESC = "\x1b";
const DOWN = "\x1b[B";
/** A passthrough theme: the master cell is 18 columns, so nothing may count as visible text. */
const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };

/** Visible text: ANSI stripped (agent name badges). */
function plain(line: string): string {
  return line.replace(/\u001b\[[0-9;]*m/g, "").replace(/<\/?[a-zA-Z]+>|\*/g, "");
}

function makeRecord(over: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "a1",
    type: "general-purpose",
    description: "Sleep then report 1",
    status: "running",
    toolUses: 0,
    startedAt: Date.now() - 5000,
    session: { subscribe: () => () => {}, messages: [] },
    lifetimeUsage: { input: 13100, output: 0, cacheWrite: 0 },
    compactionCount: 0,
    ...over,
  } as AgentRecord;
}

function runAgent(over: Partial<WorkflowAgentEntry> = {}): WorkflowAgentEntry {
  return { type: "workflow_agent", index: 0, label: "m-1", state: "running", ...over };
}

/** A run with two agents, one with a record and a session. */
function runSource(): WorkflowDialogSource {
  return {
    progress: [
      runAgent({ index: 0, label: "m-1", state: "running", recordId: "r1" }),
      runAgent({ index: 1, label: "m-2", state: "done", recordId: "r2", resultPreview: "3 tables" }),
    ],
    task: { status: "running", workflowName: "migrate-v2", startTime: Date.now() - 60_000 },
  };
}

function harness(
  agents: AgentRecord[],
  depsOver: Partial<AgentHubDeps> = {},
  size: { cols?: number; rows?: number } = {},
  th: { fg(c: string, s: string): string; bold(s: string): string } = theme,
) {
  const fakeTui = {
    mode: "regular",
    requestRender: vi.fn(),
    terminal: { columns: size.cols ?? 120, rows: size.rows ?? 40, write: vi.fn() },
  };
  const components: Array<AgentHub & { handleInput(data: string): void; render(width: number): string[] }> = [];
  let settled = false;
  const ui = {
    notify: vi.fn(),
    custom: vi.fn(async (factory: (...args: unknown[]) => unknown) => {
      return await new Promise<undefined>(resolve => {
        const done = (r: undefined) => {
          if (r === "toggle") return resolve("toggle" as never);
          settled = true;
          resolve(undefined);
        };
        components.push(factory(fakeTui, th, undefined, done) as (typeof components)[number]);
      });
    }),
  };
  const deps: AgentHubDeps = {
    manager: {
      listAgents: () => agents,
      abort: vi.fn(() => true),
      steer: vi.fn(() => true),
    } as unknown as AgentManager,
    agentActivity: new Map<string, AgentActivity>(),
    showCost: false,
    uiStyle: () => "claude",
    ...depsOver,
  };
  return {
    ui,
    deps,
    open: (initial?: Parameters<typeof openAgentHub>[2]) => {
      const promise = openAgentHub(ui as unknown as HubUICtx, deps, initial);
      return { promise, settled: () => settled };
    },
    frame: (width = 120) => (components.at(-1)?.render(width) ?? []).map(plain),
    press: (data: string) => components.at(-1)?.handleInput(data),
    settled: () => settled,
  };
}

/**
 * The divider column at 120 columns — the fixed master cell: `│ <18> │ <95> │`.
 * The parser reads the layout's known split rather than discovering a bar, so
 * a surface that moved it fails these tests instead of redefining them.
 */
const DIVIDER = 1 + MASTER_LIST_WIDTH + 2 * PANE_PADDING;
const isDivider = (ch: string | undefined) => ch === "│" || ch === "▒" || ch === "▓";
const isSplitRow = (line: string) => line.startsWith("│") && isDivider(line[DIVIDER]);
/** The cells either side of the pane divider, measured from the line itself. */
const leftCell = (line: string) => line.slice(1, DIVIDER);
const rightCell = (line: string) => line.slice(DIVIDER + 1);

describe("hub pane invariant — detail is always on the right", () => {
  const workflows = (): FleetWorkflow[] => [{
    id: "wf_1", name: "migrate-v2", status: "running", doneCount: 1, totalCount: 2,
    startedAt: Date.now() - 60_000, tokens: 500,
  }];

  it("pins the master cell at 18 columns: `│ <18> │ <95> │` at 120", () => {
    const h = harness([makeRecord({ id: "a1" })]);
    h.open();
    const body = h.frame().filter(l => l.startsWith("│"));
    expect(body.length).toBeGreaterThan(5);
    for (const line of body) {
      expect(line.length).toBe(120);
      // A body row is either full-width or split at the master cell's edge —
      // no other interior bar is allowed.
      for (const [index, ch] of [...line].entries()) {
        if (isDivider(ch) && index > 0 && index < line.length - 1) expect(index, line).toBe(DIVIDER);
      }
    }
    const split = body.filter(isSplitRow);
    expect(split.length).toBeGreaterThan(5);
    // Teeth: the master cell's content is exactly the section header — a torn
    // or mis-measured frame fails this, not just the width checks above.
    expect(split.some(l => leftCell(l).trimEnd() === " SUBAGENTS")).toBe(true);
    expect(split.every(l => leftCell(l).length === MASTER_LIST_WIDTH + 2 * PANE_PADDING)).toBe(true);
  });

  it("R: the grouped roster sits left, the selected agent's transcript right", () => {
    const h = harness([makeRecord({ id: "a1", description: "alpha task" }), makeRecord({ id: "a2", description: "beta task" })]);
    h.open();
    const frame = h.frame();
    const body = frame.filter(l => l.startsWith("│"));
    expect(body.some(l => leftCell(l).includes("SUBAGENTS"))).toBe(true);
    // The window's title row is above the split; the roster column never holds
    // the transcript and the right cell never holds the roster.
    expect(body.some(l => rightCell(l).includes("SUBAGENTS"))).toBe(false);
    expect(body.some(l => leftCell(l).includes("waiting for first message"))).toBe(false);
  });

  it("W: the roster stays pinned left, the run's phases and agents are right", () => {
    const h = harness(
      [makeRecord({ id: "a1" })],
      { workflows, workflowRun: () => runSource() },
    );
    h.open();
    h.press(DOWN); // onto the workflow row
    h.press("\r"); // page W
    const body = h.frame().filter(l => l.startsWith("│"));
    expect(body.some(l => leftCell(l).includes("SUBAGENTS"))).toBe(true);
    expect(body.some(l => rightCell(l).includes("PHASES"))).toBe(true);
    expect(body.some(l => rightCell(l).includes("RUNNING WORKFLOW AGENTS"))).toBe(true);
    // The run's own panes never leak into the roster column.
    expect(body.some(l => leftCell(l).includes("RUNNING WORKFLOW AGENTS"))).toBe(false);
  });

  it("WA: the run's agent list is demoted into the left pane, the conversation is right", () => {
    const h = harness(
      [makeRecord({ id: "r1", description: "schema tables" })],
      { workflows, workflowRun: () => runSource() },
    );
    h.open();
    h.press(DOWN);
    h.press("\r"); // W
    h.press("\r"); // WA — the selected run agent
    const body = h.frame().filter(l => l.startsWith("│"));
    expect(body.some(l => leftCell(l).includes("m-1"))).toBe(true);
    expect(body.some(l => rightCell(l).includes("waiting for first message"))).toBe(true);
    // The roster is gone at this level: the run's agents are the parent level.
    expect(body.some(l => leftCell(l).includes("SUBAGENTS"))).toBe(false);
  });

  it("L: the run's phases and agents stay left, the run log is right", () => {
    const h = harness(
      [makeRecord({ id: "r1" })],
      { workflows, workflowRun: () => runSource() },
    );
    h.open();
    h.press(DOWN);
    h.press("\r"); // W
    h.press("l"); // L
    const body = h.frame().filter(l => l.startsWith("│"));
    expect(body.some(l => leftCell(l).includes("m-1"))).toBe(true);
    expect(body.some(l => rightCell(l).includes("run start"))).toBe(true);
    expect(body.some(l => leftCell(l).includes("run start"))).toBe(false);
  });
});

describe("the header block every right pane opens with", () => {
  const workflows = (): FleetWorkflow[] => [{
    id: "wf_1", name: "migrate-v2", status: "running", doneCount: 1, totalCount: 2,
    startedAt: Date.now() - 60_000, tokens: 500,
  }];
  /** The detail cell's content columns at 120: `│ <18> │ <95> │`. */
  const DETAIL_WIDTH = 95;
  /** The right cell's rows, content only. */
  const rightRows = (frame: string[]) => frame
    .filter(isSplitRow)
    .map(l => rightCell(l).slice(1, 1 + DETAIL_WIDTH));
  /** The three identity rows: the header line, the `↳` line and the header rule. */
  const identity = (frame: string[]) => rightRows(frame).slice(0, 3);

  /** A harness with one run-agent, its record carrying an invocation. */
  const pageHarness = () => harness(
    [makeRecord({
      id: "r1",
      alias: "explore",
      description: "schema tables",
      invocation: { modelId: "anthropic/claude-sonnet-4-6", isolation: "worktree" },
    })],
    { workflows, workflowRun: () => runSource() },
  );

  /** How to reach each page from the roster. */
  const PAGES: Array<{ page: string; to: (press: (key: string) => void) => void }> = [
    { page: "R (agent)", to: () => {} },
    { page: "R (run)", to: p => p(DOWN) },
    { page: "SL", to: p => p("l") },
    { page: "W", to: p => { p(DOWN); p("\r"); } },
    { page: "WA", to: p => { p(DOWN); p("\r"); p("\r"); } },
    { page: "SAL", to: p => { p(DOWN); p("\r"); p("\r"); p("l"); } },
    { page: "L", to: p => { p(DOWN); p("\r"); p("l"); } },
  ];

  it("opens every page with the header line, the `↳` line and the rule, nothing above", () => {
    for (const { page, to } of PAGES) {
      const h = pageHarness();
      h.open();
      to(h.press);
      const [head, sub, rule] = identity(h.frame());
      expect(head, page).not.toMatch(/^─/);
      expect(head, page).toMatch(/[●○‖✓✗·]/);
      expect(sub, page).toMatch(/^ {2}↳ /);
      expect(rule, page).toBe("─".repeat(DETAIL_WIDTH));
    }
  });

  it("leads a run-agent's `↳` line with the run name, and only there", () => {
    const h = pageHarness();
    h.open();
    // The roster page's pane is the agent's conversation, and its `↳` line
    // carries the model alone (there is no parent run on the roster).
    expect(identity(h.frame())[1].trimEnd()).toBe("  ↳ anthropic/claude-sonnet-4-6 · worktree");
    h.press(DOWN);
    h.press("\r"); // W
    h.press("\r"); // WA — one level inside the run
    expect(identity(h.frame())[1].trimEnd()).toBe("  ↳ migrate-v2 · anthropic/claude-sonnet-4-6 · worktree");
    h.press("l"); // SAL — same agent, the log page
    expect(identity(h.frame())[1].trimEnd()).toBe("  ↳ migrate-v2 · anthropic/claude-sonnet-4-6 · worktree");
  });

  it("identity occupies the first three rows; the body starts directly under the rule", () => {
    const h = pageHarness();
    h.open();
    h.press("l"); // SL
    const before = identity(h.frame());
    for (let i = 0; i < 5; i++) h.press(DOWN);
    // Scrolling moves the body only: the identity triple is byte-identical
    // and still the pane's first three rows.
    expect(identity(h.frame())).toEqual(before);
    const rows = rightRows(h.frame());
    expect(rows.slice(0, 3), "identity is the first three rows").toEqual(before);
    expect(rows.length, "a body exists under the rule").toBeGreaterThan(3);
    expect(rows[3], "the row under the rule is body, not another rule or blank").not.toBe(before[2]);
    expect(rows[3].trim()).not.toBe("");
  });

  it("R (agent) / WA: the embedded viewer contributes no header, rule or footer of its own", () => {
    const pages: Array<{ page: string; to: (press: (key: string) => void) => void }> = [
      { page: "R (agent)", to: () => {} },
      { page: "WA", to: p => { p(DOWN); p("\r"); p("\r"); } },
    ];
    for (const { page, to } of pages) {
      const h = pageHarness();
      h.open();
      to(h.press);
      const rows = rightRows(h.frame());
      // Exactly one rule in the pane — the frame's header rule at row 2. The
      // viewer's own identity rule and its footer rule are suppressed, so a
      // second full-cell rule would be a second identity block.
      const ruleRows = rows
        .map((r, i) => (r.trim() === "─".repeat(DETAIL_WIDTH) ? i : -1))
        .filter(i => i >= 0);
      expect(ruleRows, page).toEqual([2]);
      // Body opens directly under the rule with the transcript, never with a
      // viewer-drawn header block or footer row.
      expect(rows[3].trim(), page).toBe("(waiting for first message...)");
      const body = rows.slice(3).join("\n");
      expect(body, page).not.toContain("↳");
      expect(body, page).not.toContain("Esc ");
      expect(body, page).not.toContain("m md");
    }
  });
});

/** A four-phase run with agents in two of them, for the state mark and cursor. */
function phasedRunSource(): WorkflowDialogSource {
  return {
    progress: [
      { type: "workflow_phase", index: 0, title: "discover" },
      { type: "workflow_phase", index: 1, title: "migrate" },
      runAgent({ index: 0, label: "m-1", state: "done", phaseIndex: 0, recordId: "r1" }),
      runAgent({ index: 1, label: "m-2", state: "running", phaseIndex: 1, recordId: "r2" }),
      runAgent({ index: 2, label: "m-3", state: "running", phaseIndex: 1, recordId: "r3" }),
    ],
    meta: { phases: [{ title: "discover" }, { title: "migrate" }, { title: "verify" }, { title: "report" }] },
    task: { status: "running", workflowName: "migrate-v2", startTime: Date.now() - 60_000 },
  };
}

describe("the run's state mark and its item cursor", () => {
  const workflows = (): FleetWorkflow[] => [{
    id: "wf_1", name: "migrate-v2", status: "running", doneCount: 1, totalCount: 3,
    startedAt: Date.now() - 60_000, tokens: 500,
  }];
  // One roster agent, so the single ↓ from the roster lands on the run row.
  const runHarness = () => harness(
    [makeRecord({ id: "r1", description: "schema tables" })],
    { workflows, workflowRun: () => phasedRunSource() },
  );
  /** The split rows' right cells — where the run's phases and agents live. */
  const runPane = (frame: string[]) => frame
    .filter(isSplitRow)
    .map(rightCell)
    .join("\n");
  const marks = (pane: string) => pane.split("❯").length - 1;

  it("R2 previews the run with the current phase's `❯` and nothing else", () => {
    const h = runHarness();
    h.open();
    h.press(DOWN); // onto the run row
    const pane = runPane(h.frame());
    expect(pane).toContain("PHASES");
    expect(pane).toContain("❯ 2 migrate");
    expect(marks(pane)).toBe(1);
  });

  it("a running run agent carries its live turn count, tokens and last output line", () => {
    const activity = new Map([["r2", { activeTools: new Map(), toolUses: 2, responseText: "Editing api.ts — route handlers split", turnCount: 3 }]]);
    const h = harness(
      [
        makeRecord({ id: "r1", parentAgentId: "main", description: "schema tables", status: "completed" }),
        makeRecord({ id: "r2", parentAgentId: "main", description: "api endpoints", status: "running", lifetimeUsage: { input: 60_000, output: 3_400, cacheWrite: 0 } }),
      ],
      { workflows, workflowRun: () => phasedRunSource(), agentActivity: activity },
    );
    h.open();
    h.press(DOWN);
    h.press("\r"); // page W
    const pane = runPane(h.frame());
    // Live facts on the running row, flush right with the duration…
    expect(pane).toContain("turn 3 · 63.4k tok");
    // …and the last output line one dim row under it, a `↳` continuation.
    // The done row (m-1) carries neither — no turn count, no tail.
    expect(pane).toContain("↳ Editing api.ts — route handlers split");
    expect(pane).not.toMatch(/m-1.*turn \d/);
    // A running agent whose record is gone gets nothing: no record, no facts.
    expect(pane.match(/turn \d/g)?.length).toBe(1);
  });

  it("between turns the tail is the newest assistant line — never tool output", () => {
    // Nothing streams and no tool runs. Tool OUTPUT must not become the tail
    // (the grep-debris regression): the walk is assistant-only, so the newest
    // narration wins, the older opener does not, and a child that has not
    // narrated yet shows its last completed call (tracker) or thinking… —
    // never `api.ts: 120 refs`.
    const h = harness(
      [
        makeRecord({
          id: "r2", parentAgentId: "main", description: "api endpoints", status: "running",
          session: {
            subscribe: () => () => {},
            messages: [
              { role: "user", content: "split the route handlers" },
              { role: "assistant", content: [{ type: "text", text: "I'll start by mapping the src/ directory." }] },
              { role: "toolResult", toolCallId: "t1", toolName: "bash", content: [{ type: "text", text: "src/api.ts\nsrc/routes.ts" }] } as never,
              { role: "assistant", content: [{ type: "text", text: "Two files own the routes." }] },
              { role: "toolResult", toolCallId: "t2", toolName: "bash", content: [{ type: "text", text: "api.ts: 120 refs\nroutes.ts: 14 refs" }] } as never,
            ],
          },
        }),
      ],
      { workflows, workflowRun: () => phasedRunSource() },
    );
    h.open();
    h.press(DOWN);
    h.press("\r"); // page W
    const pane = runPane(h.frame());
    // The NEWEST assistant line — not the opener, not the tool result, not "thinking…".
    expect(pane).toContain("↳ Two files own the routes.");
    expect(pane).not.toContain("I'll start by");
    expect(pane).not.toContain("api.ts: 120 refs");
    expect(pane).not.toContain("thinking…");
    // Two assistant messages → turn 2, derived where no tracker exists.
    expect(pane).toContain("turn 2");
  });

  it("← focuses the parent pane, → descends — the run page's roster is reachable without esc", () => {
    const h = runHarness();
    h.open();
    h.press(DOWN);
    h.press("\r"); // page W
    h.press("\u001b[D"); // ← : back on the roster, the run still selected
    const roster = h.frame().join("\n");
    expect(roster).toContain("❯ ● migrate-v2");
    expect(roster).toContain("⏎ open run");
    // ↑ from the run row walks onto the agent rows — the agents are reachable.
    h.press("\u001b[A");
    expect(h.frame().join("\n")).not.toContain("❯ ● migrate-v2");
    // → on a run row descends again (⏎'s alias).
    h.press("\u001b[B");
    h.press("\u001b[C");
    expect(h.frame().join("\n")).toContain("PHASES");
    // ← on W lands on the roster; ← from the roster does nothing — the
    // window must not close on it.
    h.press("\u001b[D");
    expect(h.frame().join("\n")).toContain("⏎ open run");
    h.press("\u001b[D");
    expect(h.settled()).toBe(false);
    expect(h.frame().join("\n")).toContain("⏎ open run");
  });

  it("← pops from WA to W", () => {
    const h = runHarness();
    h.open();
    h.press(DOWN);
    h.press("\r"); // W
    // The item cursor walks to m-1 — the agent with a record — and ⏎ opens WA.
    h.press("\u001b[B");
    h.press("\u001b[B");
    h.press("\u001b[B");
    h.press("\r");
    expect(h.frame().join("\n")).toContain("Esc back");
    h.press("\u001b[D"); // ← : WA → W
    expect(h.frame().join("\n")).toContain("PHASES");
  });

  it("W seeds both marks on the current phase row and draws one glyph there", () => {
    const h = runHarness();
    h.open();
    h.press(DOWN);
    h.press("\r"); // page W
    const pane = runPane(h.frame());
    expect(pane).toContain("❯ 2 migrate");
    expect(pane).toContain("RUNNING WORKFLOW AGENTS");
    // The seeded item cursor sits on the same phase row, so it doubles nothing.
    expect(marks(pane)).toBe(1);
    // No agent row is selected until the cursor walks into the list.
    expect(pane).not.toContain("❯ ✓ m-1");
  });

  it("↓ from the seed moves the cursor to the next phase row, a second `❯`", () => {
    const h = runHarness();
    h.open();
    h.press(DOWN);
    h.press("\r"); // W
    h.press(DOWN); // off the current phase and onto the next one
    const pane = runPane(h.frame());
    // The state mark stays where the run is; the cursor is the row below it.
    expect(pane).toContain("❯ 2 migrate");
    expect(pane).toContain("❯ 3 verify");
    expect(marks(pane)).toBe(2);
  });

  it("↓ walks the item cursor into the agents, leaving the state mark on the phase", () => {
    const h = runHarness();
    h.open();
    h.press(DOWN);
    h.press("\r"); // W
    for (let i = 0; i < 3; i++) h.press(DOWN); // phases 2, 3, then agent m-1
    const pane = runPane(h.frame());
    // Two marks, two rows: where the run is, and what `⏎` would open.
    expect(pane).toContain("❯ 2 migrate");
    expect(pane).toContain("❯ ✓ m-1");
    expect(marks(pane)).toBe(2);
    expect(pane).not.toContain("❯ 3 verify");
  });

  it("⏎ opens the agent the cursor addresses — the phase row's first agent, or the row it sits on", () => {
    const h = harness(
      [makeRecord({ id: "r1" }), makeRecord({ id: "r2" }), makeRecord({ id: "r3" })],
      { workflows, workflowRun: () => phasedRunSource() },
    );
    h.open();
    h.press(DOWN);
    h.press(DOWN);
    h.press(DOWN); // past all three agents, onto the run row
    h.press("\r"); // W — the cursor is seeded on the running phase `migrate`
    // The phase row's first agent is m-2 (phase `discover` holds m-1), so ⏎
    // at the seed must open m-2 — not the run's first row, m-1.
    h.press("\r");
    expect(h.frame().join("\n")).toMatch(/❯ . m-2/);
    expect(h.frame().join("\n")).not.toMatch(/❯ . m-1/);
    h.press(ESC);
    // And on an agent row: walk to m-3 (the phase's second agent) and open it.
    for (let i = 0; i < 5; i++) h.press(DOWN);
    h.press("\r");
    expect(h.frame().join("\n")).toMatch(/❯ . m-3/);
    // Round trip: moving WA's agent cursor and popping back leaves W's ❯ on
    // the agent WA was showing — the row ⏎ would reopen.
    h.press(DOWN);
    h.press(ESC);
    expect(h.frame().join("\n")).toMatch(/❯ . m-3/);
  });

  it("WA's left pane keeps the agent cursor and marks the run's phase beneath it", () => {
    // Both of the current phase's agents need a record: Enter on the seeded
    // phase row opens that phase's first agent, not the run's first row.
    const h = harness(
      [makeRecord({ id: "r1" }), makeRecord({ id: "r2" })],
      { workflows, workflowRun: () => phasedRunSource() },
    );
    h.open();
    h.press(DOWN);
    h.press(DOWN); // past both agents, onto the run row
    h.press("\r"); // W
    h.press("\r"); // WA — migrate's first agent (m-2)
    const left = h.frame()
      .filter(isSplitRow)
      .map(leftCell)
      .join("\n");
    expect(left).toMatch(/❯ . m-2/);
    expect(left).toContain("PHASES");
    expect(left).toContain("❯ 2 migrate");
  });

  it("L marks the current phase and keeps the agent cursor on the run's list", () => {
    const h = runHarness();
    h.open();
    h.press(DOWN);
    h.press("\r"); // W
    h.press("l"); // L
    const left = h.frame()
      .filter(isSplitRow)
      .map(leftCell)
      .join("\n");
    expect(left).toContain("PHASES");
    expect(left).toContain("❯ 2 migrate");
    // The 18-column master clamps the section label — the prefix is what
    // survives there; the wide W pane pins the full label.
    expect(left).toContain("RUNNING WORKFLOW");
    expect(left).toContain("❯ ✓ m-1");
  });
});

describe("page footers, headers and esc", () => {
  const workflows = (): FleetWorkflow[] => [{
    id: "wf_1", name: "migrate-v2", status: "running", doneCount: 1, totalCount: 2,
    startedAt: Date.now() - 60_000, tokens: 500,
  }];

  it("R's footer carries the transcript's keys; the run row's footer names the run's", () => {
    const h = harness([makeRecord({ id: "a1" })], { workflows });
    h.open();
    const agentFooter = h.frame().join("\n");
    expect(agentFooter).toContain("x stop");
    expect(agentFooter).toContain("m md");
    expect(agentFooter).toContain("Esc close");
    // The conversation is already the pane: there is no descent to advertise.
    expect(agentFooter).not.toContain("⏎ transcript");
    h.press(DOWN);
    const runFooter = h.frame().join("\n");
    expect(runFooter).toContain("⏎ open run");
    expect(runFooter).toContain("s stop run");
    expect(runFooter).not.toContain("x stop");
  });

  it("W's footer advertises the run page's keys", () => {
    const h = harness([makeRecord({ id: "a1" })], { workflows, workflowRun: () => runSource() });
    h.open();
    h.press(DOWN);
    h.press("\r");
    const frame = h.frame().join("\n");
    expect(frame).toContain("l run log");
    expect(frame).toContain("Esc roster");
  });

  it("keeps the title constant while the header block names the item", () => {
    const h = harness(
      [makeRecord({ id: "r1" })],
      { workflows, workflowRun: () => runSource() },
    );
    h.open();
    // The 20-column title cell never carries a breadcrumb: the same title on
    // every page, and the right pane's identity block is what names the item.
    expect(h.frame()[0]).toContain(" Agents & Workflows ");
    h.press(DOWN);
    h.press("\r");
    expect(h.frame()[0]).toContain(" Agents & Workflows ");
    expect(h.frame().join("\n")).toContain("● migrate-v2  workflow");
    h.press("\r");
    expect(h.frame()[0]).toContain(" Agents & Workflows ");
    expect(h.frame().join("\n")).toContain("Sleep then report 1");
  });

  it("esc pops exactly one level: SAL → WA → W → R", () => {
    const h = harness(
      [makeRecord({ id: "r1" })],
      { workflows, workflowRun: () => runSource() },
    );
    h.open();
    h.press(DOWN);
    h.press("\r"); // W
    h.press("\r"); // WA
    h.press("l"); // SAL
    expect(h.frame().join("\n")).toContain("spawn"); // the log grammar
    expect(h.frame().join("\n")).toContain("Esc back");
    h.press(ESC);
    expect(h.frame().join("\n")).toContain("waiting for first message");
    expect(h.frame().join("\n")).not.toContain("spawn");
    h.press(ESC);
    expect(h.frame().join("\n")).toContain("⏎ agent");
    expect(h.frame().join("\n")).toContain("PHASES");
    h.press(ESC);
    expect(h.frame().join("\n")).toContain("SUBAGENTS");
    expect(h.settled()).toBe(false);
    h.press(ESC); // the roster is the top: esc closes
    expect(h.settled()).toBe(true);
  });

  it("esc on the roster's transcript closes the hub — R is the top page", () => {
    const h = harness([makeRecord({ id: "a1" })]);
    h.open();
    // The roster page's pane is the conversation, and `Esc close` is the
    // anchor: there is no transcript page above the roster to ascend from.
    expect(h.frame().join("\n")).toContain("waiting for first message");
    expect(h.frame().join("\n")).toContain("Esc close");
    h.press(ESC);
    expect(h.settled()).toBe(true);
  });

  it("l straight on a subagent row opens the log page and esc returns to the roster", () => {
    const h = harness([makeRecord({ id: "a1" })]);
    h.open();
    h.press("l");
    const frame = h.frame().join("\n");
    expect(frame).toContain("spawn");
    expect(frame).toContain("Esc back");
    h.press(ESC);
    expect(h.frame().join("\n")).toContain("SUBAGENTS");
    expect(h.frame().join("\n")).toContain("Esc close");
    expect(h.settled()).toBe(false);
  });
});

describe("the footer band", () => {
  const workflows = (): FleetWorkflow[] => [{
    id: "wf_1", name: "migrate-v2", status: "running", doneCount: 1, totalCount: 2,
    startedAt: Date.now() - 60_000, tokens: 500,
  }];
  /** The footer row's content columns at 120: `│ <116> │`. */
  const bandOf = (frame: string[]) => (frame.at(-2) ?? "").slice(2, -2);
  /**
   * The band's two slots, split at the gap between them. The left slot's own
   * separators are single spaces, so the first run of two or more is the gap.
   */
  const slots = (content: string) => {
    const at = content.search(/ {2,}/);
    let end = at;
    while (content[end] === " ") end++;
    return { left: content.slice(0, at), gap: end - at, right: content.slice(end) };
  };

  it("R: the transcript's actions left, navigation and the twin right, flush to the edge", () => {
    const h = harness([makeRecord({ id: "a1" })], { workflows });
    h.open();
    const frame = h.frame();
    // The band rule carries the divider's `┴`; the bottom edge below is plain.
    expect(frame.at(-1)).not.toContain("┴");
    expect(frame.at(-3)!.indexOf("┴")).toBe(DIVIDER);
    expect(frame.at(-1)!.endsWith("╯")).toBe(true);
    const { left, gap, right } = slots(bandOf(frame));
    // The roster page's pane is the conversation, so the band is the
    // transcript's — with `Esc close`, because R is the window's top page.
    expect(left).toBe("Enter steer · x stop · m md");
    expect(gap).toBeGreaterThanOrEqual(2);
    // The full-screen twin would give the popup, so that is the twin it names.
    expect(right).toBe("PgUp/PgDn · j scroll · o expand · l log · p pause · c copy · f popup · Esc close");
    expect(bandOf(frame).length).toBe(116);
  });

  it("R: the run row's band offers the run's keys", () => {
    const h = harness([makeRecord({ id: "a1" })], { workflows });
    h.open();
    h.press(DOWN);
    expect(slots(bandOf(h.frame())).left).toBe("⏎ open run · s stop run · c copy");
  });

  it("R (agent): the transcript's actions ride the left slot, the page's keys the right", () => {
    const h = harness([makeRecord({ id: "a1" })], { workflows });
    h.open();
    const { left, right } = slots(bandOf(h.frame()));
    // The readout drops first, exactly as it does on the run-agent page.
    expect(left).toBe("Enter steer · x stop · m md");
    expect(right).toBe("PgUp/PgDn · j scroll · o expand · l log · p pause · c copy · f popup · Esc close");
  });

  it("TD: the expanded call swaps `m md` for `c copy diff` and drops `o expand`", () => {
    const h = harness([makeRecord({ id: "a1" })], { workflows });
    h.open(); // R — its pane is the transcript
    h.frame(); // the viewer builds on the first render
    expect(slots(bandOf(h.frame())).right).toContain("o expand");
    h.press("\x0f"); // ctrl+o — expand in place, no new page
    const { left, right } = slots(bandOf(h.frame()));
    expect(left).toContain("c copy diff");
    expect(left).not.toContain("m md");
    expect(right).not.toContain("o expand");
    // TD is a view state: the roster page is still the one beneath it.
    expect(h.frame().join("\n")).toContain("SUBAGENTS");
  });

  it("TD: plain `o` is the advertised alias of the same expand toggle", () => {
    const viaO = harness([makeRecord({ id: "a1" })], { workflows });
    viaO.open(); // R
    viaO.frame(); // the viewer builds on the first render
    const viaCtrlO = harness([makeRecord({ id: "a1" })], { workflows });
    viaCtrlO.open();
    viaCtrlO.frame();
    viaCtrlO.press("\x0f"); // ctrl+o — the resolved binding
    viaO.press("o"); // the band's advertised alias
    expect(bandOf(viaO.frame())).toBe(bandOf(viaCtrlO.frame()));
    expect(slots(bandOf(viaO.frame())).left).toContain("c copy diff");
    expect(bandOf(viaO.frame())).not.toContain("o expand");
    // The alias toggles both ways.
    viaO.press("o");
    expect(slots(bandOf(viaO.frame())).right).toContain("o expand");
    expect(slots(bandOf(viaO.frame())).left).toContain("m md");
  });

  it("SL: the log's readout rides the left slot, the page's keys the right", () => {
    const h = harness([makeRecord({ id: "a1" })], { workflows });
    h.open();
    h.press("l"); // SL straight from the roster
    const { left, right } = slots(bandOf(h.frame()));
    expect(left).toBe("2 lines · 100% · x stop");
    expect(right).toBe("↑↓ scroll · c copy tail · p pause agent · f popup · Esc back");
  });

  it("W: the band reads the run's counters and phase position", () => {
    const h = harness([makeRecord({ id: "r1" })], { workflows, workflowRun: () => runSource() });
    h.open();
    h.press(DOWN);
    h.press("\r"); // W
    const { left, right } = slots(bandOf(h.frame()));
    expect(left).toBe("1/2 agents · phase 1 of 1");
    expect(right).toBe("↑↓ item · PgUp/PgDn item · ⏎ agent · l run log · s stop run · f popup · Esc roster");
  });
});

describe("size ladder", () => {
  it("refuses a terminal below 40×10 with the spec's notification, drawing no frame", () => {
    const notify = vi.fn();
    const h = harness([makeRecord({ id: "a1" })], { notify }, { cols: 39, rows: 10 });
    h.open();
    expect(h.frame(39)).toEqual([]);
    expect(notify).toHaveBeenCalledWith(HUB_SIZE_REFUSAL, "warning");
  });

  it("refuses a terminal below 10 rows even at full width", () => {
    const notify = vi.fn();
    const h = harness([makeRecord({ id: "a1" })], { notify }, { cols: 120, rows: 9 });
    h.open();
    expect(h.frame(120)).toEqual([]);
    expect(notify).toHaveBeenCalledWith(HUB_SIZE_REFUSAL, "warning");
  });

  it("40–59 cols render a single stacked pane with no split tee", () => {
    const h = harness([makeRecord({ id: "a1", description: "alpha task" })], {}, { cols: 50, rows: 30 });
    h.open();
    const frame = h.frame(50);
    expect(frame[0]).not.toContain("┬");
    expect(frame.at(-1)).not.toContain("┴");
    expect(frame.join("\n")).toContain("SUBAGENTS");
    // ⏎ pushes the detail page full width; esc pops it — the page model with
    // one column. The pushed page opens with the identity block (the constant
    // title stays on the top edge).
    h.press("\r");
    expect(h.frame(50)[0]).toContain(" Agents & Workflows ");
    expect(h.frame(50).join("\n")).toContain("alpha task");
    expect(h.frame(50).join("\n")).toContain("waiting for first message");
    h.press(ESC);
    expect(h.frame(50).join("\n")).toContain("SUBAGENTS");
  });

  it("60–99 cols keep both panes", () => {
    const h = harness([makeRecord({ id: "a1" })], {}, { cols: 60, rows: 16 });
    h.open();
    const frame = h.frame(60);
    expect(frame[0]).toContain("┬");
    expect(frame.join("\n")).toContain("SUBAGENTS");
    expect(frame.join("\n")).toContain("● Agent");
  });

  it("fills the terminal exactly: chrome is the two edges, the band rule and the footer", () => {
    for (const rows of [10, 12, 15, 16, 24, 40]) {
      for (const cols of [40, 50, 60, 120]) {
        const h = harness([makeRecord({ id: "a1" })], {}, { cols, rows });
        h.open();
        const frame = h.frame(cols);
        expect(frame.length, `${cols}x${rows}`).toBe(rows);
        // The `❞` strip is gone: nothing sits between the body and the band rule.
        expect(frame.join("\n"), `${cols}x${rows}`).not.toContain("❞");
      }
    }
    // The stacked branch too — a pushed page with a short pane must still
    // fill its rows (it pads rather than leaving stale rows below the edge).
    const stacked = harness(
      [makeRecord({ id: "a1" })],
      { workflows: () => [{ id: "wf_1", name: "migrate-v2", status: "running", doneCount: 1, totalCount: 2, startedAt: Date.now() - 1000, tokens: 0 }] },
      { cols: 50, rows: 10 },
    );
    stacked.open();
    stacked.press(DOWN); // the run row
    stacked.press("\r"); // W as a full-width page
    expect(stacked.frame(50).length).toBe(10);
  });

  it("floors the body at six rows at ten rows — the floor is the arithmetic, not a clamp", () => {
    const h = harness([makeRecord({ id: "a1" })], {}, { cols: 120, rows: 10 });
    h.open();
    const frame = h.frame(120);
    // Top edge, six split body rows, band rule, footer, bottom edge.
    const body = frame.slice(1, -3);
    expect(body).toHaveLength(6);
    expect(body.every(isSplitRow)).toBe(true);
    expect(frame.at(-3)).toContain("┴");
    expect(frame.at(-1)!.endsWith("╯")).toBe(true);
  });

  it("the filter row is full width directly under the top edge and costs the body a row", () => {
    const h = harness([makeRecord({ id: "a1" })], {}, { cols: 120, rows: 10 });
    h.open();
    h.press("/");
    h.press("a");
    const frame = h.frame(120);
    expect(frame.length).toBe(10);
    // Row 1 is the filter input: full width — the two edge bars and no pane
    // divider — above the body.
    expect(frame[1]).toContain("> a");
    expect([...frame[1]].filter(ch => ch === "│")).toHaveLength(2);
    expect(isDivider(frame[1][DIVIDER])).toBe(false);
    // The body gives up the row the filter takes: five, not six.
    const body = frame.slice(2, -3);
    expect(body).toHaveLength(5);
    expect(body.every(isSplitRow)).toBe(true);
  });
});

describe("per-row keys", () => {
  const workflows = (): FleetWorkflow[] => [{
    id: "wf_1", name: "migrate-v2", status: "running", doneCount: 1, totalCount: 2,
    startedAt: Date.now() - 60_000, tokens: 500,
  }];

  it("s on a workflow row stops the run; s on an agent row does not", () => {
    const stopWorkflow = vi.fn();
    const h = harness([makeRecord({ id: "a1" })], { workflows, stopWorkflow });
    h.open();
    h.press("s"); // agent row: no run to stop
    expect(stopWorkflow).not.toHaveBeenCalled();
    h.press(DOWN); // workflow row
    h.press("s");
    expect(stopWorkflow).toHaveBeenCalledWith("wf_1");
  });

  it("p on an agent row still pauses it; p has no run meaning on a workflow row", () => {
    const pauseAgent = vi.fn(() => undefined);
    const notify = vi.fn();
    const h = harness([makeRecord({ id: "a1" })], { workflows, pauseAgent, notify });
    h.open();
    h.press("p");
    expect(pauseAgent).toHaveBeenCalledWith("a1");
    h.press(DOWN);
    h.press("p");
    expect(pauseAgent).toHaveBeenCalledTimes(1);
  });

  it("k on the run log page scrolls rather than reaching the run's stop", () => {
    const stopWorkflow = vi.fn();
    const h = harness([makeRecord({ id: "r1" })], { workflows, stopWorkflow, workflowRun: () => runSource() });
    h.open();
    h.press(DOWN);
    h.press("\r"); // W
    h.press("l"); // L
    h.press("k"); // scroll-up on the log pages (D7), never a stop
    expect(stopWorkflow).not.toHaveBeenCalled();
    // The guarded failure mode: `k` falling through to the roster's
    // per-row stop for the focused record.
    expect(h.deps.manager.abort).not.toHaveBeenCalled();
    expect(h.frame().join("\n")).not.toContain("x again to STOP");
  });

  it("log pages open at the newest events, not the spawn line", () => {
    const h = harness(
      [makeRecord({ id: "r1" })],
      {
        agentActivity: new Map([["r1", { turnCount: 9, activeTools: [], responseText: "" } as never]]),
      },
      { rows: 10 },
    );
    h.open();
    h.press("l"); // SL — the body is three rows, the log is eleven lines
    const body = h.frame().filter(l => l.startsWith("│")).map(l => l.slice(23, 118).trimEnd());
    expect(body.join("\n")).not.toContain("spawn");
    expect(body.join("\n")).toContain("still running");
  });

  it("c on the run log page still has a subject: the run's most recently active agent", async () => {
    // The reason the W/L branch of `focusedRecord()` survives the status
    // strip: the log page's advertised `c copy tail` copies that agent's
    // result, and `p` pauses it.
    const copy = vi.spyOn(piHost, "copyToClipboard").mockResolvedValue(undefined);
    const h = harness(
      [makeRecord({ id: "r1", description: "schema tables", status: "completed", result: "the final answer" })],
      { workflows, workflowRun: () => runSource() },
    );
    h.open();
    h.press(DOWN);
    h.press("\r"); // W
    h.press("l"); // L
    h.press("c");
    for (let i = 0; i < 4; i++) await Promise.resolve();
    expect(copy).toHaveBeenCalledWith("the final answer");
    copy.mockRestore();
  });
});

/**
 * P8 — additive spec coverage. Everything P1–P7 broke was repinned in place;
 * these pins cover the spec's Tests section and the plan's D3/D4 readings.
 */
/** The right cell's content, trimmed of the frame's pad columns and border. */
const detailRows = (frame: string[]) => frame
  .filter(isSplitRow)
  .map(l => rightCell(l).slice(1, 96));

describe("P8 — roster grammar", () => {
  const many = (n: number) => Array.from({ length: n }, (_, i) =>
    makeRecord({ id: `a${i}`, alias: `agent-${i}`, description: `task ${i}`, startedAt: 1000 + i }));

  it("styles the group headers dim and bold, and selects nothing on them", () => {
    const seen: Array<{ color?: string; bold?: string }> = [];
    const recording = {
      fg: (c: string, s: string) => { seen.push({ color: c, text: s }); return s; },
      bold: (s: string) => { seen.push({ bold: s }); return s; },
    };
    const h = harness(many(1), {
      workflows: () => [{ id: "wf_1", name: "audit", status: "running", doneCount: 1, totalCount: 2, startedAt: 1, tokens: 0 }],
    }, {}, recording);
    h.open();
    h.frame();
    expect(seen.some(e => e.bold === "SUBAGENTS")).toBe(true);
    expect(seen.some(e => e.bold === "WORKFLOWS")).toBe(true);
    // Dim is bound to the headers themselves, not merely present somewhere.
    expect(seen.some(e => e.color === "dim" && e.text === "SUBAGENTS")).toBe(true);
    expect(seen.some(e => e.color === "dim" && e.text === "WORKFLOWS")).toBe(true);
    // One ↓ crosses the WORKFLOWS header onto the run row: the header took no
    // cursor slot, so the first press lands on the run, not on the header.
    h.press("\x1b[B");
    expect(h.frame().join("\n")).toContain("❯ ● audit");
  });

  it("omits an empty group's header entirely", () => {
    const agentsOnly = harness(many(1));
    agentsOnly.open();
    expect(agentsOnly.frame().join("\n")).toContain("SUBAGENTS");
    expect(agentsOnly.frame().join("\n")).not.toContain("WORKFLOWS");

    const runsOnly = harness(many(0), {
      workflows: () => [{ id: "wf_1", name: "audit", status: "running", doneCount: 1, totalCount: 2, startedAt: 1, tokens: 0 }],
    });
    runsOnly.open();
    expect(runsOnly.frame().join("\n")).not.toContain("SUBAGENTS");
    expect(runsOnly.frame().join("\n")).toContain("WORKFLOWS");
  });

  it("windows a long roster on the cursor, clamped at both ends", () => {
    const h = harness(many(30), {}, { cols: 120, rows: 10 });
    h.open();
    // Six body rows: the list is windowed, never the whole roster.
    const names = (frame: string[]) => frame
      .filter(isSplitRow)
      .map(leftCell)
      .join("\n");
    expect(names(h.frame(120))).toContain("❯ ● agent-0");
    expect(names(h.frame(120))).not.toContain("agent-6");
    for (let i = 0; i < 29; i++) h.press(DOWN);
    const tail = names(h.frame(120));
    expect(tail).toContain("❯ ● agent-29");
    expect(tail).not.toContain("agent-0");
  });

  it("flips a settling agent's glyph in place without reordering the roster", () => {
    const records = [makeRecord({ id: "a1", alias: "alpha", startedAt: 1000 }), makeRecord({ id: "a2", alias: "beta", startedAt: 2000 })];
    const h = harness(records);
    h.open();
    const before = h.frame();
    const pointer = before.findIndex(l => l.includes("❯"));
    expect(before[pointer]).toContain("● alpha");
    records[0].status = "completed";
    const after = h.frame();
    expect(after[pointer]).toContain("✓ alpha");
    // Derived grouping, not re-sorting: the row count and the row order hold.
    expect(after.filter(l => l.startsWith("│")).length).toBe(before.filter(l => l.startsWith("│")).length);
    expect(after.findIndex(l => l.includes("❯"))).toBe(pointer);
  });
});

describe("P8 — the glyph set", () => {
  it("maps every subagent state and every run state to the spec's glyphs", () => {
    const states: Array<[string, string]> = [
      ["running", "●"], ["queued", "○"], ["paused", "‖"],
      ["completed", "✓"], ["error", "✗"], ["stopped", "·"], ["aborted", "·"],
    ];
    for (const [state, glyph] of states) {
      expect(statusGlyph(state as never, theme), state).toBe(glyph);
    }
    // `steered` reuses the completed tick, as it did before the restyle.
    expect(statusGlyph("steered" as never, theme)).toBe("✓");
    const runs: Array<[string, string]> = [["running", "●"], ["paused", "‖"], ["completed", "✓"], ["error", "✗"]];
    for (const [state, glyph] of runs) {
      expect(workflowStatusGlyph(state as never, theme), state).toBe(glyph);
    }
  });

  it("renders `‖` on a parked run row and on the agents it owns", () => {
    const paused: FleetWorkflow[] = [{
      id: "wf_1", name: "migrate-v2", status: "paused", doneCount: 1, totalCount: 2,
      startedAt: Date.now() - 60_000, tokens: 500,
    }];
    const h = harness(
      [makeRecord({ id: "r1", description: "schema tables" })],
      {
        workflows: () => paused,
        workflowRun: () => ({
          progress: [runAgent({ index: 0, label: "m-1", state: "start", recordId: "r1" })],
          task: { status: "paused", workflowName: "migrate-v2", startTime: Date.now() - 60_000 },
        }),
      },
    );
    h.open();
    h.press(DOWN); // the parked run row
    expect(h.frame().join("\n")).toContain("‖ migrate-v2");
    h.press("\r"); // W — the run's owned agent says why it looks alive
    const pane = h.frame().filter(isSplitRow).map(rightCell).join("\n");
    expect(pane).toContain("‖ m-1");
    expect(pane).toContain("run paused");
  });
});

describe("P8 — the R pane", () => {
  it("renders the selected agent's conversation, never the SL event grammar", () => {
    const h = harness(
      [makeRecord({
        id: "a1",
        description: "Find and fix the flaky tests",
        session: { subscribe: () => () => {}, messages: [{ role: "user", content: "Find and fix the flaky tests" }] },
      })],
      { agentActivity: new Map([["a1", { turnCount: 2, activeTools: [], responseText: "3 unstable detected" } as never]]) },
    );
    h.open();
    const pane = detailRows(h.frame()).join("\n");
    // The roster page's pane is the transcript itself: the same blocks the
    // embedded viewer draws everywhere, with the live `▍` tail.
    expect(pane).toContain("[User]");
    expect(pane).toContain("Find and fix the flaky tests");
    expect(pane).toContain("▍ 3 unstable detected");
    // The compact event log is the SL page's grammar, not the pane's.
    expect(pane).not.toContain("spawn");
    // And there is no descent left to advertise.
    expect(pane).not.toContain("(⏎ opens the full transcript)");
  });

  it("previews a selected run with its header block and the current phase's `❯`", () => {
    const h = harness([makeRecord({ id: "a1" })], {
      workflows: () => [{
        id: "wf_1", name: "migrate-v2", status: "running", doneCount: 1, totalCount: 3,
        startedAt: Date.now() - 60_000, tokens: 500,
      }],
      workflowRun: () => ({
        progress: [
          { type: "workflow_phase", index: 0, title: "discover" },
          { type: "workflow_phase", index: 1, title: "migrate" },
          runAgent({ index: 0, label: "m-1", state: "running", phaseIndex: 1, recordId: "r1" }),
        ],
        meta: { phases: [{ title: "discover" }, { title: "migrate" }, { title: "verify" }] },
        task: { status: "running", workflowName: "migrate-v2", startTime: Date.now() - 60_000 },
      }),
    });
    h.open();
    h.press(DOWN); // onto the run row
    const rows = detailRows(h.frame());
    expect(rows[0].trimEnd()).toContain("workflow · 1/3 agents");
    expect(rows[1].trimEnd()).toMatch(/^ +↳ phase 2 of 3/);
    expect(rows[2].trim()).toBe("─".repeat(95));
    expect(rows.join("\n")).toContain("❯ 2 migrate");
    expect(rows.filter(r => r.trim() !== "").at(-1)!.trimEnd()).toBe("(⏎ opens the run page)");
  });
});

describe("P8 — the footer band", () => {
  /** The band's content at 120: `│ <116> │`. */
  const bandOf = (frame: string[], width = 120) => {
    const band = frame.at(-2) ?? "";
    expect(band.length, "the band is one full-width row").toBe(width);
    return band.slice(2, -2);
  };
  const slots = (content: string) => {
    const at = content.search(/ {2,}/);
    let end = at;
    while (content[end] === " ") end++;
    return { left: content.slice(0, at), gap: end - at, right: content.slice(end) };
  };
  const R_LEFT = ["Enter steer", "x stop", "m md"];
  const R_RIGHT = ["PgUp/PgDn", "j scroll", "o expand", "l log", "p pause", "c copy", "f popup", "Esc close"];

  it("drops whole hints only, in the spec's order, as the band narrows", () => {
    for (const cols of [64, 72, 80, 100, 120]) {
      const h = harness([makeRecord({ id: "a1" })], {}, { cols, rows: 40 });
      h.open();
      const { left, gap, right } = slots(bandOf(h.frame(cols), cols));
      expect(gap, `${cols}: at least two columns between the slots`).toBeGreaterThanOrEqual(2);
      // The readout is the first thing the band gives up; the actions follow
      // right-to-left, so a surviving left slot never splits one in half.
      for (const hint of left ? left.split(" · ") : []) expect(R_LEFT, `${cols}: ${hint}`).toContain(hint);
      for (const hint of right ? right.split(" · ") : []) expect(R_RIGHT, `${cols}: ${hint}`).toContain(hint);
      // The escape anchor is the last thing to go.
      expect(right, `${cols}: Esc pinned`).toContain("Esc close");
      if (cols === 120) expect(left).toBe(R_LEFT.join(" · "));
      // Order, pinned at the narrowest width: the readout and every action are
      // gone, whole hints survive in the spec's order, and the pinned anchor
      // closes the right slot.
      if (cols === 64) {
        expect(left ?? "").toBe("");
        expect(right ?? "").toBe("PgUp/PgDn · j scroll · o expand · l log · Esc close");
      }
    }
  });

  it("keeps both slots flush: the right slot ends at the band's last content column", () => {
    const h = harness([makeRecord({ id: "a1" })], {}, { cols: 120, rows: 40 });
    h.open();
    const band = (h.frame(120).at(-2) ?? "");
    expect(band.slice(2, -2).length).toBe(116);
    expect(band.slice(2, -2).trimEnd()).toBe(band.slice(2, -2));
  });
});

describe("P8 — transcript grammar parity and refusal behavior", () => {
  it("T and WA render the same block set from the same viewer; WA leads `↳` with the run", () => {
    const messages = [
      { role: "user", content: "Migrate the schema in db.ts to v2" },
      { role: "assistant", content: [
        { type: "thinking", thinking: "The v1 tables are created in init(); migrate needs a dual-write shim." },
        { type: "text", text: "Adding a dual-write shim around init()." },
      ] },
    ];
    const h = harness(
      [makeRecord({ id: "r1", description: "schema tables", status: "completed", result: "done", session: { subscribe: () => () => {}, messages } })],
      {
        workflows: () => [{
          id: "wf_1", name: "migrate-v2", status: "running", doneCount: 1, totalCount: 2,
          startedAt: Date.now() - 60_000, tokens: 500,
        }],
        workflowRun: () => runSource(),
        agentActivity: new Map([["r1", { turnCount: 1, activeTools: [], responseText: "" } as never]]),
      },
    );
    h.open();
    h.press("\r"); // T
    const transcript = detailRows(h.frame()).join("\n");
    expect(transcript).toContain("[User]");
    expect(transcript).toContain("Migrate the schema in db.ts to v2");
    expect(transcript).toContain("[Assistant]");
    expect(transcript).toContain("Adding a dual-write shim");
    expect(transcript).toContain("✻ thinking");
    expect(transcript).toContain("───");
    h.press(ESC);
    h.press(DOWN);
    h.press("\r"); // W
    h.press("\r"); // WA
    const embedded = detailRows(h.frame()).join("\n");
    expect(embedded).toContain("[User]");
    expect(embedded).toContain("[Assistant]");
    expect(embedded).toContain("✻ thinking");
    expect(embedded).toContain("───");
    // The same agent on the roster page has no parent run; on WA the run name
    // leads the line.
    expect(transcript).toContain("  ↳ —");
    expect(embedded).toContain("  ↳ migrate-v2");
  });

  it("a live agent's transcript carries the `▍` tail on R and on WA", () => {
    const h = harness(
      [makeRecord({
        id: "r1",
        description: "schema tables",
        session: { subscribe: () => () => {}, messages: [{ role: "user", content: "Migrate the schema in db.ts to v2" }] },
      })],
      {
        workflows: () => [{
          id: "wf_1", name: "migrate-v2", status: "running", doneCount: 1, totalCount: 2,
          startedAt: Date.now() - 60_000, tokens: 500,
        }],
        workflowRun: () => runSource(),
        agentActivity: new Map([["r1", { turnCount: 2, toolUses: 0, activeTools: new Map([["t1", { toolName: "edit", args: { path: "db.ts" } }]]), responseText: "" } as never]]),
      },
    );
    h.open();
    expect(detailRows(h.frame()).join("\n")).toContain("▍");
    h.press(DOWN);
    h.press("\r"); // W
    h.press("\r"); // WA
    expect(detailRows(h.frame()).join("\n")).toContain("▍");
  });

  it("refuses `s` off a run row, arms `x` two-press, and leaves `p` on a run row alone", () => {
    const stopWorkflow = vi.fn();
    const pauseAgent = vi.fn(() => undefined);
    const h = harness([makeRecord({ id: "a1" })], {
      stopWorkflow,
      pauseAgent,
      workflows: () => [{
        id: "wf_1", name: "migrate-v2", status: "running", doneCount: 1, totalCount: 2,
        startedAt: Date.now() - 60_000, tokens: 500,
      }],
    });
    h.open();
    h.press("s"); // agent row: no run to stop
    expect(stopWorkflow).not.toHaveBeenCalled();
    h.press("x"); // agent row: the first press only arms
    expect(h.deps.manager.abort).not.toHaveBeenCalled();
    expect(h.frame().join("\n")).toContain("x again to STOP");
    h.press("x");
    expect(h.deps.manager.abort).toHaveBeenCalledWith("a1");
    h.press(DOWN); // the run row
    h.press("p"); // a run row has no agent to pause
    expect(pauseAgent).not.toHaveBeenCalled();
    h.press("s");
    expect(stopWorkflow).toHaveBeenCalledWith("wf_1");
  });
});

describe("P10 — runId opens the run's page and the run controls live there", () => {
  const workflows = (status: FleetWorkflow["status"] = "running"): FleetWorkflow[] => [{
    id: "wf_1", name: "migrate-v2", status, doneCount: 1, totalCount: 3,
    startedAt: Date.now() - 60_000, tokens: 500,
  }];
  const records = () => [
    makeRecord({ id: "r1" }),
    makeRecord({ id: "r2" }),
    makeRecord({ id: "r3" }),
  ];
  const controls = (over: Partial<WorkflowRunControls> = {}): WorkflowRunControls => ({
    pause: vi.fn(() => true),
    resume: vi.fn(() => true),
    skip: vi.fn(() => true),
    retry: vi.fn(() => true),
    ...over,
  });
  /** The footer row's content columns at 120: `│ <116> │`. */
  const bandOf = (frame: string[]) => (frame.at(-2) ?? "").slice(2, -2);
  const openRun = (depsOver: Partial<AgentHubDeps> = {}, status: FleetWorkflow["status"] = "running") =>
    harness(records(), { workflows: () => workflows(status), workflowRun: () => phasedRunSource(), ...depsOver });

  it("runId opens page W with the run selected and the item cursor on the current phase", () => {
    const h = openRun();
    h.open({ runId: "wf_1" });
    const frame = h.frame();
    // The master's ❯ is on the run row, and the right pane is the run's page.
    expect(frame.join("\n")).toContain("❯ ● migrate-v2");
    expect(frame.join("\n")).toContain("❯ 2 migrate");
    expect(frame.join("\n")).toContain("RUNNING WORKFLOW AGENTS");
    expect(bandOf(frame)).toContain("Esc roster");
    // The item cursor is seeded on the CURRENT phase, not left at the top:
    // ⏎ opens migrate's first agent (m-2), not discover's (m-1). The string
    // pins above cannot see this — the phase's state mark draws the same
    // `❯ 2 migrate` wherever the cursor sits.
    h.press("\r");
    const agentPage = h.frame().join("\n");
    expect(agentPage).toContain("m-2");
    expect(agentPage).not.toContain("❯ m-1");
  });

  it("a runId with no detail source falls back to the roster instead of an empty run page", () => {
    const h = openRun({ workflowRun: id => (id === "wf_1" ? phasedRunSource() : undefined) });
    h.open({ runId: "wf_gone" });
    expect(h.frame().join("\n")).toContain("SUBAGENTS");
    expect(h.frame().at(-2)).toContain("Esc close");
  });

  it("a run off the roster still opens on W — the menu lists every task of the session", () => {
    // Finished long ago: the roster's linger window has dropped it, but the
    // task (the detail source) is still there. `/agents → Workflows` lists
    // it, so opening it must land on W — phases in the detail pane, the
    // run's identity block naming it — not back on the roster preview.
    const h = openRun({ workflows: () => [] });
    h.open({ runId: "wf_1" });
    const frame = h.frame().join("\n");
    expect(frame).toContain("PHASES");
    expect(frame).toContain("❯ 2 migrate");
    expect(frame).toContain("workflow · ");
    expect(frame).not.toContain("(⏎ opens");
  });

  it("p on W pauses a running run; on a parked run it resumes", () => {
    const running = controls();
    const h = openRun({ workflowControls: () => running });
    h.open({ runId: "wf_1" });
    expect(bandOf(h.frame(160))).toContain("p pause run");
    h.press("p");
    expect(running.pause).toHaveBeenCalledTimes(1);

    const parked = controls();
    const parkedHub = openRun({ workflowControls: () => parked }, "paused");
    parkedHub.open({ runId: "wf_1" });
    expect(bandOf(parkedHub.frame(160))).toContain("p resume run");
    parkedHub.press("p");
    expect(parked.resume).toHaveBeenCalledTimes(1);
    expect(parked.pause).not.toHaveBeenCalled();
  });

  it("s/r on WA skip and retry the current run agent; a done agent refuses both", () => {
    const c = controls();
    const h = openRun({ workflowControls: () => c });
    h.open({ runId: "wf_1" });
    h.press("\r"); // WA on the current phase's first agent — m-2, running
    expect(h.frame().join("\n")).toMatch(/❯ . m-2/);
    // Wider than 120: at the spec's frame the fitter gives `r retry` up first.
    expect(bandOf(h.frame(160))).toContain("s skip");
    expect(bandOf(h.frame(160))).toContain("r retry");
    h.press("s");
    expect(c.skip).toHaveBeenCalledWith(1);
    h.press("r");
    expect(c.retry).toHaveBeenCalledWith(1);

    h.press("\x1b[A"); // ↑ — m-1, which finished
    expect(h.frame().join("\n")).toMatch(/❯ . m-1/);
    expect(bandOf(h.frame(160))).not.toContain("s skip");
    expect(bandOf(h.frame(160))).not.toContain("r retry");
    h.press("s");
    h.press("r");
    expect(c.skip).toHaveBeenCalledTimes(1);
    expect(c.retry).toHaveBeenCalledTimes(1);
  });

  it("advertises no run control when the extension wired none", () => {
    const h = openRun();
    h.open({ runId: "wf_1" });
    expect(bandOf(h.frame(160))).not.toContain("p pause run");
    h.press("p"); // no-op, not a crash
    h.press("\r"); // WA
    expect(bandOf(h.frame(160))).not.toContain("s skip");
    h.press("s");
    h.press("r");
    expect(h.frame().at(-1)).toContain("╯");
  });

  it("renders Pi native chrome when uiStyle is pi", () => {
    const h = harness([makeRecord({ id: "a1" })], { uiStyle: () => "pi" });
    h.open();
    const frame = h.frame(120);
    expect(frame[0]).toBe("\u2594".repeat(120));
    expect(frame[0]).not.toContain("╭");
    expect(frame[0]).not.toContain("╮");
    expect(frame.at(-1)).toBe("\u2581".repeat(120));
    expect(frame.at(-1)).not.toContain("╰");
    expect(frame.at(-1)).not.toContain("╯");
  });
});
