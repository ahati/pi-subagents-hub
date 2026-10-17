/**
 * runner-settings.ts — settings and model resolution for the subagent runner.
 */

import type { Model } from "@earendil-works/pi-ai";
import { getAgentConfig } from "../agent-types.js";

/** Default max turns. undefined = unlimited (no turn limit). */
let defaultMaxTurns: number | undefined;

/** Normalize max turns. undefined or 0 = unlimited, otherwise minimum 1. */
export function normalizeMaxTurns(n: number | undefined): number | undefined {
  if (n == null || n === 0) return undefined;
  return Math.max(1, n);
}

/** Get the default max turns value. undefined = unlimited. */
export function getDefaultMaxTurns(): number | undefined { return defaultMaxTurns; }
/** Set the default max turns value. undefined or 0 = unlimited, otherwise minimum 1. */
export function setDefaultMaxTurns(n: number | undefined): void { defaultMaxTurns = normalizeMaxTurns(n); }

/**
 * The turn limit a run of `type` will actually enforce: an explicit value if the
 * caller supplied one, else the agent's own `max_turns`, else the project
 * default. `undefined` = unlimited.
 */
export function resolveEffectiveMaxTurns(type: string, explicit?: number): number | undefined {
  return normalizeMaxTurns(explicit ?? getAgentConfig(type)?.maxTurns ?? defaultMaxTurns);
}

/**
 * Project default for `persist_session`, from the `rememberAgents` setting.
 */
let rememberAgents = true;

/** Whether subagent sessions are persisted by default. */
export function getRememberAgents(): boolean { return rememberAgents; }
/** Set whether subagent sessions are persisted by default. */
export function setRememberAgents(b: boolean): void { rememberAgents = b; }

/** Additional turns allowed after the soft limit steer message. */
let graceTurns = 5;

/** Get the grace turns value. */
export function getGraceTurns(): number { return graceTurns; }
/** Set the grace turns value (minimum 1). */
export function setGraceTurns(n: number): void { graceTurns = Math.max(1, n); }

/**
 * Try to find the right model for an agent type.
 * Priority: explicit option > config.model > parent model.
 */
export function resolveDefaultModel(
  parentModel: Model<any> | undefined,
  registry: { find(provider: string, modelId: string): Model<any> | undefined; getAvailable?(): Model<any>[] },
  configModel?: string,
): Model<any> | undefined {
  if (configModel) {
    const slashIdx = configModel.indexOf("/");
    if (slashIdx !== -1) {
      const provider = configModel.slice(0, slashIdx);
      const modelId = configModel.slice(slashIdx + 1);

      const available = registry.getAvailable?.();
      const availableKeys = available
        ? new Set(available.map((m: any) => `${m.provider}/${m.id}`))
        : undefined;
      const isAvailable = (p: string, id: string) =>
        !availableKeys || availableKeys.has(`${p}/${id}`);

      const found = registry.find(provider, modelId);
      if (found && isAvailable(provider, modelId)) return found;
    }
  }

  return parentModel;
}
