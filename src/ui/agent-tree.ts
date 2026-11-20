/**
 * agent-tree.ts — Nested subagents laid out under their parent.
 *
 * Consolidates tree hierarchy derivation for:
 * - `/agents → Running agents` (agentTree)
 * - FleetView (buildAgentHierarchy)
 * - Agent Hub roster & drilldown (buildAgentHierarchy)
 */

import type { AgentRecord } from "../types.js";

export interface AgentTreeRow {
  record: AgentRecord;
  /** Tree glyphs before the row (`├ `, `└ `, `│ ` continuation); `""` at top level. */
  prefix: string;
}

export interface AgentHierarchyNode {
  record: AgentRecord;
  depth: number;
  isLastChild?: boolean;
  childCount: number;
  parentRecord?: AgentRecord;
}

export interface BuildAgentHierarchyOptions {
  /** Explicit root records. When omitted, records with no parentAgentId are roots. */
  roots?: readonly AgentRecord[];
  /** Sort roots by startedAt (earliest first). Default: false (preserves given root order). */
  sortRoots?: boolean;
  /** Maximum depth to traverse (0 = roots only, 1 = roots + children, etc.). Default: unlimited. */
  maxDepth?: number;
}

/** Group child records by parent ID, sorted earliest launched first. */
export function groupChildrenByParent(records: readonly AgentRecord[]): Map<string, AgentRecord[]> {
  const children = new Map<string, AgentRecord[]>();
  for (const record of records) {
    if (record.parentAgentId === undefined) continue;
    const siblings = children.get(record.parentAgentId);
    if (siblings) siblings.push(record);
    else children.set(record.parentAgentId, [record]);
  }
  for (const siblings of children.values()) {
    siblings.sort((a, b) => a.startedAt - b.startedAt);
  }
  return children;
}

/**
 * Derives a hierarchical list of agent records with depth, sibling status, and child count.
 */
export function buildAgentHierarchy(
  records: readonly AgentRecord[],
  options: BuildAgentHierarchyOptions = {},
): AgentHierarchyNode[] {
  const recordMap = new Map<string, AgentRecord>(records.map(r => [r.id, r]));
  const childrenByParent = new Map<string, AgentRecord[]>();

  for (const r of records) {
    if (r.parentAgentId && recordMap.has(r.parentAgentId)) {
      let list = childrenByParent.get(r.parentAgentId);
      if (!list) {
        list = [];
        childrenByParent.set(r.parentAgentId, list);
      }
      list.push(r);
    }
  }

  for (const list of childrenByParent.values()) {
    list.sort((a, b) => a.startedAt - b.startedAt);
  }

  let roots: AgentRecord[];
  if (options.roots) {
    roots = [...options.roots];
  } else {
    roots = records.filter(r => !r.parentAgentId);
  }

  if (options.sortRoots) {
    roots.sort((a, b) => a.startedAt - b.startedAt);
  }

  const result: AgentHierarchyNode[] = [];
  const visited = new Set<string>();

  const appendNode = (
    rec: AgentRecord,
    depth: number,
    isLastChild?: boolean,
    parentRecord?: AgentRecord,
  ) => {
    if (visited.has(rec.id)) return;
    visited.add(rec.id);

    const children = childrenByParent.get(rec.id) ?? [];
    result.push({
      record: rec,
      depth,
      isLastChild,
      childCount: children.length,
      parentRecord,
    });

    if (options.maxDepth !== undefined && depth >= options.maxDepth) return;

    for (let i = 0; i < children.length; i++) {
      const isLast = i === children.length - 1;
      appendNode(children[i], depth + 1, isLast, rec);
    }
  };

  for (const root of roots) {
    appendNode(root, 0, undefined, root.parentAgentId ? recordMap.get(root.parentAgentId) : undefined);
  }

  return result;
}

/**
 * `records` as a tree: each top-level record in the order given, then its
 * children depth-first under it, siblings earliest-launched first. A child
 * whose parent is not in `records` is dropped — it has no row to hang from.
 */
export function agentTree(records: readonly AgentRecord[]): AgentTreeRow[] {
  const children = groupChildrenByParent(records);
  const rows: AgentTreeRow[] = [];
  // `indent` is what a child's own children continue with: a rail under a
  // `├`, blank under the last sibling's `└`.
  const visit = (record: AgentRecord, prefix: string, indent: string): void => {
    rows.push({ record, prefix });
    const kids = children.get(record.id) ?? [];
    kids.forEach((kid, i) => {
      const last = i === kids.length - 1;
      visit(kid, indent + (last ? "└ " : "├ "), indent + (last ? "  " : "│ "));
    });
  };
  for (const record of records) if (record.parentAgentId === undefined) visit(record, "", "");
  return rows;
}
