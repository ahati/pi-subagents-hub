/**
 * activity.ts — the per-agent live activity tracker.
 *
 * A leaf module on purpose: the workflow host registers trackers too, and the
 * host sits inside the workflow import graph that `renderers.ts` cannot be
 * pulled into at module-init time (collisions/runner-types TDZ cycle).
 */

import type { ToolActivity } from "../runner/runner-types.js";
import type { ActiveToolCall, AgentActivity } from "../ui/agent-widget.js";
import type { LifetimeUsage } from "../usage.js";

/**
 * Create an AgentActivity state and spawn callbacks for tracking tool usage.
 * Used by every spawn path — Agent tool (foreground/background), direct mode,
 * background resume, and the workflow host — so each surface reads the same
 * live state the hub and widget render.
 */
export function createActivityTracker(maxTurns?: number, onStreamUpdate?: () => void) {
  let syntheticCall = 0;
  const state: AgentActivity = {
    activeTools: new Map<string, ActiveToolCall>(),
    toolUses: 0,
    turnCount: 1,
    maxTurns,
    responseText: "",
    lastTool: undefined,
    session: undefined,
  };

  const callbacks = {
    onToolActivity: (activity: ToolActivity) => {
      if (activity.type === "start") {
        // Live events pair by pi's toolCallId; without one, ends match by tool name.
        const key = activity.toolCallId ?? `${activity.toolName}#${syntheticCall++}`;
        state.activeTools.set(key, { toolName: activity.toolName, args: activity.args });
      } else if (activity.type === "end") {
        const key = activity.toolCallId
          ?? [...state.activeTools.entries()].find(([, call]) => call.toolName === activity.toolName)?.[0];
        const call = key !== undefined ? state.activeTools.get(key) : undefined;
        if (key !== undefined) state.activeTools.delete(key);
        // What the agent last did — shown between messages for agents that
        // narrate little, instead of falling back to thinking… (#181).
        state.lastTool = call ?? { toolName: activity.toolName };
        state.toolUses++;
      }
      // A "warning" probe (model-error/tools-error/extension-error) is a
      // one-shot diagnostic, not a tool use: nothing to paint, nothing to count.
      onStreamUpdate?.();
    },
    onTextDelta: (_delta: string, fullText: string) => {
      state.responseText = fullText;
      onStreamUpdate?.();
    },
    onTurnEnd: (turnCount: number) => {
      state.turnCount = turnCount;
      onStreamUpdate?.();
    },
    onSessionCreated: (session: unknown) => {
      state.session = session as AgentActivity["session"];
    },
    // Spend is accumulated on the AgentRecord (agent-manager), which is what
    // every surface reads; this callback exists here only to repaint on it.
    onAssistantUsage: (_usage: LifetimeUsage) => {
      onStreamUpdate?.();
    },
  };

  return { state, callbacks };
}
