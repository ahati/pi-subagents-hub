import { Text } from "@earendil-works/pi-tui";
import { hasAgentBadge, renderAgentName } from "../agent-color.js";
import { BACKGROUND_HINT_DELAY_MS, renderRunningAgentStatus } from "../entry/renderers.js";
import {
  type AgentDetails,
  fgPreservingNestedStyles,
  formatCost,
  formatMs,
  formatTurns,
  SPINNER,
  type Theme,
} from "../ui/agent-widget.js";

export function renderAgentToolCall(
  args: { subagent_type: string; description?: string; name?: string },
  theme: Theme,
  context: { isPartial?: boolean; isError?: boolean },
): Text {
  const rowBackground = hasAgentBadge(args.subagent_type) && theme.getBgAnsi
    ? theme.getBgAnsi(context.isPartial ? "toolPendingBg" : context.isError ? "toolErrorBg" : "toolSuccessBg")
    : "";
  const desc = args.description ?? "";
  const name = renderAgentName(args.subagent_type, theme, {
    fallbackColor: "toolTitle",
    restoreBackground: rowBackground,
    bold: true,
  }, typeof args.name === "string" && args.name ? args.name : undefined);
  return new Text(rowBackground + "▸ " + name + (desc ? "  " + theme.fg("muted", desc) : ""), 0, 0);
}

export function renderAgentToolResult(
  result: { content: Array<{ type: string; text?: string }>; details?: unknown },
  options: { expanded?: boolean; isPartial?: boolean },
  theme: Theme,
  renderContext: { isError?: boolean },
  showCost = false,
) {
  const details = result.details as AgentDetails | undefined;
  const text = result.content[0]?.type === "text" ? result.content[0].text ?? "" : "";
  if (renderContext.isError || !details?.status) {
    return new Text(text, 0, 0);
  }

  const stats = (d: AgentDetails) => {
    const parts: string[] = [];
    if (d.modelName) parts.push(d.modelName);
    if (d.tags) parts.push(...d.tags);
    if (d.turnCount != null && d.turnCount > 0) {
      parts.push(formatTurns(d.turnCount, d.maxTurns));
    }
    if (d.toolUses > 0) parts.push(`${d.toolUses} tool use${d.toolUses === 1 ? "" : "s"}`);
    if (d.tokens) parts.push(d.tokens);
    if (showCost) {
      const costText = formatCost(d.cost ?? 0);
      if (costText) parts.push(costText);
    }
    return parts.map(p => fgPreservingNestedStyles(theme, "dim", p)).join(" " + theme.fg("dim", "·") + " ");
  };

  if (options.isPartial || details.status === "running") {
    const frame = SPINNER[details.spinnerFrame ?? 0];
    const s = stats(details);
    const status = renderRunningAgentStatus(frame, s, details.activity ?? "thinking…", theme);
    if (details.backgroundHint && (details.durationMs ?? 0) >= BACKGROUND_HINT_DELAY_MS) {
      status.addChild(new Text(theme.fg("dim", "     (ctrl+b to run in background)"), 0, 0));
    }
    return status;
  }

  if (details.status === "background") {
    return new Text(theme.fg("dim", `  ⎿  Running in background (ID: ${details.agentId})`), 0, 0);
  }

  if (details.status === "completed" || details.status === "steered") {
    const duration = formatMs(details.durationMs ?? 0);
    const isSteered = details.status === "steered";
    const icon = isSteered ? theme.fg("warning", "✓") : theme.fg("success", "✓");
    const s = stats(details);
    let line = icon + (s ? " " + s : "");
    line += " " + theme.fg("dim", "·") + " " + theme.fg("dim", duration);

    if (options.expanded) {
      const resultText = result.content[0]?.type === "text" ? result.content[0].text ?? "" : "";
      if (resultText) {
        const lines = resultText.split("\n").slice(0, 50);
        for (const l of lines) {
          line += "\n" + theme.fg("dim", `  ${l}`);
        }
        if (resultText.split("\n").length > 50) {
          line += "\n" + theme.fg("muted", "  ... (use get_subagent_result with verbose for full output)");
        }
      }
    } else {
      const doneText = isSteered ? "Wrapped up (turn limit)" : "Done";
      line += "\n" + theme.fg("dim", `  ⎿  ${doneText}`);
    }
    return new Text(line, 0, 0);
  }

  if (details.status === "stopped") {
    const s = stats(details);
    let line = theme.fg("dim", "■") + (s ? " " + s : "");
    line += "\n" + theme.fg("dim", "  ⎿  Stopped");
    return new Text(line, 0, 0);
  }

  if (details.status !== "error" && details.status !== "aborted") {
    return new Text(text, 0, 0);
  }

  const s = stats(details);
  let line = theme.fg("error", "✗") + (s ? " " + s : "");

  if (details.status === "error") {
    line += "\n" + theme.fg("error", `  ⎿  Error: ${details.error ?? "unknown"}`);
  } else {
    line += "\n" + theme.fg("warning", "  ⎿  Aborted (max turns exceeded)");
  }

  return new Text(line, 0, 0);
}
