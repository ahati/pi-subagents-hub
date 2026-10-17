/**
 * agent-registry.ts — Agent record storage, tombstone persistence, and handle resolution.
 */

import type { AgentRecord, AgentTombstone, MentionResolution } from "../types.js";
import { MAX_TOMBSTONES } from "./manager-types.js";

export class AgentRegistry {
  readonly agents = new Map<string, AgentRecord>();
  readonly tombstones = new Map<string, AgentTombstone>();

  /** Handles already in use, so a fresh spawn can pick an unclaimed one. */
  takenHandles(): Set<string> {
    const taken = new Set<string>();
    for (const record of this.agents.values()) {
      if (record.handle) taken.add(record.handle);
      if (record.alias) taken.add(record.alias);
    }
    for (const entry of this.tombstones.values()) {
      taken.add(entry.handle);
      if (entry.alias) taken.add(entry.alias);
    }
    return taken;
  }

  /**
   * Resolve an `@name` from the prompt. Matches a top-level agent's handle
   * case-insensitively, preferring one that can still be steered and otherwise
   * the most recently started, then falls back to an exact agent id.
   */
  resolveMention(name: string): MentionResolution | undefined {
    const wanted = name.toLowerCase();
    let fallback: AgentRecord | undefined;
    for (const record of this.agents.values()) {
      if (record.parentAgentId !== undefined) continue;
      if (record.handle?.toLowerCase() !== wanted && record.alias?.toLowerCase() !== wanted) continue;
      if (record.status === "running" || record.status === "queued") return { kind: "live", record };
      if (!fallback || record.startedAt > fallback.startedAt) fallback = record;
    }
    if (fallback) return { kind: "live", record: fallback };
    const byId = this.agents.get(name);
    if (byId?.parentAgentId === undefined && byId !== undefined) return { kind: "live", record: byId };
    for (const entry of this.tombstones.values()) {
      if (entry.handle.toLowerCase() === wanted || entry.alias?.toLowerCase() === wanted || entry.id === name) {
        return { kind: "tombstone", entry };
      }
    }
    return undefined;
  }

  dropTombstone(handle: string): void {
    this.tombstones.delete(handle);
  }

  listTombstones(): AgentTombstone[] {
    return [...this.tombstones.values()].sort((a, b) => b.completedAt - a.completedAt);
  }

  listAgents(): AgentRecord[] {
    return [...this.agents.values()].sort((a, b) => b.startedAt - a.startedAt);
  }

  tombstone(record: AgentRecord): void {
    if (!record.handle || !record.sessionFile) return;
    this.tombstones.set(record.handle, {
      handle: record.handle,
      alias: record.alias,
      id: record.id,
      type: record.type,
      description: record.description,
      sessionFile: record.sessionFile,
      completedAt: record.completedAt ?? Date.now(),
    });
    while (this.tombstones.size > MAX_TOMBSTONES) {
      const oldest = [...this.tombstones.values()].reduce((a, b) => (a.completedAt <= b.completedAt ? a : b));
      this.tombstones.delete(oldest.handle);
    }
  }

  hasRunning(): boolean {
    return [...this.agents.values()].some(
      r => r.status === "running" || r.status === "queued",
    );
  }

  clearTombstones(): void {
    this.tombstones.clear();
  }
}
