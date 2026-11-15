/**
 * journal.ts — cached workflow answers, not a checkpoint of their effects.
 *
 * Calls are identified by structural position, not arrival order: the root,
 * each parallel thunk, each pipeline item's stage chain, and each nested
 * workflow body number their own slots. An unchanged pipeline can replay even
 * when its items finish in a different order.
 *
 * At the first missing, changed, failed, or invalid answer, the whole run stops
 * replaying. Structural branches can share files and other effects; a static
 * prompt does not prove independence from changed sibling or child work.
 *
 * Replay does not rerun tools or restore files. Use a fresh run after changing
 * external inputs, agent definitions, models, or the workspace. A run that used
 * `agent({ resume })` cannot replay: cached text leaves no live child to
 * continue.
 *
 * A gated call's entry records the gate's outcome alongside the answer — the
 * command is not re-run on replay, but its verdict remains the audit trail.
 *
 * The file is JSON Lines, appended as calls settle, so a run that is killed
 * mid-flight still leaves everything it had finished. Journals written before
 * structural paths were added are ignored and the work runs live.
 */

import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";

/** One settled agent call, as replayed. */
export interface WorkflowJournalEntry {
  /** Structural identity: root #k, parallel /k:p:i, pipeline /k:l:i, child /k:w. */
  path: string;
  /** Arrival order, retained for displaying the journal, not for matching calls. */
  index: number;
  /** Hash of the call's payload; a mismatch stops further replay. */
  key: string;
  /** A failure stops further replay and is retried live. */
  ok: boolean;
  /** The agent's answer, when it had one. */
  text?: string;
  /**
   * Why the call failed, bounded by the runtime (500 characters).
   *
   * Diagnostic only: a failure already stops replay, so this never takes part
   * in matching. It exists so a later reader — or the run that retries the
   * prefix live — can tell a provider error from a schema miss, a gate verdict
   * or a skip. Provider text is untrusted: render it as data.
   */
  error?: string;
  /**
   * Whether the call continued an earlier child (`agent({ resume })`).
   *
   * A replayed agent leaves no session behind in the run that replays it — the
   * conversation belongs to the run that actually spawned it, and the host's
   * id map is per-run — so a later `resume` would have nothing to continue.
   * Recording it lets the next run decline to replay at all rather than fail
   * partway through, which is why the flag is on the journal and not derived.
   */
  resumed?: true;
  /**
   * The call's `gate` outcome, when it had a gate.
   *
   * Recorded for both verdicts, because both are worth reading back: a pass is
   * the evidence the work was verified at all, and a failure is what a retry
   * loop was reacting to. Absent on an entry written before this existed, so
   * every reader has to treat it as optional.
   */
  gate?: WorkflowJournalGate;
}

/** A `gate` command's outcome, as the run's audit trail keeps it. */
export interface WorkflowJournalGate {
  /** Whether the command exited zero. */
  ok: boolean;
  /**
   * The command's combined output, tail-truncated.
   *
   * The tail rather than the head: a test run's summary is at the bottom, and
   * the whole log of a failing suite does not belong in a journal line.
   */
  output: string;
  /**
   * The directory the command actually ran in.
   *
   * The one thing that distinguishes a gate against the child's worktree from
   * a fallback gate against the main checkout — and by the time the journal is
   * read back, the worktree is long gone and this path is the only evidence of
   * which tree was verified. Absent on an entry written by a host that did not
   * report one.
   */
  cwd?: string;
}

/**
 * The fields that decide what an agent does.
 *
 * Deliberately not the whole payload: `phaseIndex` and `phaseTitle` move the
 * row around in the progress tree without changing a single token the agent
 * sees, so re-grouping phases should not throw away an hour of results.
 */
export interface JournalKeyInput {
  prompt: string;
  label?: string;
  model?: string;
  agentType?: string;
  effort?: string;
  isolation?: string;
  gate?: string;
  resume?: string;
  /** Serialized `agent({ schema })`, when the call asked for one. */
  schema?: string;
}

/** Stable hash of a call's payload. Field order is fixed here, not by the caller. */
export function journalKey(input: JournalKeyInput): string {
  const canonical = JSON.stringify([
    input.prompt,
    input.label ?? null,
    input.model ?? null,
    input.agentType ?? null,
    input.effort ?? null,
    input.isolation ?? null,
    input.gate ?? null,
    input.resume ?? null,
    // Appended only when present, which looks like a hack and is not: adding a
    // ninth slot unconditionally would change the canonical form of every entry
    // and invalidate every journal already on disk. Conditional, a schema-less
    // call keys exactly as it always did, and adding or changing a schema still
    // produces a different key.
    ...(input.schema !== undefined ? [input.schema] : []),
  ]);
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

/**
 * Read a journal file into position order.
 *
 * Never throws: a missing, truncated or hand-mangled journal means "nothing to
 * replay", which costs tokens. Refusing to run would cost the whole run.
 * A partial last line is normal — the file is appended to while agents settle.
 */
export function readJournal(path: string): WorkflowJournalEntry[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch {
    return [];
  }

  const entries: WorkflowJournalEntry[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!isEntry(parsed)) continue;
      entries.push(parsed);
    } catch {
      // A half-written final line, or someone editing the file. Skipping it
      // keeps what came before, and a shorter prefix is still a useful one.
    }
  }
  entries.sort((a, b) => a.index - b.index);
  return entries;
}

/** Append one settled call. Failure to write is not failure to run. */
export function appendJournal(path: string, entry: WorkflowJournalEntry): void {
  try {
    appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf-8");
  } catch {
    // A journal that cannot be written costs a future resume, nothing more.
  }
}

function isGate(value: unknown): value is WorkflowJournalGate {
  if (typeof value !== "object" || value === null) return false;
  const gate = value as Record<string, unknown>;
  return (
    typeof gate.ok === "boolean" &&
    typeof gate.output === "string" &&
    (gate.cwd === undefined || typeof gate.cwd === "string")
  );
}

function isEntry(value: unknown): value is WorkflowJournalEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.path === "string" &&
    /^(?:\/\d+:(?:p:\d+|l:\d+|w))*#\d+$/.test(entry.path) &&
    Number.isInteger(entry.index) &&
    (entry.index as number) >= 0 &&
    typeof entry.key === "string" &&
    typeof entry.ok === "boolean" &&
    (entry.ok ? typeof entry.text === "string" : entry.text === undefined || typeof entry.text === "string") &&
    (entry.error === undefined || typeof entry.error === "string") &&
    (entry.resumed === undefined || entry.resumed === true) &&
    (entry.gate === undefined || isGate(entry.gate))
  );
}
