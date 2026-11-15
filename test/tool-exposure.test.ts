/**
 * tool-exposure.test.ts — `toolExposure: "deferred"` is opt-in, applies to both
 * orchestration tools, and warns when `tool_search` (the only way to reach a
 * deferred tool) is not configured.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import subagentsExtension from "../src/index.js";
import { ctx, type Hermetic, hermeticDir, makePi } from "./helpers/boot-extension.js";

describe("tool exposure", () => {
  let hermetic: Hermetic | undefined;

  afterEach(() => {
    hermetic?.restore();
  });

  function boot(settings?: Record<string, unknown>) {
    hermetic = hermeticDir(settings === undefined ? {} : { settings });
    const booted = makePi();
    subagentsExtension(booted.pi);
    return booted;
  }

  it("registers both orchestration tools direct by default", () => {
    const { tools } = boot();
    expect(tools.get("Agent")?.exposure).toBe("direct");
    expect(tools.get("SubagentWorkflow")?.exposure).toBe("direct");
  });

  it("defers both tools when the file asks for it", () => {
    const { tools } = boot({ toolExposure: "deferred" });
    expect(tools.get("Agent")?.exposure).toBe("deferred");
    expect(tools.get("SubagentWorkflow")?.exposure).toBe("deferred");
  });

  it("warns once at session start when tool_search is absent", async () => {
    const { pi, lifecycle } = boot({ toolExposure: "deferred" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      pi.getAllTools.mockReturnValue([{ name: "Agent" }, { name: "SubagentWorkflow" }]);
      await lifecycle.get("session_start")?.({}, ctx());
      expect(warn.mock.calls.some(([message]) => String(message).includes("tool_search"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it("stays quiet when tool_search is available", async () => {
    const { pi, lifecycle } = boot({ toolExposure: "deferred" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      pi.getAllTools.mockReturnValue([{ name: "Agent" }, { name: "tool_search" }]);
      await lifecycle.get("session_start")?.({}, ctx());
      expect(warn.mock.calls.some(([message]) => String(message).includes("tool_search"))).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });
});
