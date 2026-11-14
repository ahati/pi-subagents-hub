/**
 * cache-retention.ts — Per-child model-call prompt cache retention.
 *
 * File-only setting (`cacheRetention` in subagents.json). Installed on every
 * child session after creation so resumed, workflow, scheduled and mention
 * clones are covered by the same rule; an explicit per-request value wins, as
 * does Pi's own `PI_CACHE_RETENTION` default when the setting is `inherit`.
 */

import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { loadSettings } from "./settings.js";

export function installSubagentCacheRetention(session: AgentSession, cwd: string): void {
  const cacheRetention = loadSettings(cwd).cacheRetention;
  if (cacheRetention === undefined || cacheRetention === "inherit") return;
  const streamFunction = session.agent.streamFunction;
  session.agent.streamFunction = (model, context, options) =>
    streamFunction(model, context, { ...options, cacheRetention: options?.cacheRetention ?? cacheRetention });
}
