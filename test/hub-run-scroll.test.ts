/**
 * hub-run-scroll.test.ts — the run page's agent list reaching its bottom.
 *
 * The W pane used to window the agent list in *entries* while the rows are
 * what get clipped (`padLines`): a live agent spends two lines — its `↳` tail
 * is never empty while running — so with more agents than fit, the pane drew
 * the top of the list and silently cut the bottom, cursor row included, and
 * nothing (keys or wheel) could bring the bottom agents in. These pins hold
 * the row-based window, the tail-follow when the cursor is on a phase, and
 * the keys that jump the item cursor.
 */
import { describe, expect, it, vi } from "vitest";
import type { AgentManager } from "../src/agent-manager.js";
import type { AgentRecord } from "../src/types.js";
import { AgentHub, type AgentHubDeps, type HubUICtx, openAgentHub } from "../src/ui/agent-hub.js";
import type { AgentActivity } from "../src/ui/agent-widget.js";
import type { FleetWorkflow } from "../src/ui/fleet-list.js";
import type { WorkflowDialogSource } from "../src/ui/workflow-view.js";
import type { WorkflowAgentEntry } from "../src/workflow/progress.js";

const DOWN = "\x1b[B";
const UP = "\x1b[A";
const HOME = "\x1b[H";
const END = "\x1b[F";
const PAGEUP = "\x1b[5~";
const PAGEDOWN = "\x1b[6~";
const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };

function plain(line: string): string {
  return line.replace(/\u001b\[[0-9;]*m/g, "").replace(/<\/?[a-zA-Z]+>|\*/g, "");
}

function makeRosterRecord(id: string): AgentRecord {
  return {
    id,
    type: "general-purpose",
    description: `roster ${id}`,
    status: "running",
    toolUses: 0,
    startedAt: Date.now() - 5000,
    session: { subscribe: () => () => {}, messages: [] },
    lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
    compactionCount: 0,
  } as AgentRecord;
}

/** A run of `n` live agents in one phase — every row spends two lines. */
function bigRun(n: number): WorkflowDialogSource {
  const progress: Array<WorkflowAgentEntry> = Array.from({ length: n }, (_, i) => ({
    type: "workflow_agent" as const,
    index: i,
    label: `w-${i}`,
    state: "running" as const,
    phaseIndex: 0,
    recordId: `r${i}`,
  }));
  // No declared phases: every agent collapses into one group titled "Agents",
  // so the item walk is phase 0 then agents 1..n.
  return {
    progress,
    task: { status: "running", workflowName: "timing-wave", startTime: Date.now() - 60_000 },
  };
}

const oneWorkflow = (n: number): FleetWorkflow[] => [{
  id: "wf_1", name: "timing-wave", status: "running", doneCount: 0, totalCount: n,
  startedAt: Date.now() - 60_000, tokens: 0,
}];

/** Activity for every run agent, so each row carries a live `↳` tail. */
function tailActivity(n: number): Map<string, AgentActivity> {
  const map = new Map<string, AgentActivity>();
  for (let i = 0; i < n; i++) {
    map.set(`r${i}`, {
      turnCount: 1,
      activeTools: new Map(),
      responseText: `tail line ${i}`,
    } as never);
  }
  return map;
}

function harness(opts: { agents: number; rows: number; roster?: AgentRecord[] }) {
  const n = opts.agents;
  const fakeTui = {
    mode: "regular",
    requestRender: vi.fn(),
    terminal: { columns: 120, rows: opts.rows, write: vi.fn() },
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
        components.push(factory(fakeTui, theme, undefined, done) as (typeof components)[number]);
      });
    }),
  };
  const deps: AgentHubDeps = {
    manager: {
      listAgents: () => opts.roster ?? ([] as AgentRecord[]),
      abort: vi.fn(() => true),
      steer: vi.fn(() => true),
    } as unknown as AgentManager,
    agentActivity: tailActivity(n),
    showCost: false,
    uiStyle: () => "claude",
    workflows: () => oneWorkflow(n),
    workflowRun: () => bigRun(n),
  };
  return () => {
    void openAgentHub(ui as unknown as HubUICtx, deps, { runId: "wf_1" });
    return {
      frame: () => (components.at(-1)?.render(120) ?? []).map(plain),
      press: (data: string) => components.at(-1)?.handleInput(data),
      hub: () => components.at(-1)!,
      settled: () => settled,
    };
  };
}

/** The run pane's right cell at 120 columns — `│ <18> │ <95> │`. */
const DIVIDER = 1 + 18 + 2;
const DETAIL_WIDTH = 95;
const isSplitRow = (line: string) => line.startsWith("│") && (line[DIVIDER] === "│" || line[DIVIDER] === "▒" || line[DIVIDER] === "▓");
const rightCell = (line: string) => line.slice(DIVIDER + 1).slice(1, 1 + DETAIL_WIDTH);
const runPane = (frame: string[]) => frame.filter(isSplitRow).map(rightCell).join("\n");

describe("the run page's agent list reaches its bottom", () => {
  it("tails the list while the cursor is on a phase — the last agents are on screen", () => {
    const open = harness({ agents: 20, rows: 24 });
    const h = open();
    const pane = runPane(h.frame());
    expect(pane).toContain("RUNNING WORKFLOW AGENTS");
    // Twenty live rows cost 40 lines against an agent block of ~5: the window
    // cannot hold every agent, and the tail — not the top — is what it keeps.
    expect(pane).not.toContain("w-0");
    expect(pane).toContain("w-19");
    expect(pane).toContain("↳ tail line 19");
  });

  it("keeps the cursor's row whole when the cursor jumps to the last agent", () => {
    const h = harness({ agents: 20, rows: 24 })();
    h.press(END); // the item cursor jumps to the last agent
    const pane = runPane(h.frame());
    // The pointer row and its `↳` tail are both drawn — no clipped cursor.
    expect(pane).toContain("❯ ⠋ w-19");
    expect(pane).toContain("↳ tail line 19");
    // And the top of the list is what gave way.
    expect(pane).not.toContain("w-0");
  });

  it("recenters on the first agent when the cursor walks down onto it", () => {
    const h = harness({ agents: 20, rows: 24 })();
    h.press(DOWN); // phase row → agent w-0
    const pane = runPane(h.frame());
    expect(pane).toContain("❯ ⠋ w-0");
    expect(pane).not.toContain("w-19");
  });

  it("PgDn/PgUp stride the item cursor; Home jumps back to the phase", () => {
    const h = harness({ agents: 20, rows: 24 })();
    h.press(END);
    expect(runPane(h.frame())).toContain("❯ ⠋ w-19");
    h.press(PAGEUP); // item 20 → item 10, agent w-9
    expect(runPane(h.frame())).toContain("❯ ⠋ w-9");
    h.press(PAGEDOWN); // item 10 → item 20, the end again
    expect(runPane(h.frame())).toContain("❯ ⠋ w-19");
    h.press(HOME);
    expect(runPane(h.frame())).toContain("❯ 1 Phase 0");
  });

  it("the wheel moves the run's item cursor, not the roster behind the page", () => {
    // The roster stays pinned left on W, and wheeling there used to move that
    // hidden selection — a no-op for the run pane. The wheel is the run page's:
    // it strides the phases+agents cursor the panes follow.
    const h = harness({
      agents: 20,
      rows: 24,
      roster: [makeRosterRecord("a1"), makeRosterRecord("a2"), makeRosterRecord("a3"), makeRosterRecord("a4")],
    })();
    const rosterBefore = h.hub().selected;
    h.hub().applyWheel(3);
    // Wheel down three items from the seeded phase row lands on w-2…
    expect(runPane(h.frame())).toContain("❯ ⠋ w-2");
    // …and the roster selection behind the page did not move.
    expect(h.hub().selected).toBe(rosterBefore);
    h.hub().applyWheel(-3);
    expect(runPane(h.frame())).toContain("❯ 1 Phase 0");
    expect(h.hub().selected).toBe(rosterBefore);
    expect(h.settled()).toBe(false);
  });

  it("↑ at the seeded phase row stays put — the walk clamps at the top", () => {
    const h = harness({ agents: 20, rows: 24 })();
    for (let i = 0; i < 3; i++) h.press(UP);
    const pane = runPane(h.frame());
    expect(pane).toContain("PHASES");
    expect(pane).toContain("❯ 1 Phase 0");
  });

  it("a list that fits is drawn whole, top to bottom", () => {
    const h = harness({ agents: 4, rows: 30 })();
    const pane = runPane(h.frame());
    expect(pane).toContain("w-0");
    expect(pane).toContain("w-3");
    expect(pane).toContain("↳ tail line 3");
  });

  it("↓ from the phase walks the cursor into the agents past the window's edge", () => {
    // From the seeded phase row, one ↓ must land on w-0 — the first item —
    // even though the tail-follow was showing the list's far end.
    const h = harness({ agents: 20, rows: 24 })();
    h.press(DOWN);
    expect(runPane(h.frame())).toContain("❯ ⠋ w-0");
  });
});
