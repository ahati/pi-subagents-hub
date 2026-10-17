import { describe, expect, it, vi } from "vitest";
import type { AgentManager } from "../src/agent-manager.js";
import type { AgentRecord } from "../src/types.js";
import {
  AgentHub,
  type AgentHubDeps,
  type HubUICtx,
  openAgentHub,
} from "../src/ui/agent-hub.js";
import type { AgentActivity } from "../src/ui/agent-widget.js";
import { MASTER_LIST_WIDTH, PANE_PADDING } from "../src/ui/window-frame.js";

const DOWN = "\x1b[B";
const RIGHT = "\x1b[C";
const LEFT = "\x1b[D";
const ESC = "\x1b";

const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };

function plain(line: string): string {
  return line.replace(/\u001b\[[0-9;]*m/g, "").replace(/<\/?[a-zA-Z]+>|\*/g, "");
}

function makeRecord(over: Partial<AgentRecord> = {}): AgentRecord {
  const type = over.type ?? "general-purpose";
  return {
    id: "a1",
    type,
    alias: over.alias ?? (over.type ? over.type : "explore"),
    description: "explore codebase",
    status: "running",
    toolUses: 0,
    startedAt: Date.now() - 5000,
    session: { subscribe: () => () => {}, messages: [] },
    lifetimeUsage: { input: 1000, output: 50, cacheWrite: 0 },
    compactionCount: 0,
    ...over,
  } as AgentRecord;
}

function harness(
  agents: AgentRecord[],
  depsOver: Partial<AgentHubDeps> = {},
  size: { cols?: number; rows?: number } = {},
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
        components.push(factory(fakeTui, theme, undefined, done) as (typeof components)[number]);
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
    notify: ui.notify,
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
    hub: () => components.at(-1),
  };
}

const DIVIDER = 1 + MASTER_LIST_WIDTH + 2 * PANE_PADDING;
const leftCell = (line: string) => line.slice(1, DIVIDER);
const rightCell = (line: string) => line.slice(DIVIDER + 1);

describe("hub nested agents — hybrid 1-level tree and drill-down", () => {
  it("shows immediate children indented by 1 level beneath their parent in the roster", () => {
    const parent = makeRecord({ id: "p1", description: "explore task", type: "explore" });
    const child1 = makeRecord({
      id: "c1",
      parentAgentId: "p1",
      description: "crawl api",
      type: "crawl",
      status: "running",
    });
    const child2 = makeRecord({
      id: "c2",
      parentAgentId: "p1",
      description: "parse spec",
      type: "parse",
      status: "completed",
    });

    const h = harness([parent, child1, child2]);
    h.open();
    const frame = h.frame();
    const body = frame.filter(l => l.startsWith("│"));
    const leftRows = body.map(leftCell);

    // Parent row is visible
    expect(leftRows.some(r => r.includes("explore"))).toBe(true);
    // Immediate children are rendered indented directly beneath the parent
    expect(leftRows.some(r => r.includes("crawl"))).toBe(true);
    expect(leftRows.some(r => r.includes("parse"))).toBe(true);

    // Tree branching: first child has ├, last child has └
    const crawlRow = leftRows.find(r => r.includes("crawl"));
    const parseRow = leftRows.find(r => r.includes("parse"));
    expect(crawlRow).toBeDefined();
    expect(parseRow).toBeDefined();
    expect(crawlRow).toMatch(/[├│↳]/);
    expect(parseRow).toMatch(/[└↳]/);
  });

  it("navigates down into a child row and updates the detail pane with child identity and transcript", () => {
    const parent = makeRecord({ id: "p1", description: "explore task", type: "explore" });
    const child = makeRecord({
      id: "c1",
      parentAgentId: "p1",
      description: "crawl api",
      type: "crawl",
      status: "running",
    });

    const h = harness([parent, child]);
    h.open();

    // Initially cursor is on parent
    let frame = h.frame();
    let body = frame.filter(l => l.startsWith("│"));
    expect(body.some(l => rightCell(l).includes("explore task"))).toBe(true);

    // Move DOWN onto child
    h.press(DOWN);
    frame = h.frame();
    body = frame.filter(l => l.startsWith("│"));

    // Cursor is now on child in left pane
    const leftRows = body.map(leftCell);
    expect(leftRows.some(r => r.includes("❯") && r.includes("crawl"))).toBe(true);

    // Right pane reflects child identity and includes parent name in header
    expect(body.some(l => rightCell(l).includes("crawl api"))).toBe(true);
    expect(body.some(l => rightCell(l).includes("↳ explore task") || rightCell(l).includes("↳ explore"))).toBe(true);
  });

  it("stops only the child agent when x is confirmed on a child row", () => {
    const parent = makeRecord({ id: "p1", description: "parent task", type: "explore" });
    const child = makeRecord({
      id: "c1",
      parentAgentId: "p1",
      description: "child task",
      type: "crawl",
      status: "running",
    });

    const h = harness([parent, child]);
    h.open();

    // Move to child
    h.press(DOWN);
    // Press x once: arms stop
    h.press("x");
    expect(h.deps.manager.abort).not.toHaveBeenCalled();

    // Press x second time: aborts child only
    h.press("x");
    expect(h.deps.manager.abort).toHaveBeenCalledWith("c1");
    expect(h.deps.manager.abort).not.toHaveBeenCalledWith("p1");
  });

  it("refuses pause on a nested child agent with a notification", () => {
    const parent = makeRecord({ id: "p1", description: "parent task" });
    const child = makeRecord({ id: "c1", parentAgentId: "p1", description: "child task" });
    const pauseAgent = vi.fn();

    const h = harness([parent, child], { pauseAgent });
    h.open();

    // Move to child
    h.press(DOWN);
    // Press p to pause
    h.press("p");

    // pauseAgent must NOT be called for child
    expect(pauseAgent).not.toHaveBeenCalled();
    // Notification must explain refusal
    expect(h.ui.notify).toHaveBeenCalledWith(
      expect.stringMatching(/agents owned by another agent refuse to pause|cannot pause/i),
      "warning",
    );
  });

  it("displays delegation badge ↳N on a child with grandchildren and resets view on right arrow", () => {
    const parent = makeRecord({ id: "p1", description: "explore task", type: "explore" });
    const child = makeRecord({
      id: "c1",
      parentAgentId: "p1",
      description: "crawl api",
      type: "crawl",
      status: "running",
    });
    const grandchild1 = makeRecord({
      id: "g1",
      parentAgentId: "c1",
      alias: "chunk-1",
      description: "chunk 1",
      type: "chunk",
      status: "running",
    });
    const grandchild2 = makeRecord({
      id: "g2",
      parentAgentId: "c1",
      alias: "chunk-2",
      description: "chunk 2",
      type: "chunk",
      status: "completed",
    });

    const h = harness([parent, child, grandchild1, grandchild2]);
    h.open();

    const frame = h.frame();
    const body = frame.filter(l => l.startsWith("│"));
    const leftRows = body.map(leftCell);

    // Child row has a badge for its 2 children (grandchildren of parent)
    const childRow = leftRows.find(r => r.includes("crawl"));
    expect(childRow).toBeDefined();
    expect(childRow).toMatch(/↳2|\[2\]/);

    // Grandchildren are NOT shown inline at root level (strictly 1-level tree)
    expect(leftRows.some(r => r.includes("chunk-1"))).toBe(false);

    // Move DOWN to child
    h.press(DOWN);

    // Press RIGHT arrow to drill down (resets the view to child's scope)
    h.press(RIGHT);

    const scopedFrame = h.frame();
    const scopedBody = scopedFrame.filter(l => l.startsWith("│"));
    const scopedLeft = scopedBody.map(leftCell);

    // Now in crawl's scope: crawl is root, chunk 1 and chunk 2 are visible as 1-level children
    expect(scopedLeft.some(r => r.includes("crawl"))).toBe(true);
    expect(scopedLeft.some(r => r.includes("chunk-1"))).toBe(true);
    expect(scopedLeft.some(r => r.includes("chunk-2"))).toBe(true);

    // Press LEFT or ESC to ascend back to parent scope
    h.press(LEFT);
    const restoredFrame = h.frame();
    const restoredLeft = restoredFrame.filter(l => l.startsWith("│")).map(leftCell);

    // Top-level explore is visible again
    expect(restoredLeft.some(r => r.includes("explore"))).toBe(true);
    // Grandchildren are hidden again at top-level
    expect(restoredLeft.some(r => r.includes("chunk-1"))).toBe(false);
  });

  it("supports multi-level drill down and sequential Esc ascent", () => {
    const root = makeRecord({ id: "p1", alias: "root", description: "root", type: "explore" });
    const child = makeRecord({ id: "c1", parentAgentId: "p1", alias: "crawl", description: "child", type: "crawl" });
    const grandchild = makeRecord({ id: "g1", parentAgentId: "c1", alias: "parse", description: "grandchild", type: "parse" });
    const greatGrandchild = makeRecord({ id: "gg1", parentAgentId: "g1", alias: "token", description: "great grandchild", type: "token" });

    const h = harness([root, child, grandchild, greatGrandchild]);
    h.open();

    // 1. At root scope: root and child are visible
    let leftRows = h.frame().filter(l => l.startsWith("│")).map(leftCell);
    expect(leftRows.some(r => r.includes("root"))).toBe(true);
    expect(leftRows.some(r => r.includes("crawl"))).toBe(true);
    expect(leftRows.some(r => r.includes("parse"))).toBe(false);

    // Drill into child (c1)
    h.press(DOWN);
    h.press(RIGHT);

    leftRows = h.frame().filter(l => l.startsWith("│")).map(leftCell);
    expect(leftRows.some(r => r.includes("crawl"))).toBe(true);
    expect(leftRows.some(r => r.includes("parse"))).toBe(true);
    expect(leftRows.some(r => r.includes("token"))).toBe(false);
    expect(h.frame().some(l => l.includes("Esc root"))).toBe(true);

    // Drill into grandchild (g1)
    h.press(DOWN);
    h.press(RIGHT);

    leftRows = h.frame().filter(l => l.startsWith("│")).map(leftCell);
    expect(leftRows.some(r => r.includes("parse"))).toBe(true);
    expect(leftRows.some(r => r.includes("token"))).toBe(true);
    expect(h.frame().some(l => l.includes("Esc crawl"))).toBe(true);

    // Ascend with ESC: should return to c1 scope
    h.press(ESC);
    leftRows = h.frame().filter(l => l.startsWith("│")).map(leftCell);
    expect(leftRows.some(r => r.includes("crawl"))).toBe(true);
    expect(leftRows.some(r => r.includes("parse"))).toBe(true);
    expect(leftRows.some(r => r.includes("token"))).toBe(false);
    expect(h.settled()).toBe(false);

    // Ascend with ESC: should return to root scope
    h.press(ESC);
    leftRows = h.frame().filter(l => l.startsWith("│")).map(leftCell);
    expect(leftRows.some(r => r.includes("root"))).toBe(true);
    expect(leftRows.some(r => r.includes("crawl"))).toBe(true);
    expect(leftRows.some(r => r.includes("parse"))).toBe(false);
    expect(h.settled()).toBe(false);

    // Press ESC at root: closes the hub
    h.press(ESC);
    expect(h.settled()).toBe(true);
  });

  it("preserves parent anchor when a nested child matches the filter", () => {
    const parent = makeRecord({ id: "p1", alias: "alpha-agent", description: "alpha parent", type: "alpha" });
    const child1 = makeRecord({ id: "c1", parentAgentId: "p1", alias: "beta-agent", description: "beta child", type: "beta" });
    const child2 = makeRecord({ id: "c2", parentAgentId: "p1", alias: "gamma-agent", description: "gamma child", type: "gamma" });

    const h = harness([parent, child1, child2]);
    h.open();

    // Filter by beta: child1 matches. Parent must stay as an anchor row.
    h.press("/");
    h.press("b");
    h.press("e");
    h.press("t");
    h.press("a");
    h.press("\r");

    let leftRows = h.frame().filter(l => l.startsWith("│")).map(leftCell);
    expect(leftRows.some(r => r.includes("alpha-agent"))).toBe(true);
    expect(leftRows.some(r => r.includes("beta-agent"))).toBe(true);
    expect(leftRows.some(r => r.includes("gamma-agent"))).toBe(false);

    // Clear filter with / then Esc
    h.press("/");
    h.press(ESC);

    // Filter by alpha: only parent matches, children do not match
    h.press("/");
    h.press("a");
    h.press("l");
    h.press("p");
    h.press("h");
    h.press("a");
    h.press("\r");

    leftRows = h.frame().filter(l => l.startsWith("│")).map(leftCell);
    expect(leftRows.some(r => r.includes("alpha-agent"))).toBe(true);
    expect(leftRows.some(r => r.includes("beta-agent"))).toBe(false);
    expect(leftRows.some(r => r.includes("gamma-agent"))).toBe(false);
  });

  it("navigates nested agents in stacked mode (< 60 columns)", () => {
    const parent = makeRecord({ id: "p1", alias: "parent-x", description: "parent x", type: "parent" });
    const child = makeRecord({ id: "c1", parentAgentId: "p1", alias: "child-y", description: "child y", type: "child" });
    const grandchild = makeRecord({ id: "g1", parentAgentId: "c1", alias: "grandchild-z", description: "grandchild z", type: "grandchild" });

    // 50 columns forces stackedMode
    const h = harness([parent, child, grandchild], {}, { cols: 50, rows: 25 });
    h.open();

    // Roster is shown in stacked mode
    let frame = h.frame(50).join("\n");
    expect(frame).toContain("parent-x");
    expect(frame).toContain("child-y");
    expect(frame).not.toContain("grandchild-z");

    // Move to child
    h.press(DOWN);

    // In stacked mode, Enter pushes detailOpen
    h.press("\r");
    frame = h.frame(50).join("\n");
    expect(frame).toContain("child y");

    // Esc closes detailOpen and returns to stacked roster
    h.press(ESC);
    frame = h.frame(50).join("\n");
    expect(frame).toContain("parent-x");
    expect(frame).toContain("child-y");

    // Press RIGHT on child with grandchild to drill down
    h.press(RIGHT);
    const scopedLines = h.frame(50).filter(l => l.startsWith("│")).map(l => l.slice(1, -1));
    expect(scopedLines.some(l => l.includes("child-y"))).toBe(true);
    expect(scopedLines.some(l => l.includes("grandchild-z"))).toBe(true);
    expect(scopedLines.some(l => l.includes("● parent-x"))).toBe(false);
    expect(h.frame(50).some(l => l.includes("Esc parent-x"))).toBe(true);
  });

  it("allows pause on top-level root agent but refuses pause on nested child", () => {
    const parent = makeRecord({ id: "p1", description: "top task", status: "running" });
    const child = makeRecord({ id: "c1", parentAgentId: "p1", description: "nested task", status: "running" });
    const pauseAgent = vi.fn();

    const h = harness([parent, child], { pauseAgent });
    h.open();

    // 1. Cursor is on root agent: pressing p pauses root
    h.press("p");
    expect(pauseAgent).toHaveBeenCalledWith("p1");

    // 2. Cursor moves down to child: pressing p is refused
    h.press(DOWN);
    h.press("p");
    expect(pauseAgent).toHaveBeenCalledTimes(1);
    expect(h.ui.notify).toHaveBeenCalledWith(
      expect.stringMatching(/agents owned by another agent refuse to pause/i),
      "warning",
    );
  });

  it("q key closes the hub even when inside a scoped view", () => {
    const parent = makeRecord({ id: "p1", alias: "p1", description: "p1" });
    const child = makeRecord({ id: "c1", parentAgentId: "p1", alias: "c1", description: "c1" });
    const grandchild = makeRecord({ id: "g1", parentAgentId: "c1", alias: "g1", description: "g1" });

    const h = harness([parent, child, grandchild]);
    h.open();

    // Move to child and drill down
    h.press(DOWN);
    h.press(RIGHT);
    expect(h.settled()).toBe(false);

    // Press q: closes immediately rather than ascending
    h.press("q");
    expect(h.settled()).toBe(true);
  });
});
