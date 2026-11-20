import { describe, expect, it, vi } from "vitest";
import { registerAgents } from "../src/agent-types.js";
import { createAgentTool } from "../src/tools/agent-tool.js";
import type { AgentConfig } from "../src/types.js";

/**
 * agent-tool-session-notify.test.ts — the fleet must be notified when a
 * background spawn's session is CREATED, not only at spawn time.
 *
 * The roster's eligibility filter requires `record.session`, which is set
 * asynchronously when the child session is built. A spawn-time
 * `fleet.update()` therefore runs against a roster that cannot include the
 * agent yet — and if nothing else is on the roster, that call clears the
 * tick timer, leaving nothing to notice the session arriving. The trace of
 * the live repro (fresh session, first background spawn) showed exactly that:
 * two update() calls with an empty roster, then silence while the agent ran.
 *
 * The fix: the background branch's onSessionCreated wrapper — the moment the
 * record clears the eligibility filter — re-arms and updates the fleet, the
 * same pattern the foreground branch and the mention path already use.
 */

const CONFIG: AgentConfig = {
  name: "general-purpose",
  displayName: "Agent",
  description: "General helper",
  systemPrompt: "You are a helper.",
  promptMode: "inherit",
} as unknown as AgentConfig;

describe("Agent tool background spawn notifies the fleet at session creation", () => {
  it("calls fleet.ensureTimer + fleet.update from the onSessionCreated wrapper", async () => {
    registerAgents(new Map([["general-purpose", CONFIG]]));
    try {
      const fleet = { ensureTimer: vi.fn(), update: vi.fn(), setUICtx: vi.fn() };
      const widget = { setUICtx: vi.fn(), ensureTimer: vi.fn(), update: vi.fn() };
      let captured: { onSessionCreated?: (session: unknown) => void } | undefined;
      const manager = {
        takenHandles: () => new Set<string>(),
        spawn: vi.fn((_pi: unknown, _ctx: unknown, _type: string, _prompt: string, options: any) => {
          captured = options;
          return "ag1";
        }),
        getRecord: vi.fn(() => undefined),
        awaitStartup: vi.fn(async () => {}),
        getMaxConcurrent: () => 5,
        listAgents: () => [],
      };

      const tool = createAgentTool({
        pi: { events: { emit: vi.fn() }, appendEntry: vi.fn() } as any,
        manager: manager as any,
        agentActivity: new Map(),
        widget: widget as any,
        fleet: fleet as any,
        scheduler: { isActive: () => true } as any,
        foregroundHandoffs: new Map(),
        reloadCustomAgents: vi.fn(),
        getBackgroundByDefault: () => true,
        isSchedulingEnabled: () => false,
        isWorktreeIsolationEnabled: () => false,
        getDefaultJoinMode: () => "smart",
        resumeTurnLimit: () => undefined,
        startBackgroundResume: vi.fn(async () => undefined),
        joinTurnGroup: vi.fn(),
        resolveAgentRef: () => undefined,
        isShowCostEnabled: () => false,
        getToolDescriptionMode: () => "full",
      } as any);

      const ctx = {
        cwd: "/tmp/probe",
        model: undefined,
        modelRegistry: { find: () => undefined, getAvailable: () => [] },
        sessionManager: { getSessionId: () => "sess", getBranch: () => [] },
        ui: { notify: vi.fn() },
      } as any;

      await tool.execute(
        "tc",
        { prompt: "run", description: "d", subagent_type: "general-purpose", run_in_background: true },
        undefined,
        undefined,
        ctx,
      );

      // Spawn-time notify (pre-existing behavior) fires with the roster not
      // yet containing the agent — its purpose is the hasRows refresh.
      const updatesAtSpawn = fleet.update.mock.calls.length;
      expect(updatesAtSpawn).toBeGreaterThanOrEqual(1);

      // The session is created asynchronously; the roster only admits the
      // record now. The wrapper must re-arm the tick and refresh the fleet.
      expect(captured?.onSessionCreated).toBeTypeOf("function");
      captured!.onSessionCreated!({ messages: [] });
      expect(fleet.ensureTimer).toHaveBeenCalled();
      expect(fleet.update.mock.calls.length).toBeGreaterThan(updatesAtSpawn);
    } finally {
      registerAgents(new Map());
    }
  });
});
