/**
 * per-session-config.test.ts — the active session's `cwd` owns agent discovery
 * and settings, not whatever directory pi happened to be launched from.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveType } from "../src/agent-types.js";
import subagentsExtension from "../src/index.js";
import { ctx, type Hermetic, hermeticDir, makePi } from "./helpers/boot-extension.js";

describe("per-session config discovery", () => {
  let hermetic: Hermetic | undefined;
  let other: string | undefined;

  afterEach(() => {
    hermetic?.restore();
    hermetic = undefined;
    if (other) rmSync(other, { recursive: true, force: true });
    other = undefined;
  });

  function otherProject(): string {
    const dir = mkdtempSync(join(tmpdir(), "pi-other-project-"));
    other = dir;
    mkdirSync(join(dir, ".pi", "agents"), { recursive: true });
    return dir;
  }

  it("reloads agent files from the session cwd at session start", async () => {
    hermetic = hermeticDir();
    const project = otherProject();
    writeFileSync(
      join(project, ".pi", "agents", "other.md"),
      "---\ndescription: other\ntools: read\n---\nother\n",
    );
    const { pi, lifecycle } = makePi();
    subagentsExtension(pi);

    expect(resolveType("other")).toBeUndefined();
    await lifecycle.get("session_start")?.({}, ctx({ cwd: project }));
    expect(resolveType("other")).toBe("other");
  });

  it("loads settings from the session's project at session start", async () => {
    hermetic = hermeticDir({ settings: { maxConcurrent: 3 } });
    const project = otherProject();
    writeFileSync(
      join(project, ".pi", "subagents.json"),
      JSON.stringify({ maxConcurrent: 7, graceTurns: 9 }),
    );
    const { pi, lifecycle } = makePi();
    subagentsExtension(pi);
    pi.events.emit.mockClear();

    await lifecycle.get("session_start")?.({}, ctx({ cwd: project }));

    const loaded = pi.events.emit.mock.calls.find(([event]) => event === "subagents:settings_loaded");
    expect(loaded?.[1].settings).toMatchObject({ maxConcurrent: 7, graceTurns: 9 });
  });
});
