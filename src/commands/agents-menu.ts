import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import {
  type ExtensionAPI,
  type ExtensionCommandContext,
  getSettingsListTheme,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  type SettingItem,
  SettingsList,
  Spacer,
  Text,
} from "@earendil-works/pi-tui";
import { locateAgentFile } from "../agent-file-toggle.js";
import { type AgentManager, isTopLevelAgent } from "../agent-manager.js";
import { rowDescription, sourceIndicator, sourceLegend } from "../agent-source-badge.js";
import { getAgentConfig, getAllTypes } from "../agent-types.js";
import { stripAgentPrefix } from "../mention.js";
import { type ModelRegistry, resolveModel } from "../model-resolver.js";
import { packageNameForPath } from "../package-resources.js";
import type { SubagentScheduler } from "../schedule.js";
import { getModelLabelFromConfig } from "../tools/agent-tool-schema.js";
import type { AgentConfig, AgentRecord, AgentTombstone } from "../types.js";
import { formatDuration, getDisplayName } from "../ui/agent-widget.js";
import type { FleetList } from "../ui/fleet-list.js";
import { showSchedulesMenu } from "../ui/schedule-menu.js";
import { selectItem } from "../ui/select-item.js";
import { showWorkflowsMenu, type WorkflowMenuDeps } from "../ui/workflow-menu.js";
import type { WorkflowTask } from "../workflow/task.js";
import {
  disableAgent,
  ejectAgent,
  enableAgent,
  showCreateWizard,
} from "./agent-wizards.js";
import {
  type PauseContinueDeps,
  pauseAgentRecord,
  resumeAgentById,
  reviveTombstone,
} from "./pause-continue.js";
import { recordName } from "./pause-state.js";

export interface AgentsMenuDeps {
  pi: ExtensionAPI;
  manager: AgentManager;
  fleet: FleetList;
  scheduler: SubagentScheduler;
  workflowTasks: Map<string, WorkflowTask>;
  workflowMenuDeps: WorkflowMenuDeps;
  pauseDeps: PauseContinueDeps;
  reloadCustomAgents: () => void;
  isWorkflowsEnabled: () => boolean;
  showSettings: (ctx: ExtensionCommandContext) => Promise<void>;
}

export function resolveCommandTarget(
  name: string,
  manager: AgentManager,
): { record: AgentRecord } | { tombstone: AgentTombstone } | undefined {
  const stripped = name.replace(/^@/, "").trim();
  const alias = stripAgentPrefix(stripped);
  const resolved = manager.resolveMention(stripped)
    ?? (alias ? manager.resolveMention(alias) : undefined);
  if (!resolved) return undefined;
  return resolved.kind === "live" ? { record: resolved.record } : { tombstone: resolved.entry };
}

export function getModelLabel(type: string, registry?: ModelRegistry): string {
  const cfg = getAgentConfig(type);
  if (!cfg?.model) return "inherit";
  const label = getModelLabelFromConfig(cfg.model);
  if (!registry) return label;
  const resolved = resolveModel(cfg.model, registry);
  if (typeof resolved === "string") return `${label} (unavailable, fallback: inherit)`;
  const resolvedFull = `${resolved.provider}/${resolved.id}`;
  const norm = (s: string) => s.toLowerCase().replace(/\./g, "-").replace(/-\d{8}$/, "");
  if (norm(cfg.model) === norm(resolvedFull)) return label;
  return `${label} (→ ${resolvedFull.replace(/-\d{8}$/, "")})`;
}

export function packageNameOf(cfg: AgentConfig | undefined): string | undefined {
  if (cfg?.source !== "package" || !cfg.sourcePath) return undefined;
  return packageNameForPath(cfg.sourcePath, process.cwd());
}

export async function pauseAgentsCommand(ctx: ExtensionCommandContext, target: string | undefined, deps: PauseContinueDeps) {
  const { pi, manager, park } = deps;
  if (target !== undefined) {
    const resolved = resolveCommandTarget(target, manager);
    const record = resolved && "record" in resolved ? resolved.record : undefined;
    if (!record) {
      ctx.ui.notify(`No active agent named @${target.replace(/^@/, "")}.`, "warning");
      return;
    }
    const name = recordName(record);
    if (record.status !== "running" && record.status !== "queued") {
      ctx.ui.notify(`@${name} is not active (${record.status}).`, "warning");
      return;
    }
    const refusal = pauseAgentRecord(record, pi, manager);
    if (refusal) {
      ctx.ui.notify(`Could not pause @${name} — ${refusal}.`, "warning");
      return;
    }
    ctx.ui.notify(`Paused @${name}.`, "info");
    return;
  }

  const captured = park.captureSettledResults(ctx, manager, () => deps.reloadCustomAgents());
  const active = manager.listAgents().filter(isTopLevelAgent)
    .filter(a => a.status === "running" || a.status === "queued");
  if (active.length === 0) {
    ctx.ui.notify(
      captured > 0
        ? `No active agents — captured ${captured} completed result${captured === 1 ? "" : "s"} for /continue.`
        : "No active agents.",
      "info",
    );
    return;
  }
  let paused = 0;
  let skipped = 0;
  for (const record of active) {
    if (pauseAgentRecord(record, pi, manager) === undefined) paused++;
    else skipped++;
  }
  ctx.ui.notify(
    `Paused ${paused} agent${paused === 1 ? "" : "s"}` +
    (captured > 0 ? `; captured ${captured} completed result${captured === 1 ? "" : "s"} for /continue` : "") +
    (skipped > 0 ? ` — ${skipped} skipped (foreground or worktree-isolated)` : "") + ".",
    "info",
  );
}

export async function resumeAgentsCommand(ctx: ExtensionCommandContext, target: string | undefined, deps: PauseContinueDeps) {
  const { manager } = deps;
  if (target !== undefined) {
    const resolved = resolveCommandTarget(target, manager);
    const record = resolved && "record" in resolved ? resolved.record : undefined;
    if (!record) {
      const tombstone = resolved && "tombstone" in resolved ? resolved.tombstone : undefined;
      ctx.ui.notify(tombstone
        ? `@${tombstone.alias ?? tombstone.handle} was evicted — use /agents revive.`
        : `No agent named @${target.replace(/^@/, "")}.`, "warning");
      return;
    }
    const name = recordName(record);
    if (record.status === "running" || record.status === "queued") {
      ctx.ui.notify(`@${name} is already active.`, "warning");
      return;
    }
    if (record.session) {
      const ok = await resumeAgentById(ctx, record, deps);
      const queued = manager.getRecord(record.id)?.status === "queued";
      const message = !ok
        ? `Could not resume @${name}.`
        : queued
          ? `Resumed @${name} — queued.`
          : `Resumed @${name}.`;
      ctx.ui.notify(message, ok ? "info" : "warning");
      return;
    }
    if (await resumeAgentById(ctx, record, deps)) {
      ctx.ui.notify(`Resumed @${name} — queued.`, "info");
      return;
    }
    ctx.ui.notify(`Could not resume @${name} — nothing to continue.`, "warning");
    return;
  }

  const paused = manager.listAgents().filter(isTopLevelAgent)
    .filter(a => a.status === "paused");
  if (paused.length === 0) {
    ctx.ui.notify("No paused agents.", "info");
    return;
  }
  let resumed = 0;
  for (const record of paused) {
    if (await resumeAgentById(ctx, record, deps)) resumed++;
  }
  ctx.ui.notify(
    `Resumed ${resumed} of ${paused.length} agent${paused.length === 1 ? "" : "s"}.`,
    "info",
  );
}

export async function reviveAgentsCommand(ctx: ExtensionCommandContext, target: string | undefined, deps: PauseContinueDeps) {
  const { manager } = deps;
  if (target !== undefined) {
    const resolved = resolveCommandTarget(target, manager);
    const tombstone = resolved && "tombstone" in resolved ? resolved.tombstone : undefined;
    if (!tombstone) {
      const record = resolved && "record" in resolved ? resolved.record : undefined;
      ctx.ui.notify(record
        ? `@${recordName(record)} is still live — /agents resume continues it.`
        : `No evicted agent named @${target.replace(/^@/, "")}.`, "warning");
      return;
    }
    await reviveTombstone(ctx, tombstone, undefined, "Reviving", deps);
    return;
  }

  const tombstones = manager.listTombstones();
  if (tombstones.length === 0) {
    ctx.ui.notify("No evicted agents to revive in this session.", "info");
    return;
  }
  const entry = await selectItem(
    ctx.ui,
    "Revive evicted agent",
    tombstones,
    t => `@${t.alias ?? t.handle} — ${t.description}`,
  );
  if (entry) await reviveTombstone(ctx, entry, undefined, "Reviving", deps);
}

export async function showAgentsMenu(ctx: ExtensionCommandContext, deps: AgentsMenuDeps) {
  const { manager, fleet, scheduler, workflowTasks, workflowMenuDeps, pauseDeps, reloadCustomAgents, isWorkflowsEnabled, showSettings } = deps;
  reloadCustomAgents();
  const allNames = getAllTypes();

  const options: string[] = [];
  const agents = manager.listAgents().filter(isTopLevelAgent);
  const active = agents.filter(a => a.status === "running" || a.status === "queued").length;
  if (agents.length > 0) {
    const done = agents.filter(a => a.status === "completed" || a.status === "steered").length;
    options.push(`Running agents (${agents.length}) — ${active} running, ${done} done`);
  }

  const pausedCount = agents.filter(a => a.status === "paused").length;
  if (active > 0) options.push(`Pause active agents (${active})`);
  if (pausedCount > 0) options.push(`Resume paused agents (${pausedCount})`);
  const evicted = manager.listTombstones().length;
  if (evicted > 0) options.push(`Revive evicted agents (${evicted})`);

  if (agents.length > 0 || fleet.hasRows()) {
    options.push("Agent hub (roster)");
  }

  if (allNames.length > 0) {
    options.push(`Agent types (${allNames.length})`);
  }

  if (scheduler.isActive()) {
    const jobCount = scheduler.list().length;
    options.push(`Scheduled jobs (${jobCount})`);
  }

  if (isWorkflowsEnabled()) {
    options.push(`Workflows (${workflowTasks.size})`);
  }

  options.push("Create new agent");
  options.push("Settings");

  const noAgentsMsg = allNames.length === 0 && agents.length === 0
    ? "No agents found. Create specialized subagents that can be delegated to.\n\n" +
      "Each subagent has its own context window, custom system prompt, and specific tools.\n\n" +
      "Try creating: Code Reviewer, Security Auditor, Test Writer, or Documentation Writer.\n\n"
    : "";

  if (noAgentsMsg) {
    ctx.ui.notify(noAgentsMsg, "info");
  }

  const choice = await ctx.ui.select("Agents", options);
  if (!choice) return;

  if (choice.startsWith("Running agents (")) {
    await showRunningAgents(ctx, deps);
    await showAgentsMenu(ctx, deps);
  } else if (choice.startsWith("Pause active agents")) {
    await pauseAgentsCommand(ctx, undefined, pauseDeps);
    await showAgentsMenu(ctx, deps);
  } else if (choice.startsWith("Resume paused agents")) {
    await resumeAgentsCommand(ctx, undefined, pauseDeps);
    await showAgentsMenu(ctx, deps);
  } else if (choice.startsWith("Revive evicted agents")) {
    await reviveAgentsCommand(ctx, undefined, pauseDeps);
    await showAgentsMenu(ctx, deps);
  } else if (choice === "Agent hub (roster)") {
    fleet.openHub();
  } else if (choice.startsWith("Agent types (")) {
    await showAllAgentsList(ctx, deps);
    await showAgentsMenu(ctx, deps);
  } else if (choice.startsWith("Scheduled jobs (")) {
    await showSchedulesMenu(ctx, scheduler);
    await showAgentsMenu(ctx, deps);
  } else if (choice.startsWith("Workflows (")) {
    await showWorkflowsMenu(ctx, workflowMenuDeps);
    await showAgentsMenu(ctx, deps);
  } else if (choice === "Create new agent") {
    await showCreateWizard(ctx, { pi: deps.pi, manager, reloadCustomAgents });
  } else if (choice === "Settings") {
    await showSettings(ctx);
    await showAgentsMenu(ctx, deps);
  }
}

export async function showAllAgentsList(ctx: ExtensionCommandContext, deps: AgentsMenuDeps) {
  const allNames = getAllTypes();
  if (allNames.length === 0) {
    ctx.ui.notify("No agents.", "info");
    return;
  }

  const configs = allNames.map(name => getAgentConfig(name));
  const items: SettingItem[] = allNames.map((name, i) => {
    const cfg = configs[i];
    const model = getModelLabel(name, ctx.modelRegistry);
    return {
      id: name,
      label: `${sourceIndicator(cfg)}${name}`,
      currentValue: model,
      description: rowDescription(name, cfg, packageNameOf(cfg)),
      values: [model],
    };
  });

  const legend = sourceLegend(configs);

  const selected = await ctx.ui.custom<string | undefined>((_tui, _theme, _kb, done) => {
    const slTheme = getSettingsListTheme();
    const list = new SettingsList(
      items,
      Math.min(items.length, 12),
      slTheme,
      id => done(id),
      () => done(undefined),
    );
    const container = new Container();
    container.addChild(new Text("Agent types", 0, 0));
    if (legend) container.addChild(new Text(slTheme.hint(legend), 0, 0));
    container.addChild(new Spacer(1));
    container.addChild(list);
    return {
      render: (w: number) => container.render(w),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => list.handleInput?.(data),
    };
  });

  if (selected && getAgentConfig(selected)) {
    await showAgentDetail(ctx, selected, deps);
    await showAllAgentsList(ctx, deps);
  }
}

export async function showRunningAgents(ctx: ExtensionCommandContext, deps: AgentsMenuDeps) {
  const agents = deps.manager.listAgents().filter(isTopLevelAgent);
  if (agents.length === 0) {
    ctx.ui.notify("No agents.", "info");
    return;
  }

  const record = await selectItem(ctx.ui, "Running agents", agents, a => {
    const dn = getDisplayName(a.type);
    const dur = formatDuration(a.startedAt, a.completedAt);
    return `${dn} (${a.description}) · ${a.toolUses} tools · ${a.status} · ${dur}`;
  });
  if (!record) return;

  await viewAgentConversation(ctx, record, deps.fleet);
  await showRunningAgents(ctx, deps);
}

export async function viewAgentConversation(ctx: ExtensionCommandContext, record: AgentRecord, fleet: FleetList) {
  if (!record.session) {
    ctx.ui.notify(`Agent is ${record.status === "queued" ? "queued" : "expired"} — no session available.`, "info");
    return;
  }
  await fleet.openHub({ agentId: record.id }, ctx.ui as never);
}

export async function showAgentDetail(ctx: ExtensionCommandContext, name: string, deps: AgentsMenuDeps) {
  const cfg = getAgentConfig(name);
  if (!cfg) {
    ctx.ui.notify(`Agent config not found for "${name}".`, "warning");
    return;
  }

  const isPackage = cfg.source === "package";
  const file = locateAgentFile(name, cfg.sourcePath, undefined, cfg.source);
  const isDefault = cfg.isDefault === true;
  const disabled = cfg.enabled === false;

  let menuOptions: string[];
  if (isPackage) {
    menuOptions = disabled
      ? ["Eject (export as .md)", "Back"]
      : ["Eject (export as .md)", "Disable", "Back"];
  } else if (disabled && file) {
    menuOptions = isDefault
      ? ["Enable", "Edit", "Reset to default", "Delete", "Back"]
      : ["Enable", "Edit", "Delete", "Back"];
  } else if (isDefault && !file) {
    menuOptions = ["Eject (export as .md)", "Disable", "Back"];
  } else if (isDefault && file) {
    menuOptions = ["Edit", "Disable", "Reset to default", "Delete", "Back"];
  } else {
    menuOptions = ["Edit", "Disable", "Delete", "Back"];
  }

  const pkgName = packageNameOf(cfg);
  const choice = await ctx.ui.select(pkgName ? `${name} — ${pkgName}` : name, menuOptions);
  if (!choice || choice === "Back") return;

  if (choice === "Edit" && file) {
    const content = readFileSync(file.path, "utf-8");
    const edited = await ctx.ui.editor(`Edit ${name}`, content);
    if (edited !== undefined && edited !== content) {
      writeFileSync(file.path, edited, "utf-8");
      deps.reloadCustomAgents();
      ctx.ui.notify(`Updated ${file.path}`, "info");
    }
  } else if (choice === "Delete") {
    if (file) {
      const confirmed = await ctx.ui.confirm("Delete agent", `Delete ${name} from ${file.location} (${file.path})?`);
      if (confirmed) {
        unlinkSync(file.path);
        deps.reloadCustomAgents();
        ctx.ui.notify(`Deleted ${file.path}`, "info");
      }
    }
  } else if (choice === "Reset to default" && file) {
    const confirmed = await ctx.ui.confirm("Reset to default", `Delete override ${file.path} and restore embedded default?`);
    if (confirmed) {
      unlinkSync(file.path);
      deps.reloadCustomAgents();
      ctx.ui.notify(`Restored default ${name}`, "info");
    }
  } else if (choice.startsWith("Eject")) {
    await ejectAgent(ctx, name, cfg, deps.reloadCustomAgents);
  } else if (choice === "Disable") {
    await disableAgent(ctx, name, deps.reloadCustomAgents);
  } else if (choice === "Enable") {
    await enableAgent(ctx, name, deps.reloadCustomAgents);
  }
}
