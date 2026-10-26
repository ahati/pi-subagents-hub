/**
 * agents-commands.test.ts — the `/agents pause|resume|revive [handle]` commands,
 * driven through the REAL extension's registered command handler.
 *
 * These pins are one layer up from agent-pause.test.ts (manager mechanics) and
 * agent-hub/fleet-list (key wiring): argument parsing, target resolution, the
 * bulk forms, the `subagents:paused` event, and the revive picker — the parts
 * that live in the extension closure and that no lower-level test can see.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});

import { resumeAgent, runAgent } from "../src/agent-runner.js";
import subagentsExtension from "../src/index.js";
import { type BootedPi, ctx, flush, type Hermetic, hermeticDir, makePi, textOf } from "./helpers/boot-extension.js";

let hermetic: Hermetic | undefined;
/** The most recently booted extension, so teardown runs even when a test throws. */
let booted: Map<string, any> | undefined;

beforeEach(() => {
  vi.mocked(runAgent).mockReset();
  vi.mocked(resumeAgent).mockReset();
});

afterEach(async () => {
  // The manager registry is a globalThis symbol claimed by the first activation
  // that finds it free and released only on shutdown (see agent-mention-wiring).
  await booted?.get("session_shutdown")?.();
  delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
  booted = undefined;
  hermetic?.restore();
  hermetic = undefined;
});

/** Enough of an AgentSession for the manager's and index's hooks. */
function fakeSession() {
  return {
    steer: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    messages: [],
    getActiveToolNames: vi.fn(() => []),
  } as any;
}

/** A runAgent that finishes immediately, leaving a resumable record behind. */
function finishedRun() {
  vi.mocked(runAgent).mockResolvedValue({
    responseText: "first answer",
    session: fakeSession(),
    aborted: false,
    steered: false,
    failure: undefined,
  } as any);
}

/** A runAgent that never settles, so the agent stays "running". */
function heldRun() {
  vi.mocked(runAgent).mockImplementation(
    (_ctx: any, _type: any, _prompt: any, opts: any) =>
      new Promise(() => {
        opts.onSessionCreated?.(fakeSession());
      }) as any,
  );
}

/** A resumeAgent that never settles, so a resumed agent stays "running". */
function heldResume() {
  vi.mocked(resumeAgent).mockImplementation(() => new Promise(() => {}) as any);
}

function boot(settings: Record<string, unknown> = {}) {
  hermetic = hermeticDir({ settings: { outputTranscript: false, ...settings } });
  const b = makePi();
  subagentsExtension(b.pi);
  booted = b.lifecycle;
  return b;
}

/** Spawn one running background agent through the real Agent tool. */
async function spawnRunning(b: BootedPi, description = "find flaky tests", subagentType = "Explore"): Promise<string> {
  heldRun();
  const r = await b.tools.get("Agent").execute(
    "tc-spawn",
    { prompt: "go", description, subagent_type: subagentType, run_in_background: true },
    undefined,
    undefined,
    ctx(),
  );
  await flush();
  return /Agent ID: (\S+)/.exec(textOf(r))![1];
}

const manager = () => (globalThis as any)[Symbol.for("pi-subagents:manager")];

/** Run the `/agents <args>` command handler with a fresh command ctx. */
function runCommand(b: BootedPi, args: string) {
  const cmdCtx = ctx();
  const result = b.commands.get("agents").handler(args, cmdCtx);
  return { cmdCtx, result: result as Promise<void> };
}

describe("/agents pause", () => {
  it("pauses one agent by handle, emitting subagents:paused", async () => {
    const b = boot();
    const id = await spawnRunning(b);

    const { cmdCtx } = runCommand(b, "pause @explore");
    await flush();

    const record = manager().getRecord(id);
    expect(record.status).toBe("paused");
    expect(b.pi.events.emit).toHaveBeenCalledWith("subagents:paused", {
      id,
      type: "Explore",
      description: "find flaky tests",
    });
    expect(cmdCtx.ui.notify).toHaveBeenCalledWith("Paused @explore.", "info");
  });

  it("pauses every active agent with no argument", async () => {
    const b = boot();
    const one = await spawnRunning(b, "one");
    const two = await spawnRunning(b, "two");

    const { cmdCtx } = runCommand(b, "pause");
    await flush();

    expect(manager().getRecord(one).status).toBe("paused");
    expect(manager().getRecord(two).status).toBe("paused");
    expect(cmdCtx.ui.notify).toHaveBeenCalledWith("Paused 2 agents.", "info");
    // One event per agent, not one for the batch.
    const paused = vi.mocked(b.pi.events.emit).mock.calls.filter(c => c[0] === "subagents:paused");
    expect(paused).toHaveLength(2);
  });

  it("refuses a worktree-isolated agent without pausing it", async () => {
    const b = boot();
    const id = await spawnRunning(b);
    manager().getRecord(id).worktree = { path: "/tmp/wt" };

    const { cmdCtx } = runCommand(b, "pause @explore");
    await flush();

    expect(manager().getRecord(id).status).toBe("running");
    expect(cmdCtx.ui.notify).toHaveBeenCalledWith(
      "Could not pause @explore — worktree-isolated runs cannot pause.",
      "warning",
    );
    expect(b.pi.events.emit).not.toHaveBeenCalledWith("subagents:paused", expect.anything());
  });

  it("names an unknown handle rather than guessing", async () => {
    const b = boot();
    await spawnRunning(b);

    const { cmdCtx } = runCommand(b, "pause nosuch");
    await flush();

    expect(cmdCtx.ui.notify).toHaveBeenCalledWith("No active agent named @nosuch.", "warning");
  });
});

describe("/agents resume", () => {
  it("continues a paused agent's session bare — no continuation prompt", async () => {
    const b = boot();
    const id = await spawnRunning(b);
    runCommand(b, "pause @explore");
    await flush();
    expect(manager().getRecord(id).status).toBe("paused");

    const { cmdCtx } = runCommand(b, "resume @explore");
    await flush();

    // The run is alive behind its gate: resume reopens it — no resumeAgent, and
    // no prompt of any kind. The bare resumeAgent funnel is for runs that
    // settled while parked (see agent-pause.test.ts).
    expect(vi.mocked(resumeAgent)).not.toHaveBeenCalled();
    expect(manager().getRecord(id).status).toBe("running");
    expect(cmdCtx.ui.notify).toHaveBeenCalledWith("Resumed @explore.", "info");
    expect(b.pi.events.emit).toHaveBeenCalledWith("subagents:resumed", {
      id,
      type: "Explore",
      description: "find flaky tests",
    });
  });

  it("emits subagents:resumed for a queued agent resumed by handle", async () => {
    const b = boot({ maxConcurrent: 1 });
    await spawnRunning(b, "holds the only slot");
    const queued = await spawnRunning(b, "waits for the slot");
    expect(manager().getRecord(queued).status).toBe("queued");

    runCommand(b, "pause @explore-2");
    await flush();
    expect(manager().getRecord(queued).status).toBe("paused");
    expect(b.pi.events.emit).toHaveBeenCalledWith("subagents:paused", {
      id: queued,
      type: "Explore",
      description: "waits for the slot",
    });

    const { cmdCtx } = runCommand(b, "resume @explore-2");
    await flush();

    // Re-queued behind the held agent — and the one resume funnel still
    // announced it, exactly as it does for a session-bearing resume.
    expect(manager().getRecord(queued).status).toBe("queued");
    expect(b.pi.events.emit).toHaveBeenCalledWith("subagents:resumed", {
      id: queued,
      type: "Explore",
      description: "waits for the slot",
    });
    expect(cmdCtx.ui.notify).toHaveBeenCalledWith("Resumed @explore-2 — queued.", "info");
  });

  it("reports a resume the full pool queued, not one that started", async () => {
    const b = boot({ maxConcurrent: 1 });
    const id = await spawnRunning(b, "parked");
    runCommand(b, "pause @explore");
    await flush();
    expect(manager().getRecord(id).status).toBe("paused");

    // The park handed the slot back, so this sibling takes it before the resume.
    const holder = await spawnRunning(b, "holder", "general-purpose");
    expect(manager().getRecord(holder).status).toBe("running");

    const { cmdCtx } = runCommand(b, "resume @explore");
    await flush();

    expect(manager().getRecord(id).status).toBe("queued");
    expect(cmdCtx.ui.notify).toHaveBeenCalledWith("Resumed @explore — queued.", "info");
  });

  it("resumes every paused agent with no argument", async () => {
    const b = boot();
    const one = await spawnRunning(b, "one");
    const two = await spawnRunning(b, "two");
    runCommand(b, "pause");
    await flush();

    heldResume();
    const { cmdCtx } = runCommand(b, "resume");
    await flush();

    expect(manager().getRecord(one).status).toBe("running");
    expect(manager().getRecord(two).status).toBe("running");
    expect(cmdCtx.ui.notify).toHaveBeenCalledWith("Resumed 2 of 2 agents.", "info");
    // One event per agent, mirroring the bulk pause.
    const resumed = vi.mocked(b.pi.events.emit).mock.calls.filter(c => c[0] === "subagents:resumed");
    expect(resumed).toHaveLength(2);
  });

  it("refuses an agent that is still active", async () => {
    const b = boot();
    await spawnRunning(b);

    const { cmdCtx } = runCommand(b, "resume @explore");
    await flush();

    expect(cmdCtx.ui.notify).toHaveBeenCalledWith("@explore is already active.", "warning");
    expect(vi.mocked(resumeAgent)).not.toHaveBeenCalled();
    // A refusal is not a resume: nothing is announced.
    expect(b.pi.events.emit).not.toHaveBeenCalledWith("subagents:resumed", expect.anything());
  });
});

describe("/agents revive", () => {
  // Only the GC interval and Date are faked: eviction runs on the manager's
  // 60s cleanup timer (see agent-mention-wiring for the full reasoning).
  beforeEach(() => vi.useFakeTimers({ toFake: ["setInterval", "Date"] }));
  afterEach(() => vi.useRealTimers());

  /**
   * Spawn one agent, let it FINISH (the GC skips running agents), point its
   * session file at disk, age it past the cutoff, and let the real GC
   * tombstone it — the same shape as a real "agent you looked at hours ago".
   */
  async function spawnEvicted(b: BootedPi, description: string): Promise<string> {
    finishedRun();
    const r = await b.tools.get("Agent").execute(
      "tc-spawn",
      { prompt: "go", description, subagent_type: "Explore", run_in_background: true },
      undefined,
      undefined,
      ctx(),
    );
    await flush();
    const id = /Agent ID: (\S+)/.exec(textOf(r))![1];
    const record = manager().getRecord(id);
    // Only a consumed result is evicted by the retention timer.
    record.resultConsumed = true;
    record.sessionFile = join(process.cwd(), `${id}-session.jsonl`);
    writeFileSync(record.sessionFile, "");
    record.completedAt = Date.now() - 11 * 60_000;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(manager().getRecord(id)).toBeUndefined();
    return id;
  }

  it("reopens an evicted conversation by handle, reclaiming the name", async () => {
    const b = boot();
    const id = await spawnEvicted(b, "find flaky tests");

    const { cmdCtx } = runCommand(b, "revive @explore");
    await flush();

    const call = vi.mocked(runAgent).mock.calls.at(-1)!;
    expect(call[3]).toMatchObject({ resumeSessionFile: join(process.cwd(), `${id}-session.jsonl`) });
    expect(cmdCtx.ui.notify).toHaveBeenCalledWith("Reviving @explore", "info");
    // The new record is a fresh id holding the old handle.
    const revived = manager().getRecord((call[3] as any).agentId);
    expect(revived).toBeDefined();
    expect(revived!.id).not.toBe(id);
    expect(revived!.handle).toBe("explore");
  });

  it("offers a newest-first picker with no argument and revives the pick", async () => {
    const b = boot();
    const first = await spawnEvicted(b, "first");
    const second = await spawnEvicted(b, "second");
    // Clear the spawn calls, keep the implementation: the revival itself is a
    // real spawn and needs runAgent to resolve.
    vi.mocked(runAgent).mockClear();

    const cmdCtx = ctx({
      ui: { notify: vi.fn(), select: vi.fn(async (_t: string, options: string[]) => options[0]) },
    });
    await b.commands.get("agents").handler("revive", cmdCtx);
    await flush();

    // listTombstones is newest-first: the most recently evicted agent's row
    // is the one the picker's default selection lands on.
    const options = vi.mocked(cmdCtx.ui.select).mock.calls[0][1] as string[];
    expect(options).toHaveLength(2);
    expect(options[0]).toContain("@explore-2");
    expect(options[1]).toContain("@explore");
    expect(vi.mocked(runAgent).mock.calls[0][3]).toMatchObject({
      resumeSessionFile: join(process.cwd(), `${second}-session.jsonl`),
    });
    expect(cmdCtx.ui.notify).toHaveBeenCalledWith("Reviving @explore-2", "info");
    void first;
  });

  it("/agents resume points at revive for an evicted handle", async () => {
    const b = boot();
    await spawnEvicted(b, "evicted");
    vi.mocked(runAgent).mockReset();

    const { cmdCtx } = runCommand(b, "resume @explore");
    await flush();

    expect(cmdCtx.ui.notify).toHaveBeenCalledWith(
      "@explore was evicted — use /agents revive.",
      "warning",
    );
    // Pointing, not reviving: nothing is reopened by a misdirected resume.
    expect(vi.mocked(runAgent)).not.toHaveBeenCalled();
  });

  it("says so when there is nothing to revive", async () => {
    const b = boot();

    const cmdCtx = ctx({ ui: { notify: vi.fn(), select: vi.fn(async () => undefined) } });
    await b.commands.get("agents").handler("revive", cmdCtx);
    await flush();

    expect(cmdCtx.ui.notify).toHaveBeenCalledWith("No evicted agents to revive in this session.", "info");
    expect(cmdCtx.ui.select).not.toHaveBeenCalled();
  });
});

describe("/agents argument fallback", () => {
  it("unknown text falls through to the menu, as /agents always has", async () => {
    const b = boot();
    await spawnRunning(b);

    const cmdCtx = ctx({
      ui: { notify: vi.fn(), select: vi.fn(async () => undefined) },
    });
    await b.commands.get("agents").handler("nonsense", cmdCtx);

    // The menu, not an error: the lifecycle entries appear when non-empty.
    const options = vi.mocked(cmdCtx.ui.select).mock.calls[0][1] as string[];
    expect(options).toContain("Running agents (1) — 1 running, 0 done");
    expect(options).toContain("Pause active agents (1)");
    expect(cmdCtx.ui.select).toHaveBeenCalledWith("Agents", expect.anything());
  });
});
