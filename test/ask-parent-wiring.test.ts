/**
 * Wiring seams for the ask_parent / answer_subagent feature.
 *
 * Everything here drives the REAL runAgent session-build path (runner-session)
 * with a mocked pi runtime, so the assertions land on the arrays and flags pi
 * actually receives: `customTools`, `tools` (noExtensions) and `excludeTools`.
 * Tool behavior itself lives in test/ask-parent.test.ts.
 */
import { describe, expect, it, vi } from "vitest";

const { createAgentSession, getAgentDir } = vi.hoisted(() => ({
  createAgentSession: vi.fn(),
  getAgentDir: vi.fn(() => "/mock/agent-dir"),
}));

vi.mock("@earendil-works/pi-coding-agent", () => ({
  createAgentSession,
  createCodemodeExtension: () => "codemode-factory",
  createToolSearchExtension: () => "tool-search-factory",
  createMcpExtension: () => "mcp-factory",
  defineTool: (definition: unknown) => definition,
  DefaultResourceLoader: class {
    constructor(readonly opts: any) {}
    async reload() {}
    getExtensions() {
      return { extensions: [], errors: [], runtime: {} };
    }
  },
  getAgentDir,
  SessionManager: {
    inMemory: vi.fn(() => ({ kind: "memory" })),
    create: vi.fn(() => ({ kind: "persistent" })),
    open: vi.fn(() => ({ kind: "opened" })),
  },
  SettingsManager: { create: vi.fn(() => ({ getSessionDir: () => undefined })) },
}));

/** Agent config returned by the mocked `getAgentConfig` — set per test. */
let agentFile: Record<string, unknown> | undefined;
/** `config` returned by the mocked `getConfig` — set per test. */
let typeConfig: Record<string, unknown>;

vi.mock("../src/agent-types.js", () => ({
  BUILTIN_TOOL_NAMES: ["read", "bash", "edit", "write", "grep", "find", "ls"],
  buildAgentRegistry: vi.fn(() => new Map()),
  getAvailableTypesIn: vi.fn(() => []),
  getConfig: vi.fn(() => typeConfig),
  getAgentConfig: vi.fn(() => agentFile),
  getMemoryToolNames: vi.fn(() => []),
  getReadOnlyMemoryToolNames: vi.fn(() => []),
  getToolNamesForType: vi.fn(() => ["read"]),
  resolveTypeIn: vi.fn(() => undefined),
}));

// The nested tool factory builds a per-branch agent registry from disk; the
// wiring under test is about names, so the registry is empty.
vi.mock("../src/custom-agents.js", () => ({ loadCustomAgents: vi.fn(() => []) }));

vi.mock("../src/env.js", () => ({
  detectEnv: vi.fn(async () => ({ isGitRepo: false, branch: "", platform: "linux" })),
}));
vi.mock("../src/prompts.js", () => ({ buildAgentPrompt: vi.fn(() => "system prompt") }));
vi.mock("../src/memory.js", () => ({
  buildMemoryBlock: vi.fn(() => ""),
  buildReadOnlyMemoryBlock: vi.fn(() => ""),
}));

import { EXCLUDED_TOOL_NAMES, runAgent, SUBAGENT_TOOL_NAMES } from "../src/agent-runner.js";
import type { NestedAgentManager } from "../src/nested-tools.js";
import { createAnswerTool } from "../src/tools/inspect-tools.js";
import type { AgentRecord } from "../src/types.js";

const NESTED = ["Agent", "get_subagent_result", "steer_subagent", "ask_parent", "answer_subagent"];

function fakeSession() {
  const session = {
    messages: [] as any[],
    subscribe: vi.fn(() => () => {}),
    prompt: vi.fn(async () => {
      session.messages.push({ role: "assistant", content: [{ type: "text", text: "DONE" }] });
    }),
    abort: vi.fn(),
    steer: vi.fn(),
    getActiveToolNames: vi.fn(() => ["read"]),
    setActiveToolsByName: vi.fn(),
    getAllTools: vi.fn(() => []),
    getToolDefinition: vi.fn(() => undefined),
    agent: {},
    setSessionName: vi.fn(),
    bindExtensions: vi.fn(async () => {}),
  };
  return session;
}

const ctx = {
  cwd: "/tmp",
  model: undefined,
  isProjectTrusted: vi.fn(() => true),
  modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
  getSystemPrompt: vi.fn(() => "parent prompt"),
  sessionManager: { getBranch: vi.fn(() => []), getSessionFile: vi.fn(() => undefined) },
} as any;

const nestedRuntime = {
  manager: {} as NestedAgentManager,
  parentAgentId: "parent-1",
  depth: 1,
  maxSubagentDepth: 2,
};

/** Build a session through the real runAgent path and return pi's options. */
async function buildSession(over: { agent?: Record<string, unknown>; config?: Record<string, unknown>; opts?: Record<string, unknown> } = {}) {
  agentFile = over.agent;
  typeConfig = { displayName: "T", description: "T", builtinToolNames: ["read"], extensions: true, skills: false, promptMode: "replace", ...over.config };
  const session = fakeSession();
  createAgentSession.mockResolvedValue({ session });
  await runAgent(ctx, "Explore", "hi", { pi: {} as any, ...over.opts });
  return createAgentSession.mock.calls.at(-1)?.[0] as any;
}

function customToolNames(opts: any): string[] {
  return (opts?.customTools ?? []).map((t: any) => t.name);
}

describe("nested tool injection gate", () => {
  it("injects exactly the five nested tools when allowedSubagents + nestedRuntime and not isolated", async () => {
    const opts = await buildSession({ agent: { allowedSubagents: "all" }, opts: { nestedRuntime } });

    expect(customToolNames(opts)).toEqual(NESTED);
    // The default (extensions loaded) branch must NOT deny any nested tool.
    for (const name of NESTED) expect(opts.excludeTools).not.toContain(name);
  });

  it("lists the nested tools in `tools` (noExtensions branch) and not in excludeTools", async () => {
    const opts = await buildSession({
      agent: { allowedSubagents: "all" },
      config: { extensions: false },
      opts: { nestedRuntime },
    });

    expect(opts.tools).toEqual(expect.arrayContaining(NESTED));
    // database: names come from createNestedSubagentTools, not a hardcoded copy
    expect(opts.excludeTools).toBeUndefined();
    for (const name of EXCLUDED_TOOL_NAMES) {
      // EXCLUDED filters root-inherited tools only; nested ones are re-added.
      if (name === SUBAGENT_TOOL_NAMES.WORKFLOW) continue;
      expect(opts.tools).toContain(name);
    }
  });

  it("drops ask_parent from the effective set when disallowedTools names it (default branch)", async () => {
    const opts = await buildSession({
      agent: { allowedSubagents: "all", disallowedTools: ["ask_parent"] },
      opts: { nestedRuntime },
    });

    // customTools carries the full factory output; the deny list is the seam
    // that removes ask_parent from the effective tool set.
    expect(customToolNames(opts)).toEqual(NESTED);
    expect(opts.excludeTools).toContain("ask_parent");
    expect(opts.excludeTools).not.toContain("answer_subagent");
    expect(opts.excludeTools).not.toContain("Agent");
  });

  it("drops ask_parent from the noExtensions tool list when disallowedTools names it", async () => {
    const opts = await buildSession({
      agent: { allowedSubagents: "all", disallowedTools: ["ask_parent"] },
      config: { extensions: false },
      opts: { nestedRuntime },
    });

    expect(opts.tools).not.toContain("ask_parent");
    expect(opts.tools).toContain("answer_subagent");
    expect(opts.tools).toContain("Agent");
  });

  it("injects no nested tools when isolated, even with allowedSubagents", async () => {
    const opts = await buildSession({
      agent: { allowedSubagents: "all", isolated: true },
      opts: { nestedRuntime },
    });

    expect(customToolNames(opts)).toEqual([]);
  });

  it("gives every subagent the ask suite even without allowedSubagents — but no delegation tools", async () => {
    const opts = await buildSession({ agent: { name: "Explore" }, opts: { nestedRuntime } });

    expect(customToolNames(opts)).toEqual(["ask_parent", "answer_subagent"]);
    expect(opts.tools ?? []).not.toContain("ask_parent");
    expect(opts.tools ?? []).not.toContain("answer_subagent");
    expect(opts.excludeTools ?? []).not.toContain("ask_parent");
  });

  it("gives a depth-capped agent the ask suite, but no delegation tools", async () => {
    const capped = { ...nestedRuntime, depth: 2, maxSubagentDepth: 2 };
    const opts = await buildSession({
      agent: { allowedSubagents: "all" },
      opts: { nestedRuntime: capped },
    });

    expect(customToolNames(opts)).toEqual(["ask_parent", "answer_subagent"]);
    expect(customToolNames(opts)).not.toContain("Agent");
  });

  it("respects disallowedTools on the ask suite outside the delegation gate", async () => {
    const opts = await buildSession({
      agent: { name: "Explore", disallowedTools: ["ask_parent"] },
      opts: { nestedRuntime },
    });

    expect(customToolNames(opts)).toEqual(["ask_parent", "answer_subagent"]);
    expect(opts.excludeTools).toContain("ask_parent");
    expect(opts.excludeTools).not.toContain("answer_subagent");
  });

  it("injects no nested tools without a nestedRuntime (root session)", async () => {
    const opts = await buildSession({ agent: { allowedSubagents: "all" } });

    expect(customToolNames(opts)).toEqual([]);
  });
});

describe("EXCLUDED_TOOL_NAMES and the root answer tool", () => {
  it("excludes answer_subagent from children but leaves ask_parent nested-only", () => {
    expect(SUBAGENT_TOOL_NAMES.ANSWER).toBe("answer_subagent");
    expect(EXCLUDED_TOOL_NAMES).toContain("answer_subagent");
    expect(EXCLUDED_TOOL_NAMES).not.toContain("ask_parent");
    expect(EXCLUDED_TOOL_NAMES).not.toContain("answer_subagent_nested");
  });

  it("registers the root tool as answer_subagent and refuses a nested-owned record", async () => {
    const rec = {
      id: "a1",
      type: "general-purpose",
      description: "worker",
      status: "running",
      toolUses: 0,
      startedAt: 1,
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 },
      compactionCount: 0,
      parentAgentId: "parent-1",
      session: { steer: vi.fn() },
      questions: [{ id: "q-1", question: "?", mode: "mailbox", state: "delivered", askedAt: 1 }],
    } as unknown as AgentRecord;

    const tool = createAnswerTool({
      resolveAgentRef: (ref: string) => (ref === rec.id ? rec : undefined),
      isShowCostEnabled: () => false,
      outbox: { queue: vi.fn(), drain: vi.fn(() => []), count: vi.fn(() => 0) } as any,
      pi: { events: { emit: vi.fn() } } as any,
    } as any);

    expect(tool.name).toBe("answer_subagent");

    const result = await tool.execute("call-1", { agent_id: "a1", answer: "x" } as any, undefined as any, undefined as any, undefined as any);
    expect(result.content[0].text).toContain("Agent not found");
    expect(rec.questions?.[0]?.state).toBe("delivered");
  });
});
