import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { AgentRecord } from "../src/types.js";
import { ConversationViewer } from "../src/ui/conversation-viewer.js";
import {
  buildCompactTranscript,
  createCompactRenderState,
} from "../src/ui/viewer/viewer-compact.js";

// The transcript components read pi's global theme; only the TUI normally sets it up.
initTheme(undefined, false);

/** Visible text of rendered lines: ANSI stripped, trailing padding trimmed. */
function plain(lines: string[]): string {
  return lines.map(l => l.replace(/\u001b\[[0-9;]*m/g, "")).join("\n");
}

/** Rendered rows as visible text, trailing padding trimmed. */
function rows(lines: string[]): string[] {
  return lines.map(l => l.replace(/\u001b\[[0-9;]*m/g, "").trim());
}

const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };

function mockTui(rows = 40, columns = 120) {
  return { terminal: { rows, columns }, requestRender: vi.fn() } as any;
}

function mockSession(messages: any[]) {
  let listener: ((event: any) => void) | undefined;
  return {
    subscribe: (l: any) => {
      listener = l;
      return () => {};
    },
    emit: (event: any = { type: "message_update" }) => listener?.(event),
    messages,
    state: {},
  } as any;
}

function mockRecord(over: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "a1",
    type: "general-purpose",
    description: "the one",
    status: "completed",
    toolUses: 0,
    startedAt: Date.now(),
    compactionCount: 0,
    ...over,
  } as AgentRecord;
}

/** Render a transcript through the viewer with the compact style selected; returns raw rendered rows. */
function renderCompact(messages: any[], over: Partial<AgentRecord> = {}, activity?: any, viewerStyle: () => any = () => "compact"): string[] {
  const viewer = new ConversationViewer(
    mockTui(),
    mockSession(messages),
    mockRecord(over),
    activity,
    theme as any,
    vi.fn(),
    undefined,
    undefined,
    undefined,
    false,
    "auto",
    undefined,
    { viewerStyle },
  );
  return viewer.render(120);
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

describe("compact viewer style (viewerStyle: compact)", () => {
  it("labels messages and separates them, unlike the default chat rendering", () => {
    const messages = [
      { role: "user", content: "run the checks" },
      { role: "assistant", content: [{ type: "text", text: "On it." }] },
    ];
    const compact = plain(renderCompact(messages));
    expect(compact).toContain("[User]");
    expect(compact).toContain("[Assistant]");
    expect(compact).toContain("───");

    // The default chat style renders pi's message components: the user row
    // keeps its [User] tag, but there are no [Assistant] labels and the
    // compact `───` separator (a standalone line) is gone — the only rules
    // left are the frame's full-width ones.
    const chat = rows(renderCompact(messages, {}, undefined, () => "chat"));
    expect(chat).toContain("[User]");
    expect(chat).not.toContain("[Assistant]");
    expect(chat).not.toContain("───");
  });

  it("renders assistant text as markdown and user text verbatim", () => {
    const messages = [
      { role: "user", content: "summarize **now**" },
      { role: "assistant", content: [{ type: "text", text: "# Done\nall green" }] },
    ];
    const out = plain(renderCompact(messages));
    expect(out).toContain("summarize **now**");
    expect(out).toContain("Done");
    expect(out).toContain("all green");
  });

  it("caps collapsed tool results and expands them with o", () => {
    const messages = [{ role: "assistant", content: [CALL] }, OK_RESULT];
    const collapsed = plain(renderCompact(messages));
    expect(collapsed).toContain("bash(ls -la)");
    expect(collapsed).toContain("row-1");
    expect(collapsed).toContain("… +10 lines (o/ctrl+o for full)");
    expect(collapsed).not.toContain("row-14");

    // `o` toggles the viewer's expanded flag — the full capped body appears.
    const viewer = new ConversationViewer(
      mockTui(),
      mockSession(messages),
      mockRecord(),
      undefined,
      theme as any,
      vi.fn(),
      undefined,
      undefined,
      undefined,
      false,
      "auto",
      undefined,
      { viewerStyle: () => "compact" },
    );
    viewer.focused = true;
    viewer.handleInput("o");
    const expanded = plain(viewer.render(120));
    expect(expanded).toContain("row-14");
    expect(expanded).not.toContain("(o/ctrl+o for full)");
  });

  it("previews errors with the error marker", () => {
    const out = plain(renderCompact([{ role: "assistant", content: [CALL] }, ERR_RESULT]));
    expect(out).toContain("✗ error");
    expect(out).toContain("boom: no such file");
  });

  it("shows live partial output under a running call and awaits when there is none", () => {
    const call = { ...CALL, id: "t9" };
    const session = mockSession([{ role: "assistant", content: [call] }]);
    const viewer = new ConversationViewer(
      mockTui(),
      session,
      mockRecord({ status: "running" }),
      undefined,
      theme as any,
      vi.fn(),
      undefined,
      undefined,
      undefined,
      false,
      "auto",
      undefined,
      { viewerStyle: () => "compact" },
    );
    expect(plain(viewer.render(120))).toContain("○ awaiting result");

    // Feed a partial the way the session event does, then re-render.
    session.emit({
      type: "tool_execution_update",
      toolCallId: "t9",
      partialResult: { content: [{ type: "text", text: "step one\nstep two" }] },
    });
    const out = plain(viewer.render(120));
    expect(out).toContain("step one");
    expect(out).toContain("step two");
    expect(out).not.toContain("○ awaiting result");
  });

  it("renders an orphan tool result under a [Result] label", () => {
    const orphan = {
      role: "toolResult",
      toolCallId: "gone",
      toolName: "bash",
      isError: false,
      content: [{ type: "text", text: "leftover" }],
    };
    const out = plain(renderCompact([orphan]));
    expect(out).toContain("[Result]");
    expect(out).toContain("leftover");
  });

  it("renders bash executions as `$ command` with output", () => {
    const bash = {
      role: "bashExecution",
      command: "npm test",
      output: Array.from({ length: 30 }, (_, i) => `line-${i}`).join("\n"),
      exitCode: 0,
    };
    // Tall viewport: the viewer autoscrolls, so short views clip the head.
    const viewer = new ConversationViewer(
      mockTui(120, 120),
      mockSession([bash]),
      mockRecord(),
      undefined,
      theme as any,
      vi.fn(),
      undefined,
      undefined,
      undefined,
      false,
      "auto",
      undefined,
      { viewerStyle: () => "compact" },
    );
    const out = plain(viewer.render(120));
    expect(out).toContain("$ npm test");
    expect(out).toContain("line-29");
    expect(out).not.toContain("truncated");
  });

  it("ends a running agent with its activity line", () => {
    const activity = {
      activeTools: new Map(),
      responseText: "wrapping up",
      lastTool: undefined,
      lastActivity: "text",
    };
    const out = plain(renderCompact(
      [{ role: "assistant", content: [{ type: "text", text: "working" }] }],
      { status: "running" },
      activity,
    ));
    expect(out).toContain("▍");
    expect(out).toContain("wrapping up");
  });

  it("keeps every rendered line within the width", () => {
    const messages = [
      { role: "user", content: `x${"y".repeat(300)}` },
      { role: "assistant", content: [CALL] },
      OK_RESULT,
    ];
    const viewer = new ConversationViewer(
      mockTui(40, 60),
      mockSession(messages),
      mockRecord(),
      undefined,
      theme as any,
      vi.fn(),
      undefined,
      undefined,
      undefined,
      false,
      "auto",
      undefined,
      { viewerStyle: () => "compact" },
    );
    // Inner width: the claude-style frame costs the rails and two spaces.
    for (const line of viewer.render(60)) {
      const inner = plain([line]);
      expect(visibleWidth(inner)).toBeLessThanOrEqual(60);
    }
  });

  it("picks up a live style toggle without recreating the viewer", () => {
    const messages = [
      { role: "user", content: "toggle me" },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
    ];
    let style: "chat" | "compact" = "compact";
    const viewer = new ConversationViewer(
      mockTui(),
      mockSession(messages),
      mockRecord(),
      undefined,
      theme as any,
      vi.fn(),
      undefined,
      undefined,
      undefined,
      false,
      "auto",
      undefined,
      { viewerStyle: () => style },
    );
    expect(plain(viewer.render(120))).toContain("[User]");
    style = "chat";
    const chat = rows(viewer.render(120));
    expect(chat).not.toContain("[Assistant]");
    expect(chat).not.toContain("───");
    // Toggle back — the chat components were cached, the transcript rebuilds.
    style = "compact";
    expect(plain(viewer.render(120))).toContain("[Assistant]");
  });
});

describe("buildCompactTranscript", () => {
  const markdownTheme = {
    heading: (t: string) => t,
    link: (t: string) => t,
    linkUrl: (t: string) => t,
    code: (t: string) => t,
    codeBlock: (t: string) => t,
    codeBlockBorder: (t: string) => t,
    quote: (t: string) => t,
    quoteBorder: (t: string) => t,
    hr: (t: string) => t,
    listBullet: (t: string) => t,
    bold: (t: string) => t,
    italic: (t: string) => t,
    underline: (t: string) => t,
    strikethrough: (t: string) => t,
  };

  function build(messages: any[], over: Partial<AgentRecord> = {}, partials = new Map<string, string>()): string[] {
    return buildCompactTranscript(120, {
      session: mockSession(messages),
      record: mockRecord(over),
      activity: undefined,
      theme: theme as any,
      markdownTheme: markdownTheme as any,
      partials,
      expanded: false,
      invalidate: () => {},
      state: createCompactRenderState(),
    });
  }

  it("returns the waiting line for an empty session", () => {
    expect(build([])).toEqual(["(waiting for first message...)"]);
  });

  it("returns no lines at width 0", () => {
    expect(buildCompactTranscript(0, {
      session: mockSession([]),
      record: mockRecord(),
      activity: undefined,
      theme: theme as any,
      markdownTheme: markdownTheme as any,
      partials: new Map(),
      expanded: false,
      invalidate: () => {},
      state: createCompactRenderState(),
    })).toEqual([]);
  });

  it("shows a live partial under a running call", () => {
    const call = { ...CALL, id: "t7" };
    const partials = new Map([["t7", "step one\nstep two"]]);
    const lines = plain(build(
      [{ role: "assistant", content: [call] }],
      { status: "running" },
      partials,
    ));
    expect(lines).toContain("step one");
    expect(lines).toContain("step two");
    expect(lines).not.toContain("○ awaiting result");
  });
});
