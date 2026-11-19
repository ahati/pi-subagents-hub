/**
 * hub-data.ts — Data query and indexing helpers for AgentHub.
 */

import { isTopLevelAgent } from "../../agent-manager.js";
import { buildPhaseGroups, type PhaseGroup } from "../../workflow/progress.js";
import { buildAgentHierarchy } from "../agent-tree.js";
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
 * Builds the roster entries for the given scope (undefined = root scope).
 * Shows root agents and their immediate children (1-level tree).
 */
export function hubScopeEntries(deps: AgentHubDeps, scopeId?: string): HubEntry[] {
  const all = deps.manager.listAgents();
  const sessionAgents = all.filter(a => a.session);

  if (scopeId === undefined) {
    const roots = sessionAgents
      .filter(a => isTopLevelAgent(a))
      .sort((a, b) => a.startedAt - b.startedAt);

    const nodes = buildAgentHierarchy(sessionAgents, { roots, maxDepth: 1 });
    const entries: HubEntry[] = nodes.map(n => ({
      kind: "agent",
      record: n.record,
      depth: n.depth,
      isLastChild: n.isLastChild,
      childCount: n.childCount,
      parentRecord: n.parentRecord,
    }));

    entries.push(...hubWorkflows(deps).map(workflow => ({ kind: "workflow" as const, workflow })));
    return entries;
  }

  const root = all.find(a => a.id === scopeId);
  if (!root) return hubScopeEntries(deps, undefined);

  const parentRecord = root.parentAgentId ? all.find(a => a.id === root.parentAgentId) : undefined;
  const nodes = buildAgentHierarchy(sessionAgents, { roots: [root], maxDepth: 1 });
  if (nodes.length > 0) {
    nodes[0].parentRecord = parentRecord;
  }

  return nodes.map(n => ({
    kind: "agent",
    record: n.record,
    depth: n.depth,
    isLastChild: n.isLastChild,
    childCount: n.childCount,
    parentRecord: n.parentRecord,
  }));
}

/**
 * The roster index of `agentId` — the order `entries()` draws: the subagents
 * section first (stable launch order), then the runs. `-1` when the agent has
 * no roster row.
 */
export function hubEntryIndex(deps: AgentHubDeps, agentId: string, scopeId?: string): number {
  const entries = hubScopeEntries(deps, scopeId);
  return entries.findIndex(e => e.kind === "agent" && e.record.id === agentId);
}

/**
 * The roster index of `runId` in the same order — the subagents section first,
 * then the runs. `-1` when the run has no roster row.
 */
export function hubRunIndex(deps: AgentHubDeps, runId: string, scopeId?: string): number {
  const entries = hubScopeEntries(deps, scopeId);
  return entries.findIndex(e => e.kind === "workflow" && e.workflow.id === runId);
}

/** The phase groups of a run whose row the window is opening on. */
export function hubRunGroups(deps: AgentHubDeps, runId: string): PhaseGroup[] {
  const source = deps.workflowRun?.(runId);
  return source ? buildPhaseGroups(source.progress, source.meta?.phases) : [];
}
