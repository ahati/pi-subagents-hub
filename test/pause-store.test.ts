/**
 * pause-store.test.ts — manifest v3: the paused-agent rows, the parked
 * main-turn record (`mainTurn`) and the parked workflow runs (`workflows`),
 * plus the cwd-independent manifest lookup.
 *
 * Pure fs: every test gets its own temp dir, no extension, no process.cwd
 * games. The suites below pin the v3 surface: version 3 on disk, the parked
 * workflow rows preserved across rewrites, and a v1/v2 file still readable.
 *
 * Pinned contract (from docs/pause-quit-resume-continue.md §5.2):
 *   - PauseStoreData { version: 3, entries, mainTurn?, workflows? }
 *   - store.getMainTurn() / store.setMainTurn(turn | undefined)
 *   - replace(entries) never deletes a present mainTurn; replace([]) still
 *     clears a file that has only entries.
 *   - resolvePauseManifestPath(cwd, sessionId) — the fallback lookup helper
 *     (adapt the name if the implementation lands on `findPauseStore`; the
 *     test binds whichever exists, in that order).
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import * as pauseStoreModule from "../src/pause-store.js";
import { type PausedAgentEntry, PauseStore } from "../src/pause-store.js";

/**
 * Namespace access, not named imports: a missing v2 export must fail the test
 * that needs it with a readable message instead of failing the whole file at
 * module-load time.
 */
const storeModule = pauseStoreModule as any;

/** A v2 main-turn row. */
function mainTurn(overrides: Record<string, unknown> = {}) {
  return {
    parked: true,
    pendingTools: 1,
    claim: { pid: process.pid, at: "2026-01-01T00:00:00.000Z" },
    pausedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

/** An entry row; `sessionFile` need not exist for store-level tests. */
function entry(overrides: Partial<PausedAgentEntry> = {}): PausedAgentEntry {
  return {
    id: "agent-1",
    type: "Explore",
    handle: "explore",
    description: "find flaky tests",
    sessionFile: "/tmp/agent-session.jsonl",
    pausedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

let dir: string | undefined;

function tempDir(): string {
  dir = mkdtempSync(join(tmpdir(), "pi-pause-store-"));
  return dir;
}

afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

/** The v2 lookup helper: preferred export first, the originally proposed
 * `findPauseStore` name as a fallback. */
function resolveManifestPath(cwd: string, sessionId: string): string {
  const fn = storeModule.resolvePauseManifestPath ?? storeModule.findPauseStore;
  expect(
    fn,
    "the cwd-independent manifest lookup (resolvePauseManifestPath) is not exported",
  ).toBeTypeOf("function");
  return fn(cwd, sessionId);
}

describe("PauseStore mainTurn (v2)", () => {
  it("reports no main turn for a manifest that was never written", () => {
    const file = join(tempDir(), "missing.json");
    expect(new PauseStore(file).getMainTurn()).toBeUndefined();
  });

  it("round-trips a main turn and writes version 3", () => {
    const file = join(tempDir(), "manifest.json");
    const store = new PauseStore(file);
    const turn = mainTurn({ pendingTools: 3 });

    store.setMainTurn(turn);

    expect(store.getMainTurn()).toEqual(turn);
    const onDisk = JSON.parse(readFileSync(file, "utf-8"));
    expect(onDisk.version).toBe(3);
    expect(onDisk.mainTurn).toEqual(turn);
    expect(onDisk.entries).toEqual([]);
  });

  it("preserves the cancelled flag and the claim when set", () => {
    const file = join(tempDir(), "manifest.json");
    const store = new PauseStore(file);
    const turn = mainTurn({ cancelled: true, pendingTools: 0 });

    store.setMainTurn(turn);

    expect(store.getMainTurn()).toEqual(turn);
    expect(store.getMainTurn()!.cancelled).toBe(true);
  });

  it("setMainTurn keeps the entry rows written by replace()", () => {
    const file = join(tempDir(), "manifest.json");
    const store = new PauseStore(file);
    const rows = [entry(), entry({ id: "agent-2", handle: "explore-2" })];

    store.replace(rows);
    store.setMainTurn(mainTurn());

    expect(store.list()).toEqual(rows);
    expect(store.getMainTurn()).toEqual(mainTurn());
  });

  it("replace(entries) preserves a main turn that is already on disk", () => {
    const file = join(tempDir(), "manifest.json");
    const store = new PauseStore(file);

    store.setMainTurn(mainTurn({ pendingTools: 2 }));
    store.replace([entry({ id: "agent-9" })]);

    expect(store.list()).toEqual([entry({ id: "agent-9" })]);
    expect(store.getMainTurn()).toEqual(mainTurn({ pendingTools: 2 }));
  });

  it("replace([]) keeps the file and the main turn", () => {
    const file = join(tempDir(), "manifest.json");
    const store = new PauseStore(file);

    store.setMainTurn(mainTurn());
    store.replace([]);

    expect(existsSync(file)).toBe(true);
    expect(store.getMainTurn()).toEqual(mainTurn());
    expect(store.list()).toEqual([]);
  });

  it("replace([]) still clears a file that has no main turn", () => {
    const file = join(tempDir(), "manifest.json");
    const store = new PauseStore(file);

    store.replace([entry()]);
    store.replace([]);

    expect(existsSync(file)).toBe(false);
    // Merging with the mainTurn path must not change the v1 clearing rule.
    expect(store.getMainTurn()).toBeUndefined();
  });

  it("setMainTurn(undefined) clears the main turn and removes an entry-less file", () => {
    const file = join(tempDir(), "manifest.json");
    const store = new PauseStore(file);

    store.setMainTurn(mainTurn());
    store.setMainTurn(undefined);

    expect(store.getMainTurn()).toBeUndefined();
    expect(existsSync(file)).toBe(false);
  });

  it("setMainTurn(undefined) leaves the entry rows in place", () => {
    const file = join(tempDir(), "manifest.json");
    const store = new PauseStore(file);

    store.replace([entry()]);
    store.setMainTurn(mainTurn());
    store.setMainTurn(undefined);

    expect(store.getMainTurn()).toBeUndefined();
    expect(store.list()).toEqual([entry()]);
  });

  it("ignores a corrupt manifest instead of throwing", () => {
    const file = join(tempDir(), "manifest.json");
    writeFileSync(file, "{ not json");

    const store = new PauseStore(file);
    expect(store.list()).toEqual([]);
    expect(store.getMainTurn()).toBeUndefined();
  });
});

describe("PauseStore respawn rows (v3)", () => {
  it("round-trips a respawn row with no session file", () => {
    const file = join(tempDir(), "manifest.json");
    const store = new PauseStore(file);
    const row: PausedAgentEntry = {
      id: "agent-e",
      type: "Explore",
      handle: "explore",
      alias: "auth-audit",
      description: "find flaky tests",
      respawn: { prompt: "go", model: "anthropic/claude-haiku-4.5", thinking: "low", maxTurns: 12 },
      pausedAt: "2026-01-01T00:00:00.000Z",
    };

    store.replace([row]);

    expect(store.list()).toEqual([row]);
    const onDisk = JSON.parse(readFileSync(file, "utf-8"));
    expect(onDisk.version).toBe(3);
    expect(onDisk.entries[0].sessionFile).toBeUndefined();
    expect(onDisk.entries[0].respawn.prompt).toBe("go");
  });

  it("round-trips a session-backed row with no respawn", () => {
    const file = join(tempDir(), "manifest.json");
    const store = new PauseStore(file);
    const row = entry();

    store.replace([row]);

    expect(store.list()).toEqual([row]);
    expect(store.list()[0].respawn).toBeUndefined();
  });

  it("loads a hand-written v2 manifest and rewrites it as v3", () => {
    const file = join(tempDir(), "manifest.json");
    const row = entry();
    writeFileSync(file, JSON.stringify({ version: 2, entries: [row] }));
    const store = new PauseStore(file);

    expect(store.list()).toEqual([row]);

    store.replace([row]);
    expect(JSON.parse(readFileSync(file, "utf-8")).version).toBe(3);
  });

  it("replace([]) clears a file holding only a respawn row", () => {
    const file = join(tempDir(), "manifest.json");
    const store = new PauseStore(file);

    store.replace([{ id: "agent-e", type: "Explore", description: "d", respawn: { prompt: "go" }, pausedAt: "t" }]);
    expect(existsSync(file)).toBe(true);

    store.replace([]);
    expect(existsSync(file)).toBe(false);
  });
});

describe("captured result status (additive v3)", () => {
  it("round-trips a captured row's status and error", () => {
    const file = join(tempDir(), "manifest.json");
    const store = new PauseStore(file);
    const row = entry({ status: "error", error: "provider exploded" });

    store.replace([row]);

    expect(store.list()).toEqual([row]);
    // Additive within v3: no version bump for the new fields.
    const onDisk = JSON.parse(readFileSync(file, "utf8"));
    expect(onDisk.version).toBe(3);
    expect(onDisk.entries[0].status).toBe("error");
    expect(onDisk.entries[0].error).toBe("provider exploded");
  });

  it("reads a pre-status manifest row without inventing a status", () => {
    const file = join(tempDir(), "manifest.json");
    const legacy = {
      id: "agent-legacy",
      type: "Explore",
      description: "old row",
      sessionFile: "/tmp/legacy.jsonl",
      pausedAt: "2026-01-01T00:00:00.000Z",
    };
    writeFileSync(file, JSON.stringify({ version: 2, entries: [legacy] }));
    const store = new PauseStore(file);

    expect(store.list()[0].status).toBeUndefined();

    store.replace(store.list());
    const onDisk = JSON.parse(readFileSync(file, "utf8"));
    expect(onDisk.version).toBe(3);
    expect("status" in onDisk.entries[0]).toBe(false);
    expect("error" in onDisk.entries[0]).toBe(false);
  });

  it("keeps status and error out of a parked run's row", () => {
    const file = join(tempDir(), "manifest.json");
    const store = new PauseStore(file);

    store.replace([entry()]);

    const onDisk = JSON.parse(readFileSync(file, "utf8"));
    expect("status" in onDisk.entries[0]).toBe(false);
    expect("error" in onDisk.entries[0]).toBe(false);
  });
});

/** The sweep helper: a missing export must fail the test, not the file. */
function sweep(dir: string, sessionExists: (id: string) => boolean): string[] {
  const fn = storeModule.sweepOrphanPauseManifests;
  expect(
    fn,
    "sweepOrphanPauseManifests is not exported from pause-store.ts",
  ).toBeTypeOf("function");
  return fn(dir, sessionExists);
}

describe("sweepOrphanPauseManifests", () => {
  /** A manifest dir under the temp dir, as `pauseStoreDir(cwd)` computes it. */
  function pauseDir(root = tempDir()): string {
    return join(root, ".pi", "subagent-pauses");
  }

  it("deletes manifests whose owning session is gone and keeps live ones", () => {
    const dir = pauseDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "live.json"), JSON.stringify({ version: 2, entries: [] }));
    writeFileSync(join(dir, "dead.json"), JSON.stringify({ version: 2, entries: [] }));

    const removed = sweep(dir, id => id === "live");

    expect(removed).toEqual(["dead"]);
    expect(existsSync(join(dir, "live.json"))).toBe(true);
    expect(existsSync(join(dir, "dead.json"))).toBe(false);
  });

  it("returns [] when the manifest directory does not exist", () => {
    const dir = pauseDir();
    expect(sweep(dir, () => false)).toEqual([]);
  });

  it("ignores .json.tmp snapshots, non-.json names and a bare .json", () => {
    const dir = pauseDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "dead.json.tmp"), "{}");
    writeFileSync(join(dir, "notes.txt"), "hi");
    writeFileSync(join(dir, ".json"), "{}");
    writeFileSync(join(dir, "dead.json"), "{}");

    const removed = sweep(dir, () => false);

    expect(removed).toEqual(["dead"]);
    expect(existsSync(join(dir, "dead.json.tmp"))).toBe(true);
    expect(existsSync(join(dir, "notes.txt"))).toBe(true);
    expect(existsSync(join(dir, ".json"))).toBe(true);
  });

  it("does not throw when an entry named <id>.json is a directory", () => {
    const dir = pauseDir();
    mkdirSync(join(dir, "adir.json"), { recursive: true });
    writeFileSync(join(dir, "dead.json"), "{}");

    expect(sweep(dir, () => false)).toEqual(["dead"]);
    expect(existsSync(join(dir, "adir.json"))).toBe(true);
  });

  it("deletes a corrupt manifest whose session is gone", () => {
    const dir = pauseDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "dead.json"), "{ not json");

    expect(sweep(dir, () => false)).toEqual(["dead"]);
    expect(existsSync(join(dir, "dead.json"))).toBe(false);
  });

  it("pauseStoreDir names the canonical manifest directory", () => {
    const root = tempDir();
    expect(storeModule.pauseStoreDir(root)).toBe(join(root, ".pi", "subagent-pauses"));
    expect(storeModule.resolvePauseStorePath(root, "s1")).toBe(
      join(storeModule.pauseStoreDir(root), "s1.json"),
    );

  });
});

describe("resolvePauseManifestPath fallback", () => {
  it("returns the canonical path for a session with no manifest yet", () => {
    const dir = tempDir();
    const resolved = resolveManifestPath(dir, "s1");
    expect(resolved).toBe(join(dir, ".pi", "subagent-pauses", "s1.json"));
  });

  it("finds a manifest written under a different (parent) cwd", () => {
    // What the restart flow hits: the session header recorded the workspace
    // root as cwd, but the live ctx.cwd is a subdirectory.
    const root = tempDir();
    const file = join(root, ".pi", "subagent-pauses", "s1.json");
    mkdirSync(join(root, ".pi", "subagent-pauses"), { recursive: true });
    writeFileSync(file, JSON.stringify({ version: 2, entries: [] }));

    const nested = join(root, "packages", "app");
    mkdirSync(nested, { recursive: true });

    const resolved = resolveManifestPath(nested, "s1");
    expect(resolved).toBe(file);
    expect(existsSync(resolved)).toBe(true);
  });

  it("falls back to the canonical path when nothing is found anywhere", () => {
    const dir = tempDir();
    const resolved = resolveManifestPath(dir, "nope");
    expect(typeof resolved).toBe("string");
    expect(existsSync(resolved)).toBe(false);
  });
});

/** A v3 parked-workflow row. */
function workflowRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "wf_abc123",
    journalPath: "/tmp/journal.jsonl",
    script: "export const meta = { name: 'x' };\nreturn 1;",
    args: { topic: "t" },
    toolCallId: "tool-1",
    pausedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("PauseStore workflows (v3)", () => {
  it("round-trips a workflow row and writes version 3", () => {
    const file = join(tempDir(), "manifest.json");
    const store = new PauseStore(file);
    const row = workflowRow();

    store.replaceWorkflows([row]);

    expect(store.listWorkflows()).toEqual([row]);
    const onDisk = JSON.parse(readFileSync(file, "utf-8"));
    expect(onDisk.version).toBe(3);
    expect(onDisk.workflows).toEqual([row]);
    expect(onDisk.entries).toEqual([]);
  });

  it("replace(entries) preserves parked workflow rows already on disk", () => {
    const file = join(tempDir(), "manifest.json");
    const store = new PauseStore(file);
    store.replaceWorkflows([workflowRow()]);

    store.replace([entry({ id: "agent-2" })]);

    expect(store.list()).toEqual([entry({ id: "agent-2" })]);
    expect(store.listWorkflows()).toEqual([workflowRow()]);
  });

  it("replaceWorkflows(rows) preserves entries and the main turn", () => {
    const file = join(tempDir(), "manifest.json");
    const store = new PauseStore(file);
    const turn = mainTurn();
    store.replace([entry()]);
    store.setMainTurn(turn);

    store.replaceWorkflows([workflowRow()]);

    expect(store.list()).toEqual([entry()]);
    expect(store.getMainTurn()).toEqual(turn);
    expect(store.listWorkflows()).toEqual([workflowRow()]);
  });

  it("replace([]) with only workflow rows keeps the file", () => {
    const file = join(tempDir(), "manifest.json");
    const store = new PauseStore(file);
    store.replaceWorkflows([workflowRow()]);

    store.replace([]);

    expect(existsSync(file)).toBe(true);
    expect(store.listWorkflows()).toEqual([workflowRow()]);
  });

  it("clears only when entries, workflows and mainTurn are all empty", () => {
    const file = join(tempDir(), "manifest.json");
    const store = new PauseStore(file);
    store.replaceWorkflows([workflowRow()]);
    store.replaceWorkflows([]);
    expect(existsSync(file)).toBe(false);
  });

  it("setMainTurn(undefined) keeps workflow rows", () => {
    const file = join(tempDir(), "manifest.json");
    const store = new PauseStore(file);
    store.replaceWorkflows([workflowRow()]);
    store.setMainTurn(mainTurn());

    store.setMainTurn(undefined);

    expect(existsSync(file)).toBe(true);
    expect(store.listWorkflows()).toEqual([workflowRow()]);
  });

  it("reads a v2 file (no workflows) as none, and ignores a non-array", () => {
    const dir = tempDir();
    const v2 = join(dir, "v2.json");
    writeFileSync(v2, JSON.stringify({ version: 2, entries: [entry()] }));
    expect(new PauseStore(v2).listWorkflows()).toEqual([]);

    const bogus = join(dir, "bogus.json");
    writeFileSync(bogus, JSON.stringify({ version: 3, entries: [], workflows: "nope" }));
    expect(new PauseStore(bogus).listWorkflows()).toEqual([]);
  });

  it("replaceBoth sets both agent entries and workflow rows atomically", () => {
    const file = join(tempDir(), "manifest.json");
    const store = new PauseStore(file);
    const agentRow = entry({ id: "agent-both" });
    const wfRow = workflowRow({ id: "wf-both" });

    store.replaceBoth([agentRow], [wfRow]);

    expect(store.list()).toEqual([agentRow]);
    expect(store.listWorkflows()).toEqual([wfRow]);
    const onDisk = JSON.parse(readFileSync(file, "utf-8"));
    expect(onDisk.version).toBe(3);
    expect(onDisk.entries).toEqual([agentRow]);
    expect(onDisk.workflows).toEqual([wfRow]);
  });

  it("replaceBoth clears the file when entries and workflows are empty and no mainTurn", () => {
    const file = join(tempDir(), "manifest.json");
    const store = new PauseStore(file);
    store.replaceBoth([entry()], [workflowRow()]);
    expect(existsSync(file)).toBe(true);

    store.replaceBoth([], []);
    expect(existsSync(file)).toBe(false);
  });
});
