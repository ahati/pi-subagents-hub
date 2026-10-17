/**
 * pause-restart-continue.test.ts — the restart side of the /pause → quit →
 * /resume → /continue redesign.
 *
 * Two layers, one file (both fail on missing behaviour today, not on syntax):
 *
 *  B. `src/session-continue.ts` — the M1 shadow continuation seam,
 *     `continueSessionBare(session, opts?)`, driven against a REAL
 *     SessionManager on a temp session file. The seam module does not exist
 *     yet, so it is imported lazily (the repo's existing tests do the same for
 *     not-yet-loaded modules) and each test fails on the pinned assertion with
 *     a readable "not implemented" message instead of a file-level load error.
 *
 *  C. Restart wiring through the REAL extension: a v2 manifest (mainTurn +
 *     one entry) seeded on disk, a fresh boot, `/continue`. Ordering of the
 *     main-turn continuation (ctx.switchSession) before the subagent revive
 *     (runAgent with resumeSessionFile), claim refusal, stale-claim
 *     proceed, and the `replace([])`-preservation regression.
 *
 * Pinned seam: `continueSessionBare(session, opts?)` from src/session-continue.ts.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});

vi.mock("@earendil-works/pi-coding-agent", async () => {
  const actual = await vi.importActual<any>("@earendil-works/pi-coding-agent");
  // `continueParkedMainTurn`'s shadow continuation streams a REAL model turn
  // through `createAgentSession`. With no model backend the stream dies at
  // network-failure latency — ~30s per attempt when connect hangs, minutes
  // with retries — which this file rode as a 120s budget and, on a cold run,
  // as a multi-minute stall. A scripted faux model makes the continuation
  // instant and hermetic: these tests assert the wiring (switch order, claim
  // refusal, manifest rewrite), never the model's answer.
  const { fauxModelBackend } = await import("./helpers/faux-model-backend.js");
  const { registerFauxProvider } = await import("./helpers/pi-ai.js");
  const { fauxAssistantMessage } = await import("@earendil-works/pi-ai");
  const faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: 200_000 }] });
  const step = () => fauxAssistantMessage("continuation answer");
  faux.setResponses(Array.from({ length: 32 }, () => step));
  return {
    ...actual,
    createAgentSession: (opts: any) => actual.createAgentSession({ ...opts, ...fauxModelBackend(faux.getModel()) }),
  };
});

import { resumeAgent, runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { PauseStore, resolvePauseStorePath } from "../src/pause-store.js";
import { ctx, flush, type Hermetic, hermeticDir, makePi } from "./helpers/boot-extension.js";

/** Minimal AgentMessage / SessionEntry stand-ins — the seam only reads these. */
interface ToolCallFixture {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

const ts = "2026-01-01T00:00:00.000Z";

function toolCall(call: ToolCallFixture) {
  return { type: "toolCall", id: call.id, name: call.name, arguments: call.arguments };
}

function assistantMessage(calls: ToolCallFixture[], text?: string, overrides: Record<string, unknown> = {}) {
  const content = [...(text === undefined ? [] : [{ type: "text", text }]), ...calls.map(toolCall)];
  return { role: "assistant", content, timestamp: ts, ...overrides };
}

function toolResultMessage(id: string, name = "read", overrides: Record<string, unknown> = {}) {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: name,
    content: [{ type: "text", text: `result for ${id}` }],
    usage: { input: 1, output: 2, total: 3 },
    isError: false,
    timestamp: ts,
    ...overrides,
  };
}

/** Minimal AgentMessage / SessionEntry stand-ins — the seam only reads these. */

/**
 * A session file with a real branch: system, user, assistant(text?,
 * toolCalls…), results. `overrides` lands on the assistant entry, for shapes
 * like `{ stopReason: "stop" }`.
 */
function seedTranscript(
  dir: string,
  calls: ToolCallFixture[],
  answered: ToolCallFixture[] = [],
  text?: string,
  overrides: Record<string, unknown> = {},
) {
  const manager = SessionManager.create(dir, dir);
  manager.appendMessage({ role: "system", content: [{ type: "text", text: "sys" }], timestamp: ts });
  manager.appendMessage({ role: "user", content: [{ type: "text", text: "do the thing" }], timestamp: ts });
  manager.appendMessage(assistantMessage(calls, text, overrides));
  for (const call of answered) manager.appendMessage(toolResultMessage(call.id, call.name));
  return manager;
}

/** The structural session `continueSessionBare` takes (contract B). */
function shadowSession(manager: ReturnType<typeof seedTranscript>, tools: unknown[]) {
  const agent = {
    state: { messages: manager.getBranch().map((e: any) => e.message), tools } as any,
    continue: vi.fn(async () => {}),
    waitForIdle: vi.fn(async () => {}),
    beforeToolCall: vi.fn(),
    afterToolCall: vi.fn(),
  };
  const session = {
    agent,
    sessionManager: manager,
    refreshContext: vi.fn(() => {
      agent.state.messages = manager.getBranch().map((e: any) => e.message);
    }),
  };
  return session as any;
}

/**
 * Load the not-yet-existing seam lazily so every test below fails on the
 * pinned assertion rather than on a whole-file load error.
 */
async function loadSeam(): Promise<any> {
  try {
    return await import("../src/session-continue.js");
  } catch (err) {
    throw new Error(`src/session-continue.ts (continueSessionBare) is not implemented yet: ${(err as Error).message}`);
  }
}

async function continueBare(session: any, opts: any = {}) {
  const mod = await loadSeam();
  expect(mod.continueSessionBare, "src/session-continue.ts must export continueSessionBare").toBeTypeOf("function");
  return mod.continueSessionBare(session, opts);
}

/** Flattened call arguments — tolerates `execute(toolCall, tools)` and
 * `execute(toolCall, { tools })`. */
function argsContainTools(args: unknown[], tools: unknown): boolean {
  return args.some((arg) => arg === tools || (typeof arg === "object" && arg !== null && (arg as any).tools === tools));
}

/** A JSONL session file with the given entries, written to the current temp dir. */
function writeTranscript(dir: string, entries: unknown[]): string {
  const file = join(dir, "report-transcript.jsonl");
  writeFileSync(file, entries.map(e => (typeof e === "string" ? e : JSON.stringify(e))).join("\n"));
  return file;
}

/** An assistant entry carrying the given content blocks. */
function assistantEntry(content: unknown[]): unknown {
  return { type: "message", message: { role: "assistant", content, timestamp: Date.now() } };
}

/** A user entry. */
function userEntry(text: string): unknown {
  return { type: "message", message: { role: "user", content: [{ type: "text", text }], timestamp: Date.now() } };
}

describe("finalReportFromSessionFile", () => {
  let dir: string | undefined;
  let warn: ReturnType<typeof vi.spyOn> | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-final-report-"));
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warn?.mockRestore();
    warn = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  async function read(file: string, options?: unknown) {
    const mod = await loadSeam();
    expect(
      mod.finalReportFromSessionFile,
      "src/session-continue.ts must export finalReportFromSessionFile",
    ).toBeTypeOf("function");
    return options === undefined ? mod.finalReportFromSessionFile(file) : mod.finalReportFromSessionFile(file, options);
  }

  it("returns the last assistant text without warning", async () => {
    const file = writeTranscript(dir!, [
      userEntry("go"),
      assistantEntry([{ type: "text", text: "the final report" }]),
    ]);

    expect(await read(file)).toBe("the final report");
    expect(warn).not.toHaveBeenCalled();
  });

  it("warns when the transcript ends on an unanswered tool call", async () => {
    const file = writeTranscript(dir!, [
      userEntry("go"),
      assistantEntry([{ type: "toolCall", id: "t1", name: "grep", arguments: {} }]),
    ]);

    expect(await read(file)).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    const line = String(vi.mocked(warn!).mock.calls[0][0]);
    expect(line).toContain("[pi-subagents-hub]");
    expect(line).toContain("unanswered tool call");
  });

  it("warns when the transcript ends on a non-assistant message", async () => {
    const file = writeTranscript(dir!, [
      assistantEntry([{ type: "text", text: "preamble" }]),
      { type: "message", message: { role: "toolResult", toolCallId: "t1", content: [], timestamp: Date.now() } },
    ]);

    expect(await read(file)).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(warn!).mock.calls[0][0])).toContain("non-assistant");
  });

  it("warns when the transcript ends on an assistant message with no text", async () => {
    const file = writeTranscript(dir!, [userEntry("go"), assistantEntry([])]);

    expect(await read(file)).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(warn!).mock.calls[0][0])).toContain("no text");
  });

  it("warns when the file holds no parseable message entries", async () => {
    const file = writeTranscript(dir!, ["not json", "", "also not json"]);

    expect(await read(file)).toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(warn!).mock.calls[0][0])).toContain("no message entries");
  });

  it("stays silent when the file does not exist", async () => {
    expect(await read(join(dir!, "missing.jsonl"))).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it("stays silent when the caller opts out with quiet", async () => {
    const file = writeTranscript(dir!, [
      assistantEntry([{ type: "toolCall", id: "t1", name: "grep", arguments: {} }]),
    ]);

    expect(await read(file, { quiet: true })).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("M1 shadow continuation (continueSessionBare)", () => {
  let dir: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-shadow-"));
  });

  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("executes only the unanswered tool calls", async () => {
    const answered = { id: "tc2", name: "read", arguments: { path: "b.ts" } };
    const pending = { id: "tc1", name: "read", arguments: { path: "a.ts" } };
    const manager = seedTranscript(dir!, [pending, answered], [answered]);
    const tools = [{ name: "read" }];
    const session = shadowSession(manager, tools);
    const execute = vi.fn(async (call: ToolCallFixture) => toolResultMessage(call.id, call.name));

    await continueBare(session, { execute });

    expect(execute).toHaveBeenCalledTimes(1);
    const [call, toolsArg] = execute.mock.calls[0] as [any, any];
    expect(call).toMatchObject({ id: "tc1", name: "read" });
    expect(argsContainTools([toolsArg], tools), "execute must receive the session's tools").toBe(true);
  });

  it("appends each produced ToolResultMessage to the branch and to disk", async () => {
    const pending = { id: "tc1", name: "read", arguments: { path: "a.ts" } };
    const manager = seedTranscript(dir!, [pending]);
    const session = shadowSession(manager, [{ name: "read" }]);
    const execute = vi.fn(async () => toolResultMessage("tc1"));
    const file = manager.getSessionFile();
    const sizeBefore = readFileSync(file, "utf-8").length;

    await continueBare(session, { execute });

    const branch = manager.getBranch();
    const appended = branch.find((e: any) => e.message?.role === "toolResult");
    expect(appended?.message).toMatchObject({
      role: "toolResult",
      toolCallId: "tc1",
      toolName: "read",
      isError: false,
      usage: { input: 1, output: 2, total: 3 },
    });
    expect(appended?.message.content).toEqual([{ type: "text", text: "result for tc1" }]);
    expect(readFileSync(file, "utf-8").length).toBeGreaterThan(sizeBefore);
    // Reopening the file sees the healed branch too.
    expect(
      SessionManager.open(file)
        .getBranch()
        .some((e: any) => e.message?.role === "toolResult" && e.message.toolCallId === "tc1"),
    ).toBe(true);
  });

  it("refreshes context, then bare-continues once and awaits idle", async () => {
    const pending = { id: "tc1", name: "read", arguments: { path: "a.ts" } };
    const manager = seedTranscript(dir!, [pending]);
    const session = shadowSession(manager, [{ name: "read" }]);
    const appendSpy = vi.spyOn(manager, "appendMessage");
    const execute = vi.fn(async () => toolResultMessage("tc1"));

    await continueBare(session, { execute });

    expect(session.refreshContext).toHaveBeenCalledTimes(1);
    expect(session.agent.continue).toHaveBeenCalledTimes(1);
    expect(session.agent.continue).toHaveBeenCalledWith();
    expect(session.agent.waitForIdle).toHaveBeenCalledTimes(1);
    const order = [
      appendSpy.mock.invocationCallOrder[0],
      session.refreshContext.mock.invocationCallOrder[0],
      session.agent.continue.mock.invocationCallOrder[0],
      session.agent.waitForIdle.mock.invocationCallOrder[0],
    ];
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });

  it("returns executed/errors counts", async () => {
    const calls = [
      { id: "tc1", name: "read", arguments: { path: "a.ts" } },
      { id: "tc2", name: "read", arguments: { path: "b.ts" } },
    ];
    const manager = seedTranscript(dir!, calls);
    const session = shadowSession(manager, [{ name: "read" }]);
    const execute = vi.fn(async (call: ToolCallFixture) => toolResultMessage(call.id, call.name));

    const result = await continueBare(session, { execute });

    expect(result).toEqual({ executed: 2, errors: 0 });
  });

  it("turns an executor failure into an honest isError result and does not throw", async () => {
    const pending = { id: "tc1", name: "read", arguments: { path: "a.ts" } };
    const manager = seedTranscript(dir!, [pending]);
    const session = shadowSession(manager, [{ name: "read" }]);
    const execute = vi.fn(async () => {
      throw new Error("tool blew up");
    });

    const result = await continueBare(session, { execute });

    const appended = manager.getBranch().find((e: any) => e.message?.role === "toolResult");
    expect(appended?.message).toMatchObject({ role: "toolResult", toolCallId: "tc1", toolName: "read", isError: true });
    expect(JSON.stringify(appended?.message.content)).toContain("tool blew up");
    expect(result.errors).toBe(1);
    expect(session.agent.continue).toHaveBeenCalledTimes(1);
  });

  it("still continues bare when the transcript has no pending calls", async () => {
    const manager = seedTranscript(dir!, [], []);
    const session = shadowSession(manager, [{ name: "read" }]);
    const execute = vi.fn(async () => toolResultMessage("tc-none"));

    await continueBare(session, { execute });

    expect(execute).not.toHaveBeenCalled();
    expect(session.agent.continue).toHaveBeenCalledTimes(1);
  });

  it("a completed transcript (final assistant answer, no pending calls) is recognized as already complete", async () => {
    const manager = seedTranscript(dir!, [], [], "the final report", { stopReason: "stop" });
    const session = shadowSession(manager, [{ name: "read" }]);
    const execute = vi.fn(async () => toolResultMessage("tc-none"));
    const entriesBefore = manager.getBranch().length;

    const result = await continueBare(session, { execute });

    expect(session.refreshContext).toHaveBeenCalledTimes(1);
    expect(session.agent.continue, "an already-final assistant turn cannot be continued").not.toHaveBeenCalled();
    expect(session.agent.waitForIdle).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(result).toEqual({
      executed: 0,
      errors: 0,
      alreadyComplete: true,
      finalText: "the final report",
    });
    expect(manager.getBranch().length, "a completed transcript must not gain entries").toBe(entriesBefore);
  });

  it("a completed transcript WITH an unanswered tool call still heals and continues", async () => {
    const pending = { id: "tc1", name: "read", arguments: { path: "a.ts" } };
    const manager = seedTranscript(dir!, [pending]);
    const session = shadowSession(manager, [{ name: "read" }]);
    const execute = vi.fn(async (call: ToolCallFixture) => toolResultMessage(call.id, call.name));

    const result = await continueBare(session, { execute });

    expect(execute, "the unanswered call must still be healed").toHaveBeenCalledTimes(1);
    expect(session.agent.continue, "the healed turn must still be continued").toHaveBeenCalledTimes(1);
    expect(result.alreadyComplete).toBeUndefined();
    expect(result.executed).toBe(1);
  });

  it("finalText is surfaced on the normal continuation path too", async () => {
    const answered = { id: "tc1", name: "read", arguments: { path: "a.ts" } };
    const manager = seedTranscript(dir!, [answered], [answered], "prior answer");
    const session = shadowSession(manager, [{ name: "read" }]);
    // The continuation's own answer lands after the prior turn, so finalText
    // must come from the post-continuation transcript — not the stale first
    // answer this fixture deliberately seeds.
    session.agent.continue.mockImplementation(async () => {
      manager.appendMessage(assistantMessage([], "the continuation answer"));
    });

    const result = await continueBare(session);

    expect(session.agent.continue).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ executed: 0, errors: 0, finalText: "the continuation answer" });
  });
});

describe("post-restart /continue wiring", () => {
  let hermetic: Hermetic | undefined;
  let booted: Map<string, any> | undefined;

  beforeEach(() => {
    vi.mocked(runAgent).mockReset();
    vi.mocked(resumeAgent).mockReset();
  });

  afterEach(async () => {
    await booted?.get("session_shutdown")?.();
    delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
    booted = undefined;
    hermetic?.restore();
    hermetic = undefined;
  });

  function bootOnly() {
    const b = makePi();
    subagentsExtension(b.pi);
    booted = b.lifecycle;
    return b;
  }

  /** The parked main transcript: assistant message with an unanswered tool call. */
  function seedMainSession(rootDir: string) {
    const manager = SessionManager.create(rootDir, rootDir);
    manager.appendMessage({ role: "system", content: [{ type: "text", text: "sys" }], timestamp: ts });
    manager.appendMessage({ role: "user", content: [{ type: "text", text: "do it" }], timestamp: ts });
    manager.appendMessage(
      assistantMessage([{ id: "tc1", name: "read", arguments: { path: "a.ts" } }]),
    );
    return manager.getSessionFile();
  }

  function manifestPath(sessionId = "s1"): string {
    return resolvePauseStorePath(process.cwd(), sessionId);
  }

  /** Write a v3 manifest by hand — the shape a previous process left behind. */
  function seedManifest(
    mainTurn: Record<string, unknown> | undefined,
    entries: unknown[],
    sessionId = "s1",
    workflows?: unknown[],
  ): string {
    const file = manifestPath(sessionId);
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(
      file,
      JSON.stringify(
        { version: 3, entries, ...(mainTurn ? { mainTurn } : {}), ...(workflows ? { workflows } : {}) },
        null,
        2,
      ),
    );
    return file;
  }

  function manifestOnDisk(sessionId = "s1"): any {
    const file = manifestPath(sessionId);
    if (!existsSync(file)) return undefined;
    return JSON.parse(readFileSync(file, "utf-8"));
  }

  function entryFor(sessionFile: string, overrides: Record<string, unknown> = {}) {
    return {
      id: "agent-old1",
      type: "Explore",
      handle: "explore",
      description: "find flaky tests",
      sessionFile,
      pausedAt: ts,
      ...overrides,
    };
  }

  function parkedMainTurn(overrides: Record<string, unknown> = {}) {
    return {
      parked: true,
      pendingTools: 1,
      claim: { pid: 999999999, at: ts },
      pausedAt: ts,
      ...overrides,
    };
  }

  function continueCtx(sessionFile: string, overrides: Record<string, unknown> = {}) {
    return ctx({
      isIdle: () => true,
      cwd: process.cwd(),
      ui: { setStatus: vi.fn(), setWidget: vi.fn(), notify: vi.fn(), addAutocompleteProvider: vi.fn() },
      sessionManager: {
        getSessionId: () => "s1",
        getBranch: () => [],
        getSessionFile: () => sessionFile,
      },
      // pi's switchSession runs the callback against the freshly opened session.
      // The real API passes options ({ withSession }); accept a bare callback too.
      switchSession: vi.fn(async (_file: string, arg?: unknown) => {
        const callback =
          typeof arg === "function"
            ? (arg as () => Promise<void> | void)
            : (arg as { withSession?: () => Promise<void> | void } | undefined)?.withSession;
        await callback?.();
      }),
      sendUserMessage: vi.fn(),
      ...overrides,
    });
  }

  function resumeCalls(): number {
    return vi.mocked(runAgent).mock.calls.filter((c) => (c[3] as any)?.resumeSessionFile).length;
  }

  /** A revive that stays running, so the entry's revival is observable. */
  function heldRevive() {
    vi.mocked(runAgent).mockImplementation(
      () =>
        new Promise(() => {
          /* never settles */
        }) as any,
    );
  }

  it("continues the parked main turn before reviving the subagents", async () => {
    hermetic = hermeticDir({ settings: { outputTranscript: false } });
    const mainSessionFile = seedMainSession(hermetic.dir);
    const agentSessionFile = join(hermetic.dir, "agent-session.jsonl");
    writeFileSync(agentSessionFile, "");
    seedManifest(parkedMainTurn(), [entryFor(agentSessionFile)]);

    const b = bootOnly();
    heldRevive();
    const cmdCtx = continueCtx(mainSessionFile);
    await b.commands.get("continue").handler("", cmdCtx);
    await flush();

    expect(cmdCtx.switchSession).toHaveBeenCalledWith(mainSessionFile, expect.anything());
    expect(resumeCalls()).toBe(1);
    const switchOrder = cmdCtx.switchSession.mock.invocationCallOrder[0];
    const reviveOrder = vi.mocked(runAgent).mock.invocationCallOrder[0];
    expect(switchOrder, "the main-turn continuation must run before the subagent revival").toBeLessThan(reviveOrder);
  });

  it("sends no prompt during the restart continuation", async () => {
    hermetic = hermeticDir({ settings: { outputTranscript: false } });
    const mainSessionFile = seedMainSession(hermetic.dir);
    seedManifest(parkedMainTurn(), []);

    const b = bootOnly();
    const cmdCtx = continueCtx(mainSessionFile);
    await b.commands.get("continue").handler("", cmdCtx);
    await flush();

    // The turn really was continued (not merely skipped)…
    expect(cmdCtx.switchSession, "the parked main turn must be continued").toHaveBeenCalledWith(
      mainSessionFile,
      expect.anything(),
    );
    // …and it got there with no prompt of any kind.
    expect(cmdCtx.sendUserMessage).not.toHaveBeenCalled();
    expect(b.pi.sendMessage).not.toHaveBeenCalled();
  });

  it("refuses to continue while a live window holds the claim", async () => {
    hermetic = hermeticDir({ settings: { outputTranscript: false } });
    const mainSessionFile = seedMainSession(hermetic.dir);
    const agentSessionFile = join(hermetic.dir, "agent-session.jsonl");
    writeFileSync(agentSessionFile, "");
    // process.pid is alive; the claim is fresh -> a second window is running.
    seedManifest(
      parkedMainTurn({ claim: { pid: process.pid, at: new Date().toISOString() } }),
      [entryFor(agentSessionFile)],
    );

    const b = bootOnly();
    heldRevive();
    const cmdCtx = continueCtx(mainSessionFile);
    await b.commands.get("continue").handler("", cmdCtx);
    await flush();

    expect(cmdCtx.switchSession).not.toHaveBeenCalled();
    expect(resumeCalls()).toBe(0);
    const warnings = cmdCtx.ui.notify.mock.calls.filter((c: any[]) => c[1] === "warning");
    expect(warnings.length, "a refusal must be a warning toast, never silent").toBeGreaterThan(0);
    expect(warnings.map((c: any[]) => String(c[0])).join(" ")).toMatch(/claim|pid|another|in use|window/i);
  });

  it("proceeds when the claim is stale", async () => {
    hermetic = hermeticDir({ settings: { outputTranscript: false } });
    const mainSessionFile = seedMainSession(hermetic.dir);
    seedManifest(parkedMainTurn(), []);

    const b = bootOnly();
    const cmdCtx = continueCtx(mainSessionFile);
    await b.commands.get("continue").handler("", cmdCtx);
    await flush();

    expect(cmdCtx.switchSession, "a dead pid with an old timestamp must not block /continue").toHaveBeenCalled();
    const refused = cmdCtx.ui.notify.mock.calls.some(
      (c: any[]) => c[1] === "warning" && /claim|pid|another window|in use/i.test(String(c[0])),
    );
    expect(refused).toBe(false);
  });

  it("clears mainTurn and the entries after a successful /continue", async () => {
    hermetic = hermeticDir({ settings: { outputTranscript: false } });
    const mainSessionFile = seedMainSession(hermetic.dir);
    const agentSessionFile = join(hermetic.dir, "agent-session.jsonl");
    writeFileSync(agentSessionFile, "");
    seedManifest(parkedMainTurn(), [entryFor(agentSessionFile)]);

    const b = bootOnly();
    heldRevive();
    const cmdCtx = continueCtx(mainSessionFile);
    await b.commands.get("continue").handler("", cmdCtx);
    await flush();

    expect(cmdCtx.switchSession, "the parked main turn must be continued").toHaveBeenCalledWith(
      mainSessionFile,
      expect.anything(),
    );
    const onDisk = manifestOnDisk();
    expect(onDisk?.mainTurn, "mainTurn must be cleared once the parked turn was continued").toBeUndefined();
    expect(onDisk?.entries ?? []).toEqual([]);
  });

  it("clears mainTurn, entries, and relaunches workflows after a successful /continue", async () => {
    hermetic = hermeticDir({ settings: { outputTranscript: false, workflowsEnabled: true } });
    const mainSessionFile = seedMainSession(hermetic.dir);
    const agentSessionFile = join(hermetic.dir, "agent-session.jsonl");
    writeFileSync(agentSessionFile, "");
    const journalPath = join(hermetic.dir, "test.workflow.jsonl");
    writeFileSync(journalPath, '{"index":0,"key":"k0","ok":true,"text":"res"}\n');
    const wfEntry = {
      id: "wf_1",
      journalPath,
      script: 'export const meta = { name: "wf-main", description: "wf description" }; await agent("held"); return 1;',
      pausedAt: ts,
    };
    seedManifest(parkedMainTurn(), [entryFor(agentSessionFile)], "s1", [wfEntry]);

    const b = bootOnly();
    heldRevive();
    const cmdCtx = continueCtx(mainSessionFile);
    await b.commands.get("continue").handler("", cmdCtx);
    await flush();

    expect(cmdCtx.switchSession, "the parked main turn must be continued").toHaveBeenCalledWith(
      mainSessionFile,
      expect.anything(),
    );
    const onDisk = manifestOnDisk();
    expect(onDisk?.mainTurn, "mainTurn must be cleared once the parked turn was continued").toBeUndefined();
    expect(onDisk?.entries ?? []).toEqual([]);
    expect(onDisk?.workflows ?? []).toEqual([]);
  });

  it("replace([]) from the settle funnel preserves a landed mainTurn", async () => {
    hermetic = hermeticDir({ settings: { outputTranscript: false } });
    const file = seedManifest(parkedMainTurn(), [entryFor(join(hermetic.dir, "agent-session.jsonl"))]);

    // The quit-time abortAll()/settle rewrite goes through replace([]).
    new PauseStore(file).replace([]);

    const onDisk = manifestOnDisk();
    expect(existsSync(file)).toBe(true);
    expect(onDisk?.mainTurn).toEqual(parkedMainTurn());
    expect(onDisk?.entries ?? []).toEqual([]);
  });
});
