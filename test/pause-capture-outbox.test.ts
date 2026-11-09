import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentManager } from "../src/agent-manager.js";
import { ParkGateController } from "../src/commands/pause-state.js";
import { CompletionOutbox, NOTIFICATION_HOLD_MS, type OutboxItem } from "../src/completion-outbox.js";
import type { AgentRecord, NotificationDetails } from "../src/types.js";

const ctx = {} as unknown as ExtensionContext;

function record(id: string, overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id,
    type: "Explore",
    description: `task ${id}`,
    status: "completed",
    result: `report ${id}`,
    toolUses: 1,
    startedAt: 0,
    sessionFile: `/tmp/${id}.jsonl`,
    ...overrides,
  } as AgentRecord;
}

function manager(...records: AgentRecord[]): AgentManager {
  return { listAgents: () => records } as unknown as AgentManager;
}

function details(id: string): NotificationDetails {
  return {
    id,
    description: `task ${id}`,
    status: "completed",
    toolUses: 0,
    turnCount: 0,
    totalTokens: 0,
    durationMs: 0,
    resultPreview: "",
  };
}

describe("ParkGateController.captureSettledResults", () => {
  it("cancels the pending completion for each agent it captures, once", () => {
    const park = new ParkGateController();
    const cancel = vi.fn();
    park.setCompletionCanceller(cancel);
    const agents = manager(record("a"), record("b"));

    park.captureSettledResults(ctx, agents, () => {});
    expect(cancel.mock.calls).toEqual([["a"], ["b"]]);

    park.captureSettledResults(ctx, agents, () => {});
    expect(cancel, "an already captured result must not be recaptured or re-cancelled").toHaveBeenCalledTimes(2);
  });

  it("does not cancel agents it cannot capture", () => {
    const park = new ParkGateController();
    const cancel = vi.fn();
    park.setCompletionCanceller(cancel);
    const agents = manager(
      record("running", { status: "running" }),
      record("consumed", { resultConsumed: true }),
      record("no-session", { sessionFile: undefined }),
      record("nested", { parentAgentId: "parent" }),
    );

    expect(park.captureSettledResults(ctx, agents, () => {})).toBe(0);
    expect(cancel).not.toHaveBeenCalled();
  });
});

describe("captured results and the completion outbox", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const item = (ids: string[]): OutboxItem => ({
    ids,
    build: current => ({ content: current.join(","), details: details(current[0] ?? ids[0]) }),
  });

  it("drops a pending outbox item when /pause captures every agent in it", () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const outbox = new CompletionOutbox(send, () => false);
    outbox.add(item(["a", "b"]));
    const park = new ParkGateController();
    park.setCompletionCanceller(id => outbox.cancel(id));

    park.captureSettledResults(ctx, manager(record("a"), record("b")), () => {});
    vi.advanceTimersByTime(NOTIFICATION_HOLD_MS);

    expect(send, "the captured results are delivered by /continue instead").not.toHaveBeenCalled();
    outbox.dispose();
  });

  it("still notifies for an agent that was not captured", () => {
    vi.useFakeTimers();
    const send = vi.fn();
    const outbox = new CompletionOutbox(send, () => false);
    outbox.add(item(["a", "b"]));
    const park = new ParkGateController();
    park.setCompletionCanceller(id => outbox.cancel(id));

    park.captureSettledResults(ctx, manager(record("a"), record("b", { status: "running" })), () => {});
    vi.advanceTimersByTime(NOTIFICATION_HOLD_MS);

    expect(send).toHaveBeenCalledExactlyOnceWith({ content: "b", details: details("b") });
    outbox.dispose();
  });
});
