import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { AgentManager } from "../src/agent-manager.js";
import { syncPauseManifest } from "../src/commands/pause-continue.js";
import { ParkGateController } from "../src/commands/pause-state.js";

const manager = { listAgents: () => [] } as unknown as AgentManager;

describe("syncPauseManifest with a replaced session context", () => {
  it("ignores a stale sessionManager getter after session replacement", () => {
    const staleContext = Object.defineProperty({}, "sessionManager", {
      get() { throw new Error("This extension ctx is stale after session replacement"); },
    }) as unknown as ExtensionContext;

    expect(() => syncPauseManifest(staleContext, new ParkGateController(), manager)).not.toThrow();
  });

  it("ignores a stale cwd getter after session identity was read", () => {
    const staleContext = {
      sessionManager: { getSessionId: () => "session-1" },
      get cwd() { throw new Error("This extension ctx is stale after session replacement"); },
    } as unknown as ExtensionContext;

    expect(() => syncPauseManifest(staleContext, new ParkGateController(), manager)).not.toThrow();
  });
});
