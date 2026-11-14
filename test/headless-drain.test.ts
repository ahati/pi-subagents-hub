/**
 * headless-drain.test.ts — the `agent_before_settle` boundary that keeps a
 * headless parent (`pi -p`, JSON mode) open until its background work reports.
 *
 * Pins the boundary's own rules: which modes drain, the completion it returns
 * as a continuing entry, and the `headlessWaitMinutes` ceiling.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { runAgent } from "../src/agent-runner.js";
import { NOTIFICATION_HOLD_MS } from "../src/completion-outbox.js";
import subagentsExtension from "../src/index.js";
import { setHeadlessWaitMinutes } from "../src/runner/runner-settings.js";
import { ctx, flush, type Hermetic, hermeticDir, makePi, textOf } from "./helpers/boot-extension.js";

const settleEvent = { entries: [], continue: false, context: {}, outcome: "completed" };

describe("headless drain at agent_before_settle", () => {
  let hermetic: Hermetic;
  let shutdown: (() => Promise<void>) | undefined;

  beforeEach(() => {
    vi.mocked(runAgent).mockReset();
    // Module-global like every other applied setting; reset it so an omitted
    // field in one test's settings file cannot leak into the next.
    setHeadlessWaitMinutes(0);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await shutdown?.();
    shutdown = undefined;
    await flush();
    delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
    hermetic?.restore();
    vi.restoreAllMocks();
  });

  /** A background run that only finishes when the test resolves it. */
  function heldRun() {
    let resolve!: (value: any) => void;
    vi.mocked(runAgent).mockImplementation(
      (_c: any, _t: any, _p: any, opts: any) =>
        new Promise((r) => {
          resolve = (value) => r(value);
          opts.onSessionCreated?.({
            steer: vi.fn().mockResolvedValue(undefined),
            dispose: vi.fn(),
            subscribe: vi.fn(() => () => {}),
            messages: [],
            getActiveToolNames: vi.fn(() => []),
          });
        }) as any,
    );
    return (text = "DONE") => resolve({
      responseText: text,
      session: { dispose: vi.fn() },
      aborted: false,
      steered: false,
    });
  }

  async function boot(mode: string, settings: Record<string, unknown> = {}) {
    hermetic = hermeticDir({ settings: { schedulingEnabled: false, outputTranscript: false, ...settings } });
    const booted = makePi();
    subagentsExtension(booted.pi);
    const context = ctx({ cwd: hermetic.dir, mode });
    await booted.lifecycle.get("session_start")({}, context);
    shutdown = () => booted.lifecycle.get("session_shutdown")({ reason: "quit" }, context);
    return { booted, context, settle: () => booted.lifecycle.get("agent_before_settle")(settleEvent, context) };
  }

  async function spawnBackground(booted: ReturnType<typeof makePi>, context: any) {
    const res = await booted.tools.get("Agent").execute(
      "tc-bg",
      { prompt: "spin", description: "spin", subagent_type: "general-purpose", run_in_background: true },
      undefined,
      undefined,
      context,
    );
    return /Agent ID: (\S+)/.exec(textOf(res))![1];
  }

  function record(id: string) {
    return (globalThis as any)[Symbol.for("pi-subagents:manager")].getRecord(id);
  }

  it.each(["tui", "rpc"])("does not wait in %s mode, where the session stays open", async (mode) => {
    const finish = heldRun();
    const { booted, context, settle } = await boot(mode);
    const id = await spawnBackground(booted, context);

    await expect(settle()).resolves.toBeUndefined();
    expect(record(id).status).toBe("running");
    finish();
  });

  it("returns nothing when no background work is pending", async () => {
    hermetic = hermeticDir({ settings: { schedulingEnabled: false } });
    const booted = makePi();
    subagentsExtension(booted.pi);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const context = ctx({ cwd: hermetic.dir, mode: "print" });
    await booted.lifecycle.get("session_start")({}, context);

    await expect(booted.lifecycle.get("agent_before_settle")(settleEvent, context)).resolves.toBeUndefined();
    expect(stderr.mock.calls.some(c => String(c[0]).includes("Waiting for background work"))).toBe(false);
  });

  it("waits for the completion and returns it as a continuing entry", async () => {
    const finish = heldRun();
    const { booted, context, settle } = await boot("print");
    await spawnBackground(booted, context);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const pending = settle();
    await flush();
    finish("THE-RESULT");
    const result: any = await pending;

    expect(result?.continue).toBe(true);
    expect(result?.entries.at(-1)).toMatchObject({ type: "custom_message", display: true });
    expect(result?.entries.at(-1).content).toContain("THE-RESULT");
    expect(booted.pi.sendMessage).not.toHaveBeenCalled();
  });

  it("stops the work after headlessWaitMinutes, reports it on stderr, and settles without a turn", async () => {
    heldRun();
    const { booted, context, settle } = await boot("print", { headlessWaitMinutes: 1 });
    const id = await spawnBackground(booted, context);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    const result = settle();
    await vi.advanceTimersByTimeAsync(60_000);
    vi.useRealTimers();

    await expect(result).resolves.toBeUndefined();
    const lines = stderr.mock.calls.map(c => String(c[0]));
    expect(lines.some(l => l.includes("Waiting for background work to finish (1 agent)"))).toBe(true);
    expect(lines.some(l => l.includes("still running after 1 min (1 agent); stopping it"))).toBe(true);
    await flush();
    expect(record(id).status).toBe("stopped");
    // The "stopped" notification is dropped, not sent later by the outbox timer.
    await new Promise(resolve => setTimeout(resolve, NOTIFICATION_HOLD_MS + 50));
    expect(booted.pi.sendMessage.mock.calls.some(c => c[0]?.customType === "subagent-notification")).toBe(false);
  });

  it("keeps waiting with headlessWaitMinutes 0, the default", async () => {
    heldRun();
    const { booted, context, settle } = await boot("print");
    const id = await spawnBackground(booted, context);
    expect(record(id).status).toBe("running");
    expect((globalThis as any)[Symbol.for("pi-subagents:manager")].hasRunning()).toBe(true);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

    let settled = false;
    void settle().then(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(24 * 60 * 60_000);
    vi.useRealTimers();
    await flush();

    expect(settled).toBe(false);
  });
});
