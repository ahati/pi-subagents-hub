import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  describeGateSetting,
  gateAdmitsAnything,
  NUMERIC_SETTINGS_IDS,
  SETTINGS_DESCRIPTORS,
  SETTINGS_DESCRIPTORS_BY_ID,
  type SettingsMenuDeps,
} from "../src/commands/settings-descriptors.js";
import { setPackageAgentsGate } from "../src/package-resources.js";

function makeMockDeps(): SettingsMenuDeps {
  return {
    pi: { events: { emit: vi.fn() } } as any,
    manager: {
      getMaxConcurrent: vi.fn(() => 5),
      setMaxConcurrent: vi.fn(),
      getMaxConcurrentForeground: vi.fn(() => 0),
      setMaxConcurrentForeground: vi.fn(),
      getMaxConcurrentNested: vi.fn(() => 10),
      setMaxConcurrentNested: vi.fn(),
    } as any,
    widget: {} as any,
    fleet: {} as any,
    scheduler: { stop: vi.fn() } as any,
    reloadCustomAgents: vi.fn(),
    getStrictAgentFiles: vi.fn(() => false),
    setStrictAgentFiles: vi.fn(),
    isWorkflowsEnabled: vi.fn(() => true),
    isWorkflowsPinned: vi.fn(() => false),
    setWorkflowsEnabled: vi.fn(),
    isReportUsageEnabled: vi.fn(() => false),
    setReportUsage: vi.fn(),
    isShowCostEnabled: vi.fn(() => false),
    setShowCost: vi.fn(),
    isShowModelEnabled: vi.fn(() => false),
    setShowModel: vi.fn(),
    getUIStyle: vi.fn(() => "pi"),
    setUIStyle: vi.fn(),
    getHubBackground: vi.fn(() => "blue"),
    setHubBackground: vi.fn(),
    getViewerStyle: vi.fn(() => "chat"),
    setViewerStyle: vi.fn(),
    isFleetViewEnabled: vi.fn(() => true),
    setFleetViewEnabled: vi.fn(),
    getAgentMentionMode: vi.fn(() => "model"),
    setAgentMentionMode: vi.fn(),
    getDefaultJoinMode: vi.fn(() => "smart"),
    setDefaultJoinMode: vi.fn(),
    getBackgroundByDefault: vi.fn(() => true),
    setBackgroundByDefault: vi.fn(),
    isSchedulingEnabled: vi.fn(() => true),
    setSchedulingEnabled: vi.fn(),
    setDisableDefaultAgents: vi.fn(),
    getToolDescriptionMode: vi.fn(() => "full"),
    getWorkflowReference: vi.fn(() => "inline"),
    setWorkflowReference: vi.fn(),
    setToolDescriptionMode: vi.fn(),
    getConfigCwd: vi.fn(() => "/test-dir"),
  };
}

function makeMockCtx(): ExtensionCommandContext {
  return {
    ui: {
      notify: vi.fn(),
    },
  } as any;
}

describe("settings-descriptors", () => {
  let tmpGlobalDir: string;
  let originalAgentDir: string | undefined;

  beforeEach(() => {
    tmpGlobalDir = mkdtempSync(join(tmpdir(), "pi-settings-descriptors-"));
    originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = tmpGlobalDir;
  });

  afterEach(() => {
    if (originalAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    }
    rmSync(tmpGlobalDir, { recursive: true, force: true });
  });

  it("defines complete and unique descriptors", () => {
    expect(SETTINGS_DESCRIPTORS.length).toBe(32);
    expect(SETTINGS_DESCRIPTORS_BY_ID.size).toBe(SETTINGS_DESCRIPTORS.length);

    const ids = new Set<string>();
    for (const desc of SETTINGS_DESCRIPTORS) {
      expect(desc.id).toBeTruthy();
      expect(desc.label).toBeTruthy();
      expect(desc.description).toBeTruthy();
      expect(ids.has(desc.id)).toBe(false);
      ids.add(desc.id);
    }
  });

  it("identifies numeric settings consistently in NUMERIC_SETTINGS_IDS", () => {
    const expectedNumeric = SETTINGS_DESCRIPTORS.filter((d) => d.isNumeric).map((d) => d.id);
    expect(NUMERIC_SETTINGS_IDS.size).toBe(expectedNumeric.length);
    for (const id of expectedNumeric) {
      expect(NUMERIC_SETTINGS_IDS.has(id)).toBe(true);
    }
  });

  it("applies hubBackground presets and custom hex", () => {
    const desc = SETTINGS_DESCRIPTORS_BY_ID.get("hubBackground")!;
    expect(desc).toBeDefined();
    expect(desc.getValues?.(makeMockDeps())).toContain("custom…");
    const deps = makeMockDeps();
    const ctx = makeMockCtx();

    desc.apply("beige", ctx, deps);
    desc.apply("#123456", ctx, deps);
    desc.apply("not-a-color", ctx, deps);
    expect(deps.setHubBackground).toHaveBeenCalledTimes(2);
    expect(deps.setHubBackground).toHaveBeenNthCalledWith(1, "beige");
    expect(deps.setHubBackground).toHaveBeenNthCalledWith(2, "#123456");
    expect(desc.parseText?.("  #ABCDEF  ")).toBe("#abcdef");
    expect(desc.parseText?.("chartreuse")).toBeUndefined();
  });

  it("applies maxConcurrent setting change", () => {
    const desc = SETTINGS_DESCRIPTORS_BY_ID.get("maxConcurrent")!;
    expect(desc).toBeDefined();
    const deps = makeMockDeps();
    const ctx = makeMockCtx();

    desc.apply("8", ctx, deps);
    expect(deps.manager.setMaxConcurrent).toHaveBeenCalledWith(8);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Max background concurrency set to 8"),
      expect.any(String),
    );
  });

  it("applies backgroundByDefault setting change", () => {
    const desc = SETTINGS_DESCRIPTORS_BY_ID.get("backgroundByDefault")!;
    expect(desc).toBeDefined();
    const deps = makeMockDeps();
    const ctx = makeMockCtx();

    desc.apply("off", ctx, deps);
    expect(deps.setBackgroundByDefault).toHaveBeenCalledWith(false);
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Agent calls block and return inline"),
      expect.any(String),
    );
  });

  it("applies workflowReference setting change", () => {
    const desc = SETTINGS_DESCRIPTORS_BY_ID.get("workflowReference")!;
    expect(desc).toBeDefined();
    const deps = makeMockDeps();
    const ctx = makeMockCtx();

    desc.apply("skill", ctx, deps);
    expect(deps.setWorkflowReference).toHaveBeenCalledWith("skill");
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Workflow reference moved to the workflow-authoring skill"),
      expect.any(String),
    );
  });

  it("evaluates gate helpers correctly", () => {
    // An undefined gate is the fresh-config default and must read as "on",
    // exactly like an explicit true.
    expect(gateAdmitsAnything(undefined)).toBe(true);
    expect(gateAdmitsAnything(true)).toBe(true);
    expect(gateAdmitsAnything(false)).toBe(false);
    expect(gateAdmitsAnything(["pkg-1"])).toBe(true);
    expect(gateAdmitsAnything([])).toBe(false);

    expect(describeGateSetting(true, "Base")).toBe("Base");
    expect(describeGateSetting(undefined, "Base")).toBe("Base");
    expect(describeGateSetting(["pkg-1"], "Base")).toContain("Currently limited to: pkg-1.");
    expect(describeGateSetting([], "Base")).toContain("Currently limited to an empty list, so nothing loads.");
  });

  it("stops the scheduler and short-circuits when scheduling is already off", () => {
    const desc = SETTINGS_DESCRIPTORS_BY_ID.get("schedulingEnabled")!;
    const deps = makeMockDeps();
    const ctx = makeMockCtx();

    desc.apply("off", ctx, deps);
    expect(deps.setSchedulingEnabled).toHaveBeenCalledWith(false);
    expect(deps.scheduler.stop).toHaveBeenCalledTimes(1);
    expect(deps.pi.events.emit).toHaveBeenCalledWith("subagents:settings_changed", expect.anything());
    expect(ctx.ui.notify).toHaveBeenCalledWith(
      expect.stringContaining("Scheduling disabled. Tool spec change takes effect on next pi session"),
      expect.any(String),
    );

    // Applying the same state again is a no-op: one info toast, no stop, no write.
    vi.mocked(deps.isSchedulingEnabled).mockReturnValue(false);
    const emitCalls = vi.mocked(deps.pi.events.emit).mock.calls.length;
    desc.apply("off", ctx, deps);
    expect(deps.scheduler.stop).toHaveBeenCalledTimes(1);
    expect(vi.mocked(deps.pi.events.emit).mock.calls.length).toBe(emitCalls);
    expect(ctx.ui.notify).toHaveBeenCalledWith("Scheduling already disabled.", "info");
  });

  it("short-circuits when workflows are already in the requested state", () => {
    const desc = SETTINGS_DESCRIPTORS_BY_ID.get("workflowsEnabled")!;
    const deps = makeMockDeps();
    const ctx = makeMockCtx();

    desc.apply("on", ctx, deps);
    expect(deps.setWorkflowsEnabled).not.toHaveBeenCalled();
    expect(deps.pi.events.emit).not.toHaveBeenCalled();
    expect(ctx.ui.notify).toHaveBeenCalledWith("Workflows already enabled.", "info");
  });

  it("warns when toggling package agents replaces a configured allowlist", () => {
    const desc = SETTINGS_DESCRIPTORS_BY_ID.get("packageAgents")!;
    setPackageAgentsGate(["pkg-a", "pkg-b"]);
    try {
      const deps = makeMockDeps();
      const ctx = makeMockCtx();
      desc.apply("on", ctx, deps);
      expect(deps.reloadCustomAgents).toHaveBeenCalled();
      expect(ctx.ui.notify).toHaveBeenCalledWith(
        expect.stringContaining("Replaced the allowlist (pkg-a, pkg-b)"),
        expect.any(String),
      );
    } finally {
      setPackageAgentsGate(undefined);
    }
  });

  it("reloads custom agents when the package workflows gate changes", () => {
    const desc = SETTINGS_DESCRIPTORS_BY_ID.get("packageWorkflows")!;
    const deps = makeMockDeps();
    const ctx = makeMockCtx();
    desc.apply("on", ctx, deps);
    expect(deps.reloadCustomAgents).toHaveBeenCalled();
  });

  it("persists maxSubagentDepth to the settings file when applied", () => {
    const desc = SETTINGS_DESCRIPTORS_BY_ID.get("maxSubagentDepth")!;
    const deps = makeMockDeps();
    const ctx = makeMockCtx();

    desc.apply("4", ctx, deps);

    // saveSettings rewrites subagents.json from the menu snapshot wholesale;
    // a key missing from the snapshot is erased. maxSubagentDepth must ride
    // along or the setting reverts to its default on the next session.
    const saved = JSON.parse(readFileSync(join(tmpGlobalDir, "subagents.json"), "utf-8"));
    expect(saved.maxSubagentDepth).toBe(4);
  });
});
