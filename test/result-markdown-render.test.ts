import { initTheme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import subagentsExtension from "../src/index.js";
import { createGetResultTool } from "../src/tools/inspect-tools.js";
import type { AgentRecord, NotificationDetails } from "../src/types.js";

// Result bodies render through pi's Markdown, which reads the global theme;
// only the TUI normally sets it up.
initTheme(undefined, false);

/** Visible text of rendered lines: ANSI stripped. */
function plain(lines: string[]): string {
  return lines.map(l => l.replace(/\u001b\[[0-9;]*m/g, "")).join("\n");
}

const identityTheme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };
/** Marks every foreground color, so "was this dimmed" is assertable. */
const markingTheme = { fg: (c: string, s: string) => `\u0001${c}\u0002${s}\u0003`, bold: (s: string) => s };

function mockRecord(over: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "a1",
    type: "general-purpose",
    description: "the one",
    status: "completed",
    toolUses: 3,
    startedAt: 1_000,
    completedAt: 6_000,
    lifetimeUsage: { input: 100, output: 50, cacheWrite: 0 },
    compactionCount: 0,
    result: "# Title\n\nBody **bold** text.",
    ...over,
  } as AgentRecord;
}

function fakeOutbox() {
  return { cancel: vi.fn(), hold: vi.fn(), release: vi.fn() } as any;
}

function getResultTool(record: AgentRecord | undefined) {
  return createGetResultTool({
    resolveAgentRef: (ref) => (ref === "a1" ? record : undefined),
    isShowCostEnabled: () => false,
    outbox: fakeOutbox(),
    pi: { events: { emit: vi.fn() } } as any,
  });
}

/** A booted extension, for surfaces registered on the ExtensionAPI. */function boot() {
  const captured = { messageRenderers: new Map<string, any>(), tools: new Map<string, any>() };
  const pi = {
    registerMessageRenderer: vi.fn((type: string, renderer: any) => captured.messageRenderers.set(type, renderer)),
    registerTool: vi.fn((tool: any) => captured.tools.set(tool.name, tool)),
    registerCommand: vi.fn(),
    registerEntryRenderer: vi.fn(),
    registerFlag: vi.fn(),
    getFlag: vi.fn(),
    on: vi.fn(),
    events: { emit: vi.fn(), on: vi.fn(() => vi.fn()) },
    appendEntry: vi.fn(),
    sendMessage: vi.fn(),
  } as any;
  subagentsExtension(pi);
  return captured;
}

function asContainer(component: any): any[] {
  // Markdown/Text children of the composed entries render through the container.
  return component.render(90);
}

describe("get_subagent_result renders the report as markdown", () => {
  it("keeps the model-facing text as the flat header+body string", async () => {
    const record = mockRecord();
    const tool = getResultTool(record);
    const result = await tool.execute("t1", { agent_id: "a1" }, undefined, undefined, undefined);
    const text = result.content[0].text;

    expect(text.startsWith("Agent: a1\n")).toBe(true);
    expect(text).toContain("Type: Agent | Status: completed");
    expect(text).toContain("Description: the one\n\n");
    expect(text.endsWith("# Title\n\nBody **bold** text.")).toBe(true);
    // The split the renderer consumes travels in details, not in the text.
    expect(result.details.header.startsWith("Agent: a1\n")).toBe(true);
    expect(result.details.body).toBe("# Title\n\nBody **bold** text.");
  });

  it("renders the header as text and the body as markdown", async () => {
    const tool = getResultTool(mockRecord());
    const result = await tool.execute("t1", { agent_id: "a1" }, undefined, undefined, undefined);
    const out = plain(asContainer(tool.renderResult(result, {}, identityTheme, { isError: false })));

    // Header survives verbatim — pipes and all.
    expect(out).toContain("Agent: a1");
    expect(out).toContain("Type: Agent | Status: completed | Tool uses: 3");
    // Markdown consumed the heading and emphasis markers.
    expect(out).toContain("Title");
    expect(out).not.toContain("# Title");
    expect(out).toContain("Body bold text.");
    expect(out).not.toContain("**");
  });

  it("keeps the verbose conversation section, dimmed", async () => {
    const record = mockRecord({
      session: {
        messages: [
          { role: "user", content: "do the thing" },
          { role: "assistant", content: [{ type: "text", text: "done" }] },
        ],
      },
    } as Partial<AgentRecord>);
    const tool = getResultTool(record);
    const result = await tool.execute("t1", { agent_id: "a1", verbose: true }, undefined, undefined, undefined);
    const out = plain(asContainer(tool.renderResult(result, {}, markingTheme, { isError: false })));

    expect(out).toContain("--- Agent Conversation ---");
    expect(out).toContain("[User]: do the thing");
    // The conversation is a log dump, not prose: every line dimmed, none of it
    // markdown-marked.
    const conversationLines = out.split("\n").filter(l =>
      l.includes("Agent Conversation") || l.includes("[User]") || l.includes("[Assistant]"),
    );
    expect(conversationLines.length).toBeGreaterThan(0);
    expect(conversationLines.every(l => l.includes("\u0001dim\u0002"))).toBe(true);
  });

  it("renders running and error bodies from the split", async () => {
    const running = getResultTool(mockRecord({ status: "running", completedAt: undefined, result: undefined }));
    const runningResult = await running.execute("t1", { agent_id: "a1" }, undefined, undefined, undefined);
    expect(plain(asContainer(running.renderResult(runningResult, {}, identityTheme, { isError: false }))))
      .toContain("Agent is still running");

    const failed = getResultTool(mockRecord({ status: "error", error: "boom", result: undefined }));
    const failedResult = await failed.execute("t1", { agent_id: "a1" }, undefined, undefined, undefined);
    expect(plain(asContainer(failed.renderResult(failedResult, {}, identityTheme, { isError: false }))))
      .toContain("Error: boom");
  });

  it("still consumes and cancels only settled agents", async () => {
    const settled = mockRecord();
    const settledOutbox = fakeOutbox();
    const settledTool = createGetResultTool({
      resolveAgentRef: () => settled,
      isShowCostEnabled: () => false,
      outbox: settledOutbox,
      pi: { events: { emit: vi.fn() } } as any,
    });
    await settledTool.execute("t1", { agent_id: "a1" }, undefined, undefined, undefined);
    expect(settled.resultConsumed).toBe(true);
    expect(settledOutbox.cancel).toHaveBeenCalledWith("a1");

    const running = mockRecord({ status: "running", completedAt: undefined, result: undefined });
    const runningOutbox = fakeOutbox();
    const runningTool = createGetResultTool({
      resolveAgentRef: () => running,
      isShowCostEnabled: () => false,
      outbox: runningOutbox,
      pi: { events: { emit: vi.fn() } } as any,
    });
    await runningTool.execute("t1", { agent_id: "a1" }, undefined, undefined, undefined);
    expect(running.resultConsumed).toBeUndefined();
    expect(runningOutbox.cancel).not.toHaveBeenCalled();
  });

  it("falls back to plain text without the details split (pre-refactor results)", () => {
    const tool = getResultTool(mockRecord());
    const legacy = { content: [{ type: "text", text: "Agent: old\n\n# Old" }] };
    const out = plain(asContainer(tool.renderResult(legacy, {}, identityTheme, { isError: false })));
    // No split to render: the flat string, verbatim, markdown markers included.
    expect(out).toContain("# Old");
  });

  it("renders errors as plain text", () => {
    const tool = getResultTool(mockRecord({ status: "error", error: "boom" }));
    const result = { content: [{ type: "text", text: "Agent: a1\nError: boom" }], details: { header: "Agent: a1\n", body: "Error: boom" } };
    const out = plain(asContainer(tool.renderResult(result, {}, identityTheme, { isError: true })));
    expect(out).toContain("Error: boom");
  });
});

describe("Agent tool result renders expanded output as markdown", () => {
  const details = {
    status: "completed",
    durationMs: 5_000,
    turnCount: 2,
    maxTurns: 10,
    toolUses: 1,
    tokens: "1.0k",
  };

  function agentTool() {
    return boot().tools.get("Agent");
  }

  it("expanded: the report renders as dim markdown under the ✓ line", () => {
    const tool = agentTool();
    const result = {
      content: [{ type: "text", text: "# Report\n\n- point a\n- point b" }],
      details,
    };
    const out = plain(asContainer(tool.renderResult(result, { expanded: true }, identityTheme, { isError: false })));

    expect(out).toContain("✓");
    expect(out).toContain("Report");
    expect(out).not.toContain("# Report");
    expect(out).toContain("point a");
    // Expanded shows the full report — the old 50-line cap note is gone.
    expect(out).not.toContain("use get_subagent_result with verbose");
  });

  it("expanded: the markdown body is dimmed", () => {
    const tool = agentTool();
    const result = { content: [{ type: "text", text: "plain body line" }], details };
    const out = tool.renderResult(result, { expanded: true }, markingTheme, { isError: false }).render(90).join("\n");
    expect(out).toContain("\u0001dim\u0002plain body line");
  });

  it("collapsed: the ⎿ Done line and no body, as before", () => {
    const tool = agentTool();
    const result = { content: [{ type: "text", text: "# Report" }], details };
    const out = plain(asContainer(tool.renderResult(result, { expanded: false }, identityTheme, { isError: false })));
    expect(out).toContain("⎿  Done");
    expect(out).not.toContain("Report");
  });

  it("error results stay plain text", () => {
    const tool = agentTool();
    const result = { content: [{ type: "text", text: "# boom" }], details: { status: "error" } };
    const out = plain(asContainer(tool.renderResult(result, { expanded: true }, identityTheme, { isError: true })));
    expect(out).toContain("# boom");
  });
});

describe("completion notification renders the result as markdown when expanded", () => {
  const details: NotificationDetails = {
    description: "the one",
    status: "completed",
    turnCount: 2,
    maxTurns: 10,
    toolUses: 3,
    totalTokens: 1_000,
    totalCost: 0,
    durationMs: 5_000,
    resultPreview: "# Summary\n\nPoint one.",
  };

  function renderer() {
    return boot().messageRenderers.get("subagent-notification");
  }

  it("expanded: the preview renders as dim markdown", () => {
    const out = plain(asContainer(renderer()({ details }, { expanded: true }, identityTheme)));
    expect(out).toContain("✓ the one");
    expect(out).toContain("Summary");
    expect(out).not.toContain("# Summary");
    expect(out).toContain("Point one.");
  });

  it("collapsed: the literal first-line preview is unchanged", () => {
    const out = plain(asContainer(renderer()({ details }, { expanded: false }, identityTheme)));
    expect(out).toContain("⎿  # Summary");
    expect(out).not.toContain("Point one.");
  });

  it("expanded: the transcript link survives below the markdown body", () => {
    const d = { ...details, outputFile: "/tmp/a1.output" };
    const out = plain(asContainer(renderer()({ details: d }, { expanded: true }, identityTheme)));
    expect(out).toContain("transcript: /tmp/a1.output");
  });
});
