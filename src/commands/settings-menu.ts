import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import {
  Container,
  Key,
  matchesKey,
  type SettingItem,
  SettingsList,
  Spacer,
  Text,
} from "@earendil-works/pi-tui";
import type { AgentManager } from "../agent-manager.js";
import {
  getDefaultMaxTurns,
  getGraceTurns,
  getRememberAgents,
  setDefaultMaxTurns,
  setGraceTurns,
  setRememberAgents,
} from "../agent-runner.js";
import {
  getAvailableTypes,
  getFallbackSubagent,
  isDefaultsDisabled,
  NO_FALLBACK,
  setFallbackSubagent,
} from "../agent-types.js";
import {
  isScopeModelsEnabled,
  setScopeModelsEnabled,
} from "../model-scope.js";
import {
  getMaxSubagentDepth,
  setMaxSubagentDepth,
} from "../nested-tools.js";
import {
  getOutputTranscriptDefault,
  setOutputTranscriptDefault,
} from "../output-file.js";
import {
  getPackageAgentsGate,
  getPackageWorkflowsGate,
  setPackageAgentsGate,
  setPackageWorkflowsGate,
} from "../package-resources.js";
import type { SubagentScheduler } from "../schedule.js";
import {
  type SubagentsSettings,
  saveAndEmitChanged,
  type ToolDescriptionMode,
} from "../settings.js";
import type {
  AgentMentionMode,
  JoinMode,
  UIStyle,
  WidgetMode,
} from "../types.js";
import type { AgentWidget } from "../ui/agent-widget.js";
import type { FleetList } from "../ui/fleet-list.js";
import {
  isWorktreeIsolationEnabled,
  setWorktreeIsolationEnabled,
} from "../worktree.js";

export interface SettingsMenuDeps {
  pi: ExtensionAPI;
  manager: AgentManager;
  widget: AgentWidget;
  fleet: FleetList;
  scheduler: SubagentScheduler;
  reloadCustomAgents: () => void;
  getStrictAgentFiles: () => boolean;
  setStrictAgentFiles: (b: boolean) => void;
  isWorkflowsEnabled: () => boolean;
  isWorkflowsPinned: () => boolean;
  setWorkflowsEnabled: (b: boolean) => void;
  isReportUsageEnabled: () => boolean;
  setReportUsage: (b: boolean) => void;
  isShowCostEnabled: () => boolean;
  setShowCost: (b: boolean) => void;
  isShowModelEnabled: () => boolean;
  setShowModel: (b: boolean) => void;
  getUIStyle: () => UIStyle;
  setUIStyle: (s: UIStyle) => void;
  isFleetViewEnabled: () => boolean;
  setFleetViewEnabled: (b: boolean) => void;
  getAgentMentionMode: () => AgentMentionMode;
  setAgentMentionMode: (m: AgentMentionMode) => void;
  getDefaultJoinMode: () => JoinMode;
  setDefaultJoinMode: (m: JoinMode) => void;
  getBackgroundByDefault: () => boolean;
  setBackgroundByDefault: (b: boolean) => void;
  isSchedulingEnabled: () => boolean;
  setSchedulingEnabled: (b: boolean) => void;
  setDisableDefaultAgents: (b: boolean) => void;
  getToolDescriptionMode: () => ToolDescriptionMode;
  setToolDescriptionMode: (m: ToolDescriptionMode) => void;
  getWidgetMode: () => WidgetMode;
  setWidgetMode: (m: WidgetMode) => void;
}

export function snapshotSettings(deps: SettingsMenuDeps) {
  return {
    maxConcurrent: deps.manager.getMaxConcurrent(),
    maxConcurrentForeground: deps.manager.getMaxConcurrentForeground(),
    defaultMaxTurns: getDefaultMaxTurns() ?? 0,
    graceTurns: getGraceTurns(),
    defaultJoinMode: deps.getDefaultJoinMode(),
    backgroundByDefault: deps.getBackgroundByDefault(),
    schedulingEnabled: deps.isSchedulingEnabled(),
    scopeModels: isScopeModelsEnabled(),
    strictAgentFiles: deps.getStrictAgentFiles(),
    disableDefaultAgents: isDefaultsDisabled(),
    toolDescriptionMode: deps.getToolDescriptionMode(),
    fleetView: deps.isFleetViewEnabled(),
    agentMentions: deps.getAgentMentionMode(),
    rememberAgents: getRememberAgents(),
    widgetMode: deps.getWidgetMode(),
    outputTranscript: getOutputTranscriptDefault(),
    worktreeIsolation: isWorktreeIsolationEnabled(),
    workflowsEnabled: deps.isWorkflowsPinned() ? deps.isWorkflowsEnabled() : undefined,
    maxSubagentDepth: getMaxSubagentDepth(),
    fallbackSubagent: getFallbackSubagent(),
    reportUsage: deps.isReportUsageEnabled(),
    showCost: deps.isShowCostEnabled(),
    showModel: deps.isShowModelEnabled(),
    packageAgents: getPackageAgentsGate(),
    packageWorkflows: getPackageWorkflowsGate(),
    uiStyle: deps.getUIStyle(),
  } satisfies SubagentsSettings;
}

type _NoMissingSettingsKeys =
  Exclude<keyof SubagentsSettings, keyof ReturnType<typeof snapshotSettings>> extends never
    ? true
    : ["snapshotSettings() is missing a SubagentsSettings key"];
const _settingsSnapshotIsComplete: _NoMissingSettingsKeys = true;
void _settingsSnapshotIsComplete;

export function gateAdmitsAnything(gate: ReturnType<typeof getPackageAgentsGate>): boolean {
  if (gate === undefined || gate === true) return true;
  if (gate === false) return false;
  return gate.length > 0;
}

export function describeGateSetting(gate: ReturnType<typeof getPackageAgentsGate>, base: string): string {
  if (!Array.isArray(gate)) return base;
  return gate.length > 0
    ? `${base} Currently limited to: ${gate.join(", ")}.`
    : `${base} Currently limited to an empty list, so nothing loads.`;
}

export function notifyApplied(
  ctx: ExtensionCommandContext,
  successMsg: string,
  deps: SettingsMenuDeps,
): void {
  const { message, level } = saveAndEmitChanged(
    snapshotSettings(deps),
    successMsg,
    (event, payload) => deps.pi.events.emit(event, payload),
  );
  ctx.ui.notify(message, level);
}

const NUMERIC_IDS = new Set([
  "maxConcurrent", "maxConcurrentForeground", "defaultMaxTurns", "graceTurns", "maxSubagentDepth",
]);

export async function showSettings(ctx: ExtensionCommandContext, deps: SettingsMenuDeps): Promise<void> {
  const {
    manager,
    scheduler,
    reloadCustomAgents,
    getStrictAgentFiles,
    setStrictAgentFiles,
    isWorkflowsEnabled,
    setWorkflowsEnabled,
    isReportUsageEnabled,
    setReportUsage,
    isShowCostEnabled,
    setShowCost,
    isShowModelEnabled,
    setShowModel,
    getUIStyle,
    setUIStyle,
    isFleetViewEnabled,
    setFleetViewEnabled,
    getAgentMentionMode,
    setAgentMentionMode,
    getDefaultJoinMode,
    setDefaultJoinMode,
    getBackgroundByDefault,
    setBackgroundByDefault,
    isSchedulingEnabled,
    setSchedulingEnabled,
    setDisableDefaultAgents,
    getToolDescriptionMode,
    setToolDescriptionMode,
    getWidgetMode,
    setWidgetMode,
  } = deps;

  function buildItems(): SettingItem[] {
    const mc = manager.getMaxConcurrent();
    const mcf = manager.getMaxConcurrentForeground();
    const dmt = getDefaultMaxTurns() ?? 0;
    const gt = getGraceTurns();
    const msd = getMaxSubagentDepth();
    const fallbackValue = getFallbackSubagent() ?? "general-purpose";
    const fallbackValues = [...new Set([...getAvailableTypes(), NO_FALLBACK])];

    return [
      {
        id: "maxConcurrent",
        label: "Max concurrency",
        description: "Max concurrent background agents (Enter to type)",
        currentValue: String(mc),
        values: [String(mc)],
      },
      {
        id: "maxConcurrentForeground",
        label: "Max foreground concurrency",
        description: "Max concurrent foreground (blocking) agents (0 = unlimited, Enter to type)",
        currentValue: String(mcf),
        values: [String(mcf)],
      },
      {
        id: "defaultMaxTurns",
        label: "Default max turns",
        description: "Default max turns before wrap-up (0 = unlimited, Enter to type)",
        currentValue: String(dmt),
        values: [String(dmt)],
      },
      {
        id: "graceTurns",
        label: "Grace turns",
        description: "Grace turns after wrap-up steer (Enter to type)",
        currentValue: String(gt),
        values: [String(gt)],
      },
      {
        id: "maxSubagentDepth",
        label: "Nested depth",
        description: "Hard cap on nested delegation — main is 0, its subagents 1 (0/1 = nesting off, Enter to type)",
        currentValue: String(msd),
        values: [String(msd)],
      },
      {
        id: "joinMode",
        label: "Join mode",
        description: "smart = each completion at the parent's next boundary, as in Claude Code; group = one notification per turn's batch",
        currentValue: getDefaultJoinMode() === "group" ? "group" : "smart",
        values: ["smart", "group"],
      },
      {
        id: "backgroundByDefault",
        label: "Background by default",
        description: "An Agent call that doesn't say runs detached (off = blocks the turn and returns inline)",
        currentValue: getBackgroundByDefault() ? "on" : "off",
        values: ["on", "off"],
      },
      {
        id: "schedulingEnabled",
        label: "Scheduling",
        description: "Schedule subagent feature (off removes `schedule` param from Agent tool spec on next pi session)",
        currentValue: isSchedulingEnabled() ? "on" : "off",
        values: ["on", "off"],
      },
      {
        id: "workflowsEnabled",
        label: "Workflows",
        description:
          "Scripted workflows, on unless another extension provides a workflow tool "
          + "(off keeps the SubagentWorkflow tool out of the tool spec; applies on next pi session)",
        currentValue: isWorkflowsEnabled() ? "on" : "off",
        values: ["on", "off"],
      },
      {
        id: "packageAgents",
        label: "Package agents",
        description: describeGateSetting(
          getPackageAgentsGate(),
          "Load agents declared by installed pi packages (`pi.subagents.agents` in their package.json). "
          + "They rank below your global and project agents, so a same-named local file always wins.",
        ),
        currentValue: gateAdmitsAnything(getPackageAgentsGate()) ? "on" : "off",
        values: ["on", "off"],
      },
      {
        id: "packageWorkflows",
        label: "Package workflows",
        description: describeGateSetting(
          getPackageWorkflowsGate(),
          "Resolve saved workflow names against scripts declared by installed pi packages "
          + "(`pi.subagents.workflows`). Searched last, after your project, workspace and personal directories.",
        ),
        currentValue: gateAdmitsAnything(getPackageWorkflowsGate()) ? "on" : "off",
        values: ["on", "off"],
      },
      {
        id: "scopeModels",
        label: "Scope models",
        description: "Validate subagent models against scoped models (/scoped-models)",
        currentValue: isScopeModelsEnabled() ? "on" : "off",
        values: ["on", "off"],
      },
      {
        id: "strictAgentFiles",
        label: "Strict agent files",
        description: "Fail startup on an unreadable/unparseable agent .md instead of skipping it with a warning",
        currentValue: getStrictAgentFiles() ? "on" : "off",
        values: ["on", "off"],
      },
      {
        id: "disableDefaultAgents",
        label: "Disable defaults",
        description: "Hide built-in agents (general-purpose, Explore, Plan) — custom agents are unaffected",
        currentValue: isDefaultsDisabled() ? "on" : "off",
        values: ["on", "off"],
      },
      {
        id: "fallbackSubagent",
        label: "Fallback agent",
        description: `Agent used when subagent_type is unknown, disabled, or ambiguous; "${NO_FALLBACK}" rejects the call instead (strict dispatch)`,
        currentValue: fallbackValue,
        values: fallbackValues,
      },
      {
        id: "outputTranscript",
        label: "Output transcript",
        description: "Write each subagent's .output transcript by default. A custom agent's output_transcript frontmatter overrides this.",
        currentValue: getOutputTranscriptDefault() ? "on" : "off",
        values: ["on", "off"],
      },
      {
        id: "worktreeIsolation",
        label: "Worktree isolation",
        description:
          "Allow isolation: worktree to copy the repo. Off refuses worktrees on every path immediately — for repos where a copy costs too much time or disk — and drops the `isolation` param from the Agent tool spec on next pi session.",
        currentValue: isWorktreeIsolationEnabled() ? "on" : "off",
        values: ["on", "off"],
      },
      {
        id: "reportUsage",
        label: "Report usage to session",
        description:
          "Add subagent tokens and cost to this session's own totals, so pi's footer and /cost stop reading a delegating session as nearly free. Reported on the next tool result (agents that finish in the background are counted on the one after). Context-window % is unaffected.",
        currentValue: isReportUsageEnabled() ? "on" : "off",
        values: ["on", "off"],
      },
      {
        id: "showCost",
        label: "Show cost",
        description:
          "Show an estimated `~$0.0042` beside subagent token counts in the widget, fleet view, results and notifications. Priced by pi from the model's rates — omitted entirely for a model it has no rates for.",
        currentValue: isShowCostEnabled() ? "on" : "off",
        values: ["on", "off"],
      },
      {
        id: "showModel",
        label: "Show model",
        description:
          "Name the model driving each agent, and the thinking level it is running at, on the widget's running rows. The Agent tool result and the conversation viewer show the pair either way — this adds it to the widget, where the row is already dense.",
        currentValue: isShowModelEnabled() ? "on" : "off",
        values: ["on", "off"],
      },
      {
        id: "uiStyle",
        label: "UI style",
        description: "Visual chrome style: pi (native edge-to-edge rules and footer status) or claude (rounded box corners, side rails, and plain status)",
        currentValue: getUIStyle(),
        values: ["pi", "claude"],
      },
      {
        id: "fleetView",
        label: "Fleet view",
        description: "Claude Code-style main+subagents list below the editor (↓/← to navigate, Enter to view)",
        currentValue: isFleetViewEnabled() ? "on" : "off",
        values: ["on", "off"],
      },
      {
        id: "agentMentions",
        label: "Agent mentions",
        description: "Route `@handle message` at the prompt to that agent. model = an off-screen clone of this conversation calls the Agent tool, so the agent gets a context-written prompt, a transcript and per-tool detail, and the chat stays clean; direct = started here from your text, no model call. Messaging and resuming are direct either way.",
        currentValue: getAgentMentionMode(),
        values: ["model", "direct", "off"],
      },
      {
        id: "rememberAgents",
        label: "Remember agents",
        description: "Persist subagent sessions so `@handle` can resume one long after it finished (they also appear in /resume)",
        currentValue: getRememberAgents() ? "on" : "off",
        values: ["on", "off"],
      },
      {
        id: "widgetMode",
        label: "Widget",
        description: "Above-editor agent widget: all = every agent; background = hide foreground (they already render inline); off = hide the widget.",
        currentValue: getWidgetMode(),
        values: ["all", "background", "off"],
      },
      {
        id: "toolDescriptionMode",
        label: "Tool description",
        description: "Agent tool description sent to the LLM: full (rich, default), compact (~75% fewer tokens, for small/local models), or custom (.pi/agent-tool-description.md with {{placeholders}})",
        currentValue: getToolDescriptionMode(),
        values: ["full", "compact", "custom"],
      },
    ];
  }

  function applyValue(id: string, value: string) {
    if (id === "maxConcurrent") {
      const n = parseInt(value, 10);
      if (n >= 1) {
        manager.setMaxConcurrent(n);
        notifyApplied(ctx, `Max concurrency set to ${n}`, deps);
      }
    } else if (id === "maxConcurrentForeground") {
      const n = parseInt(value, 10);
      if (n >= 0) {
        manager.setMaxConcurrentForeground(n);
        notifyApplied(ctx, n === 0
          ? "Max foreground concurrency set to unlimited"
          : `Max foreground concurrency set to ${n}`, deps);
      }
    } else if (id === "defaultMaxTurns") {
      const n = parseInt(value, 10);
      if (n === 0) {
        setDefaultMaxTurns(undefined);
        notifyApplied(ctx, "Default max turns set to unlimited", deps);
      } else if (n >= 1) {
        setDefaultMaxTurns(n);
        notifyApplied(ctx, `Default max turns set to ${n}`, deps);
      }
    } else if (id === "graceTurns") {
      const n = parseInt(value, 10);
      if (n >= 1) {
        setGraceTurns(n);
        notifyApplied(ctx, `Grace turns set to ${n}`, deps);
      }
    } else if (id === "maxSubagentDepth") {
      const n = parseInt(value, 10);
      if (n >= 0) {
        setMaxSubagentDepth(n);
        notifyApplied(
          ctx,
          n <= 1
            ? "Nested delegation disabled"
            : `Nested depth set to ${n}. Applies to agents started from now on.`,
          deps,
        );
      }
    } else if (id === "joinMode") {
      setDefaultJoinMode(value as JoinMode);
      notifyApplied(ctx, `Default join mode set to ${value}`, deps);
    } else if (id === "backgroundByDefault") {
      const enabled = value === "on";
      setBackgroundByDefault(enabled);
      notifyApplied(
        ctx,
        enabled
          ? "Agent calls run in the background unless they pass run_in_background: false"
          : "Agent calls block and return inline unless they pass run_in_background: true",
        deps,
      );
    } else if (id === "schedulingEnabled") {
      const enabled = value === "on";
      if (enabled === isSchedulingEnabled()) {
        ctx.ui.notify(`Scheduling already ${enabled ? "enabled" : "disabled"}.`, "info");
      } else {
        setSchedulingEnabled(enabled);
        if (!enabled) scheduler.stop();
        notifyApplied(
          ctx,
          `Scheduling ${enabled ? "enabled" : "disabled"}. Tool spec change takes effect on next pi session.`,
          deps,
        );
      }
    } else if (id === "workflowsEnabled") {
      const enabled = value === "on";
      if (enabled === isWorkflowsEnabled()) {
        ctx.ui.notify(`Workflows already ${enabled ? "enabled" : "disabled"}.`, "info");
      } else {
        setWorkflowsEnabled(enabled);
        notifyApplied(
          ctx,
          `Workflows ${enabled ? "enabled" : "disabled"}. Tool spec change takes effect on next pi session.`,
          deps,
        );
      }
    } else if (id === "scopeModels") {
      const enabled = value === "on";
      setScopeModelsEnabled(enabled);
      notifyApplied(ctx, `Scope models ${enabled ? "enabled" : "disabled"}`, deps);
    } else if (id === "strictAgentFiles") {
      const enabled = value === "on";
      setStrictAgentFiles(enabled);
      notifyApplied(ctx, `Strict agent files ${enabled ? "enabled" : "disabled"}. Takes effect on next pi session.`, deps);
    } else if (id === "disableDefaultAgents") {
      const enabled = value === "on";
      setDisableDefaultAgents(enabled);
      notifyApplied(ctx, `Default agents ${enabled ? "disabled" : "enabled"}. Tool spec change takes effect on next pi session.`, deps);
    } else if (id === "fallbackSubagent") {
      setFallbackSubagent(value);
      notifyApplied(
        ctx,
        value === NO_FALLBACK
          ? "Unknown or disabled agent types will now be rejected"
          : `Unknown agent types will fall back to ${value}`,
        deps,
      );
    } else if (id === "outputTranscript") {
      const enabled = value === "on";
      setOutputTranscriptDefault(enabled);
      notifyApplied(ctx, `Output transcript ${enabled ? "enabled" : "disabled"} by default`, deps);
    } else if (id === "worktreeIsolation") {
      const enabled = value === "on";
      setWorktreeIsolationEnabled(enabled);
      notifyApplied(
        ctx,
        `Worktree isolation ${enabled ? "enabled" : "disabled"}. Tool parameter updates on next pi session.`,
        deps,
      );
    } else if (id === "packageAgents" || id === "packageWorkflows") {
      const enabled = value === "on";
      const isAgents = id === "packageAgents";
      const previous = isAgents ? getPackageAgentsGate() : getPackageWorkflowsGate();
      (isAgents ? setPackageAgentsGate : setPackageWorkflowsGate)(enabled);
      reloadCustomAgents();
      const label = isAgents ? "Package agents" : "Package workflows";
      const replaced = Array.isArray(previous) && previous.length > 0
        ? ` Replaced the allowlist (${previous.join(", ")}) — re-add it in .pi/subagents.json to narrow it again.`
        : "";
      const specNote = isAgents ? " Tool spec change takes effect on next pi session." : "";
      notifyApplied(ctx, `${label} ${enabled ? "enabled" : "disabled"}.${replaced}${specNote}`, deps);
    } else if (id === "toolDescriptionMode") {
      setToolDescriptionMode(value as ToolDescriptionMode);
      notifyApplied(ctx, `Tool description set to ${value}. Takes effect on next pi session.`, deps);
    } else if (id === "reportUsage") {
      const enabled = value === "on";
      setReportUsage(enabled);
      notifyApplied(
        ctx,
        enabled
          ? "Subagent usage now counted in this session's totals"
          : "Subagent usage no longer counted in this session's totals",
        deps,
      );
    } else if (id === "showCost") {
      const enabled = value === "on";
      setShowCost(enabled);
      notifyApplied(ctx, `Cost display ${enabled ? "enabled" : "disabled"}`, deps);
    } else if (id === "showModel") {
      const enabled = value === "on";
      setShowModel(enabled);
      notifyApplied(ctx, `Model display ${enabled ? "enabled" : "disabled"}`, deps);
    } else if (id === "uiStyle") {
      setUIStyle(value as UIStyle);
      notifyApplied(ctx, `UI style set to ${value}`, deps);
    } else if (id === "fleetView") {
      const enabled = value === "on";
      setFleetViewEnabled(enabled);
      notifyApplied(ctx, `Fleet view ${enabled ? "enabled" : "disabled"}`, deps);
    } else if (id === "agentMentions") {
      const mode = value as AgentMentionMode;
      setAgentMentionMode(mode);
      notifyApplied(
        ctx,
        mode === "off"
          ? "Agent mentions disabled"
          : mode === "model"
            ? "Agent mentions on — a conversation clone starts a mentioned agent off-screen"
            : "Agent mentions on — a mentioned agent starts here, with no model call",
        deps,
      );
    } else if (id === "rememberAgents") {
      const enabled = value === "on";
      setRememberAgents(enabled);
      notifyApplied(ctx, `Remember agents ${enabled ? "enabled" : "disabled"}`, deps);
    } else if (id === "widgetMode") {
      setWidgetMode(value as WidgetMode);
      notifyApplied(ctx, `Widget set to ${value}`, deps);
    }
  }

  let list: SettingsList;
  let currentIndex = 0;

  const result = await ctx.ui.custom<string | undefined>((_tui, _theme, _kb, done) => {
    const items = buildItems();

    list = new SettingsList(
      items,
      items.length + 2,
      getSettingsListTheme(),
      (id, newValue) => {
        applyValue(id, newValue);
      },
      () => done(undefined as undefined),
    );

    const container = new Container();
    container.addChild(new Text("⚙  Subagent Settings", 0, 0));
    container.addChild(new Spacer(1));
    container.addChild(list);

    return {
      render: (w: number) => container.render(w),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        if (matchesKey(data, "up")) {
          currentIndex = Math.max(0, currentIndex - 1);
        } else if (matchesKey(data, "down")) {
          currentIndex = Math.min(items.length - 1, currentIndex + 1);
        }

        if (matchesKey(data, Key.enter) && NUMERIC_IDS.has(items[currentIndex].id)) {
          done(items[currentIndex].id);
          return;
        }
        list.handleInput?.(data);
      },
    };
  });

  if (result && NUMERIC_IDS.has(result)) {
    const current = result === "maxConcurrent"
      ? String(manager.getMaxConcurrent())
      : result === "maxConcurrentForeground"
        ? String(manager.getMaxConcurrentForeground())
        : result === "defaultMaxTurns"
          ? String(getDefaultMaxTurns() ?? 0)
          : result === "maxSubagentDepth"
            ? String(getMaxSubagentDepth())
            : String(getGraceTurns());

    const label = result === "maxConcurrent"
      ? "Max concurrency (1+)"
      : result === "maxConcurrentForeground"
        ? "Max foreground concurrency (0 = unlimited)"
        : result === "defaultMaxTurns"
          ? "Default max turns (0 = unlimited)"
          : result === "maxSubagentDepth"
            ? "Nested depth (0/1 = nesting off)"
            : "Grace turns (1+)";

    let input: string | undefined = await ctx.ui.input(label, current);
    while (input != null) {
      const trimmed = input.trim();
      const n = Number(trimmed);
      if (trimmed !== "" && Number.isInteger(n)) {
        applyValue(result, String(n));
        await showSettings(ctx, deps);
        return;
      }
      input = await ctx.ui.input(label, trimmed);
    }
  }
}
