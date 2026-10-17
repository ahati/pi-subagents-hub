import { describe, expect, it } from "vitest";
import { createActivityTracker, renderRunningAgentStatus } from "../src/index.js";
import type { WidgetMode } from "../src/types.js";
import { type ActiveToolCall, type AgentActivity, AgentWidget, describeActivity, fgPreservingNestedStyles, formatCost, formatSessionTokens } from "../src/ui/agent-widget.js";

describe("formatSessionTokens", () => {
  const theme = { fg: (c: string, s: string) => `<${c}>${s}</${c}>`, bold: (s: string) => s };
  const ansiTheme = {
    fg: (c: string, s: string) => {
      const codes: Record<string, string> = { dim: "2", warning: "33", accent: "35" };
      return `\u001b[${codes[c] ?? "31"}m${s}\u001b[39m`;
    },
    bold: (s: string) => s,
  };

  it("applies threshold colors (<70 dim, 70–85 warning, ≥85 error)", () => {
    expect(formatSessionTokens(1234, null, theme)).toBe("1.2k token");
    expect(formatSessionTokens(1234, 50, theme)).toBe("1.2k token (<dim>50%</dim>)");
    expect(formatSessionTokens(1234, 70, theme)).toBe("1.2k token (<warning>70%</warning>)");
    expect(formatSessionTokens(1234, 84, theme)).toBe("1.2k token (<warning>84%</warning>)");
    expect(formatSessionTokens(1234, 85, theme)).toBe("1.2k token (<error>85%</error>)");
    expect(formatSessionTokens(1234, 99, theme)).toBe("1.2k token (<error>99%</error>)");
  });

  it("annotates compaction count alongside percent", () => {
    // compactions only (e.g. immediately post-compaction, percent null)
    expect(formatSessionTokens(1234, null, theme, 1)).toBe("1.2k token (<dim>⇊1</dim>)");
    expect(formatSessionTokens(1234, null, theme, 3)).toBe("1.2k token (<dim>⇊3</dim>)");
    // percent + compactions, joined with ` · `
    expect(formatSessionTokens(1234, 45, theme, 2)).toBe("1.2k token (<dim>45%</dim> · <dim>⇊2</dim>)");
    expect(formatSessionTokens(1234, 88, theme, 4)).toBe("1.2k token (<error>88%</error> · <dim>⇊4</dim>)");
    // compactions=0 omitted
    expect(formatSessionTokens(1234, 45, theme, 0)).toBe("1.2k token (<dim>45%</dim>)");
  });

  it("preserves the outer style after nested annotation styles reset", () => {
    const tokenText = formatSessionTokens(1234, 70, ansiTheme);

    expect(fgPreservingNestedStyles(ansiTheme, "accent", tokenText)).toBe(
      "\u001b[35m1.2k token (\u001b[33m70%\u001b[39m\u001b[35m)\u001b[39m",
    );
  });
});

describe("renderRunningAgentStatus", () => {
  it("renders running status as separate component lines", () => {
    const theme = { fg: (_c: string, s: string) => s };
    const component = renderRunningAgentStatus("⠋", "thinking: xhigh · 4 tool uses", "thinking…", theme);

    expect(component.render(120).map((line) => line.trimEnd())).toEqual([
      "⠋ thinking: xhigh · 4 tool uses",
      "  ⎿  thinking…",
    ]);
  });
});

// While an agent streams text with no tool mid-flight, the `⎿` line shows a
// line from that text. It must be the LAST line of the stream — what the agent
// is writing right now — not the first, which completes as soon as the first
// `\n` arrives and would otherwise pin the subtext to the message's opening
// sentence for the rest of the message.
describe("describeActivity text fallback", () => {
  const noTools = new Map<string, ActiveToolCall>();

  it("shows the latest line of streamed text, not the first", () => {
    const streamed = "Let me look at the files.\nReading the config now.\nFound three suspects in src/auth.ts.";
    expect(describeActivity(noTools, streamed)).toBe("Found three suspects in src/auth.ts.");
  });

  it("rolls forward as new lines arrive", () => {
    // Same message, two points in its stream: the displayed line must move.
    const before = describeActivity(noTools, "First line done.\n");
    const after = describeActivity(noTools, "First line done.\nSecond line is the current one.");
    expect(before).toBe("First line done.");
    expect(after).toBe("Second line is the current one.");
  });

  it("skips blank and whitespace-only lines when finding the latest", () => {
    const streamed = "Opening line.\n\n   \n\nLatest after a gap.\n";
    expect(describeActivity(noTools, streamed)).toBe("Latest after a gap.");
  });

  it("still truncates the picked line to 60 chars with an ellipsis", () => {
    const long = "x".repeat(80);
    expect(describeActivity(noTools, `short preamble.\n${long}`)).toBe("x".repeat(60) + "…");
  });

  it("keeps tool activity ahead of response text", () => {
    const reading = new Map<string, ActiveToolCall>([
      ["call-1", { toolName: "read", args: { path: "src/a.ts" } }],
      ["call-2", { toolName: "read", args: { path: "src/b.ts" } }],
    ]);
    expect(describeActivity(reading, "some streamed text")).toBe("reading src/a.ts, reading src/b.ts…");
  });

  it("falls back to thinking… with no tools and no text", () => {
    expect(describeActivity(noTools, "")).toBe("thinking…");
    expect(describeActivity(noTools, "\n \n")).toBe("thinking…");
  });
});

describe("describeActivity tool phrases", () => {
  const calls = (list: [string, ActiveToolCall][]) => new Map<string, ActiveToolCall>(list);

  it("names the file an edit targets", () => {
    const active = calls([["c1", { toolName: "edit", args: { path: "src/auth.ts", edits: [] } }]]);
    expect(describeActivity(active)).toBe("editing src/auth.ts…");
  });

  it("shows the command's first words for bash", () => {
    const active = calls([["c1", { toolName: "bash", args: { command: "npm run check --silent" } }]]);
    expect(describeActivity(active)).toBe("running npm run check…");
  });

  it("falls back to the generic verb when bash has no command", () => {
    expect(describeActivity(calls([["c1", { toolName: "bash" }]]))).toBe("running command…");
  });

  it("quotes search patterns", () => {
    const active = calls([["c1", { toolName: "grep", args: { pattern: "max turns" } }]]);
    expect(describeActivity(active)).toBe("searching 'max turns'…");
  });

  it("uses the raw tool name for unmapped tools, with or without args", () => {
    expect(describeActivity(calls([["c1", { toolName: "web_search" }]]))).toBe("web_search…");
    expect(describeActivity(calls([["c1", { toolName: "document_parse", args: { path: "doc.pdf" } }]]))).toBe("document_parse…");
  });

  it("joins distinct phrases and counts the overflow", () => {
    const active = calls([
      ["c1", { toolName: "edit", args: { path: "a.ts" } }],
      ["c2", { toolName: "read", args: { path: "b.ts" } }],
      ["c3", { toolName: "grep", args: { pattern: "x" } }],
      ["c4", { toolName: "bash", args: { command: "npm test" } }],
    ]);
    expect(describeActivity(active)).toBe("editing a.ts, reading b.ts, searching 'x' +1 more…");
  });

  it("deduplicates identical phrases", () => {
    const active = calls([
      ["c1", { toolName: "read", args: { path: "a.ts" } }],
      ["c2", { toolName: "read", args: { path: "a.ts" } }],
    ]);
    expect(describeActivity(active)).toBe("reading a.ts…");
  });

  it("clamps the joined phrase to 60 chars", () => {
    const active = calls([["c1", { toolName: "edit", args: { path: `${"d/".repeat(30)}file.ts` } }]]);
    const text = describeActivity(active);
    expect(text.length).toBeLessThanOrEqual(60);
    expect(text.endsWith("…")).toBe(true);
  });
});

describe("createActivityTracker", () => {
  it("pairs start/end by toolCallId, leaving same-name calls alone", () => {
    const { state, callbacks } = createActivityTracker();
    callbacks.onToolActivity({ type: "start", toolName: "read", toolCallId: "t1", args: { path: "a.ts" } });
    callbacks.onToolActivity({ type: "start", toolName: "read", toolCallId: "t2", args: { path: "b.ts" } });
    expect(state.activeTools.get("t1")).toEqual({ toolName: "read", args: { path: "a.ts" } });
    callbacks.onToolActivity({ type: "end", toolName: "read", toolCallId: "t1" });
    expect([...state.activeTools.keys()]).toEqual(["t2"]);
    expect(state.toolUses).toBe(1);
  });

  it("matches ends by tool name when no toolCallId is given", () => {
    const { state, callbacks } = createActivityTracker();
    callbacks.onToolActivity({ type: "start", toolName: "grep" });
    callbacks.onToolActivity({ type: "end", toolName: "grep" });
    expect(state.activeTools.size).toBe(0);
    expect(state.toolUses).toBe(1);
  });

  it("clears responseText when a new message starts", () => {
    const { state, callbacks } = createActivityTracker();
    callbacks.onTextDelta("tail of the old message", "tail of the old message");
    expect(state.responseText).toBe("tail of the old message");
    callbacks.onMessageStart();
    expect(state.responseText).toBe("");
  });
});

describe("AgentWidget", () => {
  const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };

  function makeActivity(): AgentActivity {
    return {
      activeTools: new Map(),
      toolUses: 0,
      responseText: "",
      turnCount: 1,
    };
  }

  function makeRecord(
    id: string,
    opts: { isBackground?: boolean; parentAgentId?: string; workflowId?: string } = {},
  ) {
    return {
      id,
      type: "general-purpose",
      description: `${id} description`,
      status: "running",
      toolUses: 0,
      startedAt: Date.now(),
      lifetimeUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compactionCount: 0,
      invocation: { modelName: "sonnet 4.6", modelId: "anthropic/claude-sonnet-4-6", thinking: "high" },
      isBackground: opts.isBackground,
      parentAgentId: opts.parentAgentId,
      workflowId: opts.workflowId,
    };
  }

  /** Render the widget for a manager and return the produced lines ("" if nothing rendered). */
  function renderLines(manager: unknown, activityId: string, mode?: () => WidgetMode, showModel = false): string {
    const widget = new AgentWidget(
      manager as any,
      new Map([[activityId, makeActivity()]]),
      mode,
      () => false,
      () => showModel,
    );
    let factory: any;
    widget.setUICtx({
      setStatus: () => {},
      setWidget: (_key, content) => { factory = content; },
    });
    widget.update();
    if (!factory) return "";
    return factory({ terminal: { columns: 120 }, requestRender: () => {} }, theme)
      .render()
      .join("\n");
  }

  // "all" (and the no-policy constructor default) shows every agent.
  it("shows foreground agents in 'all' mode (and by default)", () => {
    const manager = { listAgents: () => [makeRecord("foreground", { isBackground: false })] };
    expect(renderLines(manager, "foreground")).toContain("foreground description");
    expect(renderLines(manager, "foreground", () => "all")).toContain("foreground description");
  });

  it("hides nested children in every coordinator widget mode", () => {
    const manager = {
      listAgents: () => [makeRecord("nested", { isBackground: true, parentAgentId: "parent" })],
    };
    expect(renderLines(manager, "nested", () => "all")).toBe("");
    expect(renderLines(manager, "nested", () => "background")).toBe("");
  });

  it("hides a workflow's agents in every coordinator widget mode", () => {
    // They belong to the run, which reports for them through its own card and
    // its own row in the fleet list.
    const manager = {
      listAgents: () => [makeRecord("child", { isBackground: true, workflowId: "wf_abc" })],
    };
    expect(renderLines(manager, "child", () => "all")).toBe("");
    expect(renderLines(manager, "child", () => "background")).toBe("");
  });

  it("excludes foreground agents in 'background' mode", () => {
    const manager = { listAgents: () => [makeRecord("foreground", { isBackground: false })] };
    expect(renderLines(manager, "foreground", () => "background")).toBe("");
  });

  // Also covers scheduler-spawned agents (isBackground=true, no `invocation`
  // snapshot): if the filter still keyed off `invocation.runInBackground` —
  // #118's original approach — this would wrongly vanish.
  it("renders background agents in 'background' mode", () => {
    const manager = { listAgents: () => [makeRecord("background", { isBackground: true })] };
    const lines = renderLines(manager, "background", () => "background");
    expect(lines).toContain("Agents");
    expect(lines).toContain("background description");
  });

  // 'background' excludes only agents *known* to be foreground; one with no
  // isBackground flag (e.g. a cross-extension RPC spawn) is kept, not hidden.
  it("keeps agents with no isBackground flag in 'background' mode", () => {
    const manager = { listAgents: () => [makeRecord("unflagged", {})] };
    expect(renderLines(manager, "unflagged", () => "background")).toContain("unflagged description");
  });

  // The model is opt-in: the row is already dense, and the same pair is on the
  // tool result and in the conversation viewer either way.
  it("names the model and thinking on a running row under showModel", () => {
    const manager = { listAgents: () => [makeRecord("bg", { isBackground: true })] };

    expect(renderLines(manager, "bg", () => "background", true))
      .toContain("sonnet 4.6 · thinking: high");
  });

  it("renders the row exactly as before when showModel is off", () => {
    const manager = { listAgents: () => [makeRecord("bg", { isBackground: true })] };

    const off = renderLines(manager, "bg", () => "background");
    expect(off).toContain("bg description");
    expect(off).not.toContain("sonnet 4.6");
    expect(off).not.toContain("thinking:");
  });

  it("carries the short label, never the canonical id, onto the row", () => {
    const manager = { listAgents: () => [makeRecord("bg", { isBackground: true })] };

    expect(renderLines(manager, "bg", () => "background", true))
      .not.toContain("anthropic/claude-sonnet-4-6");
  });

  it("discloses a level the run did not honor", () => {
    const record = makeRecord("bg", { isBackground: true });
    record.invocation = { modelName: "haiku 4.5", thinking: "high", requestedThinking: "max" };
    const manager = { listAgents: () => [record] };

    expect(renderLines(manager, "bg", () => "background", true))
      .toContain("haiku 4.5 · thinking: high (asked max)");
  });

  // Queued agents stay a one-line count. A fan-out of ten would otherwise eat
  // the whole widget and push every finished agent out of it.
  it("keeps queued agents on one summary line and finished agents visible", () => {
    const records = [
      ...[1, 2, 3].map(i => ({ ...makeRecord(`run${i}`, { isBackground: true }), status: "running" })),
      ...[1, 2, 3, 4, 5, 6, 7].map(i => ({ ...makeRecord(`q${i}`, { isBackground: true }), status: "queued" })),
      ...[1, 2, 3].map(i => ({
        ...makeRecord(`fin${i}`, { isBackground: true }),
        status: "completed",
        completedAt: Date.now(),
      })),
    ];
    const widget = new AgentWidget(
      { listAgents: () => records } as any,
      new Map(),
      () => "background",
      () => false,
      () => true,
    );
    let factory: any;
    widget.setUICtx({ setStatus: () => {}, setWidget: (_key, content) => { factory = content; } });
    for (const r of records) if (r.status === "completed") widget.markFinished(r.id);
    widget.update();
    const lines = factory({ terminal: { columns: 200 }, requestRender: () => {} }, theme).render().join("\n");

    expect(lines).toContain("7 queued");
    expect(lines).not.toContain("q1 description");
    for (const i of [1, 2, 3]) expect(lines).toContain(`fin${i} description`);
    expect(lines).not.toContain("more (");
  });

  // "off" hides the widget entirely — even a background agent renders nothing.
  it("renders nothing in 'off' mode", () => {
    const manager = { listAgents: () => [makeRecord("background", { isBackground: true })] };
    expect(renderLines(manager, "background", () => "off")).toBe("");
  });
});

// The widget caps itself at MAX_WIDGET_LINES (12) and, past that, hands out a
// line budget in priority order: running pairs, then the queued summary, then
// finished lines. Running and finished increment `hiddenRunning`/`hiddenFinished`
// when they don't fit; the queued line is dropped with NO counter at all, so the
// footer under-reports and — worse — the queue vanishes from the UI entirely.
// That happens exactly when the concurrency limit is saturated, i.e. when the
// queue is the thing the user most needs to see.
describe("formatCost", () => {
  it("keeps the precision that distinguishes one run from another", () => {
    // Rounding to cents would print the same figure for a run that cost four
    // times another — the band most single subagent runs fall in.
    expect(formatCost(0.0042)).toBe("~$0.0042");
    expect(formatCost(0.0123)).toBe("~$0.0123");
    expect(formatCost(1.239)).toBe("~$1.24");
  });

  it("never pads a round figure with noise, nor cuts it below cents", () => {
    expect(formatCost(0.05)).toBe("~$0.05");    // not ~$0.0500
    expect(formatCost(0.4)).toBe("~$0.40");     // not ~$0.4
    expect(formatCost(12)).toBe("~$12.00");
  });

  it("shows nothing when there is nothing to show", () => {
    // Zero is what a model with no pricing data reports, so `$0.00` would claim
    // a measurement that was never made.
    expect(formatCost(0)).toBe("");
    expect(formatCost(Number.NaN)).toBe("");
    expect(formatCost(-1)).toBe("");
  });

  it("says a real but tiny cost is tiny, not zero", () => {
    // The distinction the whole helper turns on: "measured, below what four
    // decimals can show" must not render the same as "never measured".
    expect(formatCost(0.00002)).toBe("<$0.0001");
    expect(formatCost(0)).toBe("");
  });

  it("marks the figure as an estimate", () => {
    // The tilde is the whole disclaimer — it sits beside exact token counts.
    expect(formatCost(0.5).startsWith("~")).toBe(true);
  });
});

describe("AgentWidget cost display", () => {
  const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };

  function render(showCost: boolean, cost: number): string {
    const agent = {
      id: "a1",
      type: "general-purpose",
      description: "spending agent",
      status: "running",
      toolUses: 1,
      startedAt: Date.now(),
      lifetimeUsage: { input: 1000, output: 200, cacheWrite: 0, cost },
      compactionCount: 0,
    };
    // Carries figures of its own, in the shape the tracker used to have: spend
    // is read from the record now, so these must not reach the line. Only the
    // record accumulates a nested child's spend, and only it outlives the run.
    const activity = new Map([["a1", {
      activeTools: new Map(),
      toolUses: 1,
      responseText: "",
      turnCount: 1,
      lifetimeUsage: { input: 9, output: 9, cacheWrite: 0, cost: 0.9 },
    } as unknown as AgentActivity]]);
    const widget = new AgentWidget(
      { listAgents: () => [agent] } as any,
      activity,
      () => "all",
      () => showCost,
    );
    let factory: any;
    widget.setUICtx({ setStatus: () => {}, setWidget: (_k, c) => { factory = c; } } as any);
    widget.update();
    return factory({ terminal: { columns: 200 }, requestRender: () => {} }, theme).render().join("\n");
  }

  it("shows the cost beside the token count when enabled", () => {
    const line = render(true, 0.0042);
    expect(line).toContain("1.2k token");
    expect(line).toContain("~$0.0042");
  });

  it("shows no cost when disabled", () => {
    const line = render(false, 0.0042);
    expect(line).toContain("1.2k token");
    expect(line).not.toContain("$");
  });

  it("shows no cost for an unpriced model, even when enabled", () => {
    const line = render(true, 0);
    expect(line).toContain("1.2k token");
    expect(line).not.toContain("$");
  });

  it("keeps the cost visible after the agent finishes", () => {
    // The activity entry is deleted the moment an agent finishes, so a finished
    // line reading from it would drop the number precisely when the question
    // "what did that cost" gets asked.
    const finished = {
      id: "a1", type: "general-purpose", description: "done agent", status: "completed",
      toolUses: 2, startedAt: Date.now() - 1000, completedAt: Date.now(),
      lifetimeUsage: { input: 1000, output: 200, cacheWrite: 0, cost: 0.0042 },
      compactionCount: 0,
    };
    const widget = new AgentWidget(
      { listAgents: () => [finished] } as any, new Map(), () => "all", () => true,
    );
    let factory: any;
    widget.setUICtx({ setStatus: () => {}, setWidget: (_k, c) => { factory = c; } } as any);
    widget.update();
    const out = factory({ terminal: { columns: 200 }, requestRender: () => {} }, theme).render().join("\n");

    expect(out).toContain("done agent");
    expect(out).toContain("~$0.0042");
  });

  it("shows stats for an agent nobody is tracking live", () => {
    // A scheduled agent has no activity entry — it spawns through the manager
    // directly — and used to render with no tokens and no cost at all.
    const running = {
      id: "sched", type: "general-purpose", description: "scheduled agent", status: "running",
      toolUses: 1, startedAt: Date.now(),
      lifetimeUsage: { input: 1000, output: 200, cacheWrite: 0, cost: 0.0042 },
      compactionCount: 0,
    };
    const widget = new AgentWidget(
      { listAgents: () => [running] } as any, new Map(), () => "all", () => true,
    );
    let factory: any;
    widget.setUICtx({ setStatus: () => {}, setWidget: (_k, c) => { factory = c; } } as any);
    widget.update();
    const out = factory({ terminal: { columns: 200 }, requestRender: () => {} }, theme).render().join("\n");

    expect(out).toContain("1.2k token");
    expect(out).toContain("~$0.0042");
  });

  it("defaults to hiding it", () => {
    const agent = {
      id: "a1", type: "general-purpose", description: "d", status: "running",
      toolUses: 0, startedAt: Date.now(),
      lifetimeUsage: { input: 1000, output: 200, cacheWrite: 0, cost: 0.5 }, compactionCount: 0,
    };
    const activity = new Map([["a1", {
      activeTools: new Map(), toolUses: 0, responseText: "", turnCount: 1,
    } as AgentActivity]]);
    const widget = new AgentWidget({ listAgents: () => [agent] } as any, activity, () => "all");
    let factory: any;
    widget.setUICtx({ setStatus: () => {}, setWidget: (_k, c) => { factory = c; } } as any);
    widget.update();
    expect(factory({ terminal: { columns: 200 }, requestRender: () => {} }, theme).render().join("\n"))
      .not.toContain("$");
  });
});

describe("AgentWidget overflow accounting", () => {
  const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };

  function record(id: string, status: string) {
    return {
      id,
      type: "general-purpose",
      description: `${id} description`,
      status,
      toolUses: 0,
      startedAt: Date.now(),
      completedAt: status === "completed" ? Date.now() : undefined,
      lifetimeUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compactionCount: 0,
      isBackground: true,
    };
  }

  /** Render a whole fleet (mixed statuses) and return the produced lines. */
  function renderFleet(counts: { running: number; queued: number; finished: number }): string[] {
    const agents = [
      ...Array.from({ length: counts.running }, (_, i) => record(`run${i}`, "running")),
      ...Array.from({ length: counts.queued }, (_, i) => record(`q${i}`, "queued")),
      ...Array.from({ length: counts.finished }, (_, i) => record(`fin${i}`, "completed")),
    ];
    const activity = new Map(agents.map(a => [a.id, {
      activeTools: new Map(),
      toolUses: 0,
      responseText: "",
      turnCount: 1,
    } as AgentActivity]));
    const widget = new AgentWidget({ listAgents: () => agents } as any, activity, () => "all");
    let factory: any;
    widget.setUICtx({ setStatus: () => {}, setWidget: (_k, c) => { factory = c; } } as any);
    widget.update();
    if (!factory) return [];
    return factory({ terminal: { columns: 200 }, requestRender: () => {} }, theme).render();
  }

  /** The `+N more (…)` footer, if the widget overflowed. */
  const footer = (lines: string[]) => lines.find(l => l.includes("more ("));

  /** Every fleet shape worth rendering — swept, not sampled. */
  const SHAPES: { running: number; queued: number; finished: number }[] = [];
  for (let running = 0; running <= 8; running++)
    for (let queued = 0; queued <= 8; queued++)
      for (let finished = 0; finished <= 8; finished++) SHAPES.push({ running, queued, finished });

  // Swept rather than sampled: reserving the queued row moves `budget` around by
  // hand, and an off-by-one there overflows the cap only for specific shapes.
  it("never exceeds the line cap, for any fleet shape", () => {
    for (const counts of SHAPES) {
      expect(renderFleet(counts).length, JSON.stringify(counts)).toBeLessThanOrEqual(12);
    }
  });

  it("never prints a footer that miscounts what it hid, for any fleet shape", () => {
    for (const counts of SHAPES) {
      const f = footer(renderFleet(counts));
      if (!f) continue;
      const total = Number(/\+(\d+) more/.exec(f)?.[1]);
      const where = `${JSON.stringify(counts)} → ${f}`;
      // A visible footer means something was dropped, so "+0 more ()" is a lie...
      expect(total, where).toBeGreaterThan(0);
      // ...and it counts agents that have their own row, so it can never exceed
      // them — in particular the queued summary must not be counted as an agent.
      expect(total, where).toBeLessThanOrEqual(counts.running + counts.finished);
    }
  });

  it("keeps the queued summary visible when the running agents fill the widget", () => {
    // 5 running (10 lines) consume the entire budget, so the queued line is
    // dropped — and with it, any sign that 3 agents are waiting to start.
    const lines = renderFleet({ running: 5, queued: 3, finished: 1 });
    expect(lines.join("\n")).toContain("3 queued");
  });

  it("counts everything it hid — the footer total matches what is missing", () => {
    // Computed rather than hardcoded, so this survives a scenario change but not
    // a change to what the footer counts.
    const counts = { running: 5, queued: 3, finished: 1 };
    const lines = renderFleet(counts);
    const body = lines.join("\n");

    const shownRunning = counts.running - [...Array(counts.running).keys()]
      .filter(i => !body.includes(`run${i} description`)).length;
    const shownFinished = counts.finished - [...Array(counts.finished).keys()]
      .filter(i => !body.includes(`fin${i} description`)).length;
    const actuallyHidden = (counts.running - shownRunning) + (counts.finished - shownFinished);

    const reported = Number(/\+(\d+) more/.exec(footer(lines) ?? "")?.[1] ?? -1);
    expect(reported).toBe(actuallyHidden);
  });

  it("gives the queued summary priority over finished lines", () => {
    const lines = renderFleet({ running: 4, queued: 2, finished: 3 });
    expect(lines.join("\n")).toContain("2 queued");
  });

  it("renders everything with no footer when the fleet fits", () => {
    const lines = renderFleet({ running: 2, queued: 1, finished: 1 });
    expect(lines.join("\n")).toContain("1 queued");
    expect(footer(lines)).toBeUndefined();
  });

  // A background resume runs an agent that already finished once. markFinished
  // only seeds an age it has not seen before, so without markRunning the agent
  // carries its previous run's age — already past the linger limit — and the
  // resumed run's ✓ line never renders: the agent just disappears.
  it("shows the completion line again after a finished agent is resumed", () => {
    const agent = record("resumed", "completed");
    const activity = new Map([[agent.id, {
      activeTools: new Map(),
      toolUses: 0,
      responseText: "",
      turnCount: 1,
    } as AgentActivity]]);
    const widget = new AgentWidget({ listAgents: () => [agent] } as any, activity, () => "all");
    let factory: any;
    widget.setUICtx({ setStatus: () => {}, setWidget: (_k: any, c: any) => { factory = c; } } as any);
    const render = () => {
      widget.update();
      return (factory?.({ terminal: { columns: 200 }, requestRender: () => {} }, theme).render() ?? []).join("\n");
    };

    // First run finishes and ages out of the widget.
    widget.markFinished(agent.id);
    widget.onTurnStart();
    widget.onTurnStart();
    expect(render()).not.toContain("resumed description");

    // Background resume puts it back on the running list.
    agent.status = "running";
    widget.markRunning(agent.id);
    expect(render()).toContain("resumed description");

    // ...and its completion is visible when the resumed run settles.
    agent.status = "completed";
    widget.markFinished(agent.id);
    expect(render()).toContain("resumed description");
  });
});

describe("AgentWidget status bar", () => {
  const theme = {
    fg: (c: string, s: string) => `<${c}>${s}</${c}>`,
    bold: (s: string) => s,
  };

  it("formats status bar with themed accent icon and dim label in Pi style", () => {
    const runningAgent = {
      id: "agent-1",
      type: "general-purpose",
      description: "running worker",
      status: "running" as const,
      toolUses: 0,
      startedAt: Date.now(),
    };
    const widget = new AgentWidget(
      { listAgents: () => [runningAgent] } as any,
      new Map(),
      () => "all",
      () => false,
      () => false,
      () => "pi",
    );
    let statusText: string | undefined;
    widget.setUICtx({
      theme,
      setStatus: (_k, text) => { statusText = text; },
      setWidget: () => {},
    });
    widget.update();
    expect(statusText).toBe("<accent>⠋</accent> <dim>1 running agent</dim>");
  });

  it("formats status bar as plain text in Claude style even with theme", () => {
    const runningAgent = {
      id: "agent-1",
      type: "general-purpose",
      description: "running worker",
      status: "running" as const,
      toolUses: 0,
      startedAt: Date.now(),
    };
    const widget = new AgentWidget(
      { listAgents: () => [runningAgent] } as any,
      new Map(),
      () => "all",
      () => false,
      () => false,
      () => "claude",
    );
    let statusText: string | undefined;
    widget.setUICtx({
      theme,
      setStatus: (_k, text) => { statusText = text; },
      setWidget: () => {},
    });
    widget.update();
    expect(statusText).toBe("1 running agent");
  });

  it("formats status bar as plain text when no theme is present on UICtx", () => {
    const runningAgent = {
      id: "agent-1",
      type: "general-purpose",
      description: "running worker",
      status: "running" as const,
      toolUses: 0,
      startedAt: Date.now(),
    };
    const widget = new AgentWidget(
      { listAgents: () => [runningAgent] } as any,
      new Map(),
      () => "all",
      () => false,
      () => false,
      () => "pi",
    );
    let statusText: string | undefined;
    widget.setUICtx({
      setStatus: (_k, text) => { statusText = text; },
      setWidget: () => {},
    });
    widget.update();
    expect(statusText).toBe("1 running agent");
  });

  it("clears status bar when all agents finish and clear", () => {
    const agent = {
      id: "agent-1",
      type: "general-purpose",
      description: "worker",
      status: "running" as const,
      toolUses: 0,
      startedAt: Date.now(),
    };
    const widget = new AgentWidget(
      { listAgents: () => [agent] } as any,
      new Map(),
      () => "all",
      () => false,
      () => false,
      () => "pi",
    );
    let statusText: string | undefined;
    widget.setUICtx({
      theme,
      setStatus: (_k, text) => { statusText = text; },
      setWidget: () => {},
    });
    widget.update();
    expect(statusText).toBeDefined();

    agent.status = "completed" as any;
    widget.markFinished(agent.id);
    widget.onTurnStart();
    widget.onTurnStart();
    widget.update();
    expect(statusText).toBeUndefined();
  });
});
