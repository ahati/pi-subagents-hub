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

/** The slice of `ExtensionRunner` the viewer needs; cast at the boundary because our renderers are loosely typed. */
interface RendererChainHost {
  resolveToolRenderers?(toolName: string, base: () => ToolRenderers | undefined): ToolRenderers | undefined;
}

/**
 * The same resolution the main window does: extension chain first
 * (`registerToolRenderer` — renderer extensions such as pi-ui-enhancement),
 * the session's own definition next, pi's built-ins last.
 */
export function resolveRenderers(
  session: AgentSession,
  builtinRenderers: Record<string, ToolRenderers> | undefined,
  toolName: string,
): ToolRenderers | undefined {
  const base = (): ToolRenderers | undefined => {
    let def: any;
    try {
      def = session.getToolDefinition?.(toolName);
    } catch {
      def = undefined;
    }
    const builtin = builtinRenderers?.[toolName];
    const merged: ToolRenderers = {
      renderShell: def?.renderShell ?? builtin?.renderShell,
      renderCall: def?.renderCall ?? builtin?.renderCall,
      renderResult: def?.renderResult ?? builtin?.renderResult,
    };
    if (!merged.renderCall && !merged.renderResult) return undefined;
    return merged;
  };
  const runner = session.extensionRunner as unknown as RendererChainHost | undefined;
  return runner?.resolveToolRenderers?.call(runner, toolName, base) ?? base();
}
