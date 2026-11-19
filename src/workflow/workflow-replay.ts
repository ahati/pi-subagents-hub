import type { WorkflowJournalEntry } from "./journal.js";
import type { CompiledSchema } from "./json-schema.js";
import { applySchema } from "./workflow-gate.js";

/**
 * Replay engine: matches calls by structural position and enforces prefix integrity.
 *
 * Invalidation is run-wide: once a position misses (different key, journaled failure,
 * invalid schema, or absent entry), every later call runs live.
 */
export class WorkflowReplayEngine {
  private readonly journalByPath = new Map<string, WorkflowJournalEntry>();
  private prefixIntact: boolean;
  private _replayedCount = 0;

  constructor(
    entries: readonly WorkflowJournalEntry[] = [],
    journalResumes = entries.some((entry) => entry.resumed),
  ) {
    for (const entry of entries) {
      if (!this.journalByPath.has(entry.path)) {
        this.journalByPath.set(entry.path, entry);
      }
    }
    // A journal from a run that used agent({ resume }) is declined whole:
    // a replayed agent leaves nothing for a later resume to continue.
    this.prefixIntact = entries.length > 0 && !journalResumes;
  }

  get replayedCount(): number {
    return this._replayedCount;
  }

  get isPrefixIntact(): boolean {
    return this.prefixIntact;
  }

  invalidate(): void {
    this.prefixIntact = false;
  }

  /**
   * Match a cached answer at this structural position and key.
   * If a schema is specified, re-validates the replayed text.
   */
  match(
    path: string,
    key: string,
    compiledSchema?: CompiledSchema,
  ): WorkflowJournalEntry | undefined {
    if (!this.prefixIntact) return undefined;
    const entry = this.journalByPath.get(path);
    if (
      entry === undefined ||
      entry.key !== key ||
      !entry.ok ||
      typeof entry.text !== "string"
    ) {
      this.prefixIntact = false;
      return undefined;
    }
    if (compiledSchema !== undefined) {
      const recheck = applySchema(
        { ok: true, text: entry.text },
        compiledSchema,
      );
      if (!recheck.ok) {
        this.prefixIntact = false;
        return undefined;
      }
    }
    this._replayedCount++;
    return entry;
  }
}
