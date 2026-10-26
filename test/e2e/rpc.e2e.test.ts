/**
 * rpc.e2e.test.ts — the `subagents:rpc:*` surface driven end to end, for real.
 *
 * The unit suite (cross-extension-rpc.test.ts) drives `registerRpcHandlers`
 * against a hand-built bus and a stub manager. This suite proves the parts fit:
 * a real pi session boots the real extension, the handlers land on the live
 * event bus, and a client — playing the second-extension role, exactly the
 * envelope docs/rpc.md documents — spawns an agent through the real manager
 * against the faux model and walks its whole lifecycle: spawn, completion
 * event, consume, steer, stop, pause, resume, and the error envelopes.
 *
 * Evidence over claims: a consume that returns success means the extension's
 * own manager marked the record consumed; a steer success means the message
 * reached a live child session's steering queue. Neither can happen unless
 * every link in the bus → handler → manager → session chain ran.
 *
 * No network and no keys: the faux backend answers every model call, and the
 * suite pins `live: false` — the assertions rest on scripted spawns a real
 * model has no reason to reproduce.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@earendil-works/pi-ai";
import { fauxText } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { type FauxReply, runPrintMode } from "../helpers/print-mode-runner.js";
import { createRpcClient, type RpcClient } from "../helpers/rpc-client.js";

/**
 * Wait until the RPC-spawned child has a live session. The spawn reply resolves
 * once the agent is *running*, but `onSessionCreated` lands after that — a
 * client that wants the sessionful paths (steer into the session, pause at a
 * hook) must wait, exactly as a real second extension would.
 */
async function awaitChildSession(run: Awaited<ReturnType<typeof runPrintMode>>, id: string, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  for (;;) {
    const record = run.manager?.getRecord(id) as { session?: unknown } | undefined;
    if (record?.session) return;
    if (Date.now() - start > timeoutMs) throw new Error(`child session for ${id} never appeared`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

/**
 * Responder that serves the parent turn immediately and hands every later
 * (child) call to `child`, so an RPC spawn's model call can be gated or
 * scripted per test. `rpcSpawned` flips to true right before the suite spawns
 * over the bus — calls before that are the parent's.
 */
function childGatedResponder(
  rpcSpawned: { value: boolean },
  child: FauxReply | ((call: number) => FauxReply | Promise<FauxReply>),
) {
  let childCalls = 0;
  return async (ctx: Context): Promise<FauxReply> => {
    if (!rpcSpawned.value) return fauxText("done.");
    void ctx;
    const call = ++childCalls;
    return typeof child === "function" ? child(call) : child;
  };
}

function rpcProject(): string {
  const dir = mkdtempSync(join(tmpdir(), "subagents-rpc-e2e-"));
  mkdirSync(join(dir, ".pi"), { recursive: true });
  writeFileSync(join(dir, ".pi", "subagents.json"), JSON.stringify({}));
  return dir;
}

/** A deferred faux reply: the child's model call hangs until `release`. */
function gatedReply(): { reply: Promise<FauxContentBlock>; release: (text: string) => void } {
  let release!: (text: string) => void;
  const reply = new Promise<FauxContentBlock>(res => {
    release = (text: string) => res(fauxText(text));
  });
  return { reply, release };
}

describe("subagents:rpc end to end", () => {
  // Session boots + gated children need more than vitest's 5s default.
  const TIMEOUT = 60_000;
  let cwd: string | undefined;

  afterEach(() => {
    if (cwd) {
      rmSync(cwd, { recursive: true, force: true });
      cwd = undefined;
    }
  });

  it("ping advertises the protocol version and every capability", async () => {
    cwd = rpcProject();
    const rpcSpawned = { value: false };
    const run = await runPrintMode({
      cwd,
      live: false,
      prompt: "hello",
      respond: ctx => childGatedResponder(rpcSpawned, fauxText("child done."))(ctx),
      timeoutMs: 60_000,
    });
    try {
      const rpc = createRpcClient(run.eventBus);
      const reply = await rpc.call<{ version: number; capabilities: string[] }>("ping");

      expect(reply.success).toBe(true);
      expect(reply.data?.version).toBe(2);
      expect([...reply.data?.capabilities ?? []].sort()).toEqual(
        ["consume", "pause", "resume", "spawn", "steer", "stop"],
      );
    } finally {
      await run.dispose();
    }
  }, TIMEOUT);

  it("spawn → subagents:completed → consume suppresses the notification at the source", async () => {
    cwd = rpcProject();
    const rpcSpawned = { value: false };
    const run = await runPrintMode({
      cwd,
      live: false,
      prompt: "hello",
      respond: ctx => childGatedResponder(rpcSpawned, fauxText("child done."))(ctx),
      timeoutMs: 60_000,
    });
    try {
      const rpc = createRpcClient(run.eventBus);
      const completed = rpc.nextEvent("subagents:completed");

      rpcSpawned.value = true;
      const spawned = await rpc.call<{ id: string }>("spawn", {
        type: "general-purpose",
        prompt: "say hi",
      });
      expect(spawned.success).toBe(true);
      const id = spawned.data?.id;
      expect(typeof id).toBe("string");

      const event = (await completed) as { id?: string; status?: string };
      expect(event.id).toBe(id);
      expect(event.status).toBe("completed");

      const consumed = await rpc.call("consume", { agentId: id });
      expect(consumed.success).toBe(true);

      const record = run.manager?.getRecord(id) as { resultConsumed?: boolean } | undefined;
      expect(record?.resultConsumed).toBe(true);
    } finally {
      await run.dispose();
    }
  }, TIMEOUT);

  it("steer reaches a live child and rejects an empty message", async () => {
    cwd = rpcProject();
    const rpcSpawned = { value: false };
    const gate = gatedReply();
    let childCalls = 0;
    const run = await runPrintMode({
      cwd,
      live: false,
      prompt: "hello",
      respond: async (ctx): Promise<FauxReply> => {
        if (!rpcSpawned.value) return fauxText("done.");
        void ctx;
        childCalls += 1;
        if (childCalls === 1) return gate.reply;
        return fauxText("child done.");
      },
      timeoutMs: 60_000,
    });
    try {
      const rpc = createRpcClient(run.eventBus);
      rpcSpawned.value = true;
      const spawned = await rpc.call<{ id: string }>("spawn", {
        type: "general-purpose",
        prompt: "long task",
      });
      const id = spawned.data?.id as string;
      await awaitChildSession(run, id);

      const steered = rpc.nextEvent("subagents:steered");
      const bad = await rpc.call("steer", { agentId: id, message: "   " });
      expect(bad.success).toBe(false);
      expect((bad as { error?: string }).error).toBe("Steer message must be a non-empty string");

      const good = await rpc.call("steer", { agentId: id, message: "also check the flaky test" });
      expect(good.success).toBe(true);
      const event = (await steered) as { id?: string; message?: string };
      expect(event.id).toBe(id);
      expect(event.message).toBe("also check the flaky test");

      gate.release("wrapping up");
    } finally {
      await run.dispose();
    }
  }, TIMEOUT);

  it("stop settles a running child, and a second stop reports it", async () => {
    cwd = rpcProject();
    const rpcSpawned = { value: false };
    const gate = gatedReply();
    let childCalls = 0;
    const run = await runPrintMode({
      cwd,
      live: false,
      prompt: "hello",
      respond: async (ctx): Promise<FauxReply> => {
        if (!rpcSpawned.value) return fauxText("done.");
        void ctx;
        childCalls += 1;
        if (childCalls === 1) return gate.reply;
        return fauxText("unreachable.");
      },
      timeoutMs: 60_000,
    });
    try {
      const rpc = createRpcClient(run.eventBus);
      rpcSpawned.value = true;
      const spawned = await rpc.call<{ id: string }>("spawn", {
        type: "general-purpose",
        prompt: "long task",
      });
      const id = spawned.data?.id as string;
      await awaitChildSession(run, id);

      const failed = rpc.nextEvent("subagents:failed");
      const stopped = await rpc.call("stop", { agentId: id });
      expect(stopped.success).toBe(true);
      // Abort does not reject the in-flight faux model call; resolving the gate
      // lets the loop see the abort flag and settle the run as stopped.
      gate.release("too late — aborted");

      const event = (await failed) as { id?: string; status?: string };
      expect(event.id).toBe(id);
      expect(event.status).toBe("stopped");

      const again = await rpc.call("stop", { agentId: id });
      expect(again.success).toBe(false);
      expect((again as { error?: string }).error).toBe("Agent is not running");
    } finally {
      await run.dispose();
    }
  }, TIMEOUT);

  it("pause and resume round-trip a gated child", async () => {
    cwd = rpcProject();
    const rpcSpawned = { value: false };
    const gate = gatedReply();
    let childCalls = 0;
    const run = await runPrintMode({
      cwd,
      live: false,
      prompt: "hello",
      respond: async (ctx): Promise<FauxReply> => {
        if (!rpcSpawned.value) return fauxText("done.");
        void ctx;
        childCalls += 1;
        if (childCalls === 1) return gate.reply;
        return fauxText("child done.");
      },
      timeoutMs: 60_000,
    });
    try {
      const rpc = createRpcClient(run.eventBus);
      rpcSpawned.value = true;
      const spawned = await rpc.call<{ id: string }>("spawn", {
        type: "general-purpose",
        prompt: "long task",
      });
      const id = spawned.data?.id as string;
      await awaitChildSession(run, id);

      const paused = await rpc.call("pause", { agentId: id });
      expect(paused.success).toBe(true);
      const resumed = await rpc.call("resume", { agentId: id });
      expect(resumed.success).toBe(true);

      gate.release("finishing after resume");
      await rpc.nextEvent("subagents:completed");
      const settled = await rpc.call("consume", { agentId: id });
      expect(settled.success).toBe(true);
    } finally {
      await run.dispose();
    }
  }, TIMEOUT);

  it("resume reopens a gate-paused run whose session has not appeared yet", async () => {
    // The spawn reply resolves at "running"; onSessionCreated lands after.
    // A pause in that window records a gate, and the old resume path — which
    // for a sessionless record degrades to unpause — refused it forever (only
    // queued pauses are unpausable). The manager's gate reopen is the fix.
    cwd = rpcProject();
    const rpcSpawned = { value: false };
    const gate = gatedReply();
    let childCalls = 0;
    const run = await runPrintMode({
      cwd,
      live: false,
      prompt: "hello",
      respond: async (ctx): Promise<FauxReply> => {
        if (!rpcSpawned.value) return fauxText("done.");
        void ctx;
        childCalls += 1;
        if (childCalls === 1) return gate.reply;
        return fauxText("child done.");
      },
      timeoutMs: 60_000,
    });
    try {
      const rpc = createRpcClient(run.eventBus);
      rpcSpawned.value = true;
      const spawned = await rpc.call<{ id: string }>("spawn", {
        type: "general-purpose",
        prompt: "long task",
      });
      const id = spawned.data?.id as string;

      const paused = await rpc.call("pause", { agentId: id });
      expect(paused.success).toBe(true);
      const resumed = await rpc.call("resume", { agentId: id });
      expect(resumed.success).toBe(true);

      await awaitChildSession(run, id);
      gate.release("finishing after reopen");
      await rpc.nextEvent("subagents:completed");
      const settled = await rpc.call("consume", { agentId: id });
      expect(settled.success).toBe(true);
    } finally {
      await run.dispose();
    }
  }, TIMEOUT);

  it("error envelopes carry the documented strings", async () => {
    cwd = rpcProject();
    const rpcSpawned = { value: false };
    const run = await runPrintMode({
      cwd,
      live: false,
      prompt: "hello",
      respond: ctx => childGatedResponder(rpcSpawned, fauxText("child done."))(ctx),
      timeoutMs: 60_000,
    });
    try {
      const rpc: RpcClient = createRpcClient(run.eventBus);

      const unknown = await rpc.call("consume", { agentId: "no-such-agent" });
      expect(unknown.success).toBe(false);
      expect((unknown as { error?: string }).error).toBe("Agent not found or still running");

      const stopUnknown = await rpc.call("stop", { agentId: "no-such-agent" });
      expect((stopUnknown as { error?: string }).error).toBe("Agent not found");

      const badModel = await rpc.call("spawn", {
        type: "general-purpose",
        prompt: "x",
        options: { model: "no-such-provider/no-such-model" },
      });
      expect(badModel.success).toBe(false);
      expect((badModel as { error?: string }).error).toContain("Model not found");
    } finally {
      await run.dispose();
    }
  }, TIMEOUT);
});
