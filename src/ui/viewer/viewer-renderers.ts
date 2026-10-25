/**
 * viewer-renderers.ts — Tool-renderer resolution for ConversationViewer.
 *
 * The same merge pi's main window does: the session's own tool definition
 * wins; pi's built-in renderers (loaded by `loadBuiltinRenderers`) fill the
 * gaps. The merged pair is handed to `ToolExecutionComponent`, which owns
 * everything else — render contexts, state handback, fallbacks, expansion.
 */

import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { ToolRenderers } from "./viewer-types.js";

export function resolveRenderers(
  session: AgentSession,
  builtinRenderers: Record<string, ToolRenderers> | undefined,
  toolName: string,
): ToolRenderers | undefined {
  let def: any;
  try {
    def = session.getToolDefinition?.(toolName);
  } catch {
    def = undefined;
  }
  const builtin = builtinRenderers?.[toolName];
  const merged: ToolRenderers = {
    renderCall: def?.renderCall ?? builtin?.renderCall,
    renderResult: def?.renderResult ?? builtin?.renderResult,
  };
  if (!merged.renderCall && !merged.renderResult) return undefined;
  return merged;
}
