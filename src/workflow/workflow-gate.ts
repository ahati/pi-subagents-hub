/**
 * workflow-gate.ts — gate execution, schema validation, and message shaping for workflow child runs.
 */

import type { WorkflowJournalGate } from "./journal.js";
import type { CompiledSchema } from "./json-schema.js";
import type { WorkflowEntry } from "./progress.js";
import {
  GATE_OUTPUT_TAIL,
  PREVIEW_LENGTH,
  WorkflowHost,
  WorkflowSpawnResult,
} from "./runtime-types.js";

export interface AgentCallPayload {
  prompt: string;
  label?: string;
  model?: string;
  agentType?: string;
  isolation?: "worktree";
  phaseIndex?: number;
  phaseTitle?: string;
  /** Shell command that has to pass before the agent counts as done. */
  gate?: string;
  /** Label of an earlier child in this run to continue instead of starting one. */
  resume?: string;
  /** Reasoning effort, already validated against pi's thinking levels worker-side. */
  effort?: string;
  /** Raw JSON Schema from `agent({ schema })`, compiled before anything spawns. */
  schema?: unknown;
}

export type WorkerMessage =
  | { type: "call"; callId: number; method: string; payload: AgentCallPayload }
  | { type: "progress"; entries: WorkflowEntry[] }
  | { type: "complete"; resultJson?: string }
  | { type: "error"; message: string; stack?: string };

export const preview = (text: string): string =>
  text.length <= PREVIEW_LENGTH ? text : `${text.slice(0, PREVIEW_LENGTH - 1)}…`;

/** First line of the prompt, trimmed — the fallback display name for an agent. */
export function derivedLabel(prompt: string): string {
  const line = prompt.split("\n", 1)[0].trim();
  return line.length <= 60 ? line || "agent" : `${line.slice(0, 59)}…`;
}

/**
 * A child `resume` can revive, remembered under its label.
 *
 * The spawn options travel with it because `resume` deliberately takes none: the
 * revived child keeps the agent type, model and isolation it was started with,
 * and the progress entry has to show the same thing the first entry showed.
 */
export interface CompletedChild {
  agentId: string;
  label: string;
  agentType: string;
  model?: string;
  isolation?: "worktree";
}

/**
 * Hold a schema'd result to its schema, host-side.
 *
 * The child's own tool already validated whatever it passed, so this normally
 * agrees. It exists for the cases where nothing did: a host that ignores
 * `schema` entirely, a replayed journal entry from before the schema changed,
 * or a payload that reached us some other way. The script asked for a shape;
 * exactly one place should be able to promise it.
 */
export function applySchema(result: WorkflowSpawnResult, compiled: CompiledSchema): WorkflowSpawnResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.text ?? "");
  } catch {
    return {
      ...result,
      ok: false,
      error: "The agent did not return structured output: its answer was not JSON.",
    };
  }
  const verdict = compiled.check(parsed);
  if (verdict === true) return result;
  return {
    ...result,
    ok: false,
    error: `The agent's answer did not match the requested schema: ${verdict}`,
  };
}

export async function applyGate(
  result: WorkflowSpawnResult,
  command: string,
  agentId: string,
  runGate: NonNullable<WorkflowHost["runGate"]>,
): Promise<{ result: WorkflowSpawnResult; gate: WorkflowJournalGate }> {
  const outcome =
    result.gate ??
    (await runGate(command, {
      agentId,
      // Where the child worked, when it had a worktree of its own. Gating the
      // main tree instead would verify code the child never touched.
      ...(result.cwd !== undefined ? { cwd: result.cwd } : {}),
    }));
  const { gate: _ran, ...kept } = result;
  // Bounded here rather than at the journal write, so the one place that
  // decides what a gate means also decides how much of it is kept. The tail,
  // because a test run's summary is at the bottom.
  const trimmed = outcome.output.trim();
  const gate: WorkflowJournalGate = {
    ok: outcome.ok,
    output:
      trimmed.length <= GATE_OUTPUT_TAIL ? trimmed : `…${trimmed.slice(trimmed.length - GATE_OUTPUT_TAIL)}`,
    ...(outcome.cwd !== undefined ? { cwd: outcome.cwd } : {}),
  };
  if (outcome.ok) return { result: kept, gate };
  const { text: _discarded, ...rest } = kept;
  return {
    result: {
      ...rest,
      ok: false,
      error: trimmed === "" ? `Gate command failed: ${command}` : trimmed,
    },
    gate,
  };
}

/**
 * Nico's wording, kept verbatim — this is the one borrowed check whose message a
 * user is likely to search for.
 */
export function unawaitedLaunchMessage(labels: readonly string[]): string {
  const list = labels.map(label => `'${label}'`).join(", ");
  return `workflow script completed with unawaited agent launch(es): ${list}. Await or return each launch.`;
}
