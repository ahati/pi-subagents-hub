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
 * Child agents owned by parentId with a session, earliest-launched first.
 */
export function childAgentsOf(deps: AgentHubDeps, parentId: string): AgentRecord[] {
  return deps.manager.listAgents()
    .filter(a => a.parentAgentId === parentId && a.session)
    .sort((a, b) => a.startedAt - b.startedAt);
}

/**
 * Builds the roster entries for the given scope (undefined = root scope).
 * Shows root agents and their immediate children (1-level tree).
 */
export function hubScopeEntries(deps: AgentHubDeps, scopeId?: string): HubEntry[] {
  const all = deps.manager.listAgents();
  if (scopeId === undefined) {
    const roots = all
      .filter(a => isTopLevelAgent(a) && a.session)
      .sort((a, b) => a.startedAt - b.startedAt);

    const entries: HubEntry[] = [];
    for (const root of roots) {
      const children = all
        .filter(a => a.parentAgentId === root.id && a.session)
        .sort((a, b) => a.startedAt - b.startedAt);

      entries.push({
        kind: "agent",
        record: root,
        depth: 0,
        childCount: children.length,
      });

      for (let i = 0; i < children.length; i++) {
        const child = children[i];
        const grandchildren = all.filter(a => a.parentAgentId === child.id && a.session);
        entries.push({
          kind: "agent",
          record: child,
          depth: 1,
          isLastChild: i === children.length - 1,
          childCount: grandchildren.length,
          parentRecord: root,
        });
      }
    }

    entries.push(...hubWorkflows(deps).map(workflow => ({ kind: "workflow" as const, workflow })));
    return entries;
  }

  const root = all.find(a => a.id === scopeId);
  if (!root) return hubScopeEntries(deps, undefined);

  const children = all
    .filter(a => a.parentAgentId === root.id && a.session)
    .sort((a, b) => a.startedAt - b.startedAt);

  const parentRecord = root.parentAgentId ? all.find(a => a.id === root.parentAgentId) : undefined;
  const entries: HubEntry[] = [{
    kind: "agent",
    record: root,
    depth: 0,
    childCount: children.length,
    parentRecord,
  }];

  for (let i = 0; i < children.length; i++) {
    const child = children[i];
    const grandchildren = all.filter(a => a.parentAgentId === child.id && a.session);
    entries.push({
      kind: "agent",
      record: child,
      depth: 1,
      isLastChild: i === children.length - 1,
      childCount: grandchildren.length,
      parentRecord: root,
    });
  }

  return entries;
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
