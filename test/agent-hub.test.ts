import * as piHost from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { AgentManager } from "../src/agent-manager.js";
import type { AgentRecord } from "../src/types.js";
import { AgentHub, type AgentHubDeps, type HubUICtx, openAgentHub } from "../src/ui/agent-hub.js";
import { type AgentActivity } from "../src/ui/agent-widget.js";

// ---- Key sequences (see node_modules/@earendil-works/pi-tui/dist/keys.js) ----
const ESC = "\x1b";
const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };

/** Visible text of a rendered line: ANSI stripped (agent badges), markers removed. */
function plain(line: string): string {
  return line.replace(/\u001b\[[0-9;]*m/g, "").replace(/<\/?[a-zA-Z]+>|\*/g, "");
}

function sessionOf(...messages: string[]): AgentRecord["session"] {
  return {
    subscribe: () => () => {},
    messages: messages.map(content => ({ role: "user", content })),
  } as AgentRecord["session"];
}

function makeRecord(over: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "a1",
    type: "general-purpose",
    description: "Sleep then report 1",
    status: "running",
    toolUses: 0,
    startedAt: Date.now(),
    session: { subscribe: () => () => {}, messages: [] },
    lifetimeUsage: { input: 13100, output: 0, cacheWrite: 0 },
    compactionCount: 0,
    ...over,
  } as AgentRecord;
}

/** Records with a session, so the roster lists them and chat can open. */
function fakeManager(agents: AgentRecord[]): AgentManager {
  return {
    listAgents: () => agents,
    abort: vi.fn(() => true),
    steer: vi.fn(() => true),
  } as unknown as AgentManager;
}

/**
 * A `ctx.ui` double that keeps every overlay OPEN and records what was asked
 * for — the hub's popup ↔ full-screen toggle closes and reopens its overlay,
 * so tests drive the sequence of components, not a single one.
 */
interface Harness {
  /** Components handed back by `custom`, in open order (last = current). */
  components: Array<AgentHub & { handleInput(data: string): void; render(width: number): string[] }>;
  /** The `overlayOptions` of each `custom` call, in open order. */
  optionSets: Array<{ overlay?: boolean; overlayOptions?: Record<string, unknown> }>;
  /** Let the reopen loop advance: resolve → loop → next `custom` → component. */
  flush(): Promise<void>;
  /** Render the current component full-frame and strip styling. */
  frame(width?: number): string[];
  /** Feed a key to the current component. */
  press(data: string): void;
  /** Whether the hub's outermost promise has settled. */
  settled(): boolean;
}

function harness(agents: AgentRecord[], depsOver: Partial<AgentHubDeps> = {}, opts: { tuiMode?: string; theme?: any } = {}) {
  const fakeTui = {
    mode: opts.tuiMode ?? "regular",
    requestRender: vi.fn(),
    terminal: { columns: 120, rows: 40, write: vi.fn() },
  };
  const activeTheme = opts.theme ?? theme;
  const components: Harness["components"] = [];
  const optionSets: Harness["optionSets"] = [];
  let settled = false;

  const ui = {
    notify: vi.fn(),
    custom: vi.fn(async (factory: (...args: unknown[]) => unknown, options?: Record<string, unknown>) => {
      optionSets.push(options ?? {});
      return await new Promise<undefined>(resolve => {
        const done = (r: undefined) => {
          if (r === "toggle") return resolve("toggle" as never);
          settled = true;
          resolve(undefined);
        };
        components.push(factory(fakeTui, activeTheme, undefined, done) as Harness["components"][number]);
      });
    }),
  };

  const manager = fakeManager(agents);
  const deps: AgentHubDeps = {
    manager,
    agentActivity: new Map<string, AgentActivity>(),
    showCost: false,
    uiStyle: () => "claude",
    ...depsOver,
  };

  return {
    ui,
    deps,
    manager,
    open: (initial?: { agentId?: string; popup?: boolean }) => {
      const promise = openAgentHub(ui as unknown as HubUICtx, deps, initial);
      return { promise, settled: () => settled, components, optionSets };
    },
    get components() {
      return components;
    },
    get optionSets() {
      return optionSets;
    },
    settled: () => settled,
    /** The fake TUI handed to the overlay factory (terminal.write spy included). */
    tui: fakeTui,
    flush: async () => {
      for (let i = 0; i < 4; i++) await Promise.resolve();
    },
    frame: (width = 120) => (components.at(-1)?.render(width) ?? []).map(plain),
    rawFrame: (width = 120) => components.at(-1)?.render(width) ?? [],
    press: (data: string) => components.at(-1)?.handleInput(data),
  };
}

describe("agent hub mouse wheel", () => {
  /** A hub whose wheel handler is the component's own (the host calls it directly). */
  function wheelHub(agents: AgentRecord[]) {
    const h = harness(agents);
    h.open();
    const component = h.components.at(-1)! as unknown as {
      handleMouse(e: { type: string; wheelDelta?: number }): { handled?: boolean } | undefined;
    };
    return { h, component };
  }

  it("keeps the conversation in the pane across an f toggle, and the wheel scrolls it", async () => {
    const messages = Array.from({ length: 40 }, (_, i) => ({ role: "user", content: `message number ${i}` }));
    const h = harness([
      makeRecord({ id: "a1", alias: "alpha", description: "alpha task", startedAt: Date.now() - 5000, session: { subscribe: () => () => {}, messages } }),
      makeRecord({ id: "a2", alias: "beta", description: "beta task", startedAt: Date.now() - 2000 }),
    ]);
    h.open({ agentId: "a1" });
    expect(h.frame().join("\n")).toContain("message number 39"); // the tail
    h.press("f");
    await h.flush();
    // The popup and the full-screen twin are the same roster page, and the
    // page's pane is the conversation in both.
    expect(h.frame().join("\n")).toContain("SUBAGENTS");
    expect(h.frame().join("\n")).toContain("message number 39");
    const component = h.components.at(-1)! as unknown as {
      handleMouse(e: { type: string; wheelDelta?: number }): { handled?: boolean } | undefined;
    };
    expect(component.handleMouse({ type: "wheel", wheelDelta: -5 })).toEqual({ handled: true });
    // The wheel scrolled the transcript; the roster selection did not move.
    expect(h.frame().join("\n")).not.toContain("message number 39");
    expect(h.frame(240).join("\n")).toContain("❯ ● alpha");
  });

  it("moves the roster selection on a run row — the run preview owns no scroll — and consumes the event", () => {
    const h = harness(
      [makeRecord({ id: "a1", alias: "alpha", description: "alpha task", startedAt: Date.now() - 5000 })],
      {
        workflows: () => [
          { id: "wf_1", name: "audit", status: "running", doneCount: 0, totalCount: 1, startedAt: Date.now() - 1000, tokens: 0 },
          { id: "wf_2", name: "migrate", status: "running", doneCount: 0, totalCount: 1, startedAt: Date.now() - 500, tokens: 0 },
        ],
      },
    );
    h.open();
    h.frame(); // the first render builds the viewer the wheel dispatches to
    const component = h.components.at(-1)! as unknown as {
      handleMouse(e: { type: string; wheelDelta?: number }): { handled?: boolean } | undefined;
    };
    // The agent row's wheel belongs to its conversation, not the list.
    expect(component.handleMouse({ type: "wheel", wheelDelta: 1 })).toEqual({ handled: true });
    expect(h.frame(240).join("\n")).toContain("❯ ● alpha");
    h.press("\x1b[B"); // onto the first run row
    expect(h.frame(240).join("\n")).toContain("❯ ● audit");
    component.handleMouse({ type: "wheel", wheelDelta: 1 });
    expect(h.frame(240).join("\n")).toContain("❯ ● migrate");
    // Clamps at the end instead of wrapping.
    component.handleMouse({ type: "wheel", wheelDelta: 5 });
    expect(h.frame(240).join("\n")).toContain("❯ ● migrate");
    // Wheel up.
    component.handleMouse({ type: "wheel", wheelDelta: -1 });
    expect(h.frame(240).join("\n")).toContain("❯ ● audit");
  });

  it("ignores non-wheel events and empty deltas", () => {
    const { component } = wheelHub([makeRecord({ id: "a1" })]);
    expect(component.handleMouse({ type: "click" })).toBeUndefined();
    expect(component.handleMouse({ type: "wheel", wheelDelta: 0 })).toBeUndefined();
    expect(component.handleMouse({ type: "wheel" })).toBeUndefined();
  });

  it("scrolls the transcript on the roster page (the agent's pane)", () => {
    const messages = Array.from({ length: 40 }, (_, i) => ({
      role: "user",
      content: `message number ${i}`,
    }));
    const h = harness([makeRecord({ id: "a1", session: { subscribe: () => () => {}, messages } })]);
    h.open({ agentId: "a1" });
    const component = h.components.at(-1)! as unknown as {
      handleMouse(e: { type: string; wheelDelta?: number }): { handled?: boolean } | undefined;
    };
    const followed = h.frame().join("\n");
    expect(followed).toContain("message number 39"); // auto-following the tail
    expect(component.handleMouse({ type: "wheel", wheelDelta: -5 })).toEqual({ handled: true });
    const scrolled = h.frame().join("\n");
    expect(scrolled).not.toBe(followed);
    expect(scrolled).not.toContain("message number 39");
  });
});

describe("agent hub mouse in regular TUI mode", () => {
  /** SGR report: 64 = wheel up, 65 = wheel down. */
  const wheel = (button: number) => `\x1b[<${button};10;5M`;

  it("captures mouse reporting while open and restores it on close", async () => {
    const h = harness([makeRecord({ id: "a1" })]);
    h.open();
    // Enable sequence written once, on construction.
    const writes = h.tui.terminal.write.mock.calls.map(c => c[0] as string);
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain("\x1b[?1006h");

    h.press("q"); // close → dispose → restore
    await h.flush();
    const after = h.tui.terminal.write.mock.calls.map(c => c[0] as string);
    expect(after).toHaveLength(2);
    expect(after[1]).toContain("\x1b[?1006l");
  });

  it("does not capture in fullscreen mode (pi dispatches there)", () => {
    const h = harness([makeRecord({ id: "a1" })], {}, { tuiMode: "fullscreen" });
    h.open();
    expect(h.tui.terminal.write).not.toHaveBeenCalled();
    h.press("q");
    expect(h.tui.terminal.write).not.toHaveBeenCalled();
  });

  it("parses wheel bytes from input and scrolls the conversation", () => {
    const messages = Array.from({ length: 40 }, (_, i) => ({ role: "user", content: `message number ${i}` }));
    const h = harness([makeRecord({ id: "a1", session: { subscribe: () => () => {}, messages } })]);
    h.open({ agentId: "a1" });
    const followed = h.frame().join("\n");
    expect(followed).toContain("message number 39");
    h.press(wheel(64)); // wheel up
    const scrolled = h.frame().join("\n");
    expect(scrolled).not.toBe(followed);
    expect(scrolled).not.toContain("message number 39");
  });

  it("parses wheel bytes in the roster views to move the selection", () => {
    const h = harness([
      makeRecord({ id: "a1", alias: "alpha", description: "alpha task", startedAt: Date.now() - 5000 }),
      makeRecord({ id: "a2", alias: "beta", description: "beta task" }),
    ]);
    h.open();
    h.press(wheel(65)); // wheel down → next row
    expect(h.frame(240).join("\n")).toContain("❯ ● beta");
  });

  it("consumes non-wheel mouse reports without moving anything", () => {
    // The identity block carries a live clock (`1ms (running)` ticks between
    // two renders), so the clock is frozen for the byte-for-byte comparison.
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const h = harness([makeRecord({ id: "a1", description: "alpha task" })]);
      h.open();
      const before = h.frame().join("\n");
      h.press("\x1b[<0;10;5M"); // left click
      h.press("\x1b[<0;10;5m"); // release
      expect(h.frame().join("\n")).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("agent hub page R — the roster beside the transcript", () => {
  const DOWN = "\x1b[B";
  const UP = "\x1b[A";

  it("renders the roster master beside the transcript, in both twins", async () => {
    const h = harness([
      makeRecord({ id: "a1", description: "alpha task", startedAt: Date.now() - 5000 }),
      makeRecord({ id: "a2", description: "beta task" }),
    ]);
    h.open({ agentId: "a1" });
    const frame = h.frame().join("\n");
    // One window: the constant title, the roster master, the transcript page.
    expect(frame).toContain(" Agents & Workflows ");
    expect(frame).toContain("SUBAGENTS");
    expect(frame).toContain("alpha task");
    expect(frame).toContain("waiting for first message");
    // The full-screen twin draws the same page — `f` is a frame size, not a view.
    h.press("f");
    await h.flush();
    const wide = h.frame().join("\n");
    expect(wide).toContain(" Agents & Workflows ");
    expect(wide).toContain("alpha task");
    expect(wide).toContain("waiting for first message");
  });

  it("wraps both panes in one overall border", () => {
    const h = harness([
      makeRecord({ id: "a1", description: "alpha task" }),
      makeRecord({ id: "a2", description: "beta task" }),
    ]);
    h.open({ agentId: "a1" });
    const frame = h.frame();
    // One shared frame: the pane list sits inside the border, the tee marks
    // the pane junction, the band rule ends the divider, and the last line
    // closes the window plain.
    expect(frame[0].startsWith("╭")).toBe(true);
    expect(frame[0]).toContain("┬");
    expect(frame.at(-3)).toContain("┴"); // top edge + body + band rule + footer
    expect(frame.at(-1)!.indexOf("┴")).toBe(-1);
    expect(frame.at(-1)!.endsWith("╯")).toBe(true);
    const pointerRow = frame.find(l => l.includes("❯"))!;
    expect(pointerRow.startsWith("│")).toBe(true); // the list is inside the frame
    expect(pointerRow).toContain("│"); // ...and the conversation beside it
    // Every content row carries the outer border on both sides...
    for (const line of frame.slice(1, -1)) {
      expect(line.startsWith("│")).toBe(true);
      expect(line.endsWith("│")).toBe(true);
    }
    // ...and no row carries a second frame of the viewer's own — the border
    // is overall, not the conversation's box with a list beside it.
    expect(frame.slice(1, -1).some(l => l.includes("╭") || l.includes("╰"))).toBe(false);
  });

  it("↓ retargets the embedded viewer: the body follows the selection, not just the identity", async () => {
    // Every other fixture shares an empty session, so a viewer that never
    // retargets would pass every other pin — only distinct bodies can see it.
    const h = harness([
      makeRecord({ id: "a1", description: "alpha task", startedAt: Date.now() - 5000, session: sessionOf("ALPHA-BODY") }),
      makeRecord({ id: "a2", description: "beta task", startedAt: Date.now() - 2000, session: sessionOf("BETA-BODY") }),
    ]);
    h.open({ agentId: "a1" });
    expect(h.frame().join("\n")).toContain("ALPHA-BODY");
    h.press(DOWN);
    const out = h.frame().join("\n");
    expect(out).toContain("beta task");
    expect(out).toContain("BETA-BODY");
    expect(out).not.toContain("ALPHA-BODY");
  });

  it("the steering composer owns ↑/↓ while it is open — the run's agent list must not move under the writer", async () => {
    const h = harness(
      [
        makeRecord({ id: "r1", description: "schema tables", startedAt: Date.now() - 5000 }),
        makeRecord({ id: "r2", description: "api endpoints", startedAt: Date.now() - 2000 }),
      ],
      {
        workflows: () => [{
          id: "wf_1", name: "migrate-v2", status: "running", doneCount: 1, totalCount: 2,
          startedAt: Date.now() - 60_000, tokens: 500,
        }],
        workflowRun: () => ({
          progress: [
            { type: "workflow_agent", index: 0, label: "m-1", state: "running", recordId: "r1" } as never,
            { type: "workflow_agent", index: 1, label: "m-2", state: "running", recordId: "r2" } as never,
          ],
          task: { status: "running", workflowName: "migrate-v2", startTime: Date.now() - 60_000 },
        }),
      },
    );
    h.open({ runId: "wf_1" }); // W
    h.press("\r"); // WA — the run's agent cursor
    h.frame(); // the viewer builds on the first render
    const leftPane = () => h.frame()
      .filter(l => l.startsWith("│") && l.indexOf("│", 1) === 21)
      .map(l => l.slice(1, 21))
      .join("\n");
    expect(leftPane()).toMatch(/❯ . m-1/);
    h.press("\r"); // open the composer
    const viewer = (h.components.at(-1) as unknown as { viewer?: { composing: boolean } }).viewer;
    expect(viewer?.composing).toBe(true);
    h.press("\x1b[B"); // an edit key for the message, not a selection move
    expect(viewer?.composing).toBe(true);
    expect(leftPane()).toMatch(/❯ . m-1/);
    h.press(ESC); // cancel the composer — ↓ is a selection move again
    h.press("\x1b[B");
    expect(leftPane()).toMatch(/❯ . m-2/);
  });

  it("↓ walks off the last agent onto the run rows — arrows jump between agents and workflows", async () => {
    const h = harness(
      [makeRecord({ id: "a1", alias: "alpha", description: "alpha task", startedAt: Date.now() - 5000 })],
      {
        workflows: () => [{
          id: "wf_1", name: "migrate-v2", status: "running", doneCount: 2, totalCount: 5,
          startedAt: Date.now() - 72_000, tokens: 500,
        }],
        workflowRun: () => ({
          progress: [{ type: "workflow_phase", index: 0, title: "discover" }],
          task: { status: "running", workflowName: "migrate-v2", startTime: Date.now() - 72_000 },
        }),
      },
    );
    h.open({ agentId: "a1" }); // the popup twin, the roster page with the agent selected
    h.press(DOWN); // off the last agent, across the WORKFLOWS header
    const roster = h.frame().join("\n");
    // The page became the roster with the RUN selected: its overview preview
    // and the run's own footer keys.
    expect(roster).toContain("❯ ● migrate-v2");
    expect(roster).toContain("⏎ open run");
    expect(roster).not.toContain("Esc roster");
    h.press("\r"); // ⏎ descends into the run
    const run = h.frame().join("\n");
    expect(run).toContain("PHASES");
    expect(run).toContain("Esc roster");
    // And ↑ from the roster walks back across the header without wrapping.
    h.press(ESC);
    h.press(UP);
    const back = h.frame().join("\n");
    expect(back).toContain("❯ ● alpha");
  });

  it("↓ moves to the next agent's conversation, ↑ back, clamped at the ends", async () => {
    const h = harness([
      makeRecord({ id: "a1", description: "alpha task", startedAt: Date.now() - 5000 }),
      makeRecord({ id: "a2", description: "beta task", startedAt: Date.now() - 2000 }),
      makeRecord({ id: "a3", description: "gamma task" }),
    ]);
    h.open({ agentId: "a2" });
    expect(h.frame().join("\n")).toContain("beta task");
    h.press(DOWN);
    expect(h.frame().join("\n")).toContain("gamma task");
    h.press(DOWN); // clamps at the last agent (no wrap)
    expect(h.frame().join("\n")).toContain("gamma task");
    h.press(UP);
    expect(h.frame().join("\n")).toContain("beta task");
    h.press(UP);
    expect(h.frame().join("\n")).toContain("alpha task");
    h.press(UP); // clamps at the first
    expect(h.frame().join("\n")).toContain("alpha task");
    expect(h.settled()).toBe(false);
  });

  it("the pane list marks the selected row", async () => {
    const h = harness([
      makeRecord({ id: "a1", description: "alpha task", startedAt: Date.now() - 5000 }),
      makeRecord({ id: "a2", description: "beta task" }),
    ]);
    h.open({ agentId: "a1" });
    const firstIdx = h.frame().findIndex(l => l.includes("❯"));
    expect(firstIdx).toBeGreaterThan(0);
    h.press(DOWN);
    const secondIdx = h.frame().findIndex(l => l.includes("❯"));
    expect(secondIdx).toBeGreaterThan(firstIdx); // the pointer moved down the list
    // The conversation header switched agents.
    expect(h.frame().join("\n")).toContain("beta task");
  });

  it("ctrl+o toggles rich tool expansion on the transcript page — legacy and kitty encodings", () => {
    // D3 regression guard: the expand key must survive the hub's own key
    // funnel (mouse → filter → chat → viewer) in both the legacy byte (\x0f)
    // and the kitty-protocol encoding (\x1b[111;5u) — the fleet-bar fix
    // (eec6c4a) restored delivery; this pins the hub-side delegation.
    const h = harness([makeRecord({ id: "a1", description: "alpha task" })]);
    h.open({ agentId: "a1" });
    h.frame(); // the page builds its viewer on the first render
    const viewer = (h.components.at(-1) as any)?.viewer as { expanded: boolean } | undefined;
    expect(viewer, "the roster page's pane — the embedded viewer exists").toBeDefined();
    expect(viewer!.expanded).toBe(false);

    h.press("\x0f"); // legacy ctrl+o
    expect(viewer!.expanded).toBe(true);

    h.press("\x1b[111;5u"); // kitty ctrl+o — toggles back
    expect(viewer!.expanded).toBe(false);
  });

  it("skips workflow rows in the pane list", async () => {
    const h = harness([
      makeRecord({ id: "a1", description: "alpha task", startedAt: Date.now() - 5000 }),
      makeRecord({ id: "a2", description: "beta task" }),
    ], {
      workflows: () => [{
        id: "wf_1", name: "audit", status: "running", doneCount: 0, totalCount: 1,
        startedAt: Date.now() - 1000, tokens: 0,
      }],
    });
    h.open({ agentId: "a1" });
    h.press(DOWN); // a1 → a2 (the workflow has no conversation, so it is not listed)
    expect(h.frame().join("\n")).toContain("beta task");
  });

  it("does not rebuild the viewer when the move is a no-op (single agent)", () => {
    const h = harness([makeRecord({ id: "a1", description: "only task" })]);
    h.open({ agentId: "a1" });
    const before = h.components.length;
    h.press(DOWN);
    h.press(UP);
    expect(h.components.length).toBe(before); // same viewer instance, scroll kept
  });

  it("advertises the page's keys in the band and names the twin it would swap to", async () => {
    const h = harness([makeRecord({ id: "a1" })]);
    h.open({ agentId: "a1" });
    // A wide frame: the footer's fitter drops whole hints from the right, and
    // this pins that the page keys are what survives.
    const popup = h.frame(200).join("\n");
    expect(popup).toContain("l log");
    expect(popup).toContain("c copy");
    expect(popup).toContain("f full"); // the popup would give the fullscreen twin
    expect(popup).toContain("Esc close"); // R is the top page
    expect(popup).not.toContain("←→ agent");
    h.press("f");
    await h.flush();
    const wide = h.frame(200).join("\n");
    expect(wide).toContain("f popup"); // ...and back
    expect(wide).toContain("Esc close");
  });

  it("c copies a completed agent's response to the clipboard", async () => {
    // Stub the host helper pi 1.x exports; without the stub the real
    // clipboard chain runs and the Copied notification lands after flush.
    const copy = vi.spyOn(piHost, "copyToClipboard").mockResolvedValue(undefined);
    const notify = vi.fn();
    const h = harness(
      [makeRecord({ id: "a1", description: "done task", status: "completed", result: "the final answer" })],
      { notify },
    );
    h.open({ agentId: "a1" });
    h.press("c");
    await h.flush();
    expect(copy).toHaveBeenCalledWith("the final answer");
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("Copied \"done task\""), "info");
    copy.mockRestore();
  });

  it("c on a running agent explains there is nothing to copy yet", () => {
    const notify = vi.fn();
    const h = harness([makeRecord({ id: "a1", status: "running" })], { notify });
    h.open({ agentId: "a1" });
    h.press("c");
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("still running"), "info");
  });

  it("c warns when a settled agent has no result text", () => {
    const notify = vi.fn();
    const h = harness([makeRecord({ id: "a1", status: "stopped" })], { notify });
    h.open({ agentId: "a1" });
    h.press("c");
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("no result text"), "info");
  });
});

describe("agent hub open modes", () => {
  it("defaults to the windowed popup on the agent's conversation", () => {
    const h = harness([makeRecord()]);
    h.open({ agentId: "a1" });
    expect(h.optionSets[0]?.overlayOptions).toMatchObject({ width: "90%", maxHeight: "70%" });
    // Chat view, not the roster: the conversation border + empty-state line.
    const frame = h.frame().join("\n");
    expect(frame).toContain("waiting for first message");
    expect(frame).not.toContain("1 Agents");
  });

  it("sizes the popup frame to the overlay's 70% ceiling — band and footer included", () => {
    const h = harness([makeRecord()]);
    h.open({ agentId: "a1" });
    // pi clips the overlay at floor(terminalRows × 70%); the window budgets its
    // body against the same ceiling, so the last line is the bottom edge, not
    // the middle of the transcript.
    const frame = h.frame();
    expect(frame.length).toBe(28); // 40 rows × 70%
    expect(frame[0]).toContain("┬");
    expect(frame.at(-1)).toContain("╯");
    h.components.at(-1)?.dispose?.();
  });

  it("opens full-screen on the roster when no agent is given (/agents entry)", () => {
    const h = harness([makeRecord()]);
    h.open();
    expect(h.optionSets[0]?.overlayOptions).toMatchObject({
      anchor: "top-left",
      width: "100%",
      maxHeight: "100%",
      row: 0,
      col: 0,
      margin: 0,
    });
    const frame = h.frame(240).join("\n");
    expect(frame).toContain("Agents & Workflows");
    expect(frame).toContain("Sleep then report 1");
  });

  it("renders popup with unicode box borders and outer vertical rails even under uiStyle: pi", () => {
    const h = harness([makeRecord({ id: "a1" })], { uiStyle: () => "pi" });
    h.open({ agentId: "a1", popup: true });
    const frame = h.frame(120);
    // Top border has rounded corners
    expect(frame[0].startsWith("╭")).toBe(true);
    expect(frame[0].endsWith("╮")).toBe(true);
    // Middle rows have vertical rails
    for (let i = 1; i < frame.length - 1; i++) {
      expect(frame[i].startsWith("│")).toBe(true);
      expect(frame[i].endsWith("│")).toBe(true);
    }
    // Bottom border has rounded corners
    expect(frame.at(-1)?.startsWith("╰")).toBe(true);
    expect(frame.at(-1)?.endsWith("╯")).toBe(true);
    h.components.at(-1)?.dispose?.();
  });

  it("renders fullscreen with edge-to-edge rules and no outer rails under uiStyle: pi", () => {
    const h = harness([makeRecord({ id: "a1" })], { uiStyle: () => "pi" });
    h.open({ agentId: "a1", popup: false });
    const frame = h.frame(120);
    // Top border is edge-to-edge rule with tee
    expect(frame[0].startsWith("─")).toBe(true);
    expect(frame[0]).toContain("┬");
    // Middle rows have space margins on edges, no outer │ rails
    for (let i = 1; i < frame.length - 1; i++) {
      expect(frame[i]).not.toMatch(/^│/);
      expect(frame[i]).not.toMatch(/│$/);
    }
    // Bottom border is clean edge-to-edge rule
    expect(frame.at(-1)).toBe("─".repeat(120));
    h.components.at(-1)?.dispose?.();
  });

  it("styles the active roster selection with selectedBg when theme supports bg", () => {
    const customTheme = {
      fg: (_c: string, s: string) => s,
      bold: (s: string) => s,
      bg: (c: string, s: string) => `[bg:${c}]${s}[/bg]`,
    };
    const h = harness([makeRecord({ id: "a1" })], {}, { theme: customTheme });
    h.open({ popup: false });
    const raw = h.rawFrame(120).join("\n");
    expect(raw).toContain("[bg:selectedBg]");
    h.components.at(-1)?.dispose?.();
  });
});

describe("agent hub popup ↔ full-screen toggle", () => {
  it("f expands the popup into the full-screen hub, same conversation", async () => {
    const h = harness([makeRecord({ id: "a1" })]);
    h.open({ agentId: "a1" });
    h.press("f");
    await h.flush();
    expect(h.optionSets[1]?.overlayOptions).toMatchObject({ width: "100%", maxHeight: "100%" });
    // Chat carried across: still the conversation, not the roster.
    expect(h.frame().join("\n")).toContain("waiting for first message");
    // Exactly one identity block: the page's own, drawn by the frame — the
    // viewer `ensureViewer` builds contributes body rows only (the popup's
    // viewer would have drawn a second one).
    const arrows = h.frame().filter(l => l.includes("↳ "));
    expect(arrows).toHaveLength(1);
    expect(h.settled()).toBe(false);
  });

  it("f collapses the full-screen hub back to the windowed panel", async () => {
    const h = harness([makeRecord({ id: "a1" })]);
    h.open({ agentId: "a1" });
    h.press("f");
    await h.flush();
    h.press("f");
    await h.flush();
    expect(h.optionSets[2]?.overlayOptions).toMatchObject({ width: "90%", maxHeight: "70%" });
    expect(h.frame().join("\n")).toContain("waiting for first message");
  });

  it("Esc on R closes the hub — there is no transcript page to ascend from", async () => {
    const h = harness([makeRecord({ id: "a1" })]);
    const opened = h.open({ agentId: "a1" });
    h.press("f");
    await h.flush();
    // The roster page's pane is the conversation, so Esc is the window's own
    // close rather than a descent.
    expect(h.frame().join("\n")).toContain("waiting for first message");
    h.press(ESC);
    await h.flush();
    expect(h.settled()).toBe(true);
    expect(await opened.promise).toBeUndefined();
  });

  it("the popup twin budgets the activity view too: 28 rows on a 40-row terminal", async () => {
    const h = harness([makeRecord({ id: "a1", status: "running" })]);
    h.open();
    h.press("2"); // the activity view, reachable from the roster
    h.press("f"); // into the popup twin — still the activity view
    await h.flush();
    // 70 % of 40 is 28 — the frame's bottom edge and footer must land inside
    // the overlay, not be clipped off it (chrome is 6 rows here, not 4).
    expect(h.frame()).toHaveLength(28);
    expect(h.frame().at(-1)).toMatch(/^╰/);
  });

  it("f from the roster is a frame-size change only — the same page and its conversation stay up", async () => {
    const h = harness([makeRecord({ id: "a1", description: "the one" })]);
    h.open(); // full-screen roster
    h.press("f");
    await h.flush();
    expect(h.optionSets[1]?.overlayOptions).toMatchObject({ width: "90%", maxHeight: "70%" });
    const frame = h.frame().join("\n");
    // Same page in the popup frame: the roster master beside the selected
    // agent's conversation.
    expect(frame).toContain("SUBAGENTS");
    expect(frame).toContain("the one");
    expect(frame).toContain("waiting for first message");
    expect(frame).not.toContain("(⏎ opens the full transcript)");
  });

  it("the roster page's keys are the page's, in the popup twin too — l, c, p and x all land", () => {
    const pauseAgent = vi.fn(() => undefined);
    const notify = vi.fn();
    const h = harness([makeRecord({ id: "a1", status: "running" })], { pauseAgent, notify });
    h.open({ agentId: "a1" }); // the popup twin, the roster page with the agent selected
    h.press("l"); // the page's log key, not the viewer's
    expect(h.frame().join("\n")).toContain("Esc back");
    h.press(ESC); // back to T
    h.press("p");
    expect(pauseAgent).toHaveBeenCalledWith("a1");
    h.press("c"); // the page's copy resolves the page's agent
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("still running"), "info");
    h.press("x"); // two-press stop, armed by the page
    expect(h.manager.abort).not.toHaveBeenCalled();
    expect(h.frame().join("\n")).toContain("x again to STOP");
    h.press("x");
    expect(h.manager.abort).toHaveBeenCalledWith("a1");
  });

  it("f on the roster's transcript keeps the page — popup and fullscreen show the same conversation", async () => {
    const h = harness([makeRecord({ id: "a1" })]);
    h.open({ agentId: "a1" }); // popup, R with the agent selected
    h.press("f");
    await h.flush();
    expect(h.optionSets[1]?.overlayOptions).toMatchObject({ width: "100%", maxHeight: "100%" });
    const wide = h.frame().join("\n");
    expect(wide).toContain("waiting for first message");
    expect(wide).toContain("Esc close");
    h.press("f");
    await h.flush();
    expect(h.frame().join("\n")).toContain("waiting for first message");
  });

  it("a log page opened from the roster pops back to the roster after an f toggle", async () => {
    const h = harness([makeRecord({ id: "a1", description: "alpha task" })]);
    h.open(); // full-screen roster
    h.press("l"); // `l` on a roster row: SL, whose parent is the roster
    expect(h.frame().join("\n")).toContain("Esc back");
    h.press("f"); // frame-size change mid-log — the log page must survive the reopen
    await h.flush();
    h.press(ESC); // SL pops back to the roster, whose pane is the transcript
    const out = h.frame().join("\n");
    expect(out).toContain("waiting for first message");
    expect(out).toContain("Esc close");
    expect(out).not.toContain("spawn");
  });

  it("a stacked twin opened on an agent opens with the conversation pushed, and keeps it across f", async () => {
    const h = harness(
      [makeRecord({ id: "a1", alias: "alpha", description: "alpha task", startedAt: Date.now() - 5000 })],
      {}, { cols: 50, rows: 30 },
    );
    h.open({ agentId: "a1" });
    // The conversation is what was asked for — not the roster list.
    expect(h.frame(50).join("\n")).toContain("waiting for first message");
    expect(h.frame(50).join("\n")).not.toContain("SUBAGENTS");
    // The pushed pane is view state: it survives the frame-size toggle.
    h.press("f");
    await h.flush();
    expect(h.frame(50).join("\n")).toContain("waiting for first message");
  });

  it("a stacked twin's wheel drives the roster once the pane is popped, not the hidden viewer", () => {
    const h = harness(
      [
        makeRecord({ id: "a1", alias: "alpha", description: "alpha task", startedAt: Date.now() - 5000 }),
        makeRecord({ id: "a2", alias: "beta", description: "beta task", startedAt: Date.now() - 2000 }),
      ],
      {}, { cols: 50, rows: 30 },
    );
    h.open({ agentId: "a1" });
    h.press(ESC); // pop the pushed pane back to the roster
    expect(h.frame(50).join("\n")).toContain("SUBAGENTS");
    const component = h.components.at(-1)! as unknown as {
      handleMouse(e: { type: string; wheelDelta?: number }): { handled?: boolean } | undefined;
    };
    expect(component.handleMouse({ type: "wheel", wheelDelta: 1 })).toEqual({ handled: true });
    // The wheel moved the roster selection — the invisible viewer did not eat it.
    expect(h.frame(50).join("\n")).toContain("❯ ● beta");
  });

  it("the activity view owns keys and wheel while it is up, not the live viewer", async () => {
    const h = harness([makeRecord({ id: "a1", alias: "alpha", description: "alpha task" })]);
    h.open({ agentId: "a1" }); // R with a live viewer in the pane
    h.press("2"); // the activity view
    const frame = h.frame().join("\n");
    expect(frame).toContain("activity · 1 agents · 1 active");
    // A wheel moves the activity list's selection; the hidden viewer must not
    // consume it and scroll itself.
    const component = h.components.at(-1)! as unknown as {
      handleMouse(e: { type: string; wheelDelta?: number }): { handled?: boolean } | undefined;
    };
    expect(component.handleMouse({ type: "wheel", wheelDelta: 1 })).toEqual({ handled: true });
    expect(h.settled()).toBe(false);
  });

  it("an agent without a roster row still shows its identity and note when opened by id", () => {
    const h = harness([
      makeRecord({ id: "a1", alias: "alpha", description: "alpha task", startedAt: Date.now() - 5000 }),
      makeRecord({ id: "a2", alias: "swept", description: "swept task", session: undefined, status: "completed", startedAt: Date.now() - 4000 }),
    ]);
    h.open({ agentId: "a2" });
    const out = h.frame().join("\n");
    expect(out).toContain("swept task");
    expect(out).toContain("unavailable");
    expect(out).not.toContain("[User]");
  });

  it("carries selection and filter across the toggle", async () => {
    const h = harness([
      makeRecord({ id: "a1", description: "alpha task", startedAt: Date.now() - 5000 }),
      makeRecord({ id: "a2", description: "beta task" }),
    ]);
    h.open(); // full-screen roster
    h.press("2"); // activity tab
    h.press("f");
    await h.flush();
    h.press(ESC); // popup chat closes outright
    await h.flush();
    // Reopen full-screen: resumed on the activity tab, not the default table.
    expect(h.settled()).toBe(true);

    const h2 = harness([
      makeRecord({ id: "a1", description: "alpha task", startedAt: Date.now() - 5000 }),
      makeRecord({ id: "a2", description: "beta task" }),
    ]);
    h2.open(); // full-screen roster
    h2.press("/"); // filter open
    for (const ch of "beta") h2.press(ch);
    h2.press("\r"); // apply
    const frame = h2.frame(240).join("\n");
    expect(frame).toContain("beta task");
    expect(frame).not.toContain("alpha task");
    expect(frame).toContain("1/2 match");
  });
});

describe("agent hub roster", () => {
  it("filter / narrows rows, Esc clears it", () => {
    const h = harness([
      makeRecord({ id: "a1", description: "alpha task" }),
      makeRecord({ id: "a2", description: "beta task" }),
    ]);
    h.open();
    h.press("/");
    for (const ch of "zzz") h.press(ch);
    expect(h.frame().join("\n")).toContain("no matches");
    h.press(ESC); // clears the filter
    expect(h.frame(240).join("\n")).toContain("alpha task");
  });

  it("activity tab describes what each agent is doing", () => {
    const activity = new Map<string, AgentActivity>([[
      "a1",
      { activeTools: new Map([["call-1", "read"]]), toolUses: 3, responseText: "", turnCount: 2 },
    ]]);
    const h = harness([makeRecord({ id: "a1" })], { agentActivity: activity });
    h.open();
    h.press("2");
    const frame = h.frame().join("\n");
    expect(frame).toContain("activity");
    expect(frame).toContain("Agent"); // the display name of general-purpose
    expect(frame.toLowerCase()).toContain("read");
  });

  it("x twice stops the selected agent", () => {
    const h = harness([makeRecord({ id: "a1" })]);
    h.open();
    h.press("x");
    expect(h.manager.abort).not.toHaveBeenCalled();
    expect(h.frame().join("\n")).toContain("x again to STOP");
    h.press("x");
    expect(h.manager.abort).toHaveBeenCalledWith("a1");
  });

  it("p pauses the selected running agent and says so", () => {
    const pauseAgent = vi.fn(() => undefined);
    const notify = vi.fn();
    const h = harness([makeRecord({ id: "a1", status: "running" })], { pauseAgent, notify });
    h.open();
    expect(h.frame().join("\n")).toContain("p pause");
    h.press("p");
    expect(pauseAgent).toHaveBeenCalledWith("a1");
    expect(notify).toHaveBeenCalledWith('Paused "Sleep then report 1".', "info");
  });

  it("p resumes a paused agent, reports a refusal as a warning", () => {
    const DOWN = "\x1b[B";
    const resumeAgent = vi.fn(() => true);
    const pauseAgent = vi.fn(() => "worktree-isolated runs cannot pause");
    const notify = vi.fn();
    const h = harness(
      [makeRecord({ id: "a1", status: "paused" }), makeRecord({ id: "a2", status: "running" })],
      { resumeAgent, pauseAgent, notify },
    );
    h.open();
    h.press("p"); // a1 is paused → resume
    expect(resumeAgent).toHaveBeenCalledWith("a1");
    expect(notify).toHaveBeenCalledWith('Resuming "Sleep then report 1".', "info");

    h.press(DOWN); // a2 is running → pause refused
    h.press("p");
    expect(pauseAgent).toHaveBeenCalledWith("a2");
    expect(notify).toHaveBeenCalledWith('Cannot pause "Sleep then report 1" — worktree-isolated runs cannot pause.', "warning");
  });

  it("p leaves a settled agent alone — continuing a finished run is /agents resume's job", () => {
    const pauseAgent = vi.fn(() => undefined);
    const resumeAgent = vi.fn(() => true);
    const h = harness([makeRecord({ id: "a1", status: "completed" })], { pauseAgent, resumeAgent });
    h.open();
    h.press("p");
    expect(pauseAgent).not.toHaveBeenCalled();
    expect(resumeAgent).not.toHaveBeenCalled();
  });

  it("p on the transcript page pauses the agent being viewed", () => {
    const pauseAgent = vi.fn(() => undefined);
    const notify = vi.fn();
    const h = harness([makeRecord({ id: "a1", status: "running" })], { pauseAgent, notify });
    h.open({ agentId: "a1" });
    h.press("p");
    expect(pauseAgent).toHaveBeenCalledWith("a1");
    expect(notify).toHaveBeenCalledWith('Paused "Sleep then report 1".', "info");
  });

  it("run rows keep the done/total counter and truncate the name into the 18-column cell", () => {
    const h = harness([makeRecord({ id: "a1" })], {
      workflows: () => [{
        id: "wf_1", name: "migrate-v2-schema-rewrite", status: "running", doneCount: 3, totalCount: 5,
        startedAt: Date.now() - 1000, tokens: 0,
      }],
    });
    h.open();
    h.press("\u001b[B"); // onto the run row
    const row = h.frame().filter(l => l.startsWith("│")).find(l => l.includes("❯ ●"));
    expect(row).toBeDefined();
    // The master cell is 18 content columns: the name gives way, the counter
    // does not. (Row bytes: `│ ` + the cell + ` │`.)
    expect(row!.slice(1, 21)).toBe(" ❯ ● migrate-v… 3/5 ");
  });

  it("a wide done/total counter still survives — the prefix and name give way", () => {
    const h = harness([makeRecord({ id: "a1" })], {
      workflows: () => [{
        id: "wf_1", name: "migrate-v2-schema-rewrite", status: "running", doneCount: 1234, totalCount: 9999,
        startedAt: Date.now() - 1000, tokens: 0,
      }],
    });
    h.open();
    h.press("\u001b[B"); // onto the run row
    const row = h.frame().filter(l => l.startsWith("│")).find(l => l.slice(1, 21).includes("1234/9999"));
    expect(row).toBeDefined();
    // `1234/9999` is 9 columns: the name truncates to fit, the counter is
    // whole, and the row still fills exactly the 18-column cell.
    expect(row!.slice(1, 21)).toBe(" ❯ ● mig… 1234/9999 ");
  });

  it("Enter on a workflow row opens page W in the same window", async () => {
    const h = harness([makeRecord({ id: "a1" })], {
      workflows: () => [{
        id: "wf_1", name: "audit", status: "running", doneCount: 1, totalCount: 2,
        startedAt: Date.now() - 1000, tokens: 500,
      }],
    });
    h.open();
    // The roster groups SUBAGENTS first, then WORKFLOWS: the workflow row is
    // one below the single agent row, and the header between them takes no
    // cursor slot.
    h.press("\u001b[B");
    h.press("\r");
    // The run opens as page W inside the same window — no second overlay.
    expect(h.settled()).toBe(false);
    expect(h.components).toHaveLength(1);
    const frame = h.frame().join("\n");
    // The constant title names the window; the header block names the run.
    expect(h.frame()[0]).toContain(" Agents & Workflows ");
    expect(frame).toContain("● audit  workflow · 1/2 agents");
    expect(frame).toContain("⏎ agent");
  });

  it("groups the roster: SUBAGENTS, then WORKFLOWS, with non-selectable headers", () => {
    const h = harness(
      [makeRecord({ id: "a1", description: "alpha task", startedAt: Date.now() - 5000 })],
      {
        workflows: () => [{
          id: "wf_1", name: "audit", status: "running", doneCount: 1, totalCount: 2,
          startedAt: Date.now() - 1000, tokens: 500,
        }],
      },
    );
    h.open();
    const frame = h.frame(240).join("\n");
    expect(frame).toContain("SUBAGENTS");
    expect(frame).toContain("WORKFLOWS");
    // The workflow row carries the run-state glyph and its done/total counter.
    expect(frame).toContain("● audit");
    expect(frame).toContain("1/2");
    // The cursor starts on the first agent, not on the SUBAGENTS header.
    expect(frame).toContain("❯ ● Agent");
    // One ↓ crosses the WORKFLOWS header onto the run row — headers take no
    // cursor slot, so the very next press selects the workflow.
    h.press("\u001b[B");
    expect(h.frame(240).join("\n")).toContain("❯ ● audit");
  });

  it("Enter on an agent row opens its conversation", () => {
    const h = harness([makeRecord({ id: "a1", description: "the one" })]);
    h.open();
    h.press("\r");
    expect(h.frame().join("\n")).toContain("waiting for first message");
  });
});

describe("hub page keys through the band", () => {
  /** A hub on the roster (full-screen), with one running agent. */
  const rosterHub = () => {
    const h = harness([makeRecord({ id: "a1" })]);
    h.open();
    return h;
  };

  it("x on a transcript page arms first, stops on the second press", () => {
    const h = rosterHub();
    h.frame(); // the roster page's pane builds its viewer on the first render
    expect(h.frame().join("\n")).toContain("x stop");
    h.press("x");
    expect(h.manager.abort).not.toHaveBeenCalled();
    expect(h.frame().join("\n")).toContain("x again to STOP");
    h.press("x");
    expect(h.manager.abort).toHaveBeenCalledWith("a1");
  });

  it("another key disarms the transcript page's stop", () => {
    const h = rosterHub();
    h.frame(); // the roster page's pane builds its viewer
    h.press("x");
    expect(h.frame().join("\n")).toContain("x again to STOP");
    h.press("j"); // the viewer's own scroll key — it disarms before scrolling
    expect(h.frame().join("\n")).not.toContain("x again to STOP");
    h.press("x");
    expect(h.manager.abort).not.toHaveBeenCalled();
  });

  it("k stops on a transcript page (the viewer hands it to the hub) but scrolls a log page", () => {
    const h = rosterHub();
    h.press("l"); // SL — `k` stays scroll-up here
    h.frame();
    h.press("k");
    expect(h.manager.abort).not.toHaveBeenCalled();
    expect(h.frame().join("\n")).not.toContain("x again to STOP");
    h.press(ESC); // back to the roster
    h.frame();
    h.press("k");
    expect(h.frame().join("\n")).toContain("x again to STOP");
    h.press("k");
    expect(h.manager.abort).toHaveBeenCalledWith("a1");
  });

  it("an agent without a session draws its identity block and the honest note", () => {
    // Opened by id with the session gone: no roster row addresses the record,
    // so the page's pin is what the pane shows — and it never crashes.
    const h = harness([makeRecord({ id: "a1", session: undefined })]);
    h.open({ agentId: "a1", popup: false });
    const out = h.frame().join("\n");
    expect(out).toContain("Sleep then report 1");
    expect(out).toContain("  ↳ —");
    expect(out).toContain("transcript unavailable — agent is running");
    expect(out).toContain("Esc close");
    h.press(ESC);
    expect(h.settled()).toBe(true);
  });
});

describe("P8 — the escalation resize keeps state", () => {
  /** The transcript pane's rows below the identity block, at 60 columns. */
  const bodyRows = (frame: string[]) => frame
    .filter(l => l.startsWith("│") && l.indexOf("│", 1) === 21)
    .map(l => l.slice(23).replace(/ *│$/, ""))
    .slice(3);
  const band = (frame: string[]) => frame.at(-2) ?? "";

  it("survives 59→60 columns and 15→16 rows: selection, scroll, page and expand intact", () => {
    const messages = Array.from({ length: 60 }, (_, i) => ({ role: "user", content: `message number ${i}` }));
    const h = harness([
      makeRecord({ id: "a1", alias: "alpha", description: "alpha task", startedAt: 1000, status: "completed" }),
      makeRecord({ id: "a2", alias: "beta", description: "beta task", startedAt: 2000, session: { subscribe: () => () => {}, messages } }),
      makeRecord({ id: "a3", alias: "gamma", description: "gamma task", startedAt: 3000, status: "completed" }),
    ]);
    h.open();
    h.press("\x1b[B"); // select beta
    expect(h.frame(120).join("\n")).toContain("❯ ● beta");

    // The roster page's pane is the selected agent's transcript — no descent.
    h.frame(120);
    // Scroll the viewer and expand in place, at a width that can show both.
    h.press("\x1b[5~"); // PgUp
    const scrolledAt120 = bodyRows(h.frame(120));
    expect(scrolledAt120.join("\n")).not.toContain("message number 59"); // scrolled off the tail
    h.press("o"); // expand — a view state, not a page
    // The expanded band is the `c copy diff` one; at 120 the fitter has
    // already dropped the `o collapse` hint itself (spec TD frame).
    expect(band(h.frame(120))).toContain("c copy diff");

    // The escalation: 60→59 columns (two panes → stacked) and 16→15 rows.
    h.tui.terminal.columns = 60;
    h.tui.terminal.rows = 16;
    const before = bodyRows(h.frame(60)).slice(0, 3);
    h.tui.terminal.columns = 59;
    h.tui.terminal.rows = 15;
    const stacked = h.frame(59);
    expect(stacked[0]).not.toContain("┬");
    // The stacked twin shows the roster (R is the page, the transcript is its
    // pane) and stays on the same page.
    expect(stacked.join("\n")).toContain("SUBAGENTS");
    expect(stacked.join("\n")).toContain("Esc close");
    h.tui.terminal.columns = 60;
    h.tui.terminal.rows = 16;
    const wide = h.frame(60);
    expect(wide[0]).toContain("┬");
    expect(wide.join("\n")).toContain("Esc close");
    // The scrolled window survived the trip: the same rows open the pane.
    expect(bodyRows(wide).slice(0, 3)).toEqual(before);

    // Widen again: the expand state is still on, so the band still says so.
    h.tui.terminal.columns = 120;
    h.tui.terminal.rows = 20;
    expect(band(h.frame(120))).toContain("c copy diff");
    expect(band(h.frame(120))).not.toContain("m md");

    // The roster selection survived the whole escalation, and the hub's tick
    // interval does not outlive the test.
    expect(h.frame(120).join("\n")).toContain("❯ ● beta");
    h.components.at(-1)?.dispose?.();
  });
});

describe("agent hub Pi-native window chrome", () => {
  it("renders edge-to-edge rules and no side rails in Pi native style", () => {
    const h = harness([makeRecord({ id: "a1", alias: "worker", description: "do work" })], {
      uiStyle: () => "pi",
    });
    h.open();
    const frame = h.frame(120);
    // Top border is edge-to-edge rule with divider tee
    expect(frame[0].startsWith("─")).toBe(true);
    expect(frame[0]).not.toContain("╭");
    expect(frame[0]).not.toContain("╮");
    expect(frame[0]).toContain("┬");

    // Body rows have space margins and no outer side rails
    const body = frame.slice(1, -3);
    for (const row of body) {
      expect(row).not.toMatch(/^│/);
      expect(row).not.toMatch(/│$/);
    }

    // Bottom border is edge-to-edge rule with no rounded corners
    const last = frame.at(-1)!;
    expect(last).toBe("─".repeat(120));
    expect(last).not.toContain("╰");
    expect(last).not.toContain("╯");
    h.components.at(-1)?.dispose?.();
  });
});
