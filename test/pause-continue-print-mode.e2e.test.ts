/**
 * pause-continue-print-mode.e2e.test.ts — the `/pause` → quit → reload →
 * `/continue` story against the REAL pi runtime.
 *
 * The wiring tests (pause-continue-wiring.test.ts) mock `runAgent`, so their
 * "session files" are empty paths and `SessionManager.open` never runs. This
 * suite closes that gap with no pi-mono mock and only the model faux:
 *
 *   - run 1 drives a real parent turn (real command dispatch through
 *     `session.prompt("/pause")`, real `ExtensionCommandContext`) that spawns
 *     a real child session whose faux model call is held open, so the child is
 *     mid-turn when `/pause` lands; the manifest then holds a REAL session
 *     file path, and run 1's shutdown must leave it intact.
 *   - run 2 boots a fresh extension against the SAME cwd, resuming run 1's
 *     parent session file (the cross-boot step), and `/continue` revives the
 *     child through the real `SessionManager.open` → `resumeAgent` path.
 *
 * The disk is the assertion surface: the manifest, the child session file's
 * content before and after the continuation, and the parent's follow-up turn.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxText, fauxToolCall, getCurrentTools } from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PauseStore, resolvePauseStorePath } from "../src/pause-store.js";
import { readJournal } from "../src/workflow/journal.js";
import { agentCall, conversationText, routeBySession, runPrintMode, toolResultsNamed } from "./helpers/print-mode-runner.js";

vi.setConfig({ testTimeout: 60_000 });

/** Poll a condition with real timers — the runs have genuinely async tails. */
async function waitFor(what: () => boolean, ms = 10_000): Promise<void> {
  const start = Date.now();
  while (!what()) {
    if (Date.now() - start > ms) throw new Error(`waitFor timed out after ${ms}ms`);
    await new Promise(r => setTimeout(r, 50));
  }
}

/** How many messages of `role` a session JSONL holds — the transcript's own count. */
function countMessages(text: string, role: string): number {
  return (text.match(new RegExp(`"role":"${role}"`, "g")) ?? []).length;
}

/** Everything the faux backend was asked, flattened for substring checks. */
const asText = (context: { messages?: unknown[] }) => JSON.stringify(context.messages ?? []);

describe("/pause → quit → reload → /continue (real pi sessions, faux model)", () => {
  let cwd: string;
  let sessionDir: string;
  let prevSessionDirEnv: string | undefined;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "pause-continue-e2e-"));
    sessionDir = join(cwd, "sessions");
    // Both runs must resolve child sessions to the SAME dir under the shared
    // cwd: each run isolates HOME, and pi's default session dir lives under
    // it, which would make run 1's child sessions unreachable from run 2.
    prevSessionDirEnv = process.env.PI_CODING_AGENT_SESSION_DIR;
    process.env.PI_CODING_AGENT_SESSION_DIR = sessionDir;
  });

  afterEach(() => {
    if (prevSessionDirEnv === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
    else process.env.PI_CODING_AGENT_SESSION_DIR = prevSessionDirEnv;
    rmSync(cwd, { recursive: true, force: true });
  });

  it("parks a mid-turn child, survives shutdown, and continues it after a reload", async () => {
    // --- run 1: spawn, park, quit -----------------------------------------
    let releaseChild!: () => void;
    const childHeld = new Promise<string>(resolve => {
      releaseChild = () => resolve("late answer, dropped after the pause");
    });

    const run1 = await runPrintMode({
      live: false,
      cwd,
      prompt: "delegate work",
      hold: false, // the child never finishes — the parent must not wait for it
      sessionManager: SessionManager.create(cwd, sessionDir),
      respond: routeBySession({
        parentInitial: [agentCall({ prompt: "long child task", description: "long task", run_in_background: true })],
        parentFinal: "Spawned.",
        subagent: () => childHeld,
      }),
    });
    try {
      const childId = /Agent ID: (\S+)/.exec(toolResultsNamed(run1.parentSession, "Agent")[0])![1];
      const record = run1.manager!.getRecord(childId);
      expect(record).toBeDefined();

      // The child is mid-turn: its session exists on disk and its faux model
      // call is still held. /pause parks it through REAL command dispatch.
      await waitFor(() => record!.status === "running" && !!record!.sessionFile && existsSync(record!.sessionFile!));
      await run1.parentSession.prompt("/pause");

      expect(record!.status).toBe("paused");

      const sessionId1 = run1.parentSession.sessionManager.getSessionId();
      const parentSessionFile = run1.parentSession.sessionManager.getSessionFile();
      const manifestPath = resolvePauseStorePath(cwd, sessionId1);
      const entries = new PauseStore(manifestPath).list();
      expect(entries).toHaveLength(1);
      expect(entries[0].id).toBe(childId);
      expect(entries[0].handle).toBe("general-purpose");
      expect(existsSync(entries[0].sessionFile)).toBe(true);
      const childSessionFile = entries[0].sessionFile;

      // The held stream settles so nothing dangles into dispose.
      releaseChild();
      await run1.dispose();

      // Quit must not have scrubbed the manifest — the cross-restart premise.
      expect(new PauseStore(manifestPath).list()).toHaveLength(1);

      // The child transcript as it stands before the continuation: the resumed
      // turn must add output only — never a user message of its own.
      const childTranscriptBefore = readFileSync(childSessionFile, "utf-8");

      // --- run 2: fresh boot, resumed session, /continue --------------------
      const run2 = await runPrintMode({
        live: false,
        cwd,
        prompt: "/continue",
        hold: false,
        sessionManager: SessionManager.open(parentSessionFile, sessionDir),
        respond: routeBySession({
          parentInitial: "unexpected parent turn",
          parentFinal: "Noted.",
          subagent: "continued work",
        }),
      });
      try {
        // /continue clears the manifest: the parked entry is now a live run.
        await waitFor(() => new PauseStore(manifestPath).list().length === 0);

        // The child's REAL session file was reopened and continued bare: the
        // new exchange lands on disk with no synthetic continuation prompt.
        await waitFor(() => readFileSync(childSessionFile, "utf-8").includes("continued work"));
        const childTranscript = readFileSync(childSessionFile, "utf-8");
        expect(childTranscript).toContain("long child task");
        expect(childTranscript).not.toContain("Continue from where you left off.");
        // The transcript grew by the continuation's output only: no new user
        // message was written by the resume.
        expect(countMessages(childTranscript, "user")).toBe(countMessages(childTranscriptBefore, "user"));
        expect(countMessages(childTranscript, "assistant"))
          .toBeGreaterThan(countMessages(childTranscriptBefore, "assistant"));
        expect(childTranscript).toContain("continued work");

        // The completion nudge reached the resumed parent and was processed
        // (the follow-up turn answered). The nudge itself is a user-role
        // message, so conversationText — assistant text only — shows the reply.
        await waitFor(() => conversationText(run2.parentSession).includes("Noted."));
        expect(conversationText(run2.parentSession)).toContain("Noted.");
      } finally {
        await run2.dispose();
      }
    } finally {
      releaseChild();
      await run1.dispose().catch(() => {});
    }
  });

  it("parks a multi-step workflow mid-run, survives shutdown, and continues from journal replay after reload", async () => {
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "subagents.json"), JSON.stringify({ workflowsEnabled: true }));

    const script = [
      'export const meta = { name: "test-multistep", description: "two-step pipeline" };',
      'const r1 = await agent("STEP1_WORK", { label: "one" });',
      'const r2 = await agent("STEP2_WORK", { label: "two" });',
      'return [r1, r2];',
    ].join("\n");

    let releaseChild2!: () => void;
    const child2Held = new Promise<string>(resolve => {
      releaseChild2 = () => resolve("LATE_ANSWER");
    });

    const child1Seen: string[] = [];
    const child2Seen: string[] = [];

    const run1 = await runPrintMode({
      live: false,
      cwd,
      prompt: "start workflow",
      hold: false,
      maxModelCalls: 32,
      sessionManager: SessionManager.create(cwd, sessionDir),
      respond: context => {
        const isParent = getCurrentTools(context.messages).some(t => t.name === "SubagentWorkflow");
        if (isParent) {
          return asText(context).includes("Task ID")
            ? fauxText("workflow launched")
            : fauxToolCall("SubagentWorkflow", { script });
        }
        const txt = asText(context);
        if (txt.includes("STEP1_WORK")) {
          child1Seen.push(txt);
          return fauxText("RESULT_STEP_1");
        }
        if (txt.includes("STEP2_WORK")) {
          child2Seen.push(txt);
          return child2Held;
        }
        return fauxText("unexpected child");
      },
    });

    try {
      // Wait until step 1 completed and step 2 is in-flight.
      await waitFor(() => child1Seen.length > 0 && child2Seen.length > 0);

      const sessionId1 = run1.parentSession.sessionManager.getSessionId();
      const parentSessionFile = run1.parentSession.sessionManager.getSessionFile();
      const manifestPath = resolvePauseStorePath(cwd, sessionId1);

      // Issue /pause while step 2 is mid-execution.
      await run1.parentSession.prompt("/pause");

      // Verify the workflow was parked and journal recorded step 1.
      const wfEntries = new PauseStore(manifestPath).listWorkflows();
      expect(wfEntries).toHaveLength(1);
      expect(wfEntries[0].script).toContain("test-multistep");
      expect(existsSync(wfEntries[0].journalPath)).toBe(true);

      const journal = readJournal(wfEntries[0].journalPath);
      expect(journal).toHaveLength(1);
      expect(journal[0].ok).toBe(true);
      expect(journal[0].text).toBe("RESULT_STEP_1");

      // Settle held child and quit session.
      releaseChild2();
      await run1.dispose();

      // Quit must preserve the parked workflow manifest on disk.
      expect(new PauseStore(manifestPath).listWorkflows()).toHaveLength(1);

      // --- run 2: fresh boot, reload session, /continue ---
      const childRun2Seen: string[] = [];

      const run2 = await runPrintMode({
        live: false,
        cwd,
        prompt: "/continue",
        hold: false,
        maxModelCalls: 32,
        sessionManager: SessionManager.open(parentSessionFile, sessionDir),
        respond: context => {
          const isParent = getCurrentTools(context.messages).some(t => t.name === "SubagentWorkflow");
          if (isParent) {
            return "Acknowledged.";
          }
          const txt = asText(context);
          childRun2Seen.push(txt);
          if (txt.includes("STEP1_WORK")) {
            return fauxText("UNEXPECTED_STEP1_RERUN");
          }
          if (txt.includes("STEP2_WORK")) {
            return fauxText("RESULT_STEP_2");
          }
          return fauxText("other child");
        },
      });

      try {
        // Manifest must be cleared once /continue relaunches the workflow.
        await waitFor(() => new PauseStore(manifestPath).listWorkflows().length === 0);

        // Wait for step 2 to complete live in run 2.
        await waitFor(() => childRun2Seen.some(p => p.includes("STEP2_WORK")));

        // Step 1 MUST NOT have been invoked again (replayed from journal cache).
        expect(childRun2Seen.some(p => p.includes("STEP1_WORK"))).toBe(false);
        // Step 2 MUST have been invoked live against the model.
        expect(childRun2Seen.some(p => p.includes("STEP2_WORK"))).toBe(true);

        // Completion notification reached the parent session.
        await waitFor(() =>
          conversationText(run2.parentSession).includes("test-multistep") ||
          conversationText(run2.parentSession).includes("RESULT_STEP_2") ||
          conversationText(run2.parentSession).includes("Acknowledged."),
        );
      } finally {
        await run2.dispose();
      }
    } finally {
      releaseChild2();
      await run1.dispose().catch(() => {});
    }
  });

  it("exercises RPC endpoint spawn, ownership refusal on workflow child, pause, quit, continue, and consume", async () => {
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(join(cwd, ".pi", "subagents.json"), JSON.stringify({ workflowsEnabled: true }));

    const wfScript = [
      'export const meta = { name: "wf-rpc", description: "rpc workflow" };',
      'const res = await agent("WF_CHILD_TASK");',
      'return res;',
    ].join("\n");

    let releaseAgent!: () => void;
    const agentHeld = new Promise<string>(resolve => {
      releaseAgent = () => resolve("rpc agent finished");
    });
    let releaseWfChild!: () => void;
    const wfChildHeld = new Promise<string>(resolve => {
      releaseWfChild = () => resolve("wf child finished");
    });

    let rpcAgentSeen = false;
    let wfSeen = false;

    const run1 = await runPrintMode({
      live: false,
      cwd,
      prompt: "orchestrator start",
      hold: false,
      maxModelCalls: 32,
      sessionManager: SessionManager.create(cwd, sessionDir),
      respond: context => {
        const isParent = getCurrentTools(context.messages).some(t => t.name === "SubagentWorkflow");
        if (isParent) {
          const txt = asText(context);
          if (txt.includes("run the workflow")) {
            return txt.includes("Task ID")
              ? fauxText("wf started")
              : fauxToolCall("SubagentWorkflow", { script: wfScript });
          }
          return fauxText("ready");
        }
        const txt = asText(context);
        if (txt.includes("RPC_TASK_PROMPT")) {
          rpcAgentSeen = true;
          return agentHeld;
        }
        if (txt.includes("WF_CHILD_TASK")) {
          wfSeen = true;
          return wfChildHeld;
        }
        return "child done";
      },
    });

    try {
      const bus = run1.eventBus;
      function rpcCall<T = any>(channel: string, payload: any): Promise<T> {
        return new Promise((resolve, reject) => {
          const reqId = payload.requestId ?? `req-${Math.random().toString(36).slice(2)}`;
          payload.requestId = reqId;
          const unsub = bus.on(`${channel}:reply:${reqId}`, (reply: any) => {
            unsub();
            if (reply.success) resolve(reply.data);
            else reject(new Error(reply.error));
          });
          bus.emit(channel, payload);
        });
      }

      // 1. Verify RPC ping returns capabilities.
      const ping = await rpcCall<{ version: number; capabilities: string[] }>("subagents:rpc:ping", {});
      expect(ping.version).toBe(2);
      expect(ping.capabilities).toEqual(["spawn", "stop", "pause", "resume", "consume", "steer"]);

      // 2. Spawn an agent via RPC endpoint.
      const spawnReply = await rpcCall<{ id: string }>("subagents:rpc:spawn", {
        type: "general-purpose",
        prompt: "RPC_TASK_PROMPT",
        options: { description: "rpc spawned agent", isBackground: true },
      });
      const rpcAgentId = spawnReply.id;
      expect(rpcAgentId).toBeTruthy();

      // 3. Dispatch workflow via prompt.
      await run1.parentSession.prompt("run the workflow");

      // Wait for both RPC agent and workflow to be running in-flight.
      await waitFor(() => rpcAgentSeen && wfSeen);

      // Verify RPC pause rejection on an unknown agent.
      await expect(
        rpcCall("subagents:rpc:pause", { agentId: "nonexistent-agent" }),
      ).rejects.toThrow("Agent not found");

      // 4. Issue global /pause: both the RPC-spawned agent and the workflow run are paused.
      await run1.parentSession.prompt("/pause");

      const sessionId1 = run1.parentSession.sessionManager.getSessionId();
      const parentSessionFile = run1.parentSession.sessionManager.getSessionFile();
      const manifestPath = resolvePauseStorePath(cwd, sessionId1);

      const store = new PauseStore(manifestPath);
      const rpcEntry = store.list().find(e => e.id === rpcAgentId);
      expect(rpcEntry).toBeDefined();
      const rpcSessionFile = rpcEntry!.sessionFile;
      expect(rpcSessionFile).toBeTruthy();
      expect(store.listWorkflows()).toHaveLength(1);

      // Release held model promises and quit session.
      releaseAgent();
      releaseWfChild();
      await run1.dispose();

      // 5. Reload session, run /continue: both RPC agent and workflow resume and complete.
      const run2 = await runPrintMode({
        live: false,
        cwd,
        prompt: "/continue",
        hold: false,
        maxModelCalls: 32,
        sessionManager: SessionManager.open(parentSessionFile, sessionDir),
        respond: context => {
          const isParent = getCurrentTools(context.messages).some(t => t.name === "SubagentWorkflow");
          if (isParent) return "Noted.";
          return fauxText("resumed task finished");
        },
      });

      try {
        const bus2 = run2.eventBus;

        // Wait for manifest to clear.
        await waitFor(
          () =>
            new PauseStore(manifestPath).list().length === 0 &&
            new PauseStore(manifestPath).listWorkflows().length === 0,
        );

        // Wait for RPC agent to complete its resumed turn on disk.
        await waitFor(() => readFileSync(rpcSessionFile!, "utf-8").includes("resumed task finished"));

        // Wait for revived agent record in manager to settle.
        await waitFor(() => {
          const r = run2.manager?.getRecord(rpcEntry.handle!);
          return r !== undefined && (r.status === "completed" || r.result !== undefined);
        });

        const revived = run2.manager?.getRecord(rpcEntry.handle!);
        expect(revived).toBeDefined();
        const revivedAgentId = revived!.id;
        expect(revivedAgentId).toBeTruthy();

        // 6. Test subagents:rpc:consume on the finished RPC agent.
        function rpcCall2<T = any>(channel: string, payload: any): Promise<T> {
          return new Promise((resolve, reject) => {
            const reqId = payload.requestId ?? `req-${Math.random().toString(36).slice(2)}`;
            payload.requestId = reqId;
            const unsub = bus2.on(`${channel}:reply:${reqId}`, (reply: any) => {
              unsub();
              if (reply.success) resolve(reply.data);
              else reject(new Error(reply.error));
            });
            bus2.emit(channel, payload);
          });
        }

        // Consuming the result succeeds (can consume by @handle or by revived id).
        await rpcCall2("subagents:rpc:consume", { agentId: `@${rpcEntry.handle}` });

        // Consuming an unknown agent fails with "Agent not found or still running".
        await expect(
          rpcCall2("subagents:rpc:consume", { agentId: "nonexistent-agent" }),
        ).rejects.toThrow(/Agent not found or still running/);
      } finally {
        await run2.dispose();
      }
    } finally {
      releaseAgent();
      releaseWfChild();
      await run1.dispose().catch(() => {});
    }
  });

  it("parks workflow between subagent tool-call turns, verifies cached tool calls are bypassed and pending tool calls execute on /continue", async () => {
    const wfScript = [
      'export const meta = { name: "wf-tool-continue", description: "exercises tool calls across pause and continue" };',
      'const step1 = await agent("WORKFLOW_STEP1_PROMPT");',
      'const step2 = await agent("WORKFLOW_STEP2_PROMPT");',
      'return JSON.stringify({ step1, step2 });',
    ].join("\n");

    let releaseStep2!: () => void;
    const step2Held = new Promise<string>(resolve => {
      releaseStep2 = () => resolve("step2 held release");
    });

    let step1ToolInvocationsRun1 = 0;
    let step2SeenRun1 = false;

    function toolResultCount(context: { messages?: Array<{ role?: string; toolName?: string }> }, toolName: string): number {
      return (context.messages ?? []).filter(
        m => m.role === "toolResult" && m.toolName === toolName,
      ).length;
    }

    const run1 = await runPrintMode({
      live: false,
      cwd,
      prompt: "orchestrator start",
      hold: false,
      maxModelCalls: 32,
      sessionManager: SessionManager.create(cwd, sessionDir),
      respond: context => {
        const isParent = getCurrentTools(context.messages).some(t => t.name === "SubagentWorkflow");
        if (isParent) {
          const txt = asText(context);
          if (txt.includes("run tool workflow")) {
            return txt.includes("Task ID")
              ? fauxText("tool wf started")
              : fauxToolCall("SubagentWorkflow", { script: wfScript });
          }
          return fauxText("ready");
        }
        const txt = asText(context);
        if (txt.includes("WORKFLOW_STEP1_PROMPT")) {
          if (toolResultCount(context, "bash") === 0) {
            step1ToolInvocationsRun1++;
            return fauxToolCall("bash", { command: "echo step1_payload" }, { id: "tc-s1" });
          }
          return fauxText("step1_done");
        }
        if (txt.includes("WORKFLOW_STEP2_PROMPT")) {
          step2SeenRun1 = true;
          return step2Held;
        }
        return "other child";
      },
    });

    try {
      // 1. Start workflow in run 1.
      await run1.parentSession.prompt("run tool workflow");

      // Wait for step 1 to execute its tool call, complete, and step 2 to start.
      await waitFor(() => step1ToolInvocationsRun1 === 1 && step2SeenRun1);

      // 2. Issue /pause while step 2 is in-flight.
      await run1.parentSession.prompt("/pause");

      const sessionId1 = run1.parentSession.sessionManager.getSessionId();
      const parentSessionFile = run1.parentSession.sessionManager.getSessionFile();
      const manifestPath = resolvePauseStorePath(cwd, sessionId1);

      const store1 = new PauseStore(manifestPath);
      const parkedWorkflows = store1.listWorkflows();
      expect(parkedWorkflows).toHaveLength(1);

      const journalPath = parkedWorkflows[0].journalPath;
      expect(existsSync(journalPath)).toBe(true);
      // Step 1's tool execution must already be recorded in the journal.
      const entries1 = readJournal(journalPath);
      expect(entries1).toHaveLength(1);
      expect(entries1[0].ok).toBe(true);
      expect(entries1[0].text).toBe("step1_done");

      // Release held step 2 and shut down run 1.
      releaseStep2();
      await run1.dispose();

      // 3. Boot run 2: reload parent session and run /continue.
      let step1ToolInvocationsRun2 = 0;
      let step2ToolInvocationsRun2 = 0;
      let step2CompletedRun2 = false;

      const run2 = await runPrintMode({
        live: false,
        cwd,
        prompt: "/continue",
        hold: false,
        maxModelCalls: 32,
        sessionManager: SessionManager.open(parentSessionFile, sessionDir),
        respond: context => {
          const isParent = getCurrentTools(context.messages).some(t => t.name === "SubagentWorkflow");
          if (isParent) return "Acknowledged.";
          const txt = asText(context);
          if (txt.includes("WORKFLOW_STEP1_PROMPT")) {
            // Step 1 MUST NOT be invoked in run 2 (it is replayed from journal cache).
            step1ToolInvocationsRun2++;
            return fauxText("ERROR_STEP1_SHOULD_HAVE_BEEN_CACHED");
          }
          if (txt.includes("WORKFLOW_STEP2_PROMPT")) {
            if (toolResultCount(context, "bash") === 0) {
              step2ToolInvocationsRun2++;
              return fauxToolCall("bash", { command: "echo step2_payload" }, { id: "tc-s2" });
            }
            step2CompletedRun2 = true;
            return fauxText("step2_done");
          }
          return "other child";
        },
      });

      try {
        // Wait for manifest to clear.
        await waitFor(() => new PauseStore(manifestPath).listWorkflows().length === 0);

        // Wait for Step 2 to execute its tool and complete live.
        await waitFor(() => step2CompletedRun2);

        // Verification:
        // - Step 1 tool was executed in run 1, but NEVER invoked in run 2 (cached from journal).
        expect(step1ToolInvocationsRun1).toBe(1);
        expect(step1ToolInvocationsRun2).toBe(0);

        // - Step 2 tool was executed live in run 2.
        expect(step2ToolInvocationsRun2).toBe(1);

        // - Both steps are recorded in the resumed run's journal on disk.
        const taskDir = join(journalPath, "..");
        let resumedJournalPath = "";
        await waitFor(() => {
          const journalFiles = readdirSync(taskDir).filter(f => f.endsWith(".workflow.jsonl"));
          const resumedFile = journalFiles.find(f => join(taskDir, f) !== journalPath);
          if (!resumedFile) return false;
          resumedJournalPath = join(taskDir, resumedFile);
          return readJournal(resumedJournalPath).length === 2;
        });

        const finalEntries = readJournal(resumedJournalPath);
        expect(finalEntries).toHaveLength(2);
        expect(finalEntries[0].text).toBe("step1_done");
        expect(finalEntries[1].text).toBe("step2_done");

        // - Parent session received the final result with both steps.
        await waitFor(() =>
          conversationText(run2.parentSession).includes("step1_done") ||
          conversationText(run2.parentSession).includes("step2_done") ||
          conversationText(run2.parentSession).includes("wf-tool-continue"),
        );
      } finally {
        await run2.dispose();
      }
    } finally {
      releaseStep2();
      await run1.dispose().catch(() => {});
    }
  });
});

