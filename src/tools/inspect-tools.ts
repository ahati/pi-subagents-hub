import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { abortable } from "../abortable.js";
import { isTopLevelAgent } from "../agent-manager.js";
import { getAgentConversation, SUBAGENT_TOOL_NAMES, steerAgent } from "../agent-runner.js";
import { type CompletionOutbox, NOTIFICATION_HOLD_MS } from "../completion-outbox.js";
import { formatLifetimeTokens, markdownText, textResult } from "../entry/renderers.js";
import { getStatusNote, partialOutputSuffix } from "../status-note.js";
import type { AgentRecord } from "../types.js";
import { formatCost, formatDuration, getDisplayName } from "../ui/agent-widget.js";
import { getLifetimeCost, getSessionContextPercent, type PendingUsagePool } from "../usage.js";

const QUEUE_WAIT_POLL_MS = Math.floor(NOTIFICATION_HOLD_MS / 4);

export interface InspectToolsDeps {
  resolveAgentRef: (ref: string) => AgentRecord | undefined;
  isShowCostEnabled: () => boolean;
  outbox: CompletionOutbox;
  pi: ExtensionAPI;
}

export function withUsageReporting<T extends { execute: (...args: any[]) => any }>(
  tool: T,
  isReportUsageEnabled: () => boolean,
  pendingUsage: PendingUsagePool,
): T {
  return {
    ...tool,
    execute: async (toolCallId: string | undefined, ...rest: any[]) => {
      const result = await tool.execute(toolCallId, ...rest);
      if (!isReportUsageEnabled() || !toolCallId) return result;
      const usage = pendingUsage.drain();
      return usage ? { ...result, usage } : result;
    },
  };
}

export function registerToolReportingUsage(
  pi: ExtensionAPI,
  tool: any,
  isReportUsageEnabled: () => boolean,
  pendingUsage: PendingUsagePool,
): void {
  pi.registerTool(withUsageReporting(tool, isReportUsageEnabled, pendingUsage));
}

export function createGetResultTool(deps: InspectToolsDeps) {
  const { resolveAgentRef, isShowCostEnabled, outbox } = deps;

  return defineTool({
    name: SUBAGENT_TOOL_NAMES.GET_RESULT,
    label: "Get Agent Result",
    description:
      "Check status and retrieve a background agent's full result — its completion notification carries only a preview. Use the agent ID returned by Agent.",
    promptSnippet: "Check status and retrieve results from a background agent",
    parameters: Type.Object({
      agent_id: Type.String({
        description: "The agent ID to check. The agent's handle also works — its `name` if you gave it one, otherwise its type (`explore`, `explore-2`).",
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
    }),
    execute: async (_toolCallId, params, signal, _onUpdate, _ctx) => {
      const record = resolveAgentRef(params.agent_id);
      if (!record || !isTopLevelAgent(record)) {
        return textResult(`Agent not found: "${params.agent_id}". It may have been cleaned up.`);
      }

      if (params.wait && (record.status === "running" || record.status === "queued")) {
        while (record.status === "queued") {
          await abortable(
            new Promise<void>((resolve) => setTimeout(resolve, QUEUE_WAIT_POLL_MS)),
            signal,
          );
        }
        if (record.promise) await abortable(record.promise, signal);
      }

      const displayName = getDisplayName(record.type);
      const duration = formatDuration(record.startedAt, record.completedAt);
      const tokens = formatLifetimeTokens(record);
      const contextPercent = getSessionContextPercent(record.session);
      const statsParts = [`Tool uses: ${record.toolUses}`];
      if (tokens) statsParts.push(tokens);
      if (isShowCostEnabled()) {
        const costText = formatCost(getLifetimeCost(record.lifetimeUsage));
        if (costText) statsParts.push(`Cost: ${costText}`);
      }
      if (contextPercent !== null) statsParts.push(`Context: ${Math.round(contextPercent)}%`);
      if (record.compactionCount) statsParts.push(`Compactions: ${record.compactionCount}`);
      statsParts.push(`Duration: ${duration}`);

      const header =
        `Agent: ${record.id}\n` +
        `Type: ${displayName} | Status: ${record.status}${getStatusNote(record.status)} | ${statsParts.join(" | ")}\n` +
        `Description: ${record.description}\n\n`;

      let body: string;
      if (record.status === "running") {
        body = "Agent is still running. Use wait: true or check back later.";
      } else if (record.status === "error") {
        body = `Error: ${record.error}${partialOutputSuffix(record)}`;
      } else {
        body = record.result?.trim() || "No output.";
      }

      if (record.status !== "running" && record.status !== "queued") {
        record.resultConsumed = true;
        outbox.cancel(record.id);
      }

      let conversationPart: string | undefined;
      if (params.verbose && record.session) {
        const conversation = getAgentConversation(record.session);
        if (conversation) {
          conversationPart = `\n\n--- Agent Conversation ---\n${conversation}`;
        }
      }

      return textResult(header + body + (conversationPart ?? ""), { header, body, conversation: conversationPart });
    },

    renderResult(result, _options, theme, renderContext) {
      const text = result.content[0]?.type === "text" ? result.content[0].text ?? "" : "";
      if (renderContext.isError) return new Text(text, 0, 0);
      // The model-facing text is one flat string; the split lives in details.
      // Results captured before this renderer existed carry no split — plain text.
      const d = result.details as { header?: string; body?: string; conversation?: string } | undefined;
      if (!d?.header || d.body === undefined) return new Text(text, 0, 0);
      const entry = new Container();
      entry.addChild(new Text(d.header, 0, 0));
      entry.addChild(markdownText(d.body, theme));
      if (d.conversation) {
        // A log dump, not prose: dim per line, never markdown.
        entry.addChild(new Text(d.conversation.split("\n").map(l => theme.fg("dim", l)).join("\n"), 0, 0));
      }
      return entry;
    },
  });
}

export function createSteerTool(deps: InspectToolsDeps) {
  const { resolveAgentRef, isShowCostEnabled, pi } = deps;

  return defineTool({
    name: SUBAGENT_TOOL_NAMES.STEER,
    label: "Steer Agent",
    description:
      "Send a steering message to a running agent. The message will interrupt the agent after its current tool execution " +
      "and be injected into its conversation, allowing you to redirect its work mid-run. Only works on running agents.",
    promptSnippet: "Send a steering message to redirect a running background agent",
    parameters: Type.Object({
      agent_id: Type.String({
        description: "The agent ID to steer (must be currently running). The agent's handle also works — its `name` if you gave it one, otherwise its type (`explore`, `explore-2`).",
      }),
      message: Type.String({
        description: "The steering message to send. This will appear as a user message in the agent's conversation.",
      }),
    }),
    execute: async (_toolCallId, params, _signal, _onUpdate, _ctx) => {
      const record = resolveAgentRef(params.agent_id);
      if (!record || !isTopLevelAgent(record)) {
        return textResult(`Agent not found: "${params.agent_id}". It may have been cleaned up.`);
      }
      if (record.status !== "running") {
        return textResult(`Agent "${params.agent_id}" is not running (status: ${record.status}). Cannot steer a non-running agent.`);
      }
      if (!record.session) {
        if (!record.pendingSteers) record.pendingSteers = [];
        record.pendingSteers.push(params.message);
        pi.events.emit("subagents:steered", { id: record.id, message: params.message });
        return textResult(`Steering message queued for agent ${record.id}. It will be delivered once the session initializes.`);
      }

      try {
        await steerAgent(record.session, params.message);
        pi.events.emit("subagents:steered", { id: record.id, message: params.message });
        const tokens = formatLifetimeTokens(record);
        const contextPercent = getSessionContextPercent(record.session);
        const stateParts: string[] = [];
        if (tokens) stateParts.push(tokens);
        if (isShowCostEnabled()) {
          const costText = formatCost(getLifetimeCost(record.lifetimeUsage));
          if (costText) stateParts.push(costText);
        }
        stateParts.push(`${record.toolUses} tool ${record.toolUses === 1 ? "use" : "uses"}`);
        if (contextPercent !== null) stateParts.push(`context ${Math.round(contextPercent)}% full`);
        if (record.compactionCount) stateParts.push(`${record.compactionCount} compaction${record.compactionCount === 1 ? "" : "s"}`);
        return textResult(
          `Steering message sent to agent ${record.id}. The agent will process it after its current tool execution.\n` +
          `Current state: ${stateParts.join(" · ")}`,
        );
      } catch (err) {
        return textResult(`Failed to steer agent: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
  });
}
