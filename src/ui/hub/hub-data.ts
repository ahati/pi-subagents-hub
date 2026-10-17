/**
 * hub-data.ts — Data query and indexing helpers for AgentHub.
 */

import { isTopLevelAgent } from "../../agent-manager.js";
import type { AgentRecord } from "../../types.js";
import { buildPhaseGroups, type PhaseGroup } from "../../workflow/progress.js";
import type { FleetWorkflow } from "../fleet-list.js";
import {
  type AgentHubDeps,
  FINISHED_LINGER_MS,
  type HubEntry,
} from "./hub-types.js";

/** Live workflow runs, plus recently settled ones (same terms as the fleet list). */
export function hubWorkflows(deps: AgentHubDeps): FleetWorkflow[] {
  if (!deps.workflows) return [];
  const now = Date.now();
  return [...deps.workflows()]
    .filter(run =>
      run.status === "running"
      || run.status === "paused"
      || (run.completedAt != null && now - run.completedAt < FINISHED_LINGER_MS)
    )
    .sort((a, b) => a.startedAt - b.startedAt);
}

/**
 * Every top-level agent with a session, earliest-launched first.
 */
export function hubAgents(deps: AgentHubDeps): AgentRecord[] {
  return deps.manager.listAgents()
    .filter(a => isTopLevelAgent(a) && a.session)
    .sort((a, b) => a.startedAt - b.startedAt);
}

/**
 * The roster index of `agentId` — the order `entries()` draws: the subagents
 * section first (stable launch order), then the runs. `-1` when the agent has
 * no roster row.
 */
export function hubEntryIndex(deps: AgentHubDeps, agentId: string): number {
  const entries: HubEntry[] = [
    ...hubAgents(deps).map(record => ({ kind: "agent" as const, record })),
    ...hubWorkflows(deps).map(workflow => ({ kind: "workflow" as const, workflow })),
  ];
  return entries.findIndex(e => e.kind === "agent" && e.record.id === agentId);
}

/**
 * The roster index of `runId` in the same order — the subagents section first,
 * then the runs. `-1` when the run has no roster row.
 */
export function hubRunIndex(deps: AgentHubDeps, runId: string): number {
  const entries: HubEntry[] = [
    ...hubAgents(deps).map(record => ({ kind: "agent" as const, record })),
    ...hubWorkflows(deps).map(workflow => ({ kind: "workflow" as const, workflow })),
  ];
  return entries.findIndex(e => e.kind === "workflow" && e.workflow.id === runId);
}

/** The phase groups of a run whose row the window is opening on. */
export function hubRunGroups(deps: AgentHubDeps, runId: string): PhaseGroup[] {
  const source = deps.workflowRun?.(runId);
  return source ? buildPhaseGroups(source.progress, source.meta?.phases) : [];
}
