/**
 * workflow-activity.test.ts — live activity tracking for workflow-run children.
 *
 * The hub's run pages read `agentActivity` for a running child's live tail; the
 * Agent tool, RPC and direct-mode spawns all register a tracker there, but the
 * workflow host's `spawnAgent`/`resumeAgent` did not — so run-owned children
 * never showed tool calls, only a transcript-scan fallback with raw tool output
 * lines. These tests pin the tracker wiring and the hub tail's extraction rules.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", () => ({
  runAgent: vi.fn(),
  resumeAgent: vi.fn(),
}));

vi.mock("../src/worktree.js", () => ({
  createWorktree: vi.fn(),
  cleanupWorktree: vi.fn(async () => ({ hasChanges: false })),
  pruneWorktrees: vi.fn(async () => {}),
  isWorktreeIsolationEnabled: vi.fn(() => false),
}));

import { AgentManager } from "../src/agent-manager.js";
import { resumeAgent, runAgent } from "../src/agent-runner.js";
import { registerAgents } from "../src/agent-types.js";
import type { AgentActivity } from "../src/ui/agent-widget.js";
import { buildAgentLogLines } from "../src/ui/hub/hub-log-view.js";
import { runAgentTail } from "../src/ui/hub/hub-panes.js";
import { createWorkflowHost } from "../src/workflow/host.js";
import type { WorkflowSpawnRequest } from "../src/workflow/runtime.js";
import { ctx } from "./helpers/boot-extension.js";

const pi = {} as any;

const spawnRequest = (overrides: Partial<WorkflowSpawnRequest> = {}): WorkflowSpawnRequest => ({
  agentId: "wf-agent-0",
  index: 0,
  prompt: "do the thing",
  label: "impl",
  agentType: "general-purpose",
  ...overrides,
});

/** Fires the callbacks a real run would fire, mid-run, then settles. */
function childEmitsActivity(during: (activity: AgentActivity | undefined) => void) {
  vi.mocked(runAgent).mockImplementation(async (_ctx: any, _type: any, _prompt: any, opts: any) => {
    // Let spawn()'s synchronous tail — onSpawned, where the tracker registers — run first.
    await new Promise((resolve) => setTimeout(resolve, 0));
    opts.onSessionCreated?.({ dispose: vi.fn() } as any);
    // The map is keyed by record id, known to the test only via the closure
    // over the host's registration — so the probe looks the entry up by value.
    let activity: AgentActivity | undefined;
    opts.onToolActivity?.({ type: "start", toolName: "read", toolCallId: "t1", args: { path: "src/a.ts" } });
    opts.onTextDelta?.("working\n", "working\n");
    for (const entry of probe.values()) {
      if (entry.activeTools.has("t1")) activity = entry;
    }
    during(activity);
    opts.onToolActivity?.({ type: "end", toolName: "read", toolCallId: "t1" });
    return { responseText: "done", session: { dispose: vi.fn() } as any, aborted: false, steered: false };
  });
}

let manager: AgentManager;
/** The map the production wiring passes to the workflow host; tests probe it directly. */
const probe = new Map<string, AgentActivity>();

beforeEach(() => {
  vi.mocked(runAgent).mockReset();
  vi.mocked(resumeAgent).mockReset();
  registerAgents(new Map());
  manager = new AgentManager();
  probe.clear();
});

describe("workflow child activity tracking", () => {
  it("registers a tracker for a spawned child, with tool calls and streamed text", async () => {
    let seen: AgentActivity | undefined;
    childEmitsActivity((activity) => {
      expect(activity).toBeDefined();
      expect(activity!.activeTools.get("t1")).toEqual({ toolName: "read", args: { path: "src/a.ts" } });
      expect(activity!.responseText).toBe("working\n");
      seen = activity;
    });
    const host = createWorkflowHost({ pi, ctx: ctx({}), manager, agentActivity: probe });
    const result = await host.spawnAgent(spawnRequest({}));
    expect(result.ok).toBe(true);
    expect(seen).toBeDefined();
  });

  it("drops the tracker entry when the child settles", async () => {
    childEmitsActivity(() => {});
    const host = createWorkflowHost({ pi, ctx: ctx({}), manager, agentActivity: probe });
    const result = await host.spawnAgent(spawnRequest({}));
    expect(result.ok).toBe(true);
    expect(probe.size).toBe(0);
  });

  it("tracks a resumed workflow child too", async () => {
    childEmitsActivity(() => {});
    const host = createWorkflowHost({ pi, ctx: ctx({}), manager, agentActivity: probe });
    const spawned = await host.spawnAgent(spawnRequest({}));
    expect(spawned.ok).toBe(true);
    vi.mocked(resumeAgent).mockImplementation(async (_session: any, promptOrOpts: any, optsArg: any) => {
      // resumeAgent takes (session, options) for a bare continuation and
      // (session, prompt, options) with a prompt; the callbacks ride last.
      const opts = typeof promptOrOpts === "string" ? optsArg : promptOrOpts;
      opts?.onToolActivity?.({ type: "start", toolName: "bash", toolCallId: "t2", args: { command: "npm test" } });
      for (const entry of probe.values()) {
        expect(entry.activeTools.get("t2")).toEqual({ toolName: "bash", args: { command: "npm test" } });
      }
      opts?.onToolActivity?.({ type: "end", toolName: "bash", toolCallId: "t2" });
      return { text: "resumed", aborted: false, steered: false };
    });
    const result = await host.resumeAgent("wf-agent-0", undefined, () => {});
    expect(result.ok).toBe(true);
  });
});

describe("runAgentTail extraction", () => {
  const msg = (role: string, text: string) => ({ role, content: [{ type: "text", text }] });

  it("between turns, a tracked agent falls back to the transcript like an untracked one", () => {
    const activity: AgentActivity = {
      activeTools: new Map(),
      toolUses: 1,
      responseText: "",
      turnCount: 2,
    };
    const record = { session: { messages: [msg("assistant", "old narration"), msg("toolResult", "json output\n}")] } };
    expect(runAgentTail(record as any, activity)).toBe("json output");
  });

  it("shows the newest message's line — narration when the agent spoke last", () => {
    const record = { session: { messages: [msg("toolResult", "{\n  \"key\": \"value\"\n}"), msg("assistant", "Reading the config now.")] } };
    expect(runAgentTail(record as any, undefined)).toBe("Reading the config now.");
  });

  it("extracts a contentful line from tool output, skipping JSON braces", () => {
    const record = { session: { messages: [msg("assistant", "Checking the config."), msg("toolResult", "{\n  \"key\": \"value\"\n}")] } };
    expect(runAgentTail(record as any, undefined)).toBe("\"key\": \"value\"");
  });

  it("falls back to the tool result's first contentful line, not its last", () => {
    const record = { session: { messages: [msg("toolResult", "src/auth.ts\nsrc/session.ts\n(truncated)")] } };
    expect(runAgentTail(record as any, undefined)).toBe("src/auth.ts");
  });

  it("the agent log's note line shows the latest line, not the first", () => {
    const record = {
      id: "a1", alias: "alpha", handle: "alpha", type: "general-purpose", description: "task",
      startedAt: 1_000, toolUses: 1, status: "running",
    };
    const activity: AgentActivity = {
      activeTools: new Map(), toolUses: 1,
      responseText: "Opening line.\n\nLatest line after more work.",
      turnCount: 1,
    };
    const calls: unknown[] = [];
    const host = {
      theme: { fg: (_c: string, s: string) => s },
      focusedRecord: () => record,
      deps: { agentActivity: new Map([["a1", activity]]), showCost: false },
      logScroll: 0,
      setLogScroll: () => {},
      setLogReadout: () => { calls.push("readout"); },
    };
    const rows = buildAgentLogLines(80, 20, host as any)
      .map((r: any) => (Array.isArray(r) ? r.map((s: any) => s.text).join("") : ""));
    expect(rows.join("\n")).toContain("note   Latest line after more work.");
    expect(rows.join("\n")).not.toContain("note   Opening line.");
  });
});
