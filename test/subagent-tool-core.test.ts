import { describe, expect, it, vi } from "vitest";
import {
  deliverQuestionAnswer,
  queueOrSteerAgent,
  resolveAndScopeModel,
  resolveTargetQuestion,
  shouldWaitForRecord,
} from "../src/tools/subagent-tool-core.js";
import type { AgentQuestion, AgentRecord } from "../src/types.js";

function makeRecord(partial: Partial<AgentRecord> = {}): AgentRecord {
  return {
    id: "test-agent-1",
    type: "explore",
    description: "test agent",
    status: "running",
    startedAt: 1000,
    lifetimeUsage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
    toolUses: 0,
    ...partial,
  };
}

describe("subagent-tool-core", () => {
  describe("shouldWaitForRecord", () => {
    it("returns true when wait is requested and agent is running or queued", () => {
      expect(shouldWaitForRecord(makeRecord({ status: "running" }), true)).toBe(true);
      expect(shouldWaitForRecord(makeRecord({ status: "queued" }), true)).toBe(true);
      expect(shouldWaitForRecord(makeRecord({ status: "running" }), false)).toBe(false);
      expect(shouldWaitForRecord(makeRecord({ status: "completed" }), true)).toBe(false);
    });

    it("returns true for terminal worktree status that is not paused", () => {
      expect(shouldWaitForRecord(makeRecord({ status: "completed", worktree: {} as any }), false)).toBe(true);
      expect(shouldWaitForRecord(makeRecord({ status: "error", worktree: {} as any }), false)).toBe(true);
      expect(shouldWaitForRecord(makeRecord({ status: "paused", worktree: {} as any }), false)).toBe(false);
    });
  });

  describe("resolveTargetQuestion", () => {
    it("returns undefined if record has no questions", () => {
      const res = resolveTargetQuestion(makeRecord());
      expect(res.question).toBeUndefined();
      expect(res.closedReason).toBe("");
    });

    it("finds oldest open or delivered question by default", () => {
      const q1: AgentQuestion = { id: "q-1", question: "first?", mode: "mailbox", state: "delivered", askedAt: 100 };
      const q2: AgentQuestion = { id: "q-2", question: "second?", mode: "mailbox", state: "open", askedAt: 200 };
      const rec = makeRecord({ questions: [q1, q2] });

      const res = resolveTargetQuestion(rec);
      expect(res.question?.id).toBe("q-1");
    });

    it("finds question by specific id", () => {
      const q1: AgentQuestion = { id: "q-1", question: "first?", mode: "mailbox", state: "open", askedAt: 100 };
      const q2: AgentQuestion = { id: "q-2", question: "second?", mode: "mailbox", state: "open", askedAt: 200 };
      const rec = makeRecord({ questions: [q1, q2] });

      const res = resolveTargetQuestion(rec, "q-2");
      expect(res.question?.id).toBe("q-2");
    });

    it("returns closed reason when target question is closed or dropped", () => {
      const q1: AgentQuestion = { id: "q-1", question: "drop?", mode: "mailbox", state: "dropped", askedAt: 100 };
      const rec = makeRecord({ questions: [q1] });

      const res = resolveTargetQuestion(rec, "q-1");
      expect(res.question).toBeUndefined();
      expect(res.closedReason).toContain("dropped when the run ended");
    });
  });

  describe("deliverQuestionAnswer", () => {
    it("delivers answer to session and updates state", async () => {
      const steer = vi.fn().mockResolvedValue(undefined);
      const session = { steer } as any;
      const q: AgentQuestion = { id: "q-1", question: "proceed?", mode: "mailbox", state: "open", askedAt: 100 };
      const rec = makeRecord({ session, questions: [q] });

      const result = await deliverQuestionAnswer({
        record: rec,
        question: q,
        answer: "yes proceed",
        answeredBy: "root",
      });

      expect(result.success).toBe(true);
      expect(q.state).toBe("answered");
      expect(q.answer).toBe("yes proceed");
      expect(q.answeredBy).toBe("root");
      expect(steer).toHaveBeenCalledWith(expect.stringContaining("yes proceed"));
    });

    it("enqueues steer in pendingSteers when session is absent", async () => {
      const q: AgentQuestion = { id: "q-1", question: "proceed?", mode: "mailbox", state: "open", askedAt: 100 };
      const rec = makeRecord({ session: undefined, questions: [q] });

      const result = await deliverQuestionAnswer({
        record: rec,
        question: q,
        answer: "go ahead",
        answeredBy: "parent-1",
      });

      expect(result.success).toBe(true);
      expect(q.state).toBe("answered");
      expect(rec.pendingSteers).toBeDefined();
      expect(rec.pendingSteers?.[0]).toContain("go ahead");
    });

    it("rolls back state if steer throws", async () => {
      const steer = vi.fn().mockRejectedValue(new Error("steer failed"));
      const session = { steer } as any;
      const q: AgentQuestion = { id: "q-1", question: "proceed?", mode: "mailbox", state: "open", askedAt: 100 };
      const rec = makeRecord({ session, questions: [q] });

      const result = await deliverQuestionAnswer({
        record: rec,
        question: q,
        answer: "yes",
        answeredBy: "root",
      });

      expect(result.success).toBe(false);
      expect(q.state).toBe("open");
      expect(q.answer).toBeUndefined();
      expect(q.answeredBy).toBeUndefined();
      if (!result.success) {
        expect(result.error).toBe("steer failed");
      }
    });
  });

  describe("queueOrSteerAgent", () => {
    it("queues message when session is absent", async () => {
      const rec = makeRecord({ session: undefined });
      const result = await queueOrSteerAgent({ record: rec, message: "redirect" });
      expect(result).toEqual({ queued: true });
      expect(rec.pendingSteers).toEqual(["redirect"]);
    });

    it("calls steer when session is present", async () => {
      const steer = vi.fn().mockResolvedValue(undefined);
      const rec = makeRecord({ session: { steer } as any });
      const result = await queueOrSteerAgent({ record: rec, message: "steer now" });
      expect(result).toEqual({ queued: false });
      expect(steer).toHaveBeenCalledWith("steer now");
    });

    it("returns error on steer failure", async () => {
      const steer = vi.fn().mockRejectedValue(new Error("fail"));
      const rec = makeRecord({ session: { steer } as any });
      const result = await queueOrSteerAgent({ record: rec, message: "steer now" });
      expect(result).toEqual({ error: "fail" });
    });
  });

  describe("resolveAndScopeModel", () => {
    it("resolves model when modelInput is valid", () => {
      const fakeModel = { id: "model-1" };
      const modelRegistry = {
        find: vi.fn(),
        getAll: () => [fakeModel],
      } as any;

      const result = resolveAndScopeModel({
        modelInput: undefined,
        callerSupplied: false,
        fallbackModel: fakeModel as any,
        modelRegistry,
        cwd: "/test",
        agentLabel: "test",
      });

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.model).toBe(fakeModel);
      }
    });

    it("returns error when callerSupplied model cannot be resolved", () => {
      const modelRegistry = {
        find: vi.fn(),
        getAll: () => [],
      } as any;

      const result = resolveAndScopeModel({
        modelInput: "nonexistent-model",
        callerSupplied: true,
        modelRegistry,
        cwd: "/test",
        agentLabel: "test",
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain('Model not found: "nonexistent-model"');
      }
    });
  });
});
