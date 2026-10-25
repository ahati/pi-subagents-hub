import { initTheme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { AgentRecord } from "../src/types.js";
import { ConversationViewer } from "../src/ui/conversation-viewer.js";

// The transcript components read pi's global theme; only the TUI normally sets it up.
initTheme(undefined, false);

/** Visible text of a rendered frame: ANSI stripped. */
function plain(lines: string[]): string {
  return lines.map(l => l.replace(/\u001b\[[0-9;]*m/g, "")).join("\n");
}

const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };

function mockTui(rows = 40, columns = 120) {
  return { terminal: { rows, columns }, requestRender: vi.fn() } as any;
}

function mockSession(messages: any[], getToolDefinition?: (name: string) => unknown) {
  let listener: ((event: any) => void) | undefined;
  return {
    subscribe: (l: any) => {
      listener = l;
      return () => {};
    },
    /** Fire the session event a real pi session fires for a transcript change. */
    emit: (event: any = { type: "message_update" }) => listener?.(event),
    messages,
    state: {},
    getToolDefinition,
  } as any;
}

function mockRecord(over: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "a1",
    type: "general-purpose",
    description: "the one",
    status: "running",
    toolUses: 0,
    startedAt: Date.now(),
    compactionCount: 0,
    ...over,
  } as AgentRecord;
}

function render(messages: any[], over: Partial<AgentRecord> = {}, getToolDefinition?: (name: string) => unknown, activity?: any): string {
  const viewer = new ConversationViewer(
    mockTui(),
    mockSession(messages, getToolDefinition),
    mockRecord(over),
    activity,
    theme as any,
    vi.fn(),
  );
  return plain(viewer.render(120));
}

const CALL = { type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls -la" } };
const OK_RESULT = {
  role: "toolResult",
  toolCallId: "t1",
  toolName: "bash",
  isError: false,
  content: [{ type: "text", text: Array.from({ length: 14 }, (_, i) => `row-${i + 1}`).join("\n") }],
};
const ERR_RESULT = {
  role: "toolResult",
  toolCallId: "t1",
  toolName: "bash",
  isError: true,
  content: [{ type: "text", text: "boom: no such file" }],
};

describe("tool calls render through pi's ToolExecutionComponent", () => {
  it("uses the session definition's renderCall for the call row", () => {
    const richDef = {
      renderCall: (args: any) => ({ render: (_w: number) => [`RICH CALL ${JSON.stringify(args)}`] }),
      renderResult: (_result: any, _opts: any, _theme: any, ctx: any) => ({
        render: (_w: number) => [`RICH RESULT err=${ctx.isError}`],
      }),
    };
    const out = render(
      [{ role: "assistant", content: [CALL] }, OK_RESULT],
      {},
      name => (name === "bash" ? richDef : undefined),
    );
    expect(out).toContain('RICH CALL {"command":"ls -la"}');
    expect(out).toContain("RICH RESULT err=false");
  });

  it("hands the error flag to the result renderer through the context", () => {
    const richDef = {
      renderCall: () => ({ render: () => ["RICH CALL"] }),
      renderResult: (_result: any, _opts: any, _theme: any, ctx: any) => ({
        render: () => [`RICH RESULT err=${ctx.isError}`],
      }),
    };
    const out = render(
      [{ role: "assistant", content: [CALL] }, ERR_RESULT],
      {},
      () => richDef,
    );
    expect(out).toContain("RICH RESULT err=true");
  });

  it("falls back to the component's own call format when a rich renderer throws", () => {
    const throwing = {
      renderCall: () => {
        throw new Error("renderer bug");
      },
    };
    const out = render(
      [{ role: "assistant", content: [CALL] }],
      {},
      () => throwing,
    );
    expect(out).toContain("bash");
    expect(out).toContain("ls -la");
    expect(out).not.toContain("renderer bug");
  });

  it("merges: a definition's renderResult wins, its missing renderCall falls back", () => {
    const half = {
      renderResult: () => ({ render: () => ["HALF RESULT"] }),
    };
    const out = render(
      [{ role: "assistant", content: [CALL] }, OK_RESULT],
      {},
      () => half,
    );
    expect(out).toContain("bash");
    expect(out).toContain("HALF RESULT");
  });

  it("keeps renderer state shared between the call and its result (edit-diff pattern)", () => {
    let seenByResult: unknown = "not called";
    const editLike = {
      renderCall: (_args: any, _theme: any, ctx: any) => {
        ctx.state.diff = "DIFF HUNK";
        return { render: () => ["CALL ROW"] };
      },
      renderResult: (_result: any, _opts: any, _theme: any, ctx: any) => {
        seenByResult = ctx.state.diff;
        return { render: () => [ctx.state.diff === "DIFF HUNK" ? "RESULT WITH HUNKS" : "RESULT WITHOUT HUNKS"] };
      },
    };
    const out = render(
      [{ role: "assistant", content: [CALL] }, OK_RESULT],
      {},
      () => editLike,
    );
    expect(out).toContain("RESULT WITH HUNKS");
    expect(seenByResult).toBe("DIFF HUNK");
  });

  it("re-invokes renderCall with the previous component when the renderer invalidates", async () => {
    // pi's edit renderer lands its diff ASYNC via ctx.invalidate(). The
    // component must survive across that boundary and hand the renderer its
    // own previous component back, so the preview it built is still there.
    const lastComponents: unknown[] = [];
    const returned: unknown[] = [];
    let preview: string[] | undefined;
    const def = {
      renderCall: (_args: any, _theme: any, ctx: any) => {
        lastComponents.push(ctx.lastComponent);
        const component = {
          invalidate() {},
          render: () => ["header", ...(preview ?? [])],
        };
        returned.push(component);
        if (returned.length === 1) {
          Promise.resolve().then(() => {
            preview = ["+ diff line"];
            ctx.invalidate();
          });
        }
        return component;
      },
    };
    const session = mockSession([{ role: "assistant", content: [CALL] }], () => def);
    const viewer = new ConversationViewer(mockTui(), session, mockRecord(), undefined, theme as any, vi.fn());
    expect(plain(viewer.render(120))).not.toContain("+ diff line");
    await 0; // let the simulated async preview land
    expect(plain(viewer.render(120))).toContain("+ diff line");
    // The re-invocation after the async landing saw the component the
    // previous invocation returned — the preview it built survives.
    expect(lastComponents.at(-1)).toBe(returned.at(-2));
  });

  it("keeps separate renderer state per execution when call ids collide", () => {
    const states: unknown[] = [];
    const def = {
      renderCall: (_a: any, _t: any, ctx: any) => {
        states.push(ctx.state);
        return { render: () => ["C"] };
      },
    };
    const session = mockSession([
      { role: "assistant", content: [
        { type: "toolCall", id: "t1", name: "edit", arguments: { n: 1 } },
        { type: "toolCall", id: "t1", name: "edit", arguments: { n: 2 } },
      ] },
    ], () => def);
    const viewer = new ConversationViewer(mockTui(), session, mockRecord(), undefined, theme as any, vi.fn());
    viewer.render(120);
    // Component creation invokes the renderer more than once (constructor plus
    // the started/args-complete marks) — what matters is that the two calls,
    // despite the colliding id, hold distinct state objects.
    expect(states).toHaveLength(6);
    expect(states[0]).not.toBe(states[3]);
  });
});

describe("expanded tool output (o / ctrl+o)", () => {
  function expandViewer() {
    // Without renderers the component dumps full output (pi's main window
    // always merges builtins, so expansion is a renderer concern). Simulate a
    // renderer that honors the toggle, as pi's read/bash renderers do.
    const def = {
      renderCall: () => ({ render: () => ["CALL ROW"] }),
      renderResult: (result: any, options: any) => ({
        render: () => [options.expanded ? `EXPANDED ${result.content[0].text}` : "COLLAPSED"],
      }),
    };
    const session = mockSession([
      { role: "assistant", content: [CALL] },
      OK_RESULT,
    ], () => def);
    return new ConversationViewer(mockTui(60, 120), session, mockRecord(), undefined, theme as any, vi.fn());
  }

  it("starts collapsed and threads the toggle into the renderer on ctrl+o", () => {
    const viewer = expandViewer();
    expect(plain(viewer.render(120))).toContain("COLLAPSED");

    viewer.handleInput("\x0f");
    expect(plain(viewer.render(120))).toContain(`EXPANDED ${(OK_RESULT.content[0] as any).text}`);
  });

  it("toggles back off with a second press, and `o` is the plain alias", () => {
    const viewer = expandViewer();
    viewer.handleInput("o");
    expect(plain(viewer.render(120))).toContain("EXPANDED");
    viewer.handleInput("o");
    expect(plain(viewer.render(120))).toContain("COLLAPSED");
  });
});

describe("transcript format (main-window components)", () => {
  it("labels user messages with [User] so @-mentions stay attributable", () => {
    const out = render([{ role: "user", content: "take another look at the diff" }]);
    expect(out).toContain("[User]");
    expect(out).toContain("take another look at the diff");
  });

  it("renders assistant text as Markdown", () => {
    const out = render([{ role: "assistant", content: [{ type: "text", text: "# Heading\n\nbody" }] }]);
    expect(out).toContain("Heading");
    expect(out).not.toContain("# Heading");
  });

  it("renders thinking text without a fixed preview window", () => {
    const thinking = Array.from({ length: 12 }, (_, i) => `step ${i + 1}`).join("\n");
    const out = render([{
      role: "assistant",
      content: [{ type: "thinking", thinking }, { type: "text", text: "On it." }],
    }]);
    expect(out).toContain("step 12");
    expect(out).toContain("On it.");
  });

  it("pairs a result with its call and does not repeat it as a standalone [Result]", () => {
    const out = render([{ role: "assistant", content: [CALL] }, OK_RESULT]);
    expect(out).toContain("row-14");
    expect(out.match(/row-14\b/g)?.length).toBe(1);
    expect(out).not.toContain("[Result]");
  });

  it("renders orphaned results as a dim [Result] block, byte-exact", () => {
    const raw = ["#!/bin/sh", "# section", "3) alpha", "---", "next"].join("\n");
    const out = render([{ role: "toolResult", toolCallId: "t1", toolName: "bash", isError: false, content: [{ type: "text", text: raw }] }]);
    expect(out).toContain("[Result]");
    for (const line of raw.split("\n")) expect(out).toContain(line);
    expect(out).not.toContain("#! rewritten");
  });

  it("renders bash executions with command and output", () => {
    const out = render([{
      role: "bashExecution", command: "npm test", output: "all green", exitCode: 0, timestamp: Date.now(),
    }]);
    expect(out).toContain("npm test");
    expect(out).toContain("all green");
  });

  it("shows the live activity tail for a running agent", () => {
    const activity = {
      activeTools: new Map([["read", { toolName: "read", args: { path: "file.ts" } }]] as any),
      toolUses: 2,
      responseText: "",
      lastTool: "read",
      lastActivity: "tool" as const,
    };
    const out = render([{ role: "user", content: "go" }], { status: "running" }, undefined, activity);
    expect(out).toContain("▍");
  });

  it("shows the waiting placeholder for an empty transcript", () => {
    const out = render([]);
    expect(out).toContain("(waiting for first message...)");
  });
});

describe("live tool output (streaming partials)", () => {
  function streamingViewer() {
    const messages = [{
      role: "assistant",
      content: [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "yes" } }],
    }];
    const session = mockSession(messages);
    const viewer = new ConversationViewer(mockTui(60, 120), session, mockRecord({ status: "running" }), undefined, theme as any, vi.fn());
    return { viewer, session };
  }

  it("feeds tool_execution_update text into the call's component", () => {
    const { viewer, session } = streamingViewer();
    let out = plain(viewer.render(120));
    expect(out).toContain("bash");
    expect(out).not.toContain("l6");

    session.emit({ type: "tool_execution_update", toolCallId: "t1", partialResult: { content: [{ type: "text", text: "l1\nl2\nl3\nl4\nl5\nl6" }] } });
    out = plain(viewer.render(120));
    expect(out).toContain("l6");

    session.emit({ type: "tool_execution_end", toolCallId: "t1" });
    out = plain(viewer.render(120));
    expect(out).toContain("bash");
  });

  it("replaces a partial with the final result when it arrives", () => {
    const { viewer, session } = streamingViewer();
    session.emit({ type: "tool_execution_update", toolCallId: "t1", partialResult: { content: [{ type: "text", text: "partial output" }] } });
    expect(plain(viewer.render(120))).toContain("partial output");

    (session.messages as any[]).push({ ...OK_RESULT, content: [{ type: "text", text: "final output" }] });
    session.emit();
    const out = plain(viewer.render(120));
    expect(out).toContain("final output");
    expect(out).not.toContain("partial output");
  });
});

describe("streaming assistant message", () => {
  it("renders the in-flight streaming message after the completed ones", () => {
    const session = mockSession([{ role: "assistant", content: [{ type: "text", text: "final part" }] }]);
    (session as any).state = { streamingMessage: { role: "assistant", content: [{ type: "text", text: "streaming part" }] } };
    const viewer = new ConversationViewer(mockTui(60, 120), session, mockRecord({ status: "running" }), undefined, theme as any, vi.fn());
    const out = plain(viewer.render(120));
    expect(out).toContain("final part");
    expect(out).toContain("streaming part");
  });

  it("shows the thinking placeholder while the streaming message is empty", () => {
    const session = mockSession([{ role: "assistant", content: [{ type: "text", text: "earlier done" }] }]);
    (session as any).state = { streamingMessage: { role: "assistant", content: [] } };
    const viewer = new ConversationViewer(mockTui(60, 120), session, mockRecord({ status: "running" }), undefined, theme as any, vi.fn());
    expect(plain(viewer.render(120))).toContain("✻ thinking…");
  });
});

describe("viewer scrollBy (mouse wheel funnel)", () => {
  function tallViewer() {
    const messages = Array.from({ length: 60 }, (_, i) => ({ role: "user", content: `line ${i}` }));
    const viewer = new ConversationViewer(mockTui(200, 120), mockSession(messages), mockRecord({ status: "completed" }), undefined, theme as any, vi.fn());
    return viewer;
  }

  it("scrolls up from the tail, and down again to re-arm auto-follow", () => {
    const viewer = tallViewer();
    const tail = plain(viewer.render(120));
    expect(tail).toContain("line 59");
    expect(viewer.scrollBy(-5)).toBe(true);
    const up = plain(viewer.render(120));
    expect(up).not.toContain("line 59");
    expect(viewer.scrollBy(5)).toBe(true);
    expect(plain(viewer.render(120))).toContain("line 59");
  });

  it("returns false when nothing can move, and for degenerate deltas", () => {
    const viewer = tallViewer();
    viewer.render(120);
    expect(viewer.scrollBy(0)).toBe(false);
    expect(viewer.scrollBy(Number.NaN)).toBe(false);
    expect(viewer.scrollBy(999)).toBe(false); // already at the tail
  });
});
