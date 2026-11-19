import type { Model } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { resolveModel } from "../model-resolver.js";
import { checkModelScope } from "../model-scope.js";
import { formatAnswerSteer } from "../status-note.js";
import type { AgentQuestion, AgentRecord } from "../types.js";

export const getSubagentResultSchema = Type.Object({
  agent_id: Type.String({
    description: 'The agent name (e.g. "bold-curie") or ID to check. Also accepts type handles like "@explore".',
  }),
  wait: Type.Optional(
    Type.Boolean({
      description: "If true, wait for the agent to complete before returning. Default: false.",
    }),
  ),
  verbose: Type.Optional(
    Type.Boolean({
      description: "If true, include the agent's full conversation (messages + tool calls). Default: false.",
    }),
  ),
});

export const getNestedResultSchema = Type.Object({
  agent_id: Type.String({
    description: "The nested agent ID to check.",
  }),
  wait: Type.Optional(
    Type.Boolean({
      description: "If true, wait for the nested agent to complete before returning. Default: false.",
    }),
  ),
});

export const steerNestedSchema = Type.Object({
  agent_id: Type.String({
    description: "The nested agent ID to steer.",
  }),
  message: Type.String({
    description: "The steering message to send.",
  }),
});

export const answerSubagentSchema = Type.Object({
  agent_id: Type.String({
    description: 'The asking agent\'s name (e.g. "bold-curie") or ID, from the question card. Also accepts type handles.',
  }),
  question_id: Type.Optional(
    Type.String({ description: "Which question to answer. Defaults to the agent's oldest open question." }),
  ),
  answer: Type.String({ description: "The decision or fact the agent asked for." }),
});

/**
 * The nested `answer_subagent` tool's parameters: nested children have no
 * handles and resolve by record ID only, so the description must not promise
 * name/type-handle resolution the way the top-level tool's does.
 */
export const answerNestedSchema = Type.Object({
  agent_id: Type.String({
    description: "The asking agent's ID, from the question card.",
  }),
  question_id: Type.Optional(
    Type.String({ description: "Defaults to the agent's oldest open question." }),
  ),
  answer: Type.String({ description: "The decision or fact the agent asked for." }),
});

export function shouldWaitForRecord(record: AgentRecord, waitRequested = false): boolean {
  return (
    (waitRequested && (record.status === "running" || record.status === "queued")) ||
    (Boolean(record.worktree) && record.status !== "running" && record.status !== "queued" && record.status !== "paused")
  );
}

export interface TargetQuestionResult {
  question?: AgentQuestion;
  closedReason?: string;
}

export function resolveTargetQuestion(
  record: AgentRecord | undefined,
  questionId?: string,
): TargetQuestionResult {
  const qs = record?.questions ?? [];
  const q = questionId
    ? qs.find((x) => x.id === questionId)
    : qs.find((x) => x.state === "open" || x.state === "delivered") ?? qs[qs.length - 1];

  if (!q || (q.state !== "open" && q.state !== "delivered")) {
    const closed = !q
      ? ""
      : q.state === "superseded"
        ? " — it was superseded by a later ask"
        : q.state === "dropped"
          ? ` — it was dropped when the run ended in failure or was aborted; it asked: "${q.question}"`
          : ` — its state is ${q.state}`;
    return { closedReason: closed };
  }
  return { question: q };
}

export interface DeliverQuestionAnswerOptions {
  record: AgentRecord;
  question: AgentQuestion;
  answer: string;
  answeredBy: string;
  steer?: (session: AgentSession, message: string) => Promise<void>;
}

export async function deliverQuestionAnswer(
  opts: DeliverQuestionAnswerOptions,
): Promise<{ success: true } | { success: false; error: string }> {
  const { record, question: q, answer, answeredBy, steer } = opts;
  const priorState = q.state;
  q.state = "answered";
  q.answer = answer;
  q.answeredBy = answeredBy;
  const message = formatAnswerSteer(q);

  try {
    if (!record.session) {
      record.pendingSteers = [...(record.pendingSteers ?? []), message];
    } else if (steer) {
      await steer(record.session, message);
    } else {
      await record.session.steer(message);
    }
    return { success: true };
  } catch (err) {
    q.state = priorState;
    q.answer = undefined;
    q.answeredBy = undefined;
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function queueOrSteerAgent(opts: {
  record: AgentRecord;
  message: string;
  steer?: (session: AgentSession, message: string) => Promise<void>;
}): Promise<{ queued: boolean } | { error: string }> {
  if (!opts.record.session) {
    if (!opts.record.pendingSteers) opts.record.pendingSteers = [];
    opts.record.pendingSteers.push(opts.message);
    return { queued: true };
  }
  try {
    if (opts.steer) {
      await opts.steer(opts.record.session, opts.message);
    } else {
      await opts.record.session.steer(opts.message);
    }
    return { queued: false };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

export interface ResolveAndScopeModelOptions {
  modelInput?: string;
  callerSupplied: boolean;
  fallbackModel?: Model<any>;
  modelRegistry: Parameters<typeof resolveModel>[1];
  cwd: string;
  agentLabel: string;
  onWarn?: (message: string) => void;
}

export type ResolveAndScopeModelResult =
  | { success: true; model: Model<any> | undefined }
  | { success: false; error: string };

/**
 * Resolve the model for a spawn and enforce the scopeModels policy.
 *
 * Gates on `modelInput !== undefined` — host.ts's original semantics. The
 * Agent tool and nested spawns previously skipped resolution for a falsy
 * (empty-string) input; an explicit empty `model` from the caller now
 * resolves and reports instead of silently falling back.
 */
export function resolveAndScopeModel(opts: ResolveAndScopeModelOptions): ResolveAndScopeModelResult {
  let model: Model<any> | undefined = opts.fallbackModel;
  if (opts.modelInput !== undefined) {
    const resolved = resolveModel(opts.modelInput, opts.modelRegistry);
    if (typeof resolved === "string") {
      if (opts.callerSupplied) {
        return { success: false, error: resolved };
      }
    } else {
      model = resolved;
    }
  }

  const scopeVerdict = checkModelScope({
    model,
    cwd: opts.cwd,
    modelRegistry: opts.modelRegistry,
    callerSupplied: opts.callerSupplied,
    agentLabel: opts.agentLabel,
    modelInput: opts.modelInput,
  });

  if (scopeVerdict.kind === "error") {
    return { success: false, error: scopeVerdict.message };
  }
  if (scopeVerdict.kind === "warn" && opts.onWarn) {
    opts.onWarn(scopeVerdict.message);
  }

  return { success: true, model };
}
