/**
 * workflow-agent-error.test.ts — a failed `agent()` call stays `null`, but says
 * why: the reason is bounded on the journal entry and readable in-script.
 */
import { describe, expect, it } from "vitest";
import { journalKey, type WorkflowJournalEntry } from "../src/workflow/journal.js";
import {
  type RunWorkflowOptions,
  runWorkflow,
  type WorkflowHost,
  type WorkflowSpawnResult,
} from "../src/workflow/runtime.js";

const HEAD = 'export const meta = { name: "errors", description: "failure diagnostics" };\n';

function run(body: string, options: Omit<RunWorkflowOptions, "script">) {
  return runWorkflow({ script: HEAD + body, ...options });
}

function hostReturning(result: WorkflowSpawnResult): WorkflowHost {
  return { async spawnAgent() { return result; }, abortAgent() {} };
}

describe("agentError", () => {
  it.each([
    { name: "provider failure", reply: { ok: false, error: "429 rate_limit_error" }, error: "429 rate_limit_error" },
    { name: "missing reason", reply: { ok: false }, error: "Agent failed." },
    { name: "empty reason", reply: { ok: false, error: "" }, error: "" },
    { name: "stopped child", reply: { ok: false, skipped: true, error: "Stopped." }, error: "Stopped." },
  ])("preserves null and journals the $name", async ({ reply, error }) => {
    const entries: WorkflowJournalEntry[] = [];
    const result = await run(`
      const value = await agent("review", { label: "reviewer" });
      return { value, error: agentError("reviewer") };
    `, { host: hostReturning(reply), journal: { append: entry => entries.push(entry) } });

    expect(result).toMatchObject({ status: "completed", value: { value: null, error } });
    expect(entries).toEqual([{
      path: "#0",
      index: 0,
      key: journalKey({ prompt: "review", label: "reviewer" }),
      ok: false,
      error,
    }]);
  });

  it.each([499, 500, 501])("bounds a %i-character diagnostic in both the journal and sandbox", async length => {
    const entries: WorkflowJournalEntry[] = [];
    const error = "x".repeat(length);
    const result = await run('await agent("review"); return agentError("review");', {
      host: hostReturning({ ok: false, error }),
      journal: { append: entry => entries.push(entry) },
    });
    expect(result.value).toBe("x".repeat(Math.min(length, 500)));
    expect(entries[0].error).toBe("x".repeat(Math.min(length, 500)));
  });

  it("exposes thrown host errors under the derived display label", async () => {
    const result = await run('await agent("  review\\nsecond line"); return agentError("review");', {
      host: { ...hostReturning({ ok: true }), async spawnAgent() { throw new Error("provider unavailable"); } },
    });
    expect(result.value).toBe("provider unavailable");
  });

  it("reports schema and gate failures", async () => {
    const entries: WorkflowJournalEntry[] = [];
    const result = await run(`
      await agent("schema", { label: "schema", schema: { type: "object" } });
      await agent("gate", { label: "gate", gate: "npm test" });
      return [agentError("schema"), agentError("gate")];
    `, {
      host: {
        ...hostReturning({ ok: true, text: "not JSON" }),
        async runGate() { return { ok: false, output: "1 failing test" }; },
      },
      journal: { append: entry => entries.push(entry) },
    });
    const errors = ["The agent did not return structured output: its answer was not JSON.", "1 failing test"];
    expect(result.value).toEqual(errors);
    expect(entries.map(entry => entry.error)).toEqual(errors);
  });

  it("retains the last failure through success and keeps labels independent", async () => {
    const result = await run(`
      const unknown = agentError("toString") === undefined;
      await agent("first", { label: "__proto__" });
      await agent("second", { label: "other" });
      await agent("success", { label: "__proto__" });
      const afterSuccess = agentError("__proto__");
      await agent("last", { label: "__proto__" });
      return { unknown, afterSuccess, latest: agentError("__proto__"), other: agentError("other") };
    `, {
      host: {
        async spawnAgent(request) {
          return request.prompt === "success" ? { ok: true, text: "done" } : { ok: false, error: request.prompt };
        },
        abortAgent() {},
      },
    });
    expect(result.value).toEqual({ unknown: true, afterSuccess: "first", latest: "last", other: "second" });
  });

  it("uses settlement order when concurrent calls share a label", async () => {
    let finishSlow: (() => void) | undefined;
    const slowGate = new Promise<void>(resolve => { finishSlow = resolve; });
    const result = await run(`
      const slow = agent("slow", { label: "shared" });
      await agent("fast", { label: "shared" });
      const first = agentError("shared");
      await agent("release");
      await slow;
      return [first, agentError("shared")];
    `, {
      host: {
        async spawnAgent(request) {
          if (request.prompt === "slow") await slowGate;
          if (request.prompt === "release") finishSlow?.();
          return request.prompt === "release"
            ? { ok: true, text: "released" }
            : { ok: false, error: request.prompt };
        },
        abortAgent() {},
      },
    });
    expect(result.value).toEqual(["fast", "slow"]);
  });

  it("is visible inside a nested workflow", async () => {
    const result = await run('return await workflow("child");', {
      host: {
        async spawnAgent(request) {
          return request.prompt === "inner" ? { ok: false, error: "inner boom" } : { ok: true, text: "done" };
        },
        abortAgent() {},
        loadWorkflow: () => ({ ok: true, script: HEAD + 'await agent("inner"); return agentError("inner");' }),
      },
    });
    expect(result.value).toBe("inner boom");
  });

  it("does not replay an earlier error into a fresh run", async () => {
    const entries: WorkflowJournalEntry[] = [];
    const script = 'await agent("review", { label: "reviewer" }); return agentError("reviewer");';
    const first = await run(script, {
      host: hostReturning({ ok: false, error: "original" }),
      journal: { append: entry => entries.push(entry) },
    });
    expect(first.value).toBe("original");

    const second = await runWorkflow({
      script: HEAD + script,
      host: hostReturning({ ok: true, text: "fresh" }),
      journal: { entries, append: entry => entries.push(entry) },
    });
    // The failed prefix is retried live, and a success does not inherit the
    // old diagnostic: each run starts with an empty map.
    expect(second.status).toBe("completed");
    expect(second.value).toBeUndefined();
  });
});
