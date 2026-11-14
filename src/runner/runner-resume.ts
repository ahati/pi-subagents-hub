/**
 * runner-resume.ts — agent resumption, steering, and conversation formatting.
 */

import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { extractText } from "../context.js";
import { continueSessionBare } from "../session-continue.js";
import { clearDurableContextUsage } from "../usage.js";
import {
  collectResponseText,
  finalTurnError,
  forwardAbortSignal,
  getLastAssistantText,
  observeRun,
} from "./runner-helpers.js";
import { resolveEffectiveMaxTurns } from "./runner-settings.js";
import type { ResumeAgentOptions, RunResult } from "./runner-types.js";

/**
 * Continue an existing session.
 */
export async function resumeAgent(
  session: AgentSession,
  options: ResumeAgentOptions,
): Promise<{ text: string; failure?: string } & Pick<RunResult, "aborted" | "steered">>;
export async function resumeAgent(
  session: AgentSession,
  prompt: string,
  options: ResumeAgentOptions,
): Promise<{ text: string; failure?: string } & Pick<RunResult, "aborted" | "steered">>;
export async function resumeAgent(
  session: AgentSession,
  promptOrOptions: string | ResumeAgentOptions,
  optionsArg?: ResumeAgentOptions,
): Promise<{ text: string; failure?: string } & Pick<RunResult, "aborted" | "steered">> {
  const prompt = typeof promptOrOptions === "string" ? promptOrOptions : undefined;
  const options: ResumeAgentOptions = typeof promptOrOptions === "string" ? optionsArg! : promptOrOptions;
  clearDurableContextUsage(session);
  const startLen = session.messages.length;
  const collector = collectResponseText(session);
  const cleanupAbort = forwardAbortSignal(session, options.signal);
  const run = observeRun(session, { ...options, maxTurns: resolveEffectiveMaxTurns(options.type, options.maxTurns) });

  let failure: string | undefined;
  let finalText = "";
  try {
    if (prompt !== undefined) {
      if (options.signal?.aborted !== true) await session.prompt(prompt);
    } else {
      try {
        const result = await continueSessionBare(session, { execute: options.execute, signal: options.signal });
        finalText = result.finalText ?? "";
        failure = result.continuationError;
      } catch (err) {
        failure = err instanceof Error ? err.message : String(err);
      }
    }

    const stopped = () =>
      options.signal?.aborted === true ||
      run.aborted ||
      run.steered ||
      finalTurnError(session, startLen) !== undefined;

    if (!failure && !stopped()) {
      for (;;) {
        if (
          session.agent?.hasQueuedMessages?.() &&
          typeof session.agent?.continue === "function"
        ) {
          await session.agent.continue();
          if (stopped()) break;
        }
        const waited = await options.waitForBackgroundChild?.();
        if (
          !waited &&
          !(session.agent?.hasQueuedMessages?.() && typeof session.agent?.continue === "function")
        ) break;
        if (stopped()) break;
      }
    }
  } finally {
    collector.unsubscribe();
    run.unsubscribe();
    cleanupAbort();
  }

  return {
    text: collector.getText().trim() || getLastAssistantText(session, startLen) || finalText,
    failure: finalTurnError(session, startLen) ?? failure,
    aborted: options.signal?.aborted === true || run.aborted,
    steered: run.steered,
  };
}

/**
 * Send a steering message to a running subagent.
 * The message will interrupt the agent after its current tool execution.
 */
export async function steerAgent(
  session: AgentSession,
  message: string,
): Promise<void> {
  await session.steer(message);
}

/**
 * Get the subagent's conversation messages as formatted text.
 */
export function getAgentConversation(session: AgentSession): string {
  const parts: string[] = [];

  for (const msg of session.messages) {
    if (msg.role === "user") {
      const text = typeof msg.content === "string"
        ? msg.content
        : extractText(msg.content);
      if (text.trim()) parts.push(`[User]: ${text.trim()}`);
    } else if (msg.role === "assistant") {
      const textParts: string[] = [];
      const toolCalls: string[] = [];
      for (const c of msg.content) {
        if (c.type === "text" && c.text) textParts.push(c.text);
        else if (c.type === "toolCall") toolCalls.push(`  Tool: ${(c as any).name ?? (c as any).toolName ?? "unknown"}`);
      }
      if (textParts.length > 0) parts.push(`[Assistant]: ${textParts.join("\n")}`);
      if (toolCalls.length > 0) parts.push(`[Tool Calls]:\n${toolCalls.join("\n")}`);
    } else if (msg.role === "toolResult") {
      const text = extractText(msg.content);
      const truncated = text.length > 200 ? text.slice(0, 200) + "..." : text;
      parts.push(`[Tool Result (${msg.toolName})]: ${truncated}`);
    }
  }

  return parts.join("\n\n");
}
