/**
 * pause-resume-runtime-repro.test.ts — full-fidelity REPRODUCTION for the
 * reported failure: `/pause` → quit → pi `/resume` → `/continue` loses the
 * paused agents.
 *
 * The wiring-level repro (pause-resume-repro.test.ts) drives the extension's
 * resume EVENT sequence by hand and passes, so the reported failure — if real
 * — lives in the machinery pi actually runs for `/resume`: `AgentSessionRuntime`
 * with its real `switchSession` (session_before_switch → teardown of the
 * CURRENT session incl. session_shutdown → new runtime → session_start(resume)
 * → finishSessionReplacement). This test drives exactly that, in process:
 *
 *   - run 1 (runPrintMode, the proven harness): a faux parent turn spawns a
 *     real child session (held), `/pause` parks it via real command dispatch,
 *     the manifest is written, dispose() is the quit.
 *   - run 2: a manual AgentSessionRuntime on a FRESH session (as the user's pi
 *     starts), then `switchSession(<run 1 session file>)` — the operation
 *     `/resume` runs — and finally `/continue` through real command dispatch.
 *
 * Expected (docs/pause-quit-resume-continue.md §4.2 FR-C4): the resumed
 * session announces the parked agents, `/continue` revives the child from its
 * session file with no synthetic prompt, and the manifest clears.
 *
 * Outcome: the full sequence WORKS through the real runtime machinery —
 * kept as an end-to-end regression test for the resume flow.
 * NOTE: the extension is bound in `tui` mode here — see pause-continue-print-mode.e2e.test.ts.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AssistantMessage,
  type FauxContentBlock,
  type FauxResponseStep,
  fauxAssistantMessage,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  getAgentDir,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PauseStore, resolvePauseStorePath } from "../src/pause-store.js";
import { fauxModelBackend } from "./helpers/faux-model-backend.js";
import { registerFauxProvider } from "./helpers/pi-ai.js";
import {
  agentCall,
  type FauxReply,
  routeBySession,
  runPrintMode,
} from "./helpers/print-mode-runner.js";

const EXTENSION_PATH = fileURLToPath(new URL("../src/index.ts", import.meta.url));

vi.setConfig({ testTimeout: 180_000 });

async function waitFor(what: () => boolean, ms = 60_000): Promise<void> {
  const start = Date.now();
  while (!what()) {
    if (Date.now() - start > ms) throw new Error(`waitFor timed out after ${ms}ms`);
    await new Promise(r => setTimeout(r, 50));
  }
}

/**
 * The print-mode runner's `toAssistantMessage` normalizer, applied to EVERY
 * scripted step. `setResponses` takes `FauxResponseStep[]` — an `AssistantMessage`
 * or a factory, never a bare string. A string step is `structuredClone`d and
 * spread into a keyless object, `withUsageEstimate` then dereferences its absent
 * `content`, and the provider's catch turns that TypeError into an empty
 * `stopReason: "error"` assistant frame (pi-ai `providers/faux.js`,
 * `resolveResponse`/`createErrorMessage`) — the continuation then has nothing to
 * say and never completes.
 */
function scriptedStep(reply: FauxReply): FauxResponseStep {
  return async () => {
    if (reply && typeof reply === "object" && "role" in reply) return reply as AssistantMessage;
    const content: FauxContentBlock[] =
      typeof reply === "string" ? [fauxText(reply)] : Array.isArray(reply) ? reply : [reply];
    const hasToolCall = content.some(b => (b as { type?: string }).type === "toolCall");
    return fauxAssistantMessage(content, { stopReason: hasToolCall ? "toolUse" : "stop" });
  };
}

describe("REPRO (runtime): /pause → quit → /resume → /continue", () => {
  let cwd: string;
  let sessionDir: string;
  let prevSessionDirEnv: string | undefined;
  let prevCwd: string | undefined;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "pause-resume-rt-"));
    sessionDir = join(cwd, "sessions");
    prevSessionDirEnv = process.env.PI_CODING_AGENT_SESSION_DIR;
    process.env.PI_CODING_AGENT_SESSION_DIR = sessionDir;
    prevCwd = process.cwd();
    process.chdir(cwd);
  });

  afterEach(() => {
    if (prevSessionDirEnv === undefined) delete process.env.PI_CODING_AGENT_SESSION_DIR;
    else process.env.PI_CODING_AGENT_SESSION_DIR = prevSessionDirEnv;
    process.chdir(prevCwd);
    rmSync(cwd, { recursive: true, force: true });
  });

  it("parks a child, resumes the parent session via switchSession, and /continue revives it", async () => {
    // --- run 1: real runtime, real parent turn spawns a held child --------
    let releaseChild!: () => void;
    const childHeld = new Promise<string>(resolve => {
      releaseChild = () => resolve("late answer, dropped after the pause");
    });

    const parentSm = SessionManager.create(cwd, sessionDir);
    const run1 = await runPrintMode({
      mode: "tui",
      live: false,
      cwd,
      prompt: "delegate work",
      hold: false, // the child never finishes — the parent must not wait for it
      sessionManager: parentSm,
      respond: routeBySession({
        parentInitial: agentCall({ prompt: "long child task", description: "long task", run_in_background: true }),
        parentFinal: "Spawned.",
        subagent: () => childHeld,
      }),
    });
    try {
      // The e2e's probing pattern: child id from the parent transcript's tool
      // result TEXT (not its JSON form — escaped newlines would break \S+),
      // then getRecord. (The ManagerHandle exposes no listAgents.)
      const toolResultText = parentSm
        .getBranch()
        .filter((e: any) => (e as any).message?.role === "toolResult")
        .flatMap((e: any) => (e as any).message.content)
        .filter((c: any) => c?.type === "text")
        .map((c: any) => c.text)
        .join("\n");
      const childId = /Agent ID: (\S+)/.exec(toolResultText)?.[1] ?? "";
      expect(childId, "the parent turn must have spawned a child").not.toBe("");
      let dumped = false; const start1 = Date.now();
      await waitFor(() => {
        const record = run1.manager?.getRecord(childId);
        if (!dumped && Date.now() > start1 + 50_000) {
          dumped = true;
          writeFileSync(
            "/tmp/rt-repro-debug.txt",
            `childId: ${childId}\nrecord: ${JSON.stringify(record ? { status: record.status, sessionFile: record.sessionFile, handle: record.handle } : null)}\n`,
          );
        }
        return record?.status === "running" && typeof record.sessionFile === "string" && existsSync(record.sessionFile);
      });
      const child = run1.manager!.getRecord(childId)!;

      // Real command dispatch: /pause parks the child (main model is idle).
      await run1.parentSession.prompt("/pause");
      await waitFor(() => new PauseStore(resolvePauseStorePath(cwd, parentSm.getSessionId())).list().length === 1);

      const parentFile = parentSm.getSessionFile();
      const childFile = child.sessionFile as string;

      // Quit: real runtime teardown.
      releaseChild();
      await run1.dispose();
      expect(new PauseStore(resolvePauseStorePath(cwd, parentSm.getSessionId())).list()).toHaveLength(1);

      // --- run 2: fresh pi on a FRESH session, then the real /resume -------
      const freshSm = SessionManager.create(cwd, sessionDir);
      const faux = registerFauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: 200_000 }] });
      const model = faux.getModel();
      const { modelRuntime } = fauxModelBackend(model);
      const responder = routeBySession({
        parentInitial: "unexpected parent turn",
        parentFinal: "Noted.",
        subagent: "continued work",
      });
      faux.setResponses(Array.from({ length: 24 }, () => async (context: any, opts: any, state: any) => {
        const reply = responder(context, opts, state);
        return typeof reply === "string"
          ? { role: "assistant", content: [{ type: "text", text: reply }], timestamp: Date.now() } as any
          : (reply as any);
      }));

      const createRuntime = async ({ cwd: runtimeCwd, agentDir: runtimeAgentDir, sessionManager: runtimeSm, sessionStartEvent }: any) => {
        const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
        const services = await createAgentSessionServices({
          cwd: runtimeCwd,
          agentDir: runtimeAgentDir,
          settingsManager,
          modelRuntime,
          resourceLoaderOptions: {
            additionalExtensionPaths: [EXTENSION_PATH],
            // Skip discovery (installed packages) — our extension loads explicitly.
            noExtensions: true,
            noSkills: true,
            noPromptTemplates: true,
            noThemes: true,
            noContextFiles: true,
          },
        });
        const created = await createAgentSessionFromServices({
          services,
          sessionManager: runtimeSm,
          sessionStartEvent,
          model,
        });
        // Binding fires session_start so the extension publishes its manager.
        await created.session.bindExtensions({ mode: "tui" });
        return { ...created, services, diagnostics: [] };
      };
      const runtime2 = await createAgentSessionRuntime(createRuntime, {
        cwd,
        agentDir: getAgentDir(),
        sessionManager: freshSm,
      });
      try {
        // THE operation `/resume` runs.
        await runtime2.switchSession(parentFile);

        const resumedId = runtime2.session.sessionManager.getSessionId();
        expect(resumedId, "the resumed session keeps its id").toBe(parentSm.getSessionId());
        const manifestPath = resolvePauseStorePath(cwd, resumedId);
        expect(new PauseStore(manifestPath).list()).toHaveLength(1);

        // /continue through real command dispatch.
        await runtime2.session.prompt("/continue");

        await waitFor(
          () => new PauseStore(manifestPath).list().length === 0,
          60_000,
        );
        await waitFor(() => readFileSync(childFile, "utf-8").includes("continued work"));
        const transcript = readFileSync(childFile, "utf-8");
        expect(transcript).toContain("long child task");
        expect(transcript).not.toContain("Continue from where you left off.");
      } finally {
        await runtime2.dispose().catch(() => {});
      }
    } finally {
      releaseChild();
      await run1.dispose().catch(() => {});
    }
  });

  // Mirrors the REAL failure observed in session
  // 01a12a0d-fd1b-73b3-bfb9-fe5df63db96c (vsc-office-file-viewer): the parked
  // main turn's pending/continued work was `get_subagent_result` on the parked
  // agents. The M1 shadow continuation runs WITHOUT extension tools, so every
  // such call failed with "Tool get_subagent_result not found" — the model
  // degraded to reading raw transcript files and the agents were never brought
  // back. Contract: the continued turn must be able to address its subagents.
  it("the continued main turn can call get_subagent_result on the parked agents", async () => {
    const agentDir = mkdtempSync(join(tmpdir(), "pause-resume-rt-agent-"));
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({ defaultProvider: "faux", defaultModel: "faux-1" }),
    );
    writeFileSync(
      join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          faux: {
            name: "Faux",
            api: "faux",
            // Custom models need a baseUrl even though the faux api never dials it.
            baseUrl: "http://localhost:0",
            apiKey: "faux",
            models: [{ id: "faux-1", name: "Faux 1", input: ["text"], contextWindow: 200_000, maxTokens: 16_384 }],
          },
        },
      }),
    );
    const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = agentDir;

    // Seed: parent transcript ends with an UNANSWERED get_subagent_result call
    // (the parked turn), and one parked child in the manifest.
    const parentSm = SessionManager.create(cwd, sessionDir);
    const ts = Date.now();
    parentSm.appendMessage({ role: "user", content: [{ type: "text", text: "check the agents" }], timestamp: ts } as any);
    parentSm.appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "tc-1", name: "get_subagent_result", arguments: { agent_id: "29cbb351-5190-416", wait: true } }],
      timestamp: ts,
    } as any);
    const parentFile = parentSm.getSessionFile();

    const childSm = SessionManager.create(cwd, sessionDir);
    childSm.appendMessage({ role: "user", content: [{ type: "text", text: "long child task" }], timestamp: ts } as any);
    childSm.appendMessage({ role: "assistant", content: [{ type: "text", text: "child partial answer" }], timestamp: ts } as any);
    // Parked mid-turn, like the main turn: the revive heals this unanswered
    // call and continues the child bare, which is what makes its own model
    // call happen at all.
    childSm.appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "tc-child-1", name: "read", arguments: { path: "x.ts" } }],
      timestamp: ts,
    } as any);
    const childFile = childSm.getSessionFile();
    const manifestDir = join(cwd, ".pi", "subagent-pauses");
    mkdirSync(manifestDir, { recursive: true });
    writeFileSync(
      join(manifestDir, `${parentSm.getSessionId()}.json`),
      JSON.stringify({
        version: 2,
        entries: [{
          id: "29cbb351-5190-416",
          type: "general-purpose",
          handle: "general-purpose-7",
          description: "parked child",
          sessionFile: childFile,
          pausedAt: new Date().toISOString(),
        }],
        mainTurn: {
          parked: true,
          pendingTools: 1,
          claim: { pid: 999999999, at: new Date(0).toISOString() },
          pausedAt: new Date().toISOString(),
        },
      }),
    );

    // Fresh pi on a fresh session, then the real /resume.
    const freshSm = SessionManager.create(cwd, sessionDir);
    const faux = registerFauxProvider({
      api: "faux",
      provider: "faux",
      models: [{ id: "faux-1", contextWindow: 200_000 }],
    });
    const model = faux.getModel();
    const { modelRuntime } = fauxModelBackend(model);
    // Deterministic FIFO — no session routing (the shadow session is neither
    // the parent nor a spawned child, so routeBySession would misroute it):
    // 1. shadow continuation after the heal → re-asks get_subagent_result
    //    (what the real session's model did),
    // 2. shadow turn completes,
    // 3. revived child continues bare.
    faux.setResponses([
      scriptedStep(fauxToolCall("get_subagent_result", { agent_id: "29cbb351-5190-416" }, { id: "tc-2" })),
      scriptedStep("All agents reported in."),
      scriptedStep("continued work"),
    ]);

    const createRuntime = async ({ cwd: runtimeCwd, agentDir: runtimeAgentDir, sessionManager: runtimeSm, sessionStartEvent }: any) => {
      const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
      const services = await createAgentSessionServices({
        cwd: runtimeCwd,
        agentDir: runtimeAgentDir,
        settingsManager,
        modelRuntime,
        resourceLoaderOptions: {
          additionalExtensionPaths: [EXTENSION_PATH],
          noExtensions: true,
          noSkills: true,
          noPromptTemplates: true,
          noThemes: true,
          noContextFiles: true,
        },
      });
      const created = await createAgentSessionFromServices({ services, sessionManager: runtimeSm, sessionStartEvent, model });
      await created.session.bindExtensions({
        // Interactive mode binds the real switchSession host — without it
        // ctx.switchSession is a silent no-op (runner.js:192). Forward to the
        // runtime created below (assigned before any command can run).
        commandContextActions: {
          switchSession: (sessionPath: string, opts?: unknown) =>
            (hostBox.runtime as any).switchSession(sessionPath, opts),
        },
      });
      return { ...created, services, diagnostics: [] };
    };
    const hostBox: { runtime?: unknown } = {};
    const runtime2 = await createAgentSessionRuntime(createRuntime, {
      cwd,
      agentDir: getAgentDir(),
      sessionManager: freshSm,
    });
    hostBox.runtime = runtime2;
    try {
      await runtime2.switchSession(parentFile);
      // The revival runs through the replacement activation's registry entry
      // (`continueParkedMainTurn`'s `withSession` resolves it from the global
      // manager slot), so the invalidated pre-switch runner is never touched —
      // no assertActive neutering needed (PRD §5.4).
      await runtime2.session.prompt("/continue");

      // The continuation settles (parent answers after its tool call).
      try {
        await waitFor(() => readFileSync(parentFile, "utf-8").includes("All agents reported in."), 90_000);
      } catch {
        // Disk truth: what the shadow continuation actually persisted.
        const diskLines = readFileSync(parentFile, "utf-8").split("\n");
        const diskTail = diskLines.slice(-8).map(l => {
          try {
            const e = JSON.parse(l);
            const m = e.message ?? {};
            const parts = (m.content ?? []).map((c: any) =>
              c.type === "text" ? `text:${String(c.text).slice(0, 50)}` : c.type === "toolCall" ? `call:${c.name}` : c.toolCallId ? `result:${String(c.text ?? "").slice(0, 40)}` : c.type,
            );
            return `${m.role ?? e.type}[${parts.join(" | ")}]`;
          } catch {
            return l.slice(0, 60);
          }
        });
        const manager = (globalThis as any)[Symbol.for("pi-subagents:manager")];
        writeFileSync(
          "/tmp/rt-repro-debug.txt",
          `fauxCalls: ${faux.state.callCount} pending: ${faux.getPendingResponseCount()}\n` +
            `DISK tail of ${parentFile}:\n${diskTail.join("\n---\n")}\n` +
            `mainTurn: ${JSON.stringify(new PauseStore(join(manifestDir, `${parentSm.getSessionId()}.json`)).getMainTurn())}\n` +
            `entries: ${JSON.stringify(new PauseStore(join(manifestDir, `${parentSm.getSessionId()}.json`)).list().length)}\n` +
            `child tail:\n${(existsSync(childFile) ? readFileSync(childFile, "utf-8") : "(missing)").split("\n").slice(-3).join("\n---\n").slice(0, 900)}\n` +
            `records: ${JSON.stringify((manager?.listAgents?.() ?? []).map((r: any) => ({ id: r.id, status: r.status, handle: r.handle })))}\n`,
        );
        throw new Error("REPRO: the continued main turn never completed");
      }

      const transcript = readFileSync(parentFile, "utf-8");
      // Contract: neither the healed parked call nor the model's follow-up call
      // may fail for lack of the extension's tools.
      expect(transcript).not.toContain("Tool get_subagent_result not found");
      // The parked child was revived too — the manifest cleared.
      const manifestPath = join(manifestDir, `${parentSm.getSessionId()}.json`);
      await waitFor(() => !existsSync(manifestPath) || new PauseStore(manifestPath).list().length === 0);
      // The revived child continues bare with the third scripted reply. Let it
      // settle inside the test: its completion path appends to a session file,
      // and a child still running would do that after afterEach removes the
      // temp dir (an unhandled ENOENT from the persist).
      await waitFor(() => readFileSync(childFile, "utf-8").includes("continued work"));
      const liveManager = (globalThis as any)[Symbol.for("pi-subagents:manager")];
      await waitFor(() => liveManager?.hasRunning?.() !== true);
    } finally {
      await runtime2.dispose().catch(() => {});
      if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
      rmSync(agentDir, { recursive: true, force: true });
    }
  });
});
