/**
 * pause-main-agent.test.ts — the main-agent half of the /pause + /continue pair.
 *
 * Today `/pause` refuses while the main model streams. The redesigned contract
 * (docs/pause-quit-resume-continue.md §4.1) is: the first `/pause` ARMS
 * the pair, the next boundary event (`tool_call` or `turn_end`) LANDS the park
 * — subagent gates close, `mainTurn` is written to the manifest — and the main
 * run stays suspended at that boundary until `/continue` reopens it. The
 * extension registers neither lifecycle handler yet, so every test here fails
 * until it does.
 *
 * The landing summary toast's exact text is not fixed by the design and is
 * only asserted to exist; the arming and disarming wording is pinned below,
 * since those two are the only strings the design specifies (§4.1 FR-P2).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});

import { resumeAgent, runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { PauseStore, resolvePauseStorePath } from "../src/pause-store.js";
import { type BootedPi, ctx, flush, type Hermetic, hermeticDir, makePi, textOf } from "./helpers/boot-extension.js";

/** Pinned /pause state toasts. */
const ARM_TOAST = "Pausing when the turn reaches its next boundary — /pause again to cancel.";
const DISARM_TOAST = "Pause cancelled.";
/** Today's refusal — the redesign replaces it with arming. */
const OLD_REFUSAL = "Main model is streaming — press Esc (or let the turn finish) before /pause.";

let hermetic: Hermetic | undefined;
/** The most recently booted extension's lifecycle handlers, for teardown. */
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

/** A fake session that reports a session file, so its record is resumable from disk. */
function resumableSession() {
  return {
    steer: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    messages: [],
    getActiveToolNames: vi.fn(() => []),
    sessionManager: { getSessionFile: () => join(hermetic!.dir, "agent-session.jsonl") },
  } as any;
}

/** A runAgent that never settles, so the agent stays "running" (and parked alive). */
function heldRun(session: () => any) {
  vi.mocked(runAgent).mockImplementation(
    (_ctx: any, _type: any, _prompt: any, opts: any) =>
      new Promise(() => {
        opts.onSessionCreated?.(session());
      }) as any,
  );
}

/** A runAgent that finishes immediately, leaving a settled record behind. */
function finishedRun(session: () => any) {
  vi.mocked(runAgent).mockResolvedValue({
    responseText: "first answer",
    session: session(),
    aborted: false,
    steered: false,
    failure: undefined,
  } as any);
}

/** A resumeAgent whose settling the test controls, so a resumed run can stay live. */
function controllableResume(session: () => any) {
  let resolve!: (v: unknown) => void;
  vi.mocked(resumeAgent).mockImplementation(
    () =>
      new Promise(r => {
        resolve = r;
      }) as any,
  );
  return () =>
    resolve({
      responseText: "resumed answer",
      session: session(),
      aborted: false,
      steered: false,
      failure: undefined,
    });
}

function boot() {
  hermetic = hermeticDir({ settings: { outputTranscript: false } });
  return bootOnly();
}

/** Boot into the hermetic dir already created — for tests that seed state first. */
function bootOnly() {
  const b = makePi();
  subagentsExtension(b.pi);
  booted = b.lifecycle;
  return b;
}

/** Run one registered command with an overridable ctx. */
function runCommand(b: BootedPi, name: "pause" | "continue", args = "", overrides: Record<string, unknown> = {}) {
  const cmdCtx = ctx({ isIdle: () => true, ...overrides });
  const result = b.commands.get(name).handler(args, cmdCtx) as Promise<void>;
  return { cmdCtx, result };
}

const manifest = () => new PauseStore(resolvePauseStorePath(process.cwd(), "s1"));
/** The manifest's main-turn record; `getMainTurn` arrives with the feature. */
const mainTurn = (): any => (manifest() as any).getMainTurn?.();
const manager = () => (globalThis as any)[Symbol.for("pi-subagents:manager")];
const notifications = (spy: any): string[] => vi.mocked(spy).mock.calls.map(c => String(c[0]));
const notified = (spy: any, re: RegExp): boolean => notifications(spy).some(t => re.test(t));

/** Spawn one running background agent through the real Agent tool. */
async function spawnRunning(
  b: BootedPi,
  session: () => any,
  description = "find flaky tests",
  mode: "held" | "finished" = "held",
): Promise<string> {
  if (mode === "finished") finishedRun(session);
  else heldRun(session);
  const r = await b.tools.get("Agent").execute(
    "tc-spawn",
    { prompt: "go", description, subagent_type: "Explore", run_in_background: true },
    undefined,
    undefined,
    ctx(),
  );
  await flush();
  return /Agent ID: (\S+)/.exec(textOf(r))![1];
}

/** Spawn one running workflow through the real SubagentWorkflow tool. */
async function spawnRunningWorkflow(b: BootedPi, name = "wf-flow"): Promise<string> {
  const script = `export const meta = { name: "${name}", description: "d" };\nawait agent("held");\nreturn 1;\n`;
  heldRun(resumableSession);
  const r = await b.tools.get("SubagentWorkflow").execute(
    "tc-wf",
    { script },
    undefined,
    undefined,
    ctx({ cwd: hermetic!.dir }),
  );
  await flush();
  return (r as any).details.taskId;
}

/** A boundary event, as pi's extension runner delivers it. */
function turnEnd(overrides: Record<string, unknown> = {}) {
  return {
    type: "turn_end",
    turnIndex: 0,
    message: { role: "assistant", content: [] },
    toolResults: [],
    messageEntryId: "e1",
    toolResultEntryIds: [],
    outcome: "completed",
    ...overrides,
  };
}

function toolCall(overrides: Record<string, unknown> = {}) {
  return { type: "tool_call", toolName: "bash", toolCallId: "tc1", input: { command: "ls" }, ...overrides };
}

/** Start a boundary handler without awaiting it: while parked, its promise IS the gate. */
function startBoundary(handler: any, event: any, eventCtx: any) {
  const state = { settled: false, error: undefined as unknown };
  const promise = Promise.resolve()
    .then(() => handler(event, eventCtx))
    .then(
      () => {
        state.settled = true;
      },
      (error: unknown) => {
        state.error = error;
      },
    );
  return { promise, state };
}

/** Fire a boundary handler and let its synchronous landing side effects run. */
async function landBoundary(handler: any, event: any, eventCtx: any) {
  expect(typeof handler).toBe("function");
  startBoundary(handler, event, eventCtx);
  await flush();
  await flush();
}

/** Arm /pause against a streaming main model. The arming toast itself is pinned
 * in the first test; the rest start from an armed state and fail on their own subject. */
async function arm(b: BootedPi) {
  const { cmdCtx } = runCommand(b, "pause", "", { isIdle: () => false });
  await flush();
  return cmdCtx;
}

describe("/pause arming", () => {
  it("arms instead of refusing when the main model is streaming", async () => {
    const b = boot();
    const id = await spawnRunning(b, resumableSession);

    const { cmdCtx } = runCommand(b, "pause", "", { isIdle: () => false });
    await flush();

    expect(cmdCtx.ui.notify).not.toHaveBeenCalledWith(OLD_REFUSAL, "warning");
    expect(cmdCtx.ui.notify).toHaveBeenCalledWith(ARM_TOAST, "info");
    // Arming parks nothing: the subagents keep running until the boundary.
    expect(manager().getRecord(id).status).toBe("running");
    expect(manifest().list()).toEqual([]);
    expect(existsSync(resolvePauseStorePath(process.cwd(), "s1"))).toBe(false);
  });

  it("a second /pause disarms, and a later boundary lands nothing", async () => {
    const b = boot();
    const id = await spawnRunning(b, resumableSession);
    await arm(b);

    const { cmdCtx } = runCommand(b, "pause", "", { isIdle: () => false });
    await flush();
    expect(cmdCtx.ui.notify).toHaveBeenCalledWith(DISARM_TOAST, "info");

    // The boundary that would have landed the park is now a no-op.
    const landCtx = ctx({ isIdle: () => false });
    await landBoundary(b.lifecycle.get("turn_end"), turnEnd(), landCtx);

    expect(manager().getRecord(id).status).toBe("running");
    expect(mainTurn()).toBeUndefined();
    expect(landCtx.ui.notify).not.toHaveBeenCalled();
  });
});

describe("landing the park", () => {
  it("parks every active subagent and writes mainTurn on turn_end, without aborting", async () => {
    const b = boot();
    // Bind currentCtx: the settle funnel's manifest re-sync runs through it.
    await b.lifecycle.get("session_start")({ type: "session_start", reason: "startup" }, ctx());
    const one = await spawnRunning(b, resumableSession, "one");
    const two = await spawnRunning(b, resumableSession, "two");
    await arm(b);

    const landCtx = ctx({ isIdle: () => false, abort: vi.fn() });
    await landBoundary(b.lifecycle.get("turn_end"), turnEnd(), landCtx);

    expect(manager().getRecord(one).status).toBe("paused");
    expect(manager().getRecord(two).status).toBe("paused");
    expect(manifest().list().map(e => e.id).sort()).toEqual([one, two].sort());

    const parked = mainTurn();
    expect(parked).toMatchObject({ parked: true, pendingTools: 0 });
    expect(parked?.pausedAt).toBeTruthy();
    expect(typeof parked?.claim?.pid).toBe("number");
    expect(parked?.claim?.at).toBeTruthy();
    // No pending calls: nothing to unwind, so the run must not be aborted.
    expect(landCtx.abort).not.toHaveBeenCalled();
    expect(notified(landCtx.ui.notify, /paus|park/i)).toBe(true);
  });

  it("parks both active subagents and active workflows on turn_end when armed", async () => {
    hermetic = hermeticDir({ settings: { outputTranscript: false, workflowsEnabled: true } });
    const b = bootOnly();
    await b.lifecycle.get("session_start")({ type: "session_start", reason: "startup" }, ctx({ cwd: hermetic.dir }));
    const agentId = await spawnRunning(b, resumableSession, "agent-one");
    const wfId = await spawnRunningWorkflow(b, "wf-one");
    await arm(b);

    const landCtx = ctx({ isIdle: () => false, abort: vi.fn(), cwd: hermetic.dir });
    await landBoundary(b.lifecycle.get("turn_end"), turnEnd(), landCtx);

    expect(manager().getRecord(agentId).status).toBe("paused");
    expect(manifest().list().map(e => e.id)).toEqual([agentId]);
    expect(manifest().listWorkflows().map(w => w.id)).toEqual([wfId]);

    const parked = mainTurn();
    expect(parked).toMatchObject({ parked: true, pendingTools: 0 });
    expect(notified(landCtx.ui.notify, /workflow run/i)).toBe(true);
  });

  it("counts pending tool results and aborts the run on turn_end", async () => {
    const b = boot();
    await spawnRunning(b, resumableSession);
    await arm(b);

    const landCtx = ctx({ isIdle: () => false, abort: vi.fn() });
    await landBoundary(
      b.lifecycle.get("turn_end"),
      turnEnd({ toolResults: [{ toolCallId: "tc0" }, { toolCallId: "tc1" }] }),
      landCtx,
    );

    expect(mainTurn()).toMatchObject({ parked: true, pendingTools: 2 });
    // Unanswered calls: the loop must be unwound, not left to start a request.
    expect(landCtx.abort).toHaveBeenCalled();
  });

  it("lands on tool_call, counts one pending tool, and holds the gate", async () => {
    const b = boot();
    const id = await spawnRunning(b, resumableSession);
    await arm(b);

    const handler = b.lifecycle.get("tool_call");
    expect(typeof handler).toBe("function");

    const gateCtx = ctx({ isIdle: () => false, signal: new AbortController().signal, abort: vi.fn() });
    const gate = startBoundary(handler, toolCall(), gateCtx);
    await flush();
    await flush();

    expect(gate.state.error).toBeUndefined();
    expect(manager().getRecord(id).status).toBe("paused");
    expect(mainTurn()).toMatchObject({ parked: true, pendingTools: 1 });
    // The batch is suspended before the call executes: the handler's promise
    // must not resolve while the gate is closed.
    expect(gate.state.settled).toBe(false);
  });

  it("releases the held gate when the run signal aborts", async () => {
    const b = boot();
    const id = await spawnRunning(b, resumableSession);
    await arm(b);

    const handler = b.lifecycle.get("tool_call");
    expect(typeof handler).toBe("function");

    const controller = new AbortController();
    const gateCtx = ctx({ isIdle: () => false, signal: controller.signal, abort: vi.fn() });
    const gate = startBoundary(handler, toolCall(), gateCtx);
    await flush();
    expect(gate.state.settled).toBe(false);

    // Esc while parked must race the run signal; a gate that ignores it leaks
    // session.abort()'s waitForIdle().
    controller.abort();
    await flush();
    expect(gate.state.settled).toBe(true);
    expect(gate.state.error).toBeUndefined();
    // The subagents stay parked: only the held boundary call unwinds.
    expect(manager().getRecord(id).status).toBe("paused");
    expect(mainTurn()).toMatchObject({ parked: true });
  });

  it("still lands when the turn ends aborted (Esc while armed)", async () => {
    const b = boot();
    const id = await spawnRunning(b, resumableSession);
    await arm(b);

    const landCtx = ctx({ isIdle: () => false, abort: vi.fn() });
    await landBoundary(
      b.lifecycle.get("turn_end"),
      turnEnd({ outcome: "aborted", toolResults: [{ toolCallId: "tc1" }] }),
      landCtx,
    );

    expect(manager().getRecord(id).status).toBe("paused");
    expect(mainTurn()).toMatchObject({ parked: true, pendingTools: 1 });
  });

  it("writes mainTurn when no subagent is active", async () => {
    const b = boot();
    await arm(b);

    const landCtx = ctx({ isIdle: () => false, abort: vi.fn() });
    await landBoundary(b.lifecycle.get("turn_end"), turnEnd(), landCtx);

    expect(mainTurn()).toMatchObject({ parked: true, pendingTools: 0 });
    expect(manifest().list()).toEqual([]);
  });

  it("keeps mainTurn when a later settle rewrites the manifest", async () => {
    const b = boot();
    // Bind currentCtx: the settle funnel's manifest re-sync runs through it.
    await b.lifecycle.get("session_start")({ type: "session_start", reason: "startup" }, ctx());
    await spawnRunning(b, resumableSession, "parked");
    await arm(b);
    await landBoundary(b.lifecycle.get("turn_end"), turnEnd(), ctx({ isIdle: () => false, abort: vi.fn() }));
    expect(mainTurn()).toMatchObject({ parked: true });

    // A second agent finishing while parked fires syncPauseManifest, which
    // rewrites the entries list — the rewrite must not drop mainTurn.
    await spawnRunning(b, resumableSession, "finishes while parked", "finished");
    await flush();

    expect(mainTurn()).toMatchObject({ parked: true });
  });
});

describe("/continue on a parked main turn", () => {
  it("opens the gate, resumes the agents, clears mainTurn, and sends no prompt", async () => {
    const b = boot();
    const id = await spawnRunning(b, resumableSession);
    await arm(b);

    const handler = b.lifecycle.get("tool_call");
    expect(typeof handler).toBe("function");
    const gate = startBoundary(
      handler,
      toolCall(),
      ctx({ isIdle: () => false, signal: new AbortController().signal, abort: vi.fn() }),
    );
    await flush();
    expect(gate.state.settled).toBe(false);
    expect(mainTurn()).toMatchObject({ parked: true, pendingTools: 1 });

    controllableResume(resumableSession); // held — the record stays running
    b.pi.sendMessage.mockClear();
    const { cmdCtx } = runCommand(b, "continue");
    await flush();
    await flush();

    expect(gate.state.settled).toBe(true);
    expect(gate.state.error).toBeUndefined();
    expect(manager().getRecord(id).status).toBe("running");
    expect(mainTurn()?.parked ?? false).toBe(false);
    expect(notified(cmdCtx.ui.notify, /continu/i)).toBe(true);
    // Purely mechanical: /continue reopens gates, it never prompts.
    expect(b.pi.sendMessage).not.toHaveBeenCalled();
    expect(b.pi.sendMessage).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ triggerTurn: true }),
    );
  });

  it("passes a later tool_call straight through once the gate is open", async () => {
    const b = boot();
    await spawnRunning(b, resumableSession);
    await arm(b);
    await landBoundary(b.lifecycle.get("turn_end"), turnEnd(), ctx({ isIdle: () => false, abort: vi.fn() }));

    controllableResume(resumableSession);
    runCommand(b, "continue");
    await flush();
    await flush();

    const handler = b.lifecycle.get("tool_call");
    expect(typeof handler).toBe("function");
    const after = startBoundary(
      handler,
      toolCall({ toolCallId: "tc2" }),
      ctx({ isIdle: () => false, signal: new AbortController().signal, abort: vi.fn() }),
    );
    await flush();

    expect(after.state.settled).toBe(true);
    expect(after.state.error).toBeUndefined();
  });

  it("reports a zero-agent continuation and clears mainTurn", async () => {
    const b = boot();
    await arm(b);
    await landBoundary(b.lifecycle.get("turn_end"), turnEnd(), ctx({ isIdle: () => false, abort: vi.fn() }));
    expect(mainTurn()).toMatchObject({ parked: true, pendingTools: 0 });

    const { cmdCtx } = runCommand(b, "continue");
    await flush();
    await flush();

    expect(cmdCtx.ui.notify).not.toHaveBeenCalledWith("Nothing paused in this session.", "info");
    expect(notified(cmdCtx.ui.notify, /continu/i)).toBe(true);
    expect(mainTurn()?.parked ?? false).toBe(false);
  });

  it("holds completion nudges while parked and flushes them after /continue", async () => {
    const b = boot();
    // Bind currentCtx: the settle funnel's manifest re-sync runs through it.
    await b.lifecycle.get("session_start")({ type: "session_start", reason: "startup" }, ctx());
    await spawnRunning(b, resumableSession, "parked");
    await arm(b);
    await landBoundary(b.lifecycle.get("turn_end"), turnEnd(), ctx({ isIdle: () => false, abort: vi.fn() }));
    expect(mainTurn()).toMatchObject({ parked: true });

    // An agent that finishes while the main turn is parked would normally
    // nudge the main model with triggerTurn — that would un-park it.
    await spawnRunning(b, resumableSession, "finishes while parked", "finished");
    await new Promise(r => setTimeout(r, 350));
    expect(b.pi.sendMessage).not.toHaveBeenCalledWith(
      expect.objectContaining({ customType: "subagent-notification" }),
      expect.objectContaining({ triggerTurn: true }),
    );

    controllableResume(resumableSession);
    runCommand(b, "continue");
    await flush();
    await new Promise(r => setTimeout(r, 50));

    expect(b.pi.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ customType: "subagent-notification" }),
      expect.objectContaining({ triggerTurn: true }),
    );
  });
});
