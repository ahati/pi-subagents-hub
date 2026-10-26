import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { failResume, settleOutcome } from "../src/manager/resume-handler.js";
import { createNestedSubagentTools, type NestedAgentManager } from "../src/nested-tools.js";
import { formatAnswerSteer, formatQuestionCard, openQuestionsFooter } from "../src/status-note.js";
import { createAnswerTool, createGetResultTool } from "../src/tools/inspect-tools.js";
import type { AgentQuestion, AgentRecord } from "../src/types.js";

let cwd: string;
let records: Map<string, AgentRecord>;
let sendMessage: ReturnType<typeof vi.fn>;
let manager: NestedAgentManager;

function record(over: Partial<AgentRecord> & { id: string }): AgentRecord {
  return {
    type: "general-purpose",
    description: `agent ${over.id}`,
    status: "running",
    toolUses: 0,
    startedAt: 1_000,
    lifetimeUsage: { input: 10, output: 5, cacheWrite: 0 },
    compactionCount: 0,
    ...over,
  };
}

function question(over: Partial<AgentQuestion> = {}): AgentQuestion {
  return { id: "q-1", question: "which?", mode: "mailbox", state: "delivered", askedAt: 1_000, ...over };
}

/** A session whose only used surface is `steer`. */
function steerSession() {
  const steer = vi.fn(async () => {});
  return { session: { steer } as unknown as AgentRecord["session"], steer };
}

function asker(parentAgentId: string | undefined = "parent-1"): AgentRecord {
  const self = record({ id: "worker-1", type: "scout", description: "the worker", status: "running" });
  self.parentAgentId = parentAgentId;
  records.set(self.id, self);
  return self;
}

function tools(parentAgentId = "worker-1") {
  return createNestedSubagentTools({
    manager,
    pi: { sendMessage } as unknown as ExtensionAPI,
    parentAgentId,
    depth: 1,
    maxSubagentDepth: 2,
    allowedSubagents: "all",
    configCwd: cwd,
  });
}

async function execute(tool: { execute: (...args: never[]) => unknown }, params: Record<string, unknown>) {
  return (await (tool.execute as unknown as (
    id: string,
    p: Record<string, unknown>,
    signal: undefined,
    onUpdate: undefined,
    ctx: undefined,
  ) => Promise<{ content: Array<{ text: string }>; isError?: boolean }>)("call-1", params, undefined, undefined, undefined));
}

const ASK = 3;
const ANSWER = 4;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "ask-parent-test-"));
  records = new Map();
  sendMessage = vi.fn();
  manager = {
    getRecord: (id: string) => records.get(id),
    spawn: vi.fn(),
    spawnAndWait: vi.fn(),
    awaitStartup: vi.fn(async () => {}),
    resume: vi.fn(),
  } as unknown as NestedAgentManager;
});

afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

describe("ask_parent delivery", () => {
  it("records q-1 and steers the card into the live owning agent", async () => {
    const self = asker();
    const owner = steerSession();
    records.set("parent-1", record({ id: "parent-1", description: "the owner", session: owner.session }));

    const result = await execute(tools()[ASK], { question: "Which module?", assumption: "the old one" });

    expect(result.isError).toBe(false);
    expect(self.questions).toHaveLength(1);
    const q = self.questions?.[0];
    expect(q?.id).toBe("q-1");
    expect(q?.state).toBe("delivered");
    expect(q?.mode).toBe("mailbox");
    expect(owner.steer).toHaveBeenCalledTimes(1);
    const card = owner.steer.mock.calls[0]?.[0] as string;
    expect(card).toContain("[SUBAGENT QUESTION]");
    expect(card).toContain("worker-1");
    expect(card).toContain("q-1");
    expect(card).toContain('answer_subagent(agent_id: "worker-1", question_id: "q-1"');
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("queues the card in pendingSteers when the owner has no session yet", async () => {
    const self = asker();
    const owner = record({ id: "parent-1" });
    records.set("parent-1", owner);

    const result = await execute(tools()[ASK], { question: "Which module?" });

    expect(result.isError).toBe(false);
    expect(owner.pendingSteers).toHaveLength(1);
    expect(owner.pendingSteers?.[0]).toContain("[SUBAGENT QUESTION]");
    expect(self.questions?.[0]?.state).toBe("delivered");
  });

  it("skips a blocked owner and addresses the nearest free ancestor", async () => {
    const self = asker();
    const parent = steerSession();
    const mid = steerSession();
    records.set("parent-1", record({ id: "parent-1", status: "running", blocking: true, parentAgentId: "mid-1", session: parent.session }));
    records.set("mid-1", record({ id: "mid-1", status: "running", session: mid.session }));

    const result = await execute(tools()[ASK], { question: "Which module?" });

    expect(result.isError).toBe(false);
    expect(parent.steer).not.toHaveBeenCalled();
    expect(mid.steer).toHaveBeenCalledTimes(1);
    expect(mid.steer.mock.calls[0]?.[0]).toContain("q-1");
    expect(self.questions?.[0]?.state).toBe("delivered");
  });

  it("falls back to the root session when the whole chain is blocked", async () => {
    const self = asker();
    const blocked = steerSession();
    records.set("parent-1", record({ id: "parent-1", status: "running", blocking: true, session: blocked.session }));

    const result = await execute(tools()[ASK], { question: "Which module?", assumption: "ship it" });

    expect(result.isError).toBe(false);
    expect(blocked.steer).not.toHaveBeenCalled();
    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        customType: "subagent-question",
        content: expect.stringContaining("[SUBAGENT QUESTION]"),
      }),
      { deliverAs: "steer", triggerTurn: true },
    );
    expect(self.questions?.[0]?.state).toBe("delivered");
  });

  it("supersedes the previous open question with q-2", async () => {
    const self = asker();
    const owner = steerSession();
    records.set("parent-1", record({ id: "parent-1", session: owner.session }));
    const ask = tools()[ASK];

    await execute(ask, { question: "First?" });
    const second = await execute(ask, { question: "Second?" });

    expect(self.questions?.map(q => q.id)).toEqual(["q-1", "q-2"]);
    expect(self.questions?.[0]?.state).toBe("superseded");
    expect(self.questions?.[1]?.state).toBe("delivered");
    expect(second.content[0].text).toContain("Supersedes q-1");
  });

  it("refuses block: true without recording a question", async () => {
    const self = asker();
    records.set("parent-1", record({ id: "parent-1", session: steerSession().session }));

    const result = await execute(tools()[ASK], { question: "Wait for me?", block: true });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Suspension is not available yet");
    expect(self.questions ?? []).toHaveLength(0);
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("exposes exactly five child-safe tools including ask and answer", () => {
    expect(tools().map(t => t.name)).toEqual([
      "Agent",
      "get_subagent_result",
      "steer_subagent",
      "ask_parent",
      "answer_subagent",
    ]);
  });
});

describe("answer_subagent (nested)", () => {
  it("rejects an agent owned by a different parent", async () => {
    records.set("child-1", record({ id: "child-1", parentAgentId: "other", questions: [question()] }));

    const result = await execute(tools()[ANSWER], { agent_id: "child-1", answer: "x" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not owned by this parent");
  });

  it("errors when the agent has no open question", async () => {
    records.set("child-1", record({ id: "child-1", parentAgentId: "worker-1", questions: [question({ state: "answered" })] }));

    const result = await execute(tools()[ANSWER], { agent_id: "child-1", answer: "x" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("No open question");
  });

  it("rejects a settled child and points at resume", async () => {
    const settled = record({ id: "child-1", parentAgentId: "worker-1", status: "completed", result: "done", questions: [question()] });
    records.set("child-1", settled);

    const result = await execute(tools()[ANSWER], { agent_id: "child-1", answer: "x" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("already finished");
    expect(result.content[0].text).toContain("Resume it with the answer");
    expect(settled.questions?.[0]?.state).toBe("delivered");
  });

  it("answers the oldest open question and steers the answer into the child", async () => {
    const child = steerSession();
    const rec = record({ id: "child-1", parentAgentId: "worker-1", session: child.session, questions: [question()] });
    records.set("child-1", rec);

    const result = await execute(tools()[ANSWER], { agent_id: "child-1", answer: "use the new module" });

    expect(result.isError).toBe(false);
    const q = rec.questions?.[0];
    expect(q?.state).toBe("answered");
    expect(q?.answer).toBe("use the new module");
    expect(q?.answeredBy).toBe("worker-1");
    expect(child.steer).toHaveBeenCalledTimes(1);
    expect(child.steer.mock.calls[0]?.[0]).toBe(
      formatAnswerSteer(q as AgentQuestion),
    );
    expect(child.steer.mock.calls[0]?.[0]).toContain("[ANSWER to your ask_parent q-1]");
    expect(result.content[0].text).toContain("Answer to q-1 delivered");
  });

  it("honours an explicit question_id over the oldest open one", async () => {
    const child = steerSession();
    const rec = record({
      id: "child-1",
      parentAgentId: "worker-1",
      session: child.session,
      questions: [question({ id: "q-1", state: "open" }), question({ id: "q-2", state: "open" })],
    });
    records.set("child-1", rec);

    await execute(tools()[ANSWER], { agent_id: "child-1", question_id: "q-2", answer: "later one" });

    expect(rec.questions?.map(q => q.state)).toEqual(["open", "answered"]);
    expect(child.steer.mock.calls[0]?.[0]).toContain("q-2");
  });

  it("queues the answer when the child session is not ready yet", async () => {
    const rec = record({ id: "child-1", parentAgentId: "worker-1", questions: [question()] });
    records.set("child-1", rec);

    const result = await execute(tools()[ANSWER], { agent_id: "child-1", answer: "queued" });

    expect(result.isError).toBe(false);
    expect(rec.pendingSteers?.some(m => m.includes("[ANSWER to your ask_parent q-1]"))).toBe(true);
    expect(rec.questions?.[0]?.state).toBe("answered");
  });
});

describe("open questions in results and settlement", () => {
  it("formats the question card and answer steer", () => {
    const self = record({ id: "worker-1", type: "scout", description: "the worker" });
    const card = formatQuestionCard(self, question({ context: "tried both", assumption: "ship the old path" }));

    expect(card).toContain("[SUBAGENT QUESTION] scout \"the worker\" (agent id: worker-1, question q-1)");
    expect(card).toContain("Q: which?");
    expect(card).toContain("Context: tried both");
    expect(card).toContain("Child will proceed with: ship the old path");
    expect(card).toContain('Reply with answer_subagent(agent_id: "worker-1", question_id: "q-1", answer: "...")');

    expect(formatAnswerSteer(question({ state: "answered", answer: "do X" }))).toContain(
      "[ANSWER to your ask_parent q-1] do X",
    );
  });

  it("footers only open or delivered questions, with the stated assumption", () => {
    const base = record({ id: "worker-1", description: "the worker", status: "completed", result: "done" });

    expect(openQuestionsFooter(base)).toBe("");

    const delivered = { ...base, questions: [question({ assumption: "ship the old path" })] };
    const footer = openQuestionsFooter(delivered);
    expect(footer).toContain("[QUESTION for you, question q-1] which?");
    expect(footer).toContain("otherwise it proceeded with: ship the old path");

    const answered = { ...base, questions: [question({ state: "answered", answer: "x" })] };
    expect(openQuestionsFooter(answered)).toBe("");
    const dropped = { ...base, questions: [question({ state: "dropped" })] };
    expect(openQuestionsFooter(dropped)).toBe("");
  });

  it("appends the footer to a nested subagent result and omits it once answered", async () => {
    const [, getResult] = tools();
    records.set("child-1", record({
      id: "child-1",
      parentAgentId: "worker-1",
      status: "completed",
      result: "the answer is 42",
      questions: [question()],
    }));

    const open = await execute(getResult, { agent_id: "child-1" });
    expect(open.content[0].text).toContain("the answer is 42");
    expect(open.content[0].text).toContain("[QUESTION for you, question q-1] which?");

    records.set("child-1", record({
      id: "child-1",
      parentAgentId: "worker-1",
      status: "completed",
      result: "the answer is 42",
      questions: [question({ state: "answered", answer: "x" })],
    }));
    const answered = await execute(getResult, { agent_id: "child-1" });
    expect(answered.content[0].text).not.toContain("[QUESTION");
  });

  it("settleOutcome drops open questions on abort and failure, keeps them on success", () => {
    const aborted = record({ id: "c1", status: "running", questions: [question(), question({ id: "q-2", state: "open" })] });
    settleOutcome(aborted, { text: "partial", aborted: true, steered: false });
    expect(aborted.status).toBe("aborted");
    expect(aborted.questions?.map(q => q.state)).toEqual(["dropped", "dropped"]);

    const failed = record({ id: "c2", status: "running", questions: [question()] });
    settleOutcome(failed, { text: "", failure: "boom", aborted: false, steered: false });
    expect(failed.status).toBe("error");
    expect(failed.questions?.[0]?.state).toBe("dropped");

    const completed = record({ id: "c3", status: "running", questions: [question()] });
    settleOutcome(completed, { text: "done", aborted: false, steered: false });
    expect(completed.status).toBe("completed");
    expect(completed.questions?.[0]?.state).toBe("delivered");
  });

  it("failResume drops open questions alongside the error", () => {
    const rec = record({ id: "c1", status: "running", questions: [question(), question({ id: "q-2", state: "open" })] });

    failResume(rec, new Error("resume exploded"));

    expect(rec.status).toBe("error");
    expect(rec.error).toBe("resume exploded");
    expect(rec.questions?.map(q => q.state)).toEqual(["dropped", "dropped"]);
  });
});

describe("top-level answer tool and result footer", () => {
  function topRecord(over: Partial<AgentRecord> & { id: string }): AgentRecord {
    return record({ type: "general-purpose", toolUses: 3, completedAt: 6_000, compactionCount: 0, ...over });
  }

  function fakeOutbox() {
    return { cancel: vi.fn(), hold: vi.fn(), release: vi.fn() } as unknown as Parameters<typeof createGetResultTool>[0]["outbox"];
  }

  function topTools(rec: AgentRecord) {
    const deps = {
      resolveAgentRef: (ref: string) => (ref === rec.id ? rec : undefined),
      isShowCostEnabled: () => false,
      outbox: fakeOutbox(),
      pi: { events: { emit: vi.fn() } } as unknown as ExtensionAPI,
    };
    return { getResult: createGetResultTool(deps), answer: createAnswerTool(deps) };
  }

  it("get_subagent_result appends the footer for a settled record with an open question", async () => {
    const rec = topRecord({ id: "a1", status: "completed", result: "report", questions: [question({ assumption: "keep going" })] });
    const { getResult } = topTools(rec);

    const result = await execute(getResult, { agent_id: "a1" });

    expect(result.content[0].text).toContain("[QUESTION for you, question q-1] which?");
    expect(result.content[0].text).toContain("otherwise it proceeded with: keep going");
  });

  it("createAnswerTool answers a top-level child as the root session", async () => {
    const child = steerSession();
    const rec = topRecord({ id: "a1", status: "running", session: child.session, questions: [question()] });
    const { answer } = topTools(rec);

    const result = await execute(answer, { agent_id: "a1", answer: "use the new module" });

    expect(result.isError ?? false).toBe(false);
    expect(rec.questions?.[0]?.state).toBe("answered");
    expect(rec.questions?.[0]?.answer).toBe("use the new module");
    expect(rec.questions?.[0]?.answeredBy).toBe("root");
    expect(child.steer.mock.calls[0]?.[0]).toContain("[ANSWER to your ask_parent q-1]");
  });

  it("createAnswerTool rejects an agent owned by a nested parent", async () => {
    const rec = topRecord({ id: "a1", status: "running", parentAgentId: "worker-1", session: steerSession().session, questions: [question()] });
    const { answer } = topTools(rec);

    const result = await execute(answer, { agent_id: "a1", answer: "x" });

    expect(result.content[0].text).toContain("Agent not found");
    expect(rec.questions?.[0]?.state).toBe("delivered");
  });

  it("get_subagent_result mirrors the footer into details.body for the renderer", async () => {
    const rec = topRecord({ id: "a1", status: "completed", result: "report", questions: [question()] });
    const { getResult } = topTools(rec);

    const result = await execute(getResult, { agent_id: "a1" });
    const details = result.details as { body?: string };

    expect(result.content[0].text).toContain("[QUESTION for you");
    expect(details.body).toContain("[QUESTION for you");
  });
});

describe("question routing across the owner chain", () => {
  it("a grandparent that received the routed card can answer the grandchild", async () => {
    const self = asker("mid-1");
    const childSession = steerSession();
    self.session = childSession.session;
    // Direct owner is blocked mid spawnAndWait; the grandparent is free.
    records.set("mid-1", record({ id: "mid-1", blocking: true, parentAgentId: "grand-1" }));
    const grand = steerSession();
    records.set("grand-1", record({ id: "grand-1", session: grand.session }));

    await execute(tools("worker-1")[ASK], { question: "Which module?" });
    expect(self.questions?.[0]?.deliveredTo).toBe("grand-1");
    expect(grand.steer).toHaveBeenCalledTimes(1);

    // The grandparent's OWN tool suite answers a child it does not directly own.
    const result = await execute(tools("grand-1")[ANSWER], { agent_id: "worker-1", question_id: "q-1", answer: "the new one" });

    expect(result.isError ?? false).toBe(false);
    expect(self.questions?.[0]?.state).toBe("answered");
    expect(self.questions?.[0]?.answeredBy).toBe("grand-1");
    expect(childSession.steer.mock.calls[0]?.[0]).toContain("[ANSWER to your ask_parent q-1] the new one");
  });

  it("the main session can answer a routed nested (non top-level) child", async () => {
    const self = asker("mid-1");
    const childSession = steerSession();
    self.session = childSession.session;
    records.set("mid-1", record({ id: "mid-1", blocking: true }));
    records.set("grand-1", record({ id: "grand-1", blocking: true, parentAgentId: undefined }));

    const askResult = await execute(tools("worker-1")[ASK], { question: "Which?" });
    expect(askResult.isError ?? false).toBe(false);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(self.questions?.[0]?.deliveredTo).toBe("root");

    const rec = record({ id: "worker-1", status: "running", parentAgentId: "mid-1", session: childSession.session, questions: self.questions });
    const deps = {
      resolveAgentRef: (ref: string) => (ref === "worker-1" ? rec : undefined),
      isShowCostEnabled: () => false,
      outbox: { cancel: vi.fn() } as unknown as Parameters<typeof createAnswerTool>[0]["outbox"],
      pi: { events: { emit: vi.fn() } } as unknown as ExtensionAPI,
    };
    const result = await execute(createAnswerTool(deps), { agent_id: "worker-1", answer: "root says: new one" });

    expect(result.isError ?? false).toBe(false);
    expect(self.questions?.[0]?.state).toBe("answered");
    expect(self.questions?.[0]?.answeredBy).toBe("root");
    expect(childSession.steer.mock.calls.at(-1)?.[0]).toContain("[ANSWER to your ask_parent q-1] root says: new one");
  });

  it("an unrelated session still cannot answer", async () => {
    const self = asker();
    const grand = steerSession();
    records.set("parent-1", record({ id: "parent-1", blocking: true }));
    records.set("grand-1", record({ id: "grand-1", session: grand.session }));
    await execute(tools("worker-1")[ASK], { question: "Which?" });

    const result = await execute(tools("bystander-1")[ANSWER], { agent_id: "worker-1", answer: "nope" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not owned by this parent");
    expect(self.questions?.[0]?.state).toBe("delivered");
  });

  it("a rejected steer leaves the question open with no deliveredTo", async () => {
    const self = asker();
    const failing = vi.fn(async () => {
      throw new Error("session gone");
    });
    records.set("parent-1", record({ id: "parent-1", session: { steer: failing } as unknown as AgentRecord["session"] }));

    const result = await execute(tools()[ASK], { question: "Which?", assumption: "old one" });

    expect(result.isError ?? false).toBe(false);
    expect(result.content[0].text).toContain("could not be delivered mid-run");
    expect(self.questions?.[0]?.state).toBe("open");
    expect(self.questions?.[0]?.deliveredTo).toBeUndefined();
  });

  it("a throwing root sendMessage leaves the question open", async () => {
    const self = asker("mid-1");
    records.set("mid-1", record({ id: "mid-1", blocking: true }));
    records.set("grand-1", record({ id: "grand-1", blocking: true, parentAgentId: undefined }));
    sendMessage.mockImplementationOnce(() => {
      throw new Error("stale context");
    });

    const result = await execute(tools("worker-1")[ASK], { question: "Which?" });

    expect(result.content[0].text).toContain("could not be delivered");
    expect(self.questions?.[0]?.state).toBe("open");
    expect(self.questions?.[0]?.deliveredTo).toBeUndefined();
  });

  it("a failed answer delivery reverts the answered state for a retry", async () => {
    const self = asker();
    const childSession = steerSession();
    self.session = childSession.session;
    records.set("parent-1", record({ id: "parent-1", session: steerSession().session }));
    await execute(tools()[ASK], { question: "Which?" });
    childSession.steer.mockRejectedValueOnce(new Error("pipe broke"));

    const result = await execute(tools("parent-1")[ANSWER], { agent_id: "worker-1", answer: "late answer" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("pipe broke");
    expect(self.questions?.[0]?.state).toBe("delivered");
    expect(self.questions?.[0]?.answer).toBeUndefined();
    expect(self.questions?.[0]?.answeredBy).toBeUndefined();
  });

  it("question ids stay unique across supersedes", async () => {
    const self = asker();
    records.set("parent-1", record({ id: "parent-1" }));

    await execute(tools()[ASK], { question: "one" });
    await execute(tools()[ASK], { question: "two" });
    await execute(tools()[ASK], { question: "three" });

    expect(self.questions?.map(q => q.id)).toEqual(["q-1", "q-2", "q-3"]);
    expect(self.questions?.map(q => q.state)).toEqual(["superseded", "superseded", "delivered"]);
    expect(self.questions?.[1]?.deliveredTo).toBe("parent-1");
  });
});

describe("adversarial hardening", () => {
  it("the root card is sent as its own message type, not a completion notification", async () => {
    asker(undefined);
    await execute(tools("worker-1")[ASK], { question: "Which?" });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const [message] = sendMessage.mock.calls[0] as Array<Record<string, unknown>>;
    expect(message.customType).toBe("subagent-question");
    expect(message.details).toBeUndefined();
  });

  it("a foreground child routed to the root is told the answer rides its result", async () => {
    const self = asker(undefined);
    self.blocking = true; // the main session is blocked in spawnAndWait on this child

    const result = await execute(tools("worker-1")[ASK], { question: "Which?" });

    expect(result.content[0].text).toContain("waiting on this run");
    expect(result.content[0].text).not.toContain("as a steering message");
  });

  it("a background child routed to the free root still promises a steering message", async () => {
    asker(undefined); // parentAgentId undefined, not blocking

    const result = await execute(tools("worker-1")[ASK], { question: "Which?" });

    expect(result.content[0].text).toContain("as a steering message");
  });

  it("a parentAgentId cycle terminates at the root instead of looping", async () => {
    const self = asker("mid-1");
    self.blocking = true;
    // Cycle: worker-1 -> mid-1 -> worker-1, every member blocked, so the walk
    // must exit on the seen-set rather than spin forever inside the tool call.
    const mid = record({ id: "mid-1", blocking: true, parentAgentId: "worker-1" });
    records.set("mid-1", mid);

    const result = await execute(tools("worker-1")[ASK], { question: "Which?" });

    expect(result.isError ?? false).toBe(false);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(self.questions?.[0]?.deliveredTo).toBe("root");
  });

  it("answering a superseded question names the state", async () => {
    const self = asker();
    records.set("parent-1", record({ id: "parent-1", session: steerSession().session }));
    await execute(tools()[ASK], { question: "one" });
    await execute(tools()[ASK], { question: "two" });

    const result = await execute(tools("parent-1")[ANSWER], { agent_id: "worker-1", question_id: "q-1", answer: "stale" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("superseded");
    expect(self.questions?.find(q => q.id === "q-1")?.state).toBe("superseded");
  });

  it("answering a dropped question surfaces what was asked", async () => {
    const self = asker();
    self.status = "error";
    self.questions = [question({ state: "dropped" })];
    records.set("parent-1", record({ id: "parent-1" }));

    const result = await execute(tools("parent-1")[ANSWER], { agent_id: "worker-1", answer: "too late" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("dropped");
    expect(result.content[0].text).toContain("which?");
  });

  it("an answered question is not resurrected by the delivery path", async () => {
    const self = asker();
    const owner = steerSession();
    records.set("parent-1", record({ id: "parent-1", session: owner.session }));
    // Simulate the owner answering inside the steer's resolution window: the
    // question flips to answered before the ask tool's post-steer bookkeeping.
    owner.steer.mockImplementationOnce(async () => {
      const q = self.questions?.[0];
      if (q) { q.state = "answered"; q.answer = "early"; }
    });

    const result = await execute(tools()[ASK], { question: "Which?" });

    expect(result.isError ?? false).toBe(false);
    expect(self.questions?.[0]?.state).toBe("answered");
    expect(self.questions?.[0]?.answer).toBe("early");
  });
});
