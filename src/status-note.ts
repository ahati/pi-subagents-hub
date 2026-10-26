/**
 * status-note.ts — Honest framing for an agent result: the parenthetical status
 * note for a non-normal outcome, and the salvaged partial output of a failure.
 *
 * Lives here rather than in an index.ts closure because both entry points need
 * it — the top-level tools and the nested delegation tools, which can't import
 * from index.ts (that is the extension entry, and it already reaches these tools
 * through agent-runner).
 */

import type { AgentQuestion, AgentRecord } from "./types.js";

/**
 * Explicit parenthetical note for a non-normal terminal outcome, so the parent
 * agent can't mistake partial output for a completed result. Empty string for a
 * clean completion (and any unknown/non-terminal status).
 *
 * `stopped` (a human aborted it) is deliberately distinct from `aborted` (the
 * turn limit was hit) — the parent should treat human intervention differently
 * from a budget cutoff.
 */
export function getStatusNote(status: string): string {
  switch (status) {
    case "stopped":
      return " (STOPPED BY THE USER before completion — output is partial; the task was NOT finished)";
    case "aborted":
      return " (aborted — hit the turn limit before completion; output may be incomplete)";
    case "steered":
      return " (wrapped up at the turn limit — output may be partial)";
    default:
      return "";
  }
}

/**
 * Foreground variant of `getStatusNote`. A foreground caller is in a different
 * position from a background one, so it needs different text:
 *
 *   - It already holds the agent's ENTIRE output inline, whereas the background
 *     notification carries a 500-char preview. So only here can we truthfully
 *     say there is nothing more to fetch — which is the whole point, because
 *   - it has no agent id. The id travels in the tool result's renderer
 *     `details`, which is never serialized to the model. A parent that reads
 *     "output may be partial" as "truncated, go retrieve the rest" therefore
 *     has nothing valid to call `get_subagent_result` with, and will invent an
 *     id (#174).
 *
 * Only the lead clause varies between the three, and each variation carries
 * information: `wrapped up` vs `aborted` tells the parent whether the output is
 * a considered final answer or a fragment, and `stopped` shouts because a human
 * intervening outranks everything else in the string. Only `steered` hedges on
 * completion — it was told to wrap up and did, so it may well have finished at
 * the limit; an aborted run blew through its grace turns while still working,
 * and `stopped` can only fire on a running agent, so neither ever delivered a
 * final answer. Identical confidence gets identical wording: phrasing one fact
 * two ways invites a hunt for a distinction that isn't there.
 *
 * Every clause is a statement about state, never an instruction to act, and
 * `get_subagent_result` is never named — naming the tool we steer away from only
 * raises its salience. Two instructions were tried here and cut: "re-spawn with
 * a higher max_turns" (pushes a fresh multi-minute run to save one wasted tool
 * call) and, on `stopped`, "ask before restarting it" (restates the lead, and
 * presumes someone is present to ask — false under `pi -p`, in scheduled jobs,
 * and in any background-driven run). Nothing here can measure whether wording
 * improves parent behavior, so removing a false cue (which cannot induce new
 * behavior) and adding an instruction (which can) are not equally safe bets.
 * Don't add either back without a way to measure it.
 */
export function getForegroundOutcomeNote(status: string): string {
  switch (status) {
    case "stopped":
      return " (STOPPED BY THE USER — everything the agent produced is above; the task is unfinished)";
    case "aborted":
      return " (aborted at the turn limit — everything the agent produced is above; the task is unfinished)";
    case "steered":
      return " (wrapped up at the turn limit — everything the agent produced is above; the task may be unfinished)";
    default:
      return "";
  }
}

/**
 * Salvaged partial output of a failed run, as a labeled suffix for the error
 * surfaces (or "" if the run produced nothing). `record.result` is bounded to
 * the run's own turns, so this is never a stale earlier answer (#144).
 */
export function partialOutputSuffix(record: AgentRecord): string {
  const partial = record.result?.trim();
  return partial ? `\n\nPartial output before the failure:\n${partial}` : "";
}

/**
 * The question card steered to an answerer — a nested owner's session or the
 * root session. Fixed headers, never child-authored prose markers: the
 * recipient must be able to tell a question from the child's own output, and
 * the `answer_subagent` invocation line is the only reply path named.
 */
export function formatQuestionCard(child: AgentRecord, q: AgentQuestion): string {
  const lines = [
    `[SUBAGENT QUESTION] ${child.type} "${child.description}" (agent id: ${child.id}, question ${q.id})`,
    `Q: ${q.question}`,
  ];
  if (q.context) lines.push(`Context: ${q.context}`);
  if (q.assumption) lines.push(`Child will proceed with: ${q.assumption}`);
  lines.push(`Reply with answer_subagent(agent_id: "${child.id}", question_id: "${q.id}", answer: "...").`);
  return lines.join("\n");
}

/** The answer steered back into the asking child. */
export function formatAnswerSteer(q: AgentQuestion): string {
  return `[ANSWER to your ask_parent ${q.id}] ${q.answer}\nContinue with this answer; do not re-ask the same question.`;
}

/**
 * Result-time footer for questions the child finished without an answer — the
 * safety net when no answerer reached it mid-run (a blocked owner chain, an
 * unread card, an aborted root turn). Formatted from the questions field at
 * read time, never stored into `result`; empty when there is nothing to ask.
 */
export function openQuestionsFooter(record: AgentRecord): string {
  const open = record.questions?.filter(q => q.state === "open" || q.state === "delivered");
  if (!open?.length) return "";
  return open.map(q => {
    const assumption = q.assumption ? `otherwise it proceeded with: ${q.assumption}.` : "otherwise it proceeded on its own judgment.";
    return `[QUESTION for you, question ${q.id}] ${q.question}\nThis agent finished without an answer. Resume it with the answer if it matters; ${assumption}`;
  }).join("\n\n");
}
