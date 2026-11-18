/**
 * cache-retention.ts — Per-child model-call prompt cache retention.
 *
 * Precedence: an explicit per-request value (pi passes `none` for compaction
 * and branch summaries) > the agent's `cache_retention` frontmatter > the
 * `cacheRetention` setting > pi's own default. A parent on a one-hour cache
 * would otherwise make every short-lived child pay the one-hour write rate.
 *
 * The setting is module state, set when settings load and when the menu changes
 * it, and applies to agents started after that. It is installed on every child
 * session after creation, so resumed, workflow, scheduled and mention-clone
 * sessions are covered by the same rule.
 */

import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { CacheRetentionSetting } from "./types.js";

let cacheRetention: CacheRetentionSetting = "inherit";

/** The `cacheRetention` setting; `inherit` leaves pi's default in charge. */
export function getCacheRetention(): CacheRetentionSetting { return cacheRetention; }

/** Set the `cacheRetention` setting. Read at spawn, so it applies to agents started after it. */
export function setCacheRetention(value: CacheRetentionSetting): void { cacheRetention = value; }

/**
 * Supply `retention` on every model call the session makes that does not set
 * one itself. Wraps the session's own stream function, so pi's routing, auth
 * and cache warming still run and the warmer refreshes on the matching TTL.
 * `inherit` installs nothing.
 */
export function installCacheRetention(session: AgentSession, retention: CacheRetentionSetting): void {
  if (retention === "inherit") return;
  const streamFunction = session.agent.streamFunction;
  session.agent.streamFunction = (model, context, options) =>
    streamFunction(model, context, { ...options, cacheRetention: options?.cacheRetention ?? retention });
}
