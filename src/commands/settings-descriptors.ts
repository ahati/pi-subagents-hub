import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AgentManager } from "../agent-manager.js";
import {
  DEFAULT_UNCUT_PROMPT_PROVIDERS,
  getDefaultMaxTurns,
  getGraceTurns,
  getHeadlessWaitMinutes,
  getRememberAgents,
  getUncutPromptProviders,
  setDefaultMaxTurns,
  setGraceTurns,
  setHeadlessWaitMinutes,
  setRememberAgents,
} from "../agent-runner.js";
import {
  getAvailableTypes,
  getFallbackSubagent,
  isDefaultsDisabled,
  NO_FALLBACK,
  setFallbackSubagent,
} from "../agent-types.js";
import { getCacheRetention, setCacheRetention } from "../cache-retention.js";
import { isScopeModelsEnabled, setScopeModelsEnabled } from "../model-scope.js";
import { getMaxSubagentDepth, setMaxSubagentDepth } from "../nested-tools.js";
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
  MAX_HEADLESS_WAIT_MINUTES,
  type SubagentsSettings,
  saveAndEmitChanged,
  type ToolDescriptionMode,
} from "../settings.js";
import type {
  AgentMentionMode,
  CacheRetentionSetting,
  JoinMode,
  UIStyle,
  ViewerStyle,
} from "../types.js";
import type { AgentWidget } from "../ui/agent-widget.js";
import type { FleetList } from "../ui/fleet-list.js";
import {
  getWorktreeTimeoutSeconds,
  isWorktreeIsolationEnabled,
  MAX_WORKTREE_TIMEOUT_SECONDS,
  MIN_WORKTREE_TIMEOUT_SECONDS,
  setWorktreeIsolationEnabled,
  setWorktreeTimeoutSeconds,
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
  getViewerStyle: () => ViewerStyle;
  setViewerStyle: (s: ViewerStyle) => void;
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
  getWorkflowReference: () => "inline" | "skill";
  setWorkflowReference: (mode: "inline" | "skill") => void;
  setToolDescriptionMode: (m: ToolDescriptionMode) => void;
  /** The active session's project root: where this menu reads and writes settings. */
  getConfigCwd: () => string;
}

export interface SettingDescriptor {
  readonly id: string;
  readonly label: string;
  readonly description: string | ((deps: SettingsMenuDeps) => string);
  readonly isNumeric?: boolean;
  readonly numericPromptLabel?: string;
  getValues?(deps: SettingsMenuDeps): readonly string[];
  getCurrent(deps: SettingsMenuDeps): string;
  apply(value: string, ctx: ExtensionCommandContext, deps: SettingsMenuDeps): void;
}

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

export function snapshotSettings(deps: SettingsMenuDeps) {
  const uncutPromptProviders = [...getUncutPromptProviders()];
  const defaultUncut = uncutPromptProviders.length === DEFAULT_UNCUT_PROMPT_PROVIDERS.length
    && uncutPromptProviders.every((provider, index) => provider === DEFAULT_UNCUT_PROMPT_PROVIDERS[index]);
  return {
    maxConcurrent: deps.manager.getMaxConcurrent(),
    maxConcurrentForeground: deps.manager.getMaxConcurrentForeground(),
    maxConcurrentNested: deps.manager.getMaxConcurrentNested(),
    defaultMaxTurns: getDefaultMaxTurns() ?? 0,
    graceTurns: getGraceTurns(),
    headlessWaitMinutes: getHeadlessWaitMinutes(),
    defaultJoinMode: deps.getDefaultJoinMode(),
    backgroundByDefault: deps.getBackgroundByDefault(),
    schedulingEnabled: deps.isSchedulingEnabled(),
    workflowsEnabled: deps.isWorkflowsPinned() ? deps.isWorkflowsEnabled() : undefined,
    maxSubagentDepth: getMaxSubagentDepth(),
    packageAgents: getPackageAgentsGate(),
    packageWorkflows: getPackageWorkflowsGate(),
    scopeModels: isScopeModelsEnabled(),
    strictAgentFiles: deps.getStrictAgentFiles(),
    disableDefaultAgents: isDefaultsDisabled(),
    fallbackSubagent: getFallbackSubagent(),
    outputTranscript: getOutputTranscriptDefault(),
    cacheRetention: getCacheRetention(),
    worktreeIsolation: isWorktreeIsolationEnabled(),
    worktreeTimeoutSeconds: getWorktreeTimeoutSeconds(),
    reportUsage: deps.isReportUsageEnabled(),
    showCost: deps.isShowCostEnabled(),
    showModel: deps.isShowModelEnabled(),
    uiStyle: deps.getUIStyle(),
    viewerStyle: deps.getViewerStyle(),
    fleetView: deps.isFleetViewEnabled(),
    agentMentions: deps.getAgentMentionMode(),
    rememberAgents: getRememberAgents(),
    workflowReference: deps.getWorkflowReference(),
    toolDescriptionMode: deps.getToolDescriptionMode(),
    uncutPromptProviders: defaultUncut ? undefined : uncutPromptProviders,
  } satisfies SubagentsSettings;
}

// Compile-time guard: every SubagentsSettings key must be snapshotted, or a
// menu save would silently erase the missing one from subagents.json.
type _NoMissingSettingsKeys =
  Exclude<keyof SubagentsSettings, keyof ReturnType<typeof snapshotSettings>> extends never
    ? true
    : ["snapshotSettings() is missing a SubagentsSettings key"];
const _settingsSnapshotIsComplete: _NoMissingSettingsKeys = true;
void _settingsSnapshotIsComplete;

export function notifyApplied(
  ctx: ExtensionCommandContext,
  msg: string,
  deps: SettingsMenuDeps,
): void {
  const toast = saveAndEmitChanged(
    snapshotSettings(deps),
    msg,
    (event, payload) => deps.pi.events.emit(event, payload),
    deps.getConfigCwd(),
  );
  ctx.ui.notify(toast.message, toast.level);
}

export const SETTINGS_DESCRIPTORS: readonly SettingDescriptor[] = [
  {
    id: "maxConcurrent",
    label: "Max background concurrency",
    description: "Max concurrent background agents; extras wait in a queue (Enter to type)",
    isNumeric: true,
    numericPromptLabel: "Max background concurrency (1+)",
    getCurrent: (deps) => String(deps.manager.getMaxConcurrent()),
    apply: (value, ctx, deps) => {
      const n = parseInt(value, 10);
      if (n >= 1) {
        deps.manager.setMaxConcurrent(n);
        notifyApplied(ctx, `Max background concurrency set to ${n}`, deps);
      }
    },
  },
  {
    id: "maxConcurrentForeground",
    label: "Max foreground concurrency",
    description: "Max concurrent foreground (blocking) agents; extras wait in a queue (0 = unlimited, Enter to type)",
    isNumeric: true,
    numericPromptLabel: "Max foreground concurrency (0 = unlimited)",
    getCurrent: (deps) => String(deps.manager.getMaxConcurrentForeground()),
    apply: (value, ctx, deps) => {
      const n = parseInt(value, 10);
      if (n >= 0) {
        deps.manager.setMaxConcurrentForeground(n);
        notifyApplied(
          ctx,
          n === 0
            ? "Max foreground concurrency set to unlimited"
            : `Max foreground concurrency set to ${n}`,
          deps,
        );
      }
    },
  },
  {
    id: "maxConcurrentNested",
    label: "Max nested concurrency",
    description: "Max concurrent nested agents (started by subagents); extras are refused (0 = unlimited, Enter to type)",
    isNumeric: true,
    numericPromptLabel: "Max nested concurrency (0 = unlimited)",
    getCurrent: (deps) => String(deps.manager.getMaxConcurrentNested()),
    apply: (value, ctx, deps) => {
      const n = parseInt(value, 10);
      if (n >= 0) {
        deps.manager.setMaxConcurrentNested(n);
        notifyApplied(
          ctx,
          n === 0
            ? "Max nested concurrency set to unlimited"
            : `Max nested concurrency set to ${n}`,
          deps,
        );
      }
    },
  },
  {
    id: "maxSubagentDepth",
    label: "Nested depth",
    description: "Hard cap on nested delegation — main is 0, its subagents 1 (0/1 = nesting off, even with allowed_subagents; Enter to type)",
    isNumeric: true,
    numericPromptLabel: "Nested depth (0/1 = nesting off)",
    getCurrent: () => String(getMaxSubagentDepth()),
    apply: (value, ctx, deps) => {
      const n = parseInt(value, 10);
      if (n >= 0) {
        setMaxSubagentDepth(n);
        notifyApplied(
          ctx,
          n <= 1
            ? "Nested delegation disabled for every agent, including those with allowed_subagents"
            : `Nested depth set to ${n}. Applies to agents started from now on.`,
          deps,
        );
      }
    },
  },
  {
    id: "defaultMaxTurns",
    label: "Default max turns",
    description: "Default max turns before wrap-up (0 = unlimited, Enter to type)",
    isNumeric: true,
    numericPromptLabel: "Default max turns (0 = unlimited)",
    getCurrent: () => String(getDefaultMaxTurns() ?? 0),
    apply: (value, ctx, deps) => {
      const n = parseInt(value, 10);
      if (n === 0) {
        setDefaultMaxTurns(undefined);
        notifyApplied(ctx, "Default max turns set to unlimited", deps);
      } else if (n >= 1) {
        setDefaultMaxTurns(n);
        notifyApplied(ctx, `Default max turns set to ${n}`, deps);
      }
    },
  },
  {
    id: "graceTurns",
    label: "Grace turns",
    description: "Grace turns after wrap-up steer (Enter to type)",
    isNumeric: true,
    numericPromptLabel: "Grace turns (1+)",
    getCurrent: () => String(getGraceTurns()),
    apply: (value, ctx, deps) => {
      const n = parseInt(value, 10);
      if (n >= 1) {
        setGraceTurns(n);
        notifyApplied(ctx, `Grace turns set to ${n}`, deps);
      }
    },
  },
  {
    id: "headlessWaitMinutes",
    label: "Headless wait (min)",
    description: `pi -p: minutes to wait for background work before stopping it (0 = no limit, max ${MAX_HEADLESS_WAIT_MINUTES}, Enter to type)`,
    isNumeric: true,
    numericPromptLabel: `Headless wait (0-${MAX_HEADLESS_WAIT_MINUTES} minutes, 0 = no limit)`,
    getCurrent: () => String(getHeadlessWaitMinutes()),
    apply: (value, ctx, deps) => {
      const n = parseInt(value, 10);
      if (n >= 0 && n <= MAX_HEADLESS_WAIT_MINUTES) {
        setHeadlessWaitMinutes(n);
        notifyApplied(
          ctx,
          n === 0 ? "Headless wait set to no limit" : `Headless wait set to ${n} min`,
          deps,
        );
      } else {
        ctx.ui.notify(`Headless wait must be 0-${MAX_HEADLESS_WAIT_MINUTES} minutes`, "warning");
      }
    },
  },
  {
    id: "workflowReference",
    label: "Workflow reference",
    description: "inline = the script-writing reference lives in the SubagentWorkflow description; skill = it ships as the workflow-authoring skill and the description points at it",
    getValues: () => ["inline", "skill"],
    getCurrent: (deps) => deps.getWorkflowReference(),
    apply: (value, ctx, deps) => {
      const mode = value === "skill" ? "skill" : "inline";
      deps.setWorkflowReference(mode);
      notifyApplied(
        ctx,
        mode === "skill"
          ? "Workflow reference moved to the workflow-authoring skill (applies on the next pi session)"
          : "Workflow reference inlined in the tool description (applies on the next pi session)",
        deps,
      );
    },
  },
  {
    id: "joinMode",
    label: "Join mode",
    description: "smart = each completion at the parent's next boundary, as in Claude Code; group = one notification per turn's batch",
    getValues: () => ["smart", "group"],
    getCurrent: (deps) => (deps.getDefaultJoinMode() === "group" ? "group" : "smart"),
    apply: (value, ctx, deps) => {
      deps.setDefaultJoinMode(value as JoinMode);
      notifyApplied(ctx, `Default join mode set to ${value}`, deps);
    },
  },
  {
    id: "backgroundByDefault",
    label: "Background by default",
    description: "An Agent call that doesn't say runs detached (off = blocks the turn and returns inline)",
    getCurrent: (deps) => (deps.getBackgroundByDefault() ? "on" : "off"),
    apply: (value, ctx, deps) => {
      const enabled = value === "on";
      deps.setBackgroundByDefault(enabled);
      notifyApplied(
        ctx,
        enabled
          ? "Agent calls run in the background unless they pass run_in_background: false"
          : "Agent calls block and return inline unless they pass run_in_background: true",
        deps,
      );
    },
  },
  {
    id: "schedulingEnabled",
    label: "Scheduling",
    description: "Schedule subagent feature (off removes `schedule` param from Agent tool spec on next pi session)",
    getCurrent: (deps) => (deps.isSchedulingEnabled() ? "on" : "off"),
    apply: (value, ctx, deps) => {
      const enabled = value === "on";
      if (enabled === deps.isSchedulingEnabled()) {
        ctx.ui.notify(`Scheduling already ${enabled ? "enabled" : "disabled"}.`, "info");
        return;
      }
      deps.setSchedulingEnabled(enabled);
      if (!enabled) deps.scheduler.stop();
      notifyApplied(
        ctx,
        `Scheduling ${enabled ? "enabled" : "disabled"}. Tool spec change takes effect on next pi session.`,
        deps,
      );
    },
  },
  {
    id: "workflowsEnabled",
    label: "Workflows",
    description:
      "Scripted workflows, on unless another extension provides a workflow tool "
      + "(off keeps the SubagentWorkflow tool out of the tool spec; applies on next pi session)",
    getCurrent: (deps) => (deps.isWorkflowsEnabled() ? "on" : "off"),
    apply: (value, ctx, deps) => {
      const enabled = value === "on";
      if (enabled === deps.isWorkflowsEnabled()) {
        ctx.ui.notify(`Workflows already ${enabled ? "enabled" : "disabled"}.`, "info");
        return;
      }
      deps.setWorkflowsEnabled(enabled);
      notifyApplied(
        ctx,
        `Workflows ${enabled ? "enabled" : "disabled"}. Tool spec change takes effect on next pi session.`,
        deps,
      );
    },
  },
  {
    id: "packageAgents",
    label: "Package agents",
    description: () => describeGateSetting(
      getPackageAgentsGate(),
      "Load agents declared by installed pi packages (`pi.subagents.agents` in their package.json). "
      + "They rank below your global and project agents, so a same-named local file always wins.",
    ),
    getCurrent: () => (gateAdmitsAnything(getPackageAgentsGate()) ? "on" : "off"),
    apply: (value, ctx, deps) => {
      const enabled = value === "on";
      const previous = getPackageAgentsGate();
      setPackageAgentsGate(enabled);
      deps.reloadCustomAgents();
      const replaced = Array.isArray(previous) && previous.length > 0
        ? ` Replaced the allowlist (${previous.join(", ")}) — re-add it in .pi/subagents.json to narrow it again.`
        : "";
      notifyApplied(
        ctx,
        `Package agents ${enabled ? "enabled" : "disabled"}.${replaced} Tool spec change takes effect on next pi session.`,
        deps,
      );
    },
  },
  {
    id: "packageWorkflows",
    label: "Package workflows",
    description: () => describeGateSetting(
      getPackageWorkflowsGate(),
      "Resolve saved workflow names against scripts declared by installed pi packages "
      + "(`pi.subagents.workflows`). Searched last, after your project, workspace and personal directories.",
    ),
    getCurrent: () => (gateAdmitsAnything(getPackageWorkflowsGate()) ? "on" : "off"),
    apply: (value, ctx, deps) => {
      const enabled = value === "on";
      const previous = getPackageWorkflowsGate();
      setPackageWorkflowsGate(enabled);
      deps.reloadCustomAgents();
      const replaced = Array.isArray(previous) && previous.length > 0
        ? ` Replaced the allowlist (${previous.join(", ")}) — re-add it in .pi/subagents.json to narrow it again.`
        : "";
      notifyApplied(ctx, `Package workflows ${enabled ? "enabled" : "disabled"}.${replaced}`, deps);
    },
  },
  {
    id: "scopeModels",
    label: "Scope models",
    description: "Validate subagent models against scoped models (/scoped-models)",
    getCurrent: () => (isScopeModelsEnabled() ? "on" : "off"),
    apply: (value, ctx, deps) => {
      const enabled = value === "on";
      setScopeModelsEnabled(enabled);
      notifyApplied(ctx, `Scope models ${enabled ? "enabled" : "disabled"}`, deps);
    },
  },
  {
    id: "strictAgentFiles",
    label: "Strict agent files",
    description: "Fail startup on an unreadable/unparseable agent .md instead of skipping it with a warning",
    getCurrent: (deps) => (deps.getStrictAgentFiles() ? "on" : "off"),
    apply: (value, ctx, deps) => {
      const enabled = value === "on";
      deps.setStrictAgentFiles(enabled);
      notifyApplied(
        ctx,
        `Strict agent files ${enabled ? "enabled" : "disabled"}. Takes effect on next pi session.`,
        deps,
      );
    },
  },
  {
    id: "disableDefaultAgents",
    label: "Disable defaults",
    description: "Hide built-in agents (general-purpose, Explore, Plan) — custom agents are unaffected",
    getCurrent: () => (isDefaultsDisabled() ? "on" : "off"),
    apply: (value, ctx, deps) => {
      const enabled = value === "on";
      deps.setDisableDefaultAgents(enabled);
      notifyApplied(
        ctx,
        `Default agents ${enabled ? "disabled" : "enabled"}. Tool spec change takes effect on next pi session.`,
        deps,
      );
    },
  },
  {
    id: "fallbackSubagent",
    label: "Fallback agent",
    description: `Agent used when subagent_type is unknown, disabled, or ambiguous; "${NO_FALLBACK}" rejects the call instead (strict dispatch)`,
    getValues: () => [...new Set([...getAvailableTypes(), NO_FALLBACK])],
    getCurrent: () => getFallbackSubagent() ?? "general-purpose",
    apply: (value, ctx, deps) => {
      setFallbackSubagent(value);
      notifyApplied(
        ctx,
        value === NO_FALLBACK
          ? "Unknown or disabled agent types will now be rejected"
          : `Unknown agent types will fall back to ${value}`,
        deps,
      );
    },
  },
  {
    id: "outputTranscript",
    label: "Output transcript",
    description: "Write each subagent's .output transcript by default. A custom agent's output_transcript frontmatter overrides this.",
    getCurrent: () => (getOutputTranscriptDefault() ? "on" : "off"),
    apply: (value, ctx, deps) => {
      const enabled = value === "on";
      setOutputTranscriptDefault(enabled);
      notifyApplied(ctx, `Output transcript ${enabled ? "enabled" : "disabled"} by default`, deps);
    },
  },
  {
    id: "cacheRetention",
    label: "Prompt cache retention",
    description:
      "Prompt cache lifetime for subagent model calls: short (5 min on Anthropic), long (1 hour), none, or inherit "
      + "(pi's default, incl. PI_CACHE_RETENTION). An agent's cache_retention frontmatter overrides it; the main session is unaffected. Applies to agents started after the change",
    getValues: () => ["inherit", "short", "long", "none"],
    getCurrent: () => getCacheRetention(),
    apply: (value, ctx, deps) => {
      const setting = value as CacheRetentionSetting;
      setCacheRetention(setting);
      notifyApplied(ctx, `Prompt cache retention set to ${setting}`, deps);
    },
  },
  {
    id: "worktreeIsolation",
    label: "Worktree isolation",
    description:
      "Allow isolation: worktree to copy the repo. Off refuses worktrees on every path immediately — for repos where a copy costs too much time or disk — and drops the `isolation` param from the Agent tool spec on next pi session.",
    getCurrent: () => (isWorktreeIsolationEnabled() ? "on" : "off"),
    apply: (value, ctx, deps) => {
      const enabled = value === "on";
      setWorktreeIsolationEnabled(enabled);
      notifyApplied(
        ctx,
        `Worktree isolation ${enabled ? "enabled" : "disabled"}. Tool parameter updates on next pi session.`,
        deps,
      );
    },
  },
  {
    id: "worktreeTimeoutSeconds",
    label: "Worktree timeout",
    description: () =>
      `Seconds git may take to create an isolated worktree (${MIN_WORKTREE_TIMEOUT_SECONDS}-${MAX_WORKTREE_TIMEOUT_SECONDS}, default 30; raise it for a large repo, Enter to type)`,
    isNumeric: true,
    // Master renders the same label from MIN/MAX_WORKTREE_TIMEOUT_SECONDS
    // inside a lazily-built menu; this registry evaluates at module load, so
    // the bounds are spelled out - a partial worktree.js mock that omits the
    // constants must not break importing this module.
    numericPromptLabel: "Worktree timeout (30-3600 seconds)",
    getCurrent: () => String(getWorktreeTimeoutSeconds()),
    apply: (value, ctx, deps) => {
      const n = parseInt(value, 10);
      if (Number.isInteger(n) && n >= MIN_WORKTREE_TIMEOUT_SECONDS && n <= MAX_WORKTREE_TIMEOUT_SECONDS) {
        setWorktreeTimeoutSeconds(n);
        notifyApplied(ctx, `Worktree timeout set to ${getWorktreeTimeoutSeconds()}s`, deps);
      }
    },
  },
  {
    id: "reportUsage",
    label: "Report usage to session",
    description:
      "Add subagent tokens and cost to this session's own totals, so pi's footer and /cost stop reading a delegating session as nearly free. Reported on the next tool result (agents that finish in the background are counted on the one after). Context-window % is unaffected.",
    getCurrent: (deps) => (deps.isReportUsageEnabled() ? "on" : "off"),
    apply: (value, ctx, deps) => {
      const enabled = value === "on";
      deps.setReportUsage(enabled);
      notifyApplied(
        ctx,
        enabled
          ? "Subagent usage now counted in this session's totals"
          : "Subagent usage no longer counted in this session's totals",
        deps,
      );
    },
  },
  {
    id: "showCost",
    label: "Show cost",
    description:
      "Show an estimated `~$0.0042` beside subagent token counts in the widget, fleet view, results and notifications. Priced by pi from the model's rates — omitted entirely for a model it has no rates for.",
    getCurrent: (deps) => (deps.isShowCostEnabled() ? "on" : "off"),
    apply: (value, ctx, deps) => {
      const enabled = value === "on";
      deps.setShowCost(enabled);
      notifyApplied(ctx, `Cost display ${enabled ? "enabled" : "disabled"}`, deps);
    },
  },
  {
    id: "showModel",
    label: "Show model",
    description:
      "Name the model driving each agent, and the thinking level it is running at, on the widget's running rows and the fleet view rows. The Agent tool result and the conversation viewer show the pair either way — this adds it where the rows are already dense.",
    getCurrent: (deps) => (deps.isShowModelEnabled() ? "on" : "off"),
    apply: (value, ctx, deps) => {
      const enabled = value === "on";
      deps.setShowModel(enabled);
      notifyApplied(ctx, `Model display ${enabled ? "enabled" : "disabled"}`, deps);
    },
  },
  {
    id: "uiStyle",
    label: "UI style",
    description: "Visual chrome style: pi (native edge-to-edge rules and footer status) or claude (rounded box corners, side rails, and plain status)",
    getValues: () => ["pi", "claude"],
    getCurrent: (deps) => deps.getUIStyle(),
    apply: (value, ctx, deps) => {
      const style = value as UIStyle;
      deps.setUIStyle(style);
      notifyApplied(ctx, `UI style set to ${style}`, deps);
    },
  },
  {
    id: "viewerStyle",
    label: "Viewer style",
    description:
      "Conversation viewer transcript: chat = pi's main-screen message components, like main-chat output (default); "
      + "compact = the original flat transcript with [User]/[Assistant] labels, dim thinking previews and capped tool output",
    getValues: () => ["chat", "compact"],
    getCurrent: (deps) => deps.getViewerStyle(),
    apply: (value, ctx, deps) => {
      const style = value as ViewerStyle;
      deps.setViewerStyle(style);
      notifyApplied(ctx, `Viewer style set to ${style}`, deps);
    },
  },
  {
    id: "fleetView",
    label: "Fleet view",
    description: "Claude Code-style main+subagents list below the editor (↓/← to navigate, Enter to view)",
    getCurrent: (deps) => (deps.isFleetViewEnabled() ? "on" : "off"),
    apply: (value, ctx, deps) => {
      const enabled = value === "on";
      deps.setFleetViewEnabled(enabled);
      notifyApplied(ctx, `Fleet view ${enabled ? "enabled" : "disabled"}`, deps);
    },
  },
  {
    id: "agentMentions",
    label: "Agent mentions",
    description: "Route `@handle message` at the prompt to that agent. model = an off-screen clone of this conversation calls the Agent tool, so the agent gets a context-written prompt, a transcript and per-tool detail, and the chat stays clean; direct = started here from your text, no model call. Messaging and resuming are direct either way.",
    getValues: () => ["model", "direct", "off"],
    getCurrent: (deps) => deps.getAgentMentionMode(),
    apply: (value, ctx, deps) => {
      const mode = value as AgentMentionMode;
      deps.setAgentMentionMode(mode);
      notifyApplied(
        ctx,
        mode === "off"
          ? "Agent mentions disabled"
          : mode === "model"
            ? "Agent mentions on — a conversation clone starts a mentioned agent off-screen"
            : "Agent mentions on — a mentioned agent starts here, with no model call",
        deps,
      );
    },
  },
  {
    id: "rememberAgents",
    label: "Remember agents",
    description: "Persist subagent sessions so `@handle` can resume one long after it finished (they also appear in /resume)",
    getCurrent: () => (getRememberAgents() ? "on" : "off"),
    apply: (value, ctx, deps) => {
      const enabled = value === "on";
      setRememberAgents(enabled);
      notifyApplied(ctx, `Remember agents ${enabled ? "enabled" : "disabled"}`, deps);
    },
  },
  {
    id: "toolDescriptionMode",
    label: "Tool description",
    description:
      "Agent tool description sent to the LLM: full (rich, default), compact (~75% fewer tokens, for small/local models), or custom (.pi/agent-tool-description.md with {{placeholders}})",
    getValues: () => ["full", "compact", "custom"],
    getCurrent: (deps) => deps.getToolDescriptionMode(),
    apply: (value, ctx, deps) => {
      const mode = value as ToolDescriptionMode;
      deps.setToolDescriptionMode(mode);
      notifyApplied(ctx, `Tool description set to ${mode}. Takes effect on next pi session.`, deps);
    },
  },
];

export const SETTINGS_DESCRIPTORS_BY_ID = new Map<string, SettingDescriptor>(
  SETTINGS_DESCRIPTORS.map((d) => [d.id, d]),
);

export const NUMERIC_SETTINGS_IDS = new Set<string>(
  SETTINGS_DESCRIPTORS.filter((d) => d.isNumeric).map((d) => d.id),
);
