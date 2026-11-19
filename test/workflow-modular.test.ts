import { describe, expect, it, vi } from "vitest";
import type { WorkflowJournalEntry } from "../src/workflow/journal.js";
import { compileJsonSchema } from "../src/workflow/json-schema.js";
import { WorkflowControlManager } from "../src/workflow/workflow-control.js";
import { WorkflowReplayEngine } from "../src/workflow/workflow-replay.js";

describe("WorkflowReplayEngine", () => {
  it("initializes intact when entries have no resumed mark and matches valid entry", () => {
    const entries: WorkflowJournalEntry[] = [
      {
        path: "p1",
        index: 0,
        key: "key-1",
        ok: true,
        text: "hello world",
      },
    ];

    const engine = new WorkflowReplayEngine(entries);
    expect(engine.isPrefixIntact).toBe(true);

    const match = engine.match("p1", "key-1");
    expect(match).toBeDefined();
    expect(match?.text).toBe("hello world");
    expect(engine.replayedCount).toBe(1);
    expect(engine.isPrefixIntact).toBe(true);
  });

  it("declines replay prefix up front if entries include resumed", () => {
    const entries: WorkflowJournalEntry[] = [
      {
        path: "p1",
        index: 0,
        key: "key-1",
        ok: true,
        text: "hello",
        resumed: true,
      },
    ];

    const engine = new WorkflowReplayEngine(entries);
    expect(engine.isPrefixIntact).toBe(false);
    expect(engine.match("p1", "key-1")).toBeUndefined();
  });

  it("invalidates prefix upon mismatching key", () => {
    const entries: WorkflowJournalEntry[] = [
      {
        path: "p1",
        index: 0,
        key: "key-1",
        ok: true,
        text: "hello",
      },
    ];

    const engine = new WorkflowReplayEngine(entries);
    expect(engine.match("p1", "wrong-key")).toBeUndefined();
    expect(engine.isPrefixIntact).toBe(false);
  });

  it("invalidates prefix if replayed text fails schema validation", () => {
    const entries: WorkflowJournalEntry[] = [
      {
        path: "p1",
        index: 0,
        key: "key-1",
        ok: true,
        text: "not json",
      },
    ];

    const compiled = compileJsonSchema({
      type: "object",
      properties: { count: { type: "number" } },
      required: ["count"],
    });
    expect(compiled.ok).toBe(true);
    if (!compiled.ok) return;

    const engine = new WorkflowReplayEngine(entries);
    const match = engine.match("p1", "key-1", compiled.compiled);
    expect(match).toBeUndefined();
    expect(engine.isPrefixIntact).toBe(false);
  });
});

describe("WorkflowControlManager", () => {
  it("tracks pause, resume, and park draining states", () => {
    const control = new WorkflowControlManager();
    expect(control.isPaused()).toBe(false);
    expect(control.isDraining()).toBe(false);

    control.pause();
    expect(control.isPaused()).toBe(true);

    control.resume();
    expect(control.isPaused()).toBe(false);

    let drained = false;
    control.stopWhenIdle(() => {
      drained = true;
    });
    expect(control.isDraining()).toBe(true);
    expect(control.isPaused()).toBe(true);
    expect(drained).toBe(true);
  });

  it("manages live agent skip and retry with abort callback", () => {
    const control = new WorkflowControlManager();
    const live = control.register(0, "wf-agent-0");
    expect(live.started).toBe(false);

    const abortFn = vi.fn();

    // Skip unstarted agent wakes instead of calling abortAgent
    let woke = false;
    live.wake = () => {
      woke = true;
    };
    expect(control.skip(0, abortFn)).toBe(true);
    expect(live.intent).toBe("skip");
    expect(woke).toBe(true);
    expect(abortFn).not.toHaveBeenCalled();

    // Register a second agent as started
    const live2 = control.register(1, "wf-agent-1");
    live2.started = true;
    expect(control.retry(1, abortFn)).toBe(true);
    expect(live2.intent).toBe("retry");
    expect(abortFn).toHaveBeenCalledWith("wf-agent-1");
  });
});
