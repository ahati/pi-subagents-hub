import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentManager } from "../agent-manager.js";
import { getAgentConfig, getAvailableTypes, getConfig } from "../agent-types.js";
import { type PauseContinueDeps, resumeAgentById, reviveTombstone } from "../commands/pause-continue.js";
import {
  describeMention,
  handleBase,
  isReservedHandle,
  parseMention,
  resolveHandleToType,
  stripAgentPrefix,
} from "../mention.js";
import { runMentionClone } from "../mention-clone.js";
import { getOutputTranscriptDefault } from "../output-file.js";
import type { AgentMentionMode, AgentRecord } from "../types.js";
import { createMentionProvider, mentionRoster, type TypeInfo } from "../ui/agent-mention.js";

export interface MentionHookDeps {
  manager: AgentManager;
  isAgentMentionsEnabled: () => boolean;
  getAgentMentionMode: () => AgentMentionMode;
  startBackgroundResume: (
    ctx: ExtensionContext,
    existing: AgentRecord,
    prompt: string | undefined,
    opts: { outputTranscript: boolean; maxTurns?: number; toolCallId?: string },
  ) => Promise<AgentRecord | undefined>;
  resumeTurnLimit: (record: AgentRecord, explicit?: number) => number | undefined;
  registeredAgentTool: any;
  spawnTopLevel: (piRef: any, ctxRef: any, type: string, prompt: string, options: any) => string;
  pauseDeps: PauseContinueDeps;
}

export const mentionTypes = (): TypeInfo[] =>
  getAvailableTypes().map(name => ({ name, description: getAgentConfig(name)?.description ?? name }));

export function registerMentionProvider(
  ctx: ExtensionContext,
  deps: MentionHookDeps,
  state: { mentionProviderRegistered: boolean },
): void {
  if (ctx.mode === "tui" && !state.mentionProviderRegistered) {
    state.mentionProviderRegistered = true;
    ctx.ui.addAutocompleteProvider(current =>
      createMentionProvider(
        current,
        () => mentionRoster(deps.manager, mentionTypes(), type => getConfig(type).displayName),
        deps.isAgentMentionsEnabled,
      ),
    );
  }
}

export function registerMentionInputHook(pi: ExtensionAPI, deps: MentionHookDeps): void {
  const {
    manager,
    isAgentMentionsEnabled,
    getAgentMentionMode,
    startBackgroundResume,
    resumeTurnLimit,
    registeredAgentTool,
    spawnTopLevel,
    pauseDeps,
  } = deps;

  // Start a mentioned agent the direct way. runAgent resolves model, thinking,
  // max turns and `isolated` from the agent's own config when the spawn omits
  // them, but not `inherit_context`: an RPC caller decides that one itself. A
  // mention is the user starting the agent from this session, so the file does —
  // reloaded first, as the spawn reloads it, so a mid-session edit is not missed.
  const startMentioned = (ctx: ExtensionContext, type: string, message: string) => {
    pauseDeps.reloadCustomAgents();
    return spawnTopLevel(pi, ctx, type, message, {
      description: describeMention(message),
      isBackground: true,
      inheritContext: getAgentConfig(type)?.inheritContext,
    });
  };

  pi.on("input", async (event, ctx) => {
    if (event.source === "extension" || !isAgentMentionsEnabled()) return { action: "continue" };

    const canDispatchDirectly = ctx.mode === "tui";
    if (!canDispatchDirectly && getAgentMentionMode() !== "model") return { action: "continue" };

    const mention = parseMention(event.text);
    if (!mention) return { action: "continue" };

    if (isReservedHandle(mention.handle)) {
      return { action: "transform", text: mention.message, ...(event.images && { images: event.images }) };
    }

    const alias = stripAgentPrefix(mention.handle);
    const resolved = manager.resolveMention(mention.handle)
      ?? (alias ? manager.resolveMention(alias) : undefined);

    if (resolved && !canDispatchDirectly) return { action: "continue" };

    if (resolved?.kind === "live") {
      const record = resolved.record;
      const target = `@${mention.handle}`;

      if (record.status === "running" || record.status === "queued") {
        record.resultConsumed = false;
        try {
          if (!await manager.steer(record.id, mention.message)) throw new Error("Agent is not running");
          ctx.ui.notify(`Sent to ${target}`, "info");
        } catch (err) {
          ctx.ui.notify(`Failed to send to ${target}: ${err instanceof Error ? err.message : String(err)}`, "error");
        }
        return { action: "handled" };
      }

      if (record.session) {
        const wasPaused = record.status === "paused";
        const resumedRecord = await startBackgroundResume(ctx, record, mention.message, {
          outputTranscript: getAgentConfig(record.type)?.outputTranscript ?? getOutputTranscriptDefault(),
          maxTurns: resumeTurnLimit(record),
        });
        if (resumedRecord && wasPaused) {
          for (const child of manager.listAgents()) {
            if (child.parentAgentId === record.id && child.workflowId === undefined && child.status === "paused") {
              await resumeAgentById(ctx, child, pauseDeps);
            }
          }
        }
        ctx.ui.notify(
          resumedRecord ? `Resuming ${target}` : `Could not resume ${target} — it is still running.`,
          resumedRecord ? "info" : "warning",
        );
        return { action: "handled" };
      }
    }

    if (resolved?.kind === "tombstone") {
      await reviveTombstone(ctx, resolved.entry, mention.message, "Resuming", pauseDeps, mention.handle);
      return { action: "handled" };
    }

    const typeHandle = mention.handle;
    const type = resolveHandleToType(typeHandle, getAvailableTypes())
      ?? (alias ? resolveHandleToType(alias, getAvailableTypes()) : undefined);
    if (!type) return { action: "continue" };

    if (getAgentMentionMode() === "model") {
      const label = `@${handleBase(type)}`;
      ctx.ui.notify(`Prompting ${label}…`, "info");
      void runMentionClone({ ctx, type, message: mention.message, agentTool: registeredAgentTool })
        .then(async (result) => {
          if (result.spawned) return;
          try {
            const id = startMentioned(ctx, type, mention.message);
            await manager.awaitStartup(id);
            ctx.ui.notify(`Started ${label} directly — ${result.error}`, "warning");
          } catch (err) {
            ctx.ui.notify(
              `Could not start ${label}: ${err instanceof Error ? err.message : String(err)}`,
              "error",
            );
          }
        });
      return { action: "handled" };
    }

    try {
      // The manager's onStart/onComplete callbacks own the widget, the fleet list
      // and the completion notification — the same contract the scheduler and
      // cross-extension RPC spawns run under.
      const id = startMentioned(ctx, type, mention.message);
      await manager.awaitStartup(id);
      ctx.ui.notify(`Started @${handleBase(type)}`, "info");
    } catch (err) {
      ctx.ui.notify(`Could not start @${handleBase(type)}: ${err instanceof Error ? err.message : String(err)}`, "error");
    }
    return { action: "handled" };
  });
}
