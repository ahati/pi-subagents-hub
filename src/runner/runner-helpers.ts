/**
 * runner-helpers.ts — session text collection, error extraction, abort forwarding, and run observation.
 */

import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { extractText } from "../context.js";
import { getGraceTurns } from "./runner-settings.js";
import type { RunOptions } from "./runner-types.js";

/**
 * Subscribe to a session and collect the last assistant message text.
 * Returns an object with a `getText()` getter and an `unsubscribe` function.
 */
export function collectResponseText(session: AgentSession): { getText: () => string; unsubscribe: () => void } {
  let text = "";
  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "message_start" && event.message.role === "assistant") {
      text = "";
    }
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      text += event.assistantMessageEvent.delta;
    }
  });
  return { getText: () => text, unsubscribe };
}

/**
 * Get the last non-empty assistant text produced during THIS invocation.
 */
export function getLastAssistantText(session: AgentSession, startIndex = 0): string {
  for (let i = session.messages.length - 1; i >= startIndex; i--) {
    const msg = session.messages[i];
    if (msg.role !== "assistant") continue;
    const text = extractText(msg.content).trim();
    if (text) return text;
  }
  return "";
}

/**
 * Error message of THIS invocation's final assistant message, when that turn
 * failed.
 */
export function finalTurnError(session: AgentSession, startIndex = 0): string | undefined {
  for (let i = session.messages.length - 1; i >= startIndex; i--) {
    const msg = session.messages[i];
    if (msg.role !== "assistant") continue;
    if (msg.stopReason === "error") {
      return (msg as { errorMessage?: string }).errorMessage?.trim() || "provider error with no output";
    }
    if (msg.stopReason === "length" && !extractText(msg.content).trim()) {
      return "run hit the output token limit before producing any text";
    }
    return undefined;
  }
  return undefined;
}

/** The per-run callbacks a spawn and a resume share, plus the resolved turn limit. */
export type RunObserverOptions = Pick<RunOptions, "onTurnEnd" | "onTextDelta" | "onToolActivity" | "onAssistantUsage" | "onCompaction"> & {
  /** Already resolved: undefined = unlimited. */
  maxTurns?: number;
};

/**
 * Observe one prompt of a session — a spawn's or a resume's — and enforce its
 * turn limit: steer once at `maxTurns`, hard-abort after the grace turns.
 */
export function observeRun(session: AgentSession, options: RunObserverOptions): {
  steered: boolean;
  aborted: boolean;
  unsubscribe: () => void;
} {
  let turnCount = 0;
  let currentMessageText = "";
  const run = {
    steered: false,
    aborted: false,
    unsubscribe: () => {},
  };
  const graceTurns = getGraceTurns();
  run.unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "turn_end") {
      turnCount++;
      options.onTurnEnd?.(turnCount);
      if (options.maxTurns != null) {
        if (!run.steered && turnCount >= options.maxTurns) {
          run.steered = true;
          session.steer("You have reached your turn limit. Wrap up immediately — provide your final answer now.");
        } else if (run.steered && turnCount >= options.maxTurns + graceTurns) {
          run.aborted = true;
          session.abort();
        }
      }
    }
    if (event.type === "message_start") {
      currentMessageText = "";
    }
    if (event.type === "message_update") {
      const ame = event.assistantMessageEvent;
      if (ame.type === "text_delta") {
        currentMessageText += ame.delta;
        options.onTextDelta?.(ame.delta, currentMessageText);
      } else if (ame.type === "toolcall_start") {
        const item = ame.partial.content[ame.contentIndex];
        if (item && item.type === "toolCall") {
          options.onToolActivity?.({
            type: "start",
            toolName: item.name,
            toolCallId: item.id,
            args: item.arguments,
          });
        }
      } else if (ame.type === "toolcall_end") {
        options.onToolActivity?.({
          type: "start",
          toolName: ame.toolCall.name,
          toolCallId: ame.toolCall.id,
          args: ame.toolCall.arguments,
        });
      }
    }
    if (event.type === "tool_execution_start") {
      options.onToolActivity?.({ type: "start", toolName: event.toolName, toolCallId: event.toolCallId, args: event.args });
    }
    if (event.type === "tool_execution_end") {
      options.onToolActivity?.({ type: "end", toolName: event.toolName, toolCallId: event.toolCallId });
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      const u = (event.message as any).usage;
      if (u) options.onAssistantUsage?.({
        input: u.input ?? 0,
        output: u.output ?? 0,
        cacheWrite: u.cacheWrite ?? 0,
        cacheRead: u.cacheRead ?? 0,
        cost: u.cost?.total ?? 0,
      });
    }
    if (event.type === "compaction_end" && !event.aborted && event.result) {
      options.onCompaction?.({ reason: event.reason, tokensBefore: event.result.tokensBefore });
    }
  });
  return run;
}

/**
 * Wire an AbortSignal to abort a session.
 * Returns a cleanup function to remove the listener.
 */
export function forwardAbortSignal(session: AgentSession, signal?: AbortSignal): () => void {
  if (!signal) return () => {};
  const onAbort = () => session.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}

export function resolveConfiguredSessionDir(sessionDir: string | undefined, cwd: string): string | undefined {
  if (!sessionDir) return undefined;
  if (sessionDir === "~" || sessionDir.startsWith("~/")) return resolve(homedir(), sessionDir.slice(2));
  if (isAbsolute(sessionDir)) return sessionDir;
  return resolve(cwd, sessionDir);
}
