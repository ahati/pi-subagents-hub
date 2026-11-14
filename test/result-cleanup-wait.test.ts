import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => ({
  ...await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js"),
  runAgent: vi.fn(),
}));

import { AgentManager } from "../src/agent-manager.js";
import { runAgent } from "../src/agent-runner.js";
import type { CompletionOutbox } from "../src/completion-outbox.js";
import { createGetResultTool } from "../src/tools/inspect-tools.js";
import type { AgentRecord } from "../src/types.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8", stdio: "pipe" }).trim();
}

const pi = {
  exec: async (command: string, args: string[], options?: { cwd?: string; timeout?: number }) => {
    try {
      return {
        stdout: execFileSync(command, args, {
          cwd: options?.cwd, timeout: options?.timeout, encoding: "utf-8", stdio: "pipe",
        }),
        stderr: "", code: 0, killed: false,
      };
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string; status?: number; signal?: string };
      return {
        stdout: failure.stdout ?? "", stderr: failure.stderr ?? "",
        code: failure.status ?? 1, killed: !!failure.signal,
      };
    }
  },
} as ExtensionAPI;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture(preservationFails: boolean, runFails = false) {
  const dir = mkdtempSync(join(tmpdir(), "pi-result-cleanup-"));
  git(dir, ["init"]);
  git(dir, ["config", "user.name", "Test"]);
  git(dir, ["config", "user.email", "test@example.invalid"]);
  writeFileSync(join(dir, "base.txt"), "base");
  git(dir, ["add", "base.txt"]);
  git(dir, ["commit", "-m", "base"]);
  if (preservationFails) {
    // Unlike pre-commit, this real Git hook still runs with --no-verify.
    writeFileSync(join(dir, ".git/hooks/prepare-commit-msg"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  }
  const entered = deferred();
  const release = deferred();
  const consumedAtCompletion: boolean[] = [];
  const manager = new AgentManager(record => { consumedAtCompletion.push(!!record.resultConsumed); });
  let worktreePath: string | undefined;
  vi.mocked(runAgent).mockImplementationOnce(async (_ctx, _type, _prompt, options) => {
    worktreePath = options.cwd!;
    writeFileSync(join(worktreePath, "agent-output.txt"), "recover me");
    if (runFails) throw new Error("model failed");
    return {
      responseText: "done", session: { dispose() {} }, aborted: false, steered: false,
    } as Awaited<ReturnType<typeof runAgent>>;
  });
  // The Git status call is asynchronous in production. Hold it after the model
  // settles, on both the success and rejected-run paths, without mocking cleanup.
  const barrierPi = {
    ...pi,
    exec: async (command, args, options) => {
      if (args[0] === "status") {
        entered.resolve();
        await release.promise;
      }
      return pi.exec(command, args, options);
    },
  } as ExtensionAPI;
  const ctx = { cwd: dir } as ExtensionContext;
  const id = manager.spawn(barrierPi, ctx, "general-purpose", "go", {
    description: "cleanup wait", isBackground: true, isolation: "worktree",
  });
  await manager.awaitStartup(id);
  await entered.promise;
  const record = manager.getRecord(id)!;
  const promise = record.promise!;
  const cancel = vi.fn();
  const tool = createGetResultTool({
    resolveAgentRef: () => record, resolveMention: () => undefined,
    isShowCostEnabled: () => false, outbox: { cancel } as unknown as CompletionOutbox, pi,
  });
  return {
    record, promise, release, consumedAtCompletion, cancel, ctx, id, tool, dir,
    worktreePath: worktreePath!,
    async dispose() {
      release.resolve();
      await promise;
      await manager.dispose();
      if (worktreePath && existsSync(worktreePath)) rmSync(worktreePath, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const flush = () => new Promise<void>(resolve => setImmediate(resolve));

describe("result reads during worktree cleanup", () => {
  it.each([
    { preservationFails: true, runFails: false, wait: true },
    { preservationFails: false, runFails: false, wait: true },
    { preservationFails: true, runFails: true, wait: true },
    { preservationFails: true, runFails: false, wait: undefined },
  ])("wait=$wait includes cleanup notes (preservationFails=$preservationFails, runFails=$runFails)", async options => {
    const f = await fixture(options.preservationFails, options.runFails);
    try {
      let returned = false;
      const request = f.tool.execute("fetch", { agent_id: f.id, wait: options.wait }, undefined, undefined, f.ctx)
        .then(result => { returned = true; return result; });
      await flush();
      const early = { returned, consumed: !!f.record.resultConsumed, cancelled: f.cancel.mock.calls.length };
      f.release.resolve();
      const result = await request;
      expect(await f.promise).toBe(options.runFails ? "" : "done");
      const text = result.content[0].type === "text" ? result.content[0].text : "";

      expect(early).toEqual({ returned: false, consumed: false, cancelled: 0 });
      expect(text).toContain(options.preservationFails ? "Worktree cleanup failed" : "Changes saved to branch");
      expect(f.record.promise).toBe(f.promise);
      expect(f.record.resultConsumed).toBe(true);
      expect(f.cancel).toHaveBeenCalledExactlyOnceWith(f.id);
      expect(f.consumedAtCompletion).toEqual([false]);
      if (options.preservationFails) {
        expect(text).toContain(f.worktreePath);
        expect(readFileSync(join(f.worktreePath, "agent-output.txt"), "utf-8")).toBe("recover me");
      } else {
        expect(git(f.dir, ["show", `${f.record.worktreeResult!.branch}:agent-output.txt`])).toBe("recover me");
      }
      if (options.runFails) expect(text).toContain("Error: model failed");
    } finally {
      await f.dispose();
    }
  });

  it("does not consume or cancel a paused result", async () => {
    const record = {
      id: "paused-1", type: "general-purpose", description: "paused", status: "paused",
      result: "partial", toolUses: 0, startedAt: 0, completedAt: 1, compactionCount: 0,
      lifetimeUsage: { input: 0, output: 0, cacheWrite: 0 }, resultConsumed: false,
    } as unknown as AgentRecord;
    const cancel = vi.fn();
    const tool = createGetResultTool({
      resolveAgentRef: () => record, resolveMention: () => undefined,
      isShowCostEnabled: () => false, outbox: { cancel } as unknown as CompletionOutbox, pi,
    });
    const result = await tool.execute("fetch", { agent_id: record.id }, undefined, undefined, { cwd: tmpdir() } as ExtensionContext);
    expect(result.content[0].type).toBe("text");
    expect(record.resultConsumed).toBe(false);
    expect(cancel).not.toHaveBeenCalled();
  });

  it("cancels only the result wait while cleanup is pending", async () => {
    const f = await fixture(true);
    try {
      const controller = new AbortController();
      const removeListener = vi.spyOn(controller.signal, "removeEventListener");
      const outcome = f.tool.execute("fetch", { agent_id: f.id, wait: true }, controller.signal, undefined, f.ctx)
        .then(() => "returned", (error: unknown) => error instanceof Error ? error.name : String(error));
      controller.abort();
      expect(await outcome).toBe("AbortError");
      expect(f.record.abortController!.signal.aborted).toBe(false);
      expect(f.record.resultConsumed).not.toBe(true);
      expect(f.cancel).not.toHaveBeenCalled();
      expect(removeListener).toHaveBeenCalledTimes(1);
      f.release.resolve();
      await f.promise;
      expect(f.consumedAtCompletion).toEqual([false]);
      expect(f.record.status).toBe("error");
      expect(f.record.error).toContain("Worktree cleanup failed");
    } finally {
      await f.dispose();
    }
  });
});
