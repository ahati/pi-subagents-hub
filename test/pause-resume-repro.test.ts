/**
 * pause-resume-repro.test.ts — REPRODUCTION for the reported failure:
 * after `/pause` → quit → pi `/resume` → `/continue`, the paused agents are
 * gone ("/resume does not bring the paused agent states") and `/continue`
 * fails with them.
 *
 * What the existing tests never cover: the REAL `/resume` sequence. pi's
 * session switch emits, in order, `session_before_switch` → `session_shutdown`
 * (for the session being left) → `session_start` with `reason: "resume"` and
 * the RESUMED session bound to a fresh extension runtime. The wiring tests
 * boot straight into the parked session with a stub id ("s1") and a
 * hand-seeded manifest — consistent by construction, so any id/cwd/state
 * breakage across the real resume chain is invisible to them.
 *
 * These tests use a REAL SessionManager for both sides (the parked session and
 * the resumed one, so session ids come from real file headers), drive the real
 * quit path (`session_shutdown` → abortAll), and then the real resume sequence
 * before `/continue`.
 *
 * Outcome: with a real parent conversation (the session file exists, so the
 * id survives `SessionManager.open`), the full resume sequence WORKS at this
 * level — the hint announces the parked agents and `/continue` revives them.
 * Kept as a regression test for the resume-event chain; see
 * pause-resume-runtime-repro.test.ts for the runtime-level investigation.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn(), resumeAgent: vi.fn() };
});

import { resumeAgent, runAgent } from "../src/agent-runner.js";
import { CompletionOutbox } from "../src/completion-outbox.js";
import subagentsExtension from "../src/index.js";
import { PauseStore, resolvePauseStorePath } from "../src/pause-store.js";
import { type BootedPi, ctx, flush, type Hermetic, hermeticDir, makePi, textOf } from "./helpers/boot-extension.js";

let hermetic: Hermetic | undefined;
let booted: Map<string, any> | undefined;
/** The parked session's real manager/file — rebuilt per test. */
let parentSm: SessionManager | undefined;
let parentFile: string | undefined;

beforeEach(() => {
  vi.mocked(runAgent).mockReset();
  vi.mocked(resumeAgent).mockReset();
  hermetic = hermeticDir({ settings: { outputTranscript: false } });
  // A REAL parent session with a REAL conversation: pi only writes the session
  // file (and its id-bearing header) once entries exist, and the user's
  // `/resume` always resumes a session that has one.
  parentSm = SessionManager.create(hermetic.dir, hermetic.dir);
  const ts = Date.now();
  parentSm.appendMessage({ role: "user", content: [{ type: "text", text: "delegate work" }], timestamp: ts } as any);
  parentSm.appendMessage({ role: "assistant", content: [{ type: "text", text: "Spawning an agent." }], timestamp: ts } as any);
  parentFile = parentSm.getSessionFile();
  if (!existsSync(parentFile)) throw new Error("fixture: parent session file was not written");
});

afterEach(async () => {
  await booted?.get("session_shutdown")?.();
  delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
  booted = undefined;
  hermetic?.restore();
  hermetic = undefined;
  parentSm = undefined;
  parentFile = undefined;
});

/** A ctx extension wrapping the real parent session manager. */
function parentCtx(overrides: Record<string, unknown> = {}) {
  return ctx({
    isIdle: () => true,
    cwd: hermetic!.dir,
    sessionManager: {
      getSessionId: () => parentSm!.getSessionId(),
      getSessionFile: () => parentSm!.getSessionFile(),
      getBranch: () => parentSm!.getBranch(),
    },
    ...overrides,
  });
}

function boot(sessionManager?: unknown) {
  const b = makePi();
  subagentsExtension(b.pi);
  booted = b.lifecycle;
  if (sessionManager !== undefined) {
    // Fire the activation the way pi does for the resumed session.
    void b.lifecycle.get("session_start")(
      { type: "session_start", reason: "startup" },
      parentCtx({ sessionManager }),
    );
  }
  return b;
}

/** A held child run reporting a REAL resumable session file with content. */
function heldRunWithRealSession(childFile: string) {
  vi.mocked(runAgent).mockImplementation(
    (_ctx: any, _type: any, _prompt: any, opts: any) =>
      new Promise(() => {
        opts.onSessionCreated?.({
          steer: vi.fn().mockResolvedValue(undefined),
          dispose: vi.fn(),
          subscribe: vi.fn(() => () => {}),
          messages: [],
          getActiveToolNames: vi.fn(() => []),
          sessionManager: { getSessionFile: () => childFile },
        });
      }) as any,
  );
}

async function spawnRunningChild(b: BootedPi, childFile: string): Promise<string> {
  heldRunWithRealSession(childFile);
  const r = await b.tools.get("Agent").execute(
    "tc-spawn",
    { prompt: "go", description: "long task", subagent_type: "Explore", run_in_background: true },
    undefined,
    undefined,
    ctx(),
  );
  await flush();
  return /Agent ID: (\S+)/.exec(textOf(r))![1];
}

/** A runAgent that settles at once, leaving a settled record with a session file. */
function finishedRunWithRealSession(
  childFile: string,
  report: string,
  outcome: { steered?: boolean; failure?: string } = {},
) {
  vi.mocked(runAgent).mockImplementationOnce((_ctx: any, _type: any, _prompt: any, opts: any) => {
    const session = {
      steer: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn(),
      subscribe: vi.fn(() => () => {}),
      messages: [],
      getActiveToolNames: vi.fn(() => []),
      sessionManager: { getSessionFile: () => childFile },
    };
    opts.onSessionCreated?.(session);
    return Promise.resolve({
      responseText: report,
      session,
      aborted: false,
      steered: outcome.steered ?? false,
      failure: outcome.failure,
    }) as any;
  });
}

/** A child session file whose last message is the assistant's final report. */
function writeFinalReportSession(childFile: string, report: string) {
  mkdirSync(join(childFile, ".."), { recursive: true });
  const lines = [
    { type: "session" },
    { type: "message", message: { role: "user", content: [{ type: "text", text: "go" }], timestamp: 1 } },
    {
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text: report }], stopReason: "stop", timestamp: 2 },
    },
  ];
  writeFileSync(childFile, lines.map(line => JSON.stringify(line)).join("\n") + "\n");
}

/** Spawn one background child that finishes at once, reporting `report`. */
async function spawnFinishedChild(
  b: BootedPi,
  childFile: string,
  report: string,
  description: string,
  outcome: { steered?: boolean; failure?: string } = {},
): Promise<string> {
  writeFinalReportSession(childFile, report);
  finishedRunWithRealSession(childFile, report, outcome);
  const r = await b.tools.get("Agent").execute(
    `tc-${description}`,
    { prompt: "go", description, subagent_type: "Explore", run_in_background: true },
    undefined,
    undefined,
    ctx(),
  );
  await flush();
  return /Agent ID: (\S+)/.exec(textOf(r))![1];
}

describe("REPRO: /pause → quit → /resume → /continue", () => {
  it("the resume-sequence session_start still sees the manifest and /continue revives the agent", async () => {
    // ---- run 1: park ----------------------------------------------------
    const b1 = boot(parentSm);
    const childFile = join(hermetic!.dir, "child-session.jsonl");
    mkdirSync(join(childFile, ".."), { recursive: true });
    writeFileSync(childFile, "");
    const id = await spawnRunningChild(b1, childFile);

    const cmdCtx = parentCtx();
    await b1.commands.get("pause").handler("", cmdCtx);
    await flush();

    const sid = parentSm!.getSessionId();
    const manifest = new PauseStore(resolvePauseStorePath(hermetic!.dir, sid));
    expect(manifest.list()).toHaveLength(1);
    expect(manifest.list()[0].id).toBe(id);

    // ---- quit: the real shutdown path ----------------------------------
    await booted?.get("session_shutdown")?.({ type: "session_shutdown" }, parentCtx());
    booted = undefined;
    // The manifest must survive quit.
    expect(new PauseStore(resolvePauseStorePath(hermetic!.dir, sid)).list()).toHaveLength(1);

    // ---- run 2: pi /resume — fresh runtime, real resume event sequence --
    const b2 = bootOnlyResumed();

    // pi's resume order: before_switch (leaving the fresh session), shutdown
    // of that fresh session, then session_start(resume) bound to the old one.
    b2.lifecycle.get("session_before_switch")?.({ type: "session_before_switch" }, parentCtx());
    await b2.lifecycle.get("session_shutdown")?.({ type: "session_shutdown" }, parentCtx());
    const resumedSm = SessionManager.open(parentFile!);
    const resumeCtx = parentCtx({ sessionManager: resumedSm });
    await b2.lifecycle.get("session_start")?.(
      { type: "session_start", reason: "resume" },
      resumeCtx,
    );
    booted = b2.lifecycle;

    // "/resume does not bring the paused agent states": the activation hint is
    // the only paused-state surface after a resume — it must announce them.
    const resumeNotifications = vi
      .mocked(resumeCtx.ui.notify)
      .mock.calls.map(c => String(c[0]))
      .join("\n");
    expect(resumeNotifications, "the resumed session must announce the parked agents").toMatch(/paused/i);

    // ---- /continue in the resumed session ------------------------------
    vi.mocked(runAgent).mockReset();
    vi.mocked(runAgent).mockImplementation(
      (_ctx: any, _type: any, _prompt: any, opts: any) =>
        new Promise(() => {
          opts.onSessionCreated?.({
            steer: vi.fn().mockResolvedValue(undefined),
            dispose: vi.fn(),
            subscribe: vi.fn(() => () => {}),
            messages: [],
            getActiveToolNames: vi.fn(() => []),
            sessionManager: { getSessionFile: () => childFile },
          });
        }) as any,
    );

    await b2.commands.get("continue").handler("", resumeCtx);
    await flush();

    // The agent was revived from its session file.
    const reviveCall = vi.mocked(runAgent).mock.calls.find(c => (c[3] as any)?.resumeSessionFile === childFile);
    expect(reviveCall, "/continue must revive the parked agent from its session file").toBeDefined();
    // ...with no continuation prompt.
    expect(JSON.stringify(reviveCall)).not.toContain("Continue from where you left off.");
    // The manifest is cleared once revived.
    expect(new PauseStore(resolvePauseStorePath(hermetic!.dir, sid)).list()).toEqual([]);
  });
});

/** A fresh extension boot WITHOUT firing session_start — the caller drives the resume sequence. */
function bootOnlyResumed(): BootedPi {
  const b = makePi();
  subagentsExtension(b.pi);
  return b;
}

describe("REPRO: quit while the park is still armed (nothing landed yet)", () => {
  // The real-world sequence this pins: /pause typed while the main model is
  // STREAMING arms the park; the user quits before the turn's boundary lands.
  // Arming is in-memory only, so today the shutdown persists NOTHING — the
  // manifest is never written — and after /resume both the hint and /continue
  // find an empty store: "/resume does not bring the paused agent states".
  // The fix (docs/pause-quit-resume-continue.md §4.1 FR-P8): session_shutdown lands the armed park
  // best-effort BEFORE abortAll — subagent entries + mainTurn (pendingTools
  // counted from the transcript tail's unanswered tool calls) — so the
  // cross-restart flow still works.

  function seedParentWithPendingToolCall(): void {
    // The main turn is mid-flight: its last assistant message carries a tool
    // call that never answered (the model was still streaming).
    const ts = Date.now();
    parentSm!.appendMessage({ role: "user", content: [{ type: "text", text: "do work" }], timestamp: ts } as any);
    parentSm!.appendMessage({
      role: "assistant",
      content: [{ type: "toolCall", id: "tc-pending", name: "read", arguments: { path: "x.ts" } }],
      timestamp: ts,
    } as any);
  }

  it("quitting while armed persists the park: entries + mainTurn survive the shutdown", async () => {
    const b1 = boot(parentSm);
    const childFile = join(hermetic!.dir, "child-session.jsonl");
    mkdirSync(join(childFile, ".."), { recursive: true });
    writeFileSync(childFile, "");
    seedParentWithPendingToolCall();
    const id = await spawnRunningChild(b1, childFile);

    // /pause while the main model streams → ARMED (nothing written yet).
    const armCtx = parentCtx({ isIdle: () => false });
    await b1.commands.get("pause").handler("", armCtx);
    await flush();
    const sid = parentSm!.getSessionId();
    expect(new PauseStore(resolvePauseStorePath(hermetic!.dir, sid)).list()).toEqual([]);

    // Quit BEFORE the boundary lands: shutdown must land the armed park
    // best-effort — the subagent entry and the parked main turn both written.
    await booted?.get("session_shutdown")?.({ type: "session_shutdown" }, parentCtx());
    booted = undefined;

    const manifest = new PauseStore(resolvePauseStorePath(hermetic!.dir, sid));
    const entries = manifest.list();
    expect(entries, "the parked subagent must survive the quit").toHaveLength(1);
    expect(entries[0].id).toBe(id);
    const mainTurn = manifest.getMainTurn();
    expect(mainTurn?.parked, "the parked main turn must survive the quit").toBe(true);
    expect(mainTurn?.pendingTools).toBe(1);
  });

  it("after that quit, /resume + /continue restores everything: heal + revive, no prompt", async () => {
    // Same broken sequence, then the resume and the /continue.
    const b1 = boot(parentSm);
    const childFile = join(hermetic!.dir, "child-session.jsonl");
    mkdirSync(join(childFile, ".."), { recursive: true });
    writeFileSync(childFile, "");
    seedParentWithPendingToolCall();
    const id = await spawnRunningChild(b1, childFile);
    const armCtx = parentCtx({ isIdle: () => false });
    await b1.commands.get("pause").handler("", armCtx);
    await flush();
    await booted?.get("session_shutdown")?.({ type: "session_shutdown" }, parentCtx());
    booted = undefined;

    // /resume: fresh runtime, the real resume event sequence, the resumed
    // session bound (its file carries the unanswered tool call).
    const b2 = bootOnlyResumed();
    b2.lifecycle.get("session_before_switch")?.({ type: "session_before_switch" }, parentCtx());
    await b2.lifecycle.get("session_shutdown")?.({ type: "session_shutdown" }, parentCtx());
    const resumedSm = SessionManager.open(parentFile!);
    const resumeCtx = parentCtx({
      sessionManager: resumedSm,
      // pi's switchSession runs the callback against the replacement session.
      switchSession: vi.fn(async (_file: string, arg?: unknown) => {
        const callback =
          typeof arg === "function"
            ? (arg as () => Promise<void> | void)
            : (arg as { withSession?: () => Promise<void> | void } | undefined)?.withSession;
        await callback?.();
      }),
    });
    await b2.lifecycle.get("session_start")?.({ type: "session_start", reason: "resume" }, resumeCtx);
    booted = b2.lifecycle;

    // The child the revival will reopen.
    vi.mocked(runAgent).mockReset();
    vi.mocked(runAgent).mockImplementation(
      (_ctx: any, _type: any, _prompt: any, opts: any) =>
        new Promise(() => {
          opts.onSessionCreated?.({
            steer: vi.fn().mockResolvedValue(undefined),
            dispose: vi.fn(),
            subscribe: vi.fn(() => () => {}),
            messages: [],
            getActiveToolNames: vi.fn(() => []),
            sessionManager: { getSessionFile: () => childFile },
          });
        }) as any,
    );

    await b2.commands.get("continue").handler("", resumeCtx);
    await flush();

    const sid = parentSm!.getSessionId();
    const manifest = new PauseStore(resolvePauseStorePath(hermetic!.dir, sid));

    // The main turn was continued: its pending tool call was healed in place —
    // an honest result appended to the transcript, never a prompt.
    const branch = resumedSm.getBranch().map((e: any) => e.message);
    const healed = branch.some(m => m?.role === "toolResult" && m.toolCallId === "tc-pending");
    expect(healed, "the pending tool call must be healed in the resumed transcript").toBe(true);
    expect(manifest.getMainTurn(), "mainTurn must be cleared once continued").toBeUndefined();

    // The subagent was revived from its session file, with no prompt.
    const reviveCall = vi.mocked(runAgent).mock.calls.find(c => (c[3] as any)?.resumeSessionFile === childFile);
    expect(reviveCall, "/continue must revive the parked agent from its session file").toBeDefined();
    expect(JSON.stringify(reviveCall)).not.toContain("Continue from where you left off.");
    expect(manifest.list()).toEqual([]);
    void id;
  });
});

/**
 * The remaining field gap (real session 01a12ae5): children FINISHED their
 * reports BEFORE `/pause` and nothing was parked for them, so quit + `/resume`
 * + `/continue` said "Nothing paused in this session." and the reports stayed
 * orphaned in the children's session files. `/pause` must capture settled,
 * unconsumed results into the manifest, and `/continue` must deliver them —
 * in the same process or after a restart — instead of reviving a finished run.
 */
describe("REPRO: completed-but-unconsumed results are captured by /pause and delivered by /continue", () => {
  const manager = () => (globalThis as any)[Symbol.for("pi-subagents:manager")];
  const manifest = () => new PauseStore(resolvePauseStorePath(hermetic!.dir, parentSm!.getSessionId()));

  it("/pause captures completed, unconsumed agents into the manifest without delivering them", async () => {
    const b = boot(parentSm);
    const idA = await spawnFinishedChild(b, join(hermetic!.dir, "child-a.jsonl"), "report A", "task A");
    const idB = await spawnFinishedChild(b, join(hermetic!.dir, "child-b.jsonl"), "report B", "task B");
    expect(manager().getRecord(idA).status).toBe("completed");
    expect(manager().getRecord(idA).resultConsumed).not.toBe(true);

    const sendsBefore = vi.mocked(b.pi.sendMessage).mock.calls.length;
    await b.commands.get("pause").handler("", parentCtx());
    await flush();

    const entries = manifest().list();
    expect(entries.map(e => e.id).sort()).toEqual([idA, idB].sort());
    expect(entries.every(e => typeof e.sessionFile === "string")).toBe(true);
    // Capture only parks the rows: /pause itself delivers nothing.
    const sends = vi.mocked(b.pi.sendMessage).mock.calls.slice(sendsBefore)
      .filter(c => (c[0] as any)?.customType === "subagent-notification");
    expect(sends).toEqual([]);
  });

  it("/pause cancels the pending completion notification for each captured result", async () => {
    const b = boot(parentSm);
    const idA = await spawnFinishedChild(b, join(hermetic!.dir, "child-a.jsonl"), "report A", "task A");
    const idB = await spawnFinishedChild(b, join(hermetic!.dir, "child-b.jsonl"), "report B", "task B");
    const cancel = vi.spyOn(CompletionOutbox.prototype, "cancel");

    await b.commands.get("pause").handler("", parentCtx());
    await flush();
    const cancelled = cancel.mock.calls.map(c => c[0]);
    cancel.mockRestore();

    expect(cancelled).toEqual(expect.arrayContaining([idA, idB]));
  });

  it("/continue delivers the captured reports, clears the manifest, and revives nothing", async () => {
    const b = boot(parentSm);
    const idA = await spawnFinishedChild(b, join(hermetic!.dir, "child-a.jsonl"), "report A", "task A");
    const idB = await spawnFinishedChild(b, join(hermetic!.dir, "child-b.jsonl"), "report B", "task B");
    await b.commands.get("pause").handler("", parentCtx());
    await flush();
    expect(manifest().list()).toHaveLength(2);

    vi.mocked(b.pi.sendMessage).mockClear();
    vi.mocked(runAgent).mockClear();
    const cmdCtx = parentCtx();
    await b.commands.get("continue").handler("", cmdCtx);
    await flush();

    const sends = vi.mocked(b.pi.sendMessage).mock.calls
      .filter(c => (c[0] as any)?.customType === "subagent-notification");
    expect(sends).toHaveLength(2);
    const contents = sends.map(c => String((c[0] as any).content)).join("\n");
    expect(contents).toContain("report A");
    expect(contents).toContain("report B");
    for (const send of sends) {
      expect(send[1]).toMatchObject({ deliverAs: "followUp", triggerTurn: true });
    }
    // A settled result is delivered, never revived.
    expect(vi.mocked(runAgent)).not.toHaveBeenCalled();
    expect(manifest().list()).toEqual([]);
    expect(cmdCtx.ui.notify).toHaveBeenCalledWith("Delivered 2 captured agent results.", "info");
    void idA;
    void idB;
  });

  it("does not capture results that were already consumed", async () => {
    const b = boot(parentSm);
    const idA = await spawnFinishedChild(b, join(hermetic!.dir, "child-a.jsonl"), "report A", "task A");
    const idB = await spawnFinishedChild(b, join(hermetic!.dir, "child-b.jsonl"), "report B", "task B");
    // The RPC/get_subagent_result consumption path marks the record — the
    // result is already on its way to a caller, so /pause must not re-park it.
    manager().getRecord(idA).resultConsumed = true;

    await b.commands.get("pause").handler("", parentCtx());
    await flush();

    expect(manifest().list().map(e => e.id)).toEqual([idB]);
  });

  it("delivers captured reports after quit + /resume, reading them from the session files", async () => {
    // ---- run 1: capture, then quit --------------------------------------
    const b1 = boot(parentSm);
    const idA = await spawnFinishedChild(b1, join(hermetic!.dir, "child-a.jsonl"), "report A", "task A");
    const idB = await spawnFinishedChild(b1, join(hermetic!.dir, "child-b.jsonl"), "report B", "task B");
    await b1.commands.get("pause").handler("", parentCtx());
    await flush();
    const sid = parentSm!.getSessionId();
    expect(new PauseStore(resolvePauseStorePath(hermetic!.dir, sid)).list()).toHaveLength(2);

    // The real quit path: abortAll + dispose. The manifest survives.
    await booted?.get("session_shutdown")?.({ type: "session_shutdown" }, parentCtx());
    booted = undefined;
    expect(new PauseStore(resolvePauseStorePath(hermetic!.dir, sid)).list()).toHaveLength(2);

    // ---- run 2: pi /resume into a fresh runtime -------------------------
    const b2 = bootOnlyResumed();
    b2.lifecycle.get("session_before_switch")?.({ type: "session_before_switch" }, parentCtx());
    await b2.lifecycle.get("session_shutdown")?.({ type: "session_shutdown" }, parentCtx());
    const resumedSm = SessionManager.open(parentFile!);
    const resumeCtx = parentCtx({ sessionManager: resumedSm });
    await b2.lifecycle.get("session_start")?.({ type: "session_start", reason: "resume" }, resumeCtx);
    booted = b2.lifecycle;

    vi.mocked(runAgent).mockClear();
    await b2.commands.get("continue").handler("", resumeCtx);
    await flush();

    const sends = vi.mocked(b2.pi.sendMessage).mock.calls
      .filter(c => (c[0] as any)?.customType === "subagent-notification");
    expect(sends).toHaveLength(2);
    const contents = sends.map(c => String((c[0] as any).content)).join("\n");
    expect(contents).toContain("report A");
    expect(contents).toContain("report B");
    // The finished conversations must not be reopened as fresh no-op runs.
    expect(vi.mocked(runAgent)).not.toHaveBeenCalled();
    expect(new PauseStore(resolvePauseStorePath(hermetic!.dir, sid)).list()).toEqual([]);
    void idA;
    void idB;
  });
});

describe("REPRO: captured rows carry the status their run settled with", () => {
  const manifest = () => new PauseStore(resolvePauseStorePath(hermetic!.dir, parentSm!.getSessionId()));

  it("captures each settled agent's real status onto its manifest row", async () => {
    const b = boot(parentSm);
    const idDone = await spawnFinishedChild(b, join(hermetic!.dir, "child-done.jsonl"), "report A", "task A");
    const idSteered = await spawnFinishedChild(b, join(hermetic!.dir, "child-steered.jsonl"), "report B", "task B", {
      steered: true,
    });
    const idError = await spawnFinishedChild(b, join(hermetic!.dir, "child-error.jsonl"), "report C", "task C", {
      failure: "provider exploded",
    });

    await b.commands.get("pause").handler("", parentCtx());
    await flush();

    const byId = new Map(manifest().list().map(e => [e.id, e]));
    expect(byId.get(idDone)!.status).toBe("completed");
    expect(byId.get(idSteered)!.status).toBe("steered");
    expect(byId.get(idError)!.status).toBe("error");
    // Only the errored row carries a failure text — a resumed-then-completed
    // record can still hold a stale `error`, and it must not leak into the row.
    expect(byId.get(idError)!.error).toBe("provider exploded");
    expect(byId.get(idDone)!.error).toBeUndefined();
    expect(byId.get(idSteered)!.error).toBeUndefined();
    expect(byId.get(idError)!.pausedAt).toBeTruthy();
  });

  it("delivers a captured errored result across quit and /resume with its real status", async () => {
    // ---- run 1: the run errors, its report is captured, then quit --------
    const b1 = boot(parentSm);
    const childFile = join(hermetic!.dir, "child-err.jsonl");
    await spawnFinishedChild(b1, childFile, "partial report", "task E", { failure: "provider exploded" });
    await b1.commands.get("pause").handler("", parentCtx());
    await flush();
    const sid = parentSm!.getSessionId();
    expect(manifest().list()[0].status).toBe("error");
    expect(manifest().list()[0].error).toBe("provider exploded");

    await booted?.get("session_shutdown")?.({ type: "session_shutdown" }, parentCtx());
    booted = undefined;

    // ---- run 2: pi /resume, then /continue ------------------------------
    const b2 = bootOnlyResumed();
    b2.lifecycle.get("session_before_switch")?.({ type: "session_before_switch" }, parentCtx());
    await b2.lifecycle.get("session_shutdown")?.({ type: "session_shutdown" }, parentCtx());
    const resumeCtx = parentCtx({ sessionManager: SessionManager.open(parentFile!) });
    await b2.lifecycle.get("session_start")?.({ type: "session_start", reason: "resume" }, resumeCtx);
    booted = b2.lifecycle;

    vi.mocked(b2.pi.sendMessage).mockClear();
    vi.mocked(runAgent).mockClear();
    await b2.commands.get("continue").handler("", resumeCtx);
    await flush();

    const sends = vi.mocked(b2.pi.sendMessage).mock.calls
      .filter(c => (c[0] as any)?.customType === "subagent-notification");
    expect(sends).toHaveLength(1);
    const sent = sends[0][0] as any;
    expect(String(sent.content)).toContain("<status>Error: provider exploded</status>");
    expect(String(sent.content)).toContain("<result>partial report</result>");
    expect(sent.details.status).toBe("error");
    // A settled result is delivered, never revived.
    expect(vi.mocked(runAgent)).not.toHaveBeenCalled();
    expect(new PauseStore(resolvePauseStorePath(hermetic!.dir, sid)).list()).toEqual([]);
  });
});
