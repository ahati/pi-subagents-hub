import { mkdtempSync, rmSync } from "node:fs";
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
    scheduler: {} as any,
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
    expect(SETTINGS_DESCRIPTORS.length).toBeGreaterThanOrEqual(30);
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
    expect(gateAdmitsAnything(true)).toBe(true);
    expect(gateAdmitsAnything(false)).toBe(false);
    expect(gateAdmitsAnything(["pkg-1"])).toBe(true);
    expect(gateAdmitsAnything([])).toBe(false);

    expect(describeGateSetting(true, "Base")).toContain("on = all packages");
    expect(describeGateSetting(["pkg-1"], "Base")).toContain("Constrained by a list in settings (pkg-1)");
  });
});
