/**
 * fleet-list.ts — Claude Code-style "FleetView" list rendered below the editor.
 *
 * Shows `main` + each running/queued subagent as a navigable list. Pressing ↓ (or
 * ←) at an empty prompt activates the list; ↑/↓ move the selection (filled ● marker),
 * Enter opens the selected agent's live conversation overlay, Esc returns to the prompt.
 * → mirrors ←: it dismisses the list entirely — bar included — until ↓/← recall it
 * or fresh agent activity re-shows it.
 * A viewer stays open when its agent finishes; finished agents linger briefly in the list.
 *
 * Mechanics (see plan): the list is a `belowEditor` widget (render-only), and ALL key
 * handling goes through `onTerminalInput` — which fires before the focused editor and
 * can `consume` keys — gated on `getEditorText() === ""` so normal typing is untouched.
 */

import { isKeyRelease, Key, matchesKey, type ScrollViewScrollbar, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { hasAgentBadge, renderAgentRecordName } from "../agent-color.js";
import type { AgentManager } from "../agent-manager.js";
import type { AgentRecord, UIStyle, ViewerStyle } from "../types.js";
import { getLifetimeCost, getLifetimeTotal } from "../usage.js";
import type { WorkflowRunControls } from "./agent-hub.js";
import { openAgentHub } from "./agent-hub.js";
import { type AgentActivity, buildInvocationTags, formatCost, formatFleetElapsed, formatFleetTokens, type Theme } from "./agent-widget.js";
import { type ViewerBackgroundAction } from "./conversation-viewer.js";
import type { WorkflowDialogSource } from "./workflow-view.js";

/** Widget key for the below-editor fleet list. */
const FLEET_KEY = "fleet";
/** Max agent rows shown at once; extras collapse into a "↓ N more" indicator. */
const MAX_AGENT_ROWS = 10;
/** Re-render cadence so elapsed/token stats tick while agents run. */
const TICK_MS = 200;
/** How long a finished agent lingers in the list before it drops out. */
const FINISHED_LINGER_MS = 4000;

// Fleet-row format helpers moved to agent-widget (shared with the agent hub);
// re-exported here for the established import path.
export { formatFleetElapsed, formatFleetTokens } from "./agent-widget.js";

/** Minimal UI surface the FleetView needs from `ctx.ui` (structural subset). */
export type FleetUICtx = {
  setWidget(
    key: string,
    content: undefined | ((tui: any, theme: Theme) => { render(width: number): string[]; invalidate(): void; dispose?(): void }),
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void;
  onTerminalInput(handler: (data: string) => { consume?: boolean; data?: string } | undefined): () => void;
  getEditorText(): string;
  notify(message: string, type?: "info" | "warning" | "error"): void;
  custom<T>(
    factory: (tui: any, theme: Theme, keybindings: any, done: (result: T) => void) => { render(width: number): string[]; invalidate(): void; dispose?(): void },
    options?: { overlay?: boolean; overlayOptions?: unknown; onHandle?: (handle: unknown) => void },
  ): Promise<T>;
};

/**
 * A workflow run, as the fleet list needs to see it.
 *
 * Narrow on purpose: the list knows nothing about `WorkflowTask`, the runtime
 * or the dialog, so it stays as testable as it was when it only held agents.
 * The extension maps its tasks into this shape and injects an opener.
 */
export interface FleetWorkflow {
  id: string;
  /** The `meta.name` of the run, or its id when the script named nothing. */
  name: string;
  status: "running" | "completed" | "failed" | "killed" | "paused";
  doneCount: number;
  totalCount: number;
  startedAt: number;
  /** Set once the run settles, which is what freezes its clock. */
  completedAt?: number;
  tokens: number;
}

type MainEntry = { kind: "main" };
export type AgentEntry = {
  kind: "agent";
  record: AgentRecord;
  depth?: number;
  isLastChild?: boolean;
};
type WorkflowEntry = { kind: "workflow"; workflow: FleetWorkflow };
type FleetEntry = MainEntry | WorkflowEntry | AgentEntry;

/**
 * Place `right` flush to `width`, truncating `left` first so the stats survive.
 * The final clamp guarantees the line never exceeds `width` (which would wrap and
 * desync pi's line-diff → flicker) even on a terminal too narrow for the stats.
 */
function rightAlign(left: string, right: string, width: number): string {
  const rightW = visibleWidth(right);
  const maxLeft = Math.max(0, width - rightW - 1);
  const leftClamped = truncateToWidth(left, maxLeft);
  const gap = Math.max(1, width - visibleWidth(leftClamped) - rightW);
  return truncateToWidth(leftClamped + " ".repeat(gap) + right, width);
}

export const SHARED_FLEET_COORDINATOR_KEY = Symbol.for("pi-subagents:fleet-coordinator");
export const SHARED_DOCK_COORDINATOR_KEY = Symbol.for("pi-bash:dock-coordinator");

function formatFleetSectionHeader(
  title: string,
  width: number,
  theme: Theme,
  hint?: string,
): string {
  const prefix = "── ";
  const suffix = " ";
  const prefixW = visibleWidth(prefix);
  const titleW = visibleWidth(title);
  const suffixW = visibleWidth(suffix);

  if (hint && width > 50) {
    const hintText = ` ${hint} `;
    const hintW = visibleWidth(hintText);
    const midRuleLen = Math.max(1, width - prefixW - titleW - suffixW - hintW);
    const midRule = "─".repeat(midRuleLen);
    const titleStr = theme.fg("toolTitle" as any, title);
    const hintStr = theme.fg("dim", hintText);
    return truncateToWidth(`${theme.fg("dim", prefix)}${titleStr}${theme.fg("dim", suffix + midRule)}${hintStr}`, width);
  }

  const ruleLen = Math.max(0, width - prefixW - titleW - suffixW);
  const rule = "─".repeat(ruleLen);
  const titleStr = theme.fg("toolTitle" as any, title);
  return truncateToWidth(`${theme.fg("dim", prefix)}${titleStr}${theme.fg("dim", suffix + rule)}`, width);
}

export class FleetList {
  private ui: FleetUICtx | undefined;
  private tui: any | undefined;
  private inputUnsub: (() => void) | undefined;
  private widgetRegistered = false;
  private timer: ReturnType<typeof setInterval> | undefined;

  private enabled = true;
  /** Whether arrow keys currently navigate the list (vs. flow to the editor). */
  private active = false;
  /**
   * Set when → dismisses the bar. The list stays hidden — ↓/← recall it (the
   * activators are the "I want the fleet view" keys), and the flag clears when
   * the roster empties or when agents are added/removed so fresh agent activity
   * re-expands the bar on its own.
   */
  private dismissed = false;
  /** Track agent IDs to trigger auto-expansion when agents are added or removed. */
  private previousAgentIds: Set<string> = new Set();
  /**
   * Set while the agent hub overlay is up. Like `dismissed`, it holds the bar
   * down without touching the roster — but it is the hub's state, not the
   * user's: `openHub` sets it and clears it when the hub's promise settles,
   * so the bar comes back exactly as it was. The popup panel covers most of
   * the terminal but not the bar's row band, and a roster duplicated under
   * it reads as clutter.
   */
  private hubOpen = false;
  /** 0 = `main`, 1..N = subagents. */
  private selectedIndex = 0;
  /** Set while a conversation overlay is open; calling it closes the overlay. */
  private viewerClose: (() => void) | undefined;
  private viewingAgentId: string | undefined;
  /** Injected by the extension; absent until workflows are wired (or at all). */
  private workflowSource: (() => readonly FleetWorkflow[]) | undefined;
  private openWorkflow: ((id: string) => Promise<void> | void) | undefined;
  /** The hub's run-page detail and its `s`, injected by the extension. */
  private workflowRunSource: ((id: string) => WorkflowDialogSource | undefined) | undefined;
  private stopWorkflowRun: ((id: string) => boolean | undefined) | undefined;
  /** The hub's run controls (W's `p`, WA's `s`/`r`), injected by the extension. */
  private workflowRunControls: ((id: string) => WorkflowRunControls | undefined) | undefined;
  /** Injected pause/resume for the `p` key — see `setLifecycleActions`. */
  private lifecycleActions: { pause: (id: string) => string | undefined; resume: (id: string) => boolean } | undefined;
  /**
   * Set while the hub is up on a run's page.
   *
   * It does the two jobs `viewerClose` does for an agent's overlay — keep the
   * list out of the hub's keys, and remember which row to come back to —
   * minus the close handle, because that overlay belongs to the extension.
   */
  private viewingWorkflowId: string | undefined;

  constructor(
    private manager: AgentManager,
    private agentActivity: Map<string, AgentActivity>,
    /**
     * Read live at render time. Whether each row shows an estimated cost after
     * its token count. Defaults to off — the extension supplies the user's
     * `showCost` setting.
     */
    private showCost: () => boolean = () => false,
    private scrollbarMode: () => ScrollViewScrollbar = () => "auto",
    /**
     * The viewer's `b` for this row's run, supplied by the extension: only it
     * knows which runs have a tool call waiting to be released, and it owns the
     * widget this list shares with. Omitted → no `b` affordance.
     */
    private backgroundAction?: (record: AgentRecord, notify: (message: string) => void) => ViewerBackgroundAction,
    private uiStyle: () => UIStyle = () => "pi",
    private viewerStyle: () => ViewerStyle = () => "chat",
    /**
     * Read live at render time, like `showCost`. Whether each row names the
     * model driving the run and the thinking level it is running at. Defaults to
     * off — the extension supplies the user's `showModel` setting — because the
     * row is already dense and the same pair is shown unconditionally in the
     * conversation viewer and the `Agent` tool result.
     */
    private showModel: () => boolean = () => false,
  ) {}

  // ---- Lifecycle ----

  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.enabled = enabled;
    if (!enabled) this.active = false;
    // Re-enabling the setting always shows the bar again — a dismissal made
    // under the old session's keys says nothing about this toggle.
    this.dismissed = false;
    this.update();
  }

  /** Capture the UI context and (re)register the global input handler. */
  setUICtx(ui: FleetUICtx): void {
    if (ui === this.ui) return;
    this.inputUnsub?.();
    this.ui = ui;
    this.widgetRegistered = false;
    this.tui = undefined;
    this.inputUnsub = ui.onTerminalInput(data => this.handleKey(data));

    (globalThis as any)[SHARED_FLEET_COORDINATOR_KEY] = {
      isActive: () => this.active,
      hasRows: () => this.hasRows(),
      activate: (fromTop = true) => {
        this.dismissed = false;
        this.active = true;
        this.selectedIndex = fromTop ? 0 : Math.max(0, this.roster().length - 1);
        this.update();
      },
      deactivate: () => {
        this.deactivate();
      },
      update: () => {
        this.update();
      },
    };
  }

  /** Ensure the re-render timer is running (called when an agent spawns). */
  ensureTimer(): void {
    if (!this.timer) this.timer = setInterval(() => this.update(), TICK_MS);
  }

  /**
   * Called when an agent finishes. Re-expands the fleet if dismissed, and refreshes
   * so the settled agent line is visible.
   */
  onAgentFinished(_id: string): void {
    this.dismissed = false;
    this.update();
  }

  dispose(): void {
    delete (globalThis as any)[SHARED_FLEET_COORDINATOR_KEY];
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    this.inputUnsub?.();
    this.inputUnsub = undefined;
    if (this.viewerClose) { this.viewerClose(); this.viewerClose = undefined; }
    this.viewingAgentId = undefined;
    // No handle to close the hub with, but the list is going
    // away — leaving the id set would keep it swallowing input forever.
    this.viewingWorkflowId = undefined;
    if (this.ui && this.widgetRegistered) this.ui.setWidget(FLEET_KEY, undefined);
    this.widgetRegistered = false;
    this.tui = undefined;
    this.active = false;
    this.dismissed = false;
    this.previousAgentIds.clear();
    // Null last so a `viewerClose()` microtask above can't re-register the widget.
    this.ui = undefined;
  }

  /** Whether the list currently has anything to show (agents or workflow rows). */
  hasRows(): boolean {
    return this.enabled && this.roster().length > 1;
  }

  /** Re-register/refresh the below-editor widget; clears it when nothing remains. */
  update(): void {
    if (!this.ui) return;

    // Detect added or removed agents to auto-expand the fleet view if previously dismissed.
    const currentAgentIds = new Set(this.agentRosterEntries().map(e => e.record.id));
    if (this.dismissed) {
      let changed = false;
      if (this.previousAgentIds.size !== currentAgentIds.size) {
        changed = true;
      } else {
        for (const id of currentAgentIds) {
          if (!this.previousAgentIds.has(id)) {
            changed = true;
            break;
          }
        }
      }
      if (changed) {
        this.dismissed = false;
      }
    }
    this.previousAgentIds = currentAgentIds;

    // A run with no agents of its own left in the list is still worth a row —
    // it is the thing the user opens to see what its children did. Read off the
    // roster for the same reason activation does: two counts of "is there
    // anything here" drifted apart once before.
    const hasRows = this.hasRows();

    if (!hasRows) {
      if (this.widgetRegistered) {
        this.ui.setWidget(FLEET_KEY, undefined);
        this.widgetRegistered = false;
        this.tui = undefined;
      }
      if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
      this.active = false;
      this.selectedIndex = 0;
      // Nothing left to keep hidden: the next batch of agents shows the bar
      // again rather than inheriting a dismissal aimed at the last batch.
      this.dismissed = false;
      return;
    }

    this.clampSelection();
    this.ensureTimer(); // keep stats ticking whenever the list is shown (e.g. after a re-enable)

    const dockCoordinator = (globalThis as any)[SHARED_DOCK_COORDINATOR_KEY];
    const dockExpanded = !!(dockCoordinator?.isDetail?.() || dockCoordinator?.isExpanded?.());
    if (dockExpanded) {
      if (this.widgetRegistered) {
        this.ui.setWidget(FLEET_KEY, undefined);
        this.widgetRegistered = false;
        this.tui = undefined;
      }
      return;
    }

    if (this.dismissed || this.hubOpen) {
      // The user closed the bar with →, or the hub overlay is up. Stay hidden
      // while the roster lasts — only ↓/← (or this roster emptying out) bring
      // a dismissal back; the hub's own close restores its case.
      if (this.widgetRegistered) {
        this.ui.setWidget(FLEET_KEY, undefined);
        this.widgetRegistered = false;
        this.tui = undefined;
      }
      return;
    }

    if (!this.widgetRegistered) {
      this.ui.setWidget(FLEET_KEY, (tui, theme) => {
        this.tui = tui;
        // Bridge renderer-version drift: the hub hold-down clears this bar
        // while the hub overlay masks the layout shrink, so the overlay-close
        // render is what reclaims the bar's row band. Older TuiMainScreens do
        // not erase rows a shrunken frame vacated, leaving stale pixels below
        // the editor — the "bottom doesn't go back to the actual bottom"
        // report. clear-on-shrink is the renderer's own fix for exactly that
        // (full redraw whenever the frame shrinks), pi carries the flag
        // across TUI-mode switches, and it is duck-typed so hosts without it
        // just keep their current behavior.
        if (typeof tui.setClearOnShrink === "function") tui.setClearOnShrink(true);
        return {
          render: (w: number) => this.renderBar(w, theme),
          invalidate: () => { this.widgetRegistered = false; this.tui = undefined; },
        };
      }, { placement: "belowEditor" });
      this.widgetRegistered = true;
    } else {
      this.tui?.requestRender();
    }
  }

  // ---- Roster ----

  /**
   * Builds a Claude Code-style hierarchical roster of subagents.
   * Top-level agents appear at depth 0. Nested subagents (child agents spawned by a parent)
   * appear indented under their parent with tree branches (`├─ ` / `└─ `).
   */
  private agentRosterEntries(): AgentEntry[] {
    const now = Date.now();
    const all = this.manager.listAgents();
    // The viewed agent stays listed, and a nested one needs its ancestors to
    // hang from: they settle together (a parent stops its children), so the
    // parent would otherwise drop out first and take the viewed row with it.
    const pinned = new Set<string>();
    for (let id = this.viewingAgentId; id !== undefined && !pinned.has(id); ) {
      pinned.add(id);
      id = all.find(a => a.id === id)?.parentAgentId;
    }
    const eligible = all.filter(a =>
      !a.workflowId && a.session && (
        a.status === "running" || a.status === "queued" || a.status === "paused"
        || pinned.has(a.id)
        || (a.completedAt != null && now - a.completedAt < FINISHED_LINGER_MS)
      )
    );

    const eligibleMap = new Map<string, AgentRecord>(eligible.map(a => [a.id, a]));
    const childrenByParent = new Map<string, AgentRecord[]>();

    for (const a of eligible) {
      if (a.parentAgentId && eligibleMap.has(a.parentAgentId)) {
        let list = childrenByParent.get(a.parentAgentId);
        if (!list) {
          list = [];
          childrenByParent.set(a.parentAgentId, list);
        }
        list.push(a);
      }
    }

    for (const list of childrenByParent.values()) {
      list.sort((a, b) => a.startedAt - b.startedAt);
    }

    // A child whose parent is not listed has no row to hang from: drop it.
    const roots = eligible.filter(a => !a.parentAgentId);
    roots.sort((a, b) => a.startedAt - b.startedAt);

    const result: AgentEntry[] = [];
    const visited = new Set<string>();

    const appendWithChildren = (rec: AgentRecord, depth: number, isLastChild?: boolean) => {
      if (visited.has(rec.id)) return;
      visited.add(rec.id);

      result.push({
        kind: "agent",
        record: rec,
        depth,
        isLastChild,
      });

      const children = childrenByParent.get(rec.id) ?? [];
      for (let i = 0; i < children.length; i++) {
        const isLast = i === children.length - 1;
        appendWithChildren(children[i], depth + 1, isLast);
      }
    };

    for (const root of roots) {
      appendWithChildren(root, 0);
    }

    return result;
  }


  /**
   * Wire workflow runs into the list.
   *
   * Injected rather than constructed here because the fleet list predates
   * workflows and must keep working without them — a session with the feature
   * switched off never calls this, and the roster is agents-only exactly as
   * before.
   */
  setWorkflowSource(
    source: () => readonly FleetWorkflow[],
    open: (id: string) => Promise<void> | void,
  ): void {
    this.workflowSource = source;
    this.openWorkflow = open;
  }

  /**
   * The hub's run pages (W/WA/L) need the run's detail, its `s` needs a way to
   * stop one, and its `p`/`s`/`r` need the run's own controls (pause/resume,
   * skip/retry). All three live where the runs do; the hub gets them as
   * callbacks rather than reaching into the workflow runtime. Omitting the
   * controls keeps those keys and their band hints absent.
   */
  setWorkflowRunSource(
    run: (id: string) => WorkflowDialogSource | undefined,
    stop: (id: string) => boolean | undefined,
    controls?: (id: string) => WorkflowRunControls | undefined,
  ): void {
    this.workflowRunSource = run;
    this.stopWorkflowRun = stop;
    this.workflowRunControls = controls;
  }

  /**
   * Wire the `p` key's pause/resume. Injected rather than taken in the
   * constructor because the funnel lives in the extension closure (it is what
   * emits `subagents:paused`) — the same reason `setWorkflowSource` exists.
   * `pause` returns why a pause was refused; `resume` reports acceptance.
   * Omitted → `p` does nothing.
   */
  setLifecycleActions(
    actions: { pause: (id: string) => string | undefined; resume: (id: string) => boolean },
  ): void {
    this.lifecycleActions = actions;
  }

  /** Live runs, plus recently settled ones — the same linger the agents get. */
  private workflows(): FleetWorkflow[] {
    if (!this.workflowSource) return [];
    const now = Date.now();
    return [...this.workflowSource()]
      .filter(run =>
        run.status === "running"
        || run.status === "paused"
        || (run.completedAt != null && now - run.completedAt < FINISHED_LINGER_MS)
      )
      .sort((a, b) => a.startedAt - b.startedAt);
  }

  /**
   * Runs sit above the agents rather than interleaved by start time: a run owns
   * most of the agents under it, so listing the container first is what makes
   * the list read as a hierarchy rather than a shuffle.
   */
  private roster(): FleetEntry[] {
    return [
      { kind: "main" },
      ...this.workflows().map(workflow => ({ kind: "workflow" as const, workflow })),
      ...this.agentRosterEntries(),
    ];
  }

  /**
   * `p`: pause the selected agent if active, resume it if paused — the same
   * one-lifecycle toggle the hub's roster uses. Settled agents stay put.
   * Nested child subagents cannot be paused directly (managed by parent).
   */
  private pauseResumeSelected(): void {
    const entry = this.roster()[this.selectedIndex];
    if (entry?.kind !== "agent" || !this.lifecycleActions) return;
    const { status, id, parentAgentId } = entry.record;
    if (parentAgentId) {
      this.ui?.notify("Nested subagents are managed by their parent agent and cannot be paused directly", "warning");
      return;
    }
    if (status === "running" || status === "queued") {
      const refusal = this.lifecycleActions.pause(id);
      if (refusal !== undefined) this.ui?.notify(`Could not pause — ${refusal}.`, "warning");
    } else if (status === "paused") {
      if (!this.lifecycleActions.resume(id)) this.ui?.notify("Could not resume agent.", "warning");
    }
    this.update();
  }

  private clampSelection(): void {
    const max = this.roster().length - 1;
    if (this.selectedIndex > max) this.selectedIndex = Math.max(0, max);
    if (this.selectedIndex < 0) this.selectedIndex = 0;
  }

  // ---- Key handling ----

  /** Returns `{consume:true}` to swallow a key, or undefined to let it through. */
  handleKey(data: string): { consume?: boolean; data?: string } | undefined {
    if (!this.enabled || !this.ui) return undefined;
    // Input listeners receive BOTH key-press and key-release (the kitty protocol
    // emits both, and matchesKey matches either) — act on press only, or every
    // tap would move/fire twice. Repeats still pass through for held-key nav.
    if (isKeyRelease(data)) return undefined;

    const dockCoordinator = (globalThis as any)[SHARED_DOCK_COORDINATOR_KEY];
    const isDockActive = !!(dockCoordinator && (dockCoordinator.inDock?.() || dockCoordinator.isDetail?.() || dockCoordinator.isExpanded?.()));
    if (isDockActive) {
      if (this.active) this.deactivate();
      return undefined;
    }

    // While an overlay is open, let it own all input. Checked before the focus
    // test below, which would otherwise read the hub holding the keyboard as
    // "the user left the list" and reset the selection out from under it.
    // `hubOpen` included: the held-down bar has zeroed `this.tui`, so
    // `editorHasFocus()` reads true ("unknowable = editor") and this listener
    // would otherwise eat the hub's ↓/← as bar activators — wiping a →
    // dismissal with each press — and swallow one Esc per activation.
    if (this.viewerClose || this.viewingWorkflowId || this.hubOpen) return undefined;
    // Input listeners fire BEFORE the focused component, and dialogs
    // (ctx.ui.select/confirm/input, pi's own menus) swap the prompt editor out
    // while getEditorText() still reads the detached — empty — editor. So when
    // anything but the editor owns the keyboard, stay out of its keys (#123).
    if (!this.editorHasFocus()) {
      if (this.active) this.deactivate();
      return undefined;
    }

    const hasBgTasks = !!dockCoordinator?.hasTasks?.();

    if (!this.active) {
      // Activate: ↓ or ← at an empty prompt moves focus into the list — and
      // recalls a bar dismissed with →, so the closing key's mirror reopens it.
      const isDown = matchesKey(data, "down");
      const isLeft = matchesKey(data, "left");

      // When background tasks exist above the fleet, ↓ at prompt belongs to the Tasks Dock.
      // ← remains the direct activator for subagents fleet.
      if (isDown && hasBgTasks) {
        return undefined;
      }

      const isActivator = isDown || isLeft;
      // Gated on the roster, not the agents: a session whose only row is a
      // workflow run still has somewhere to go, and requiring an agent would
      // render the row but refuse to move into it.
      if (isActivator && this.roster().length > 1 && this.ui.getEditorText() === "") {
        this.dismissed = false;
        this.active = true;
        // No cursor reset here: recall resumes where the bar was left. A
        // plain → dismissal zeroed the cursor on the way out (deactivate),
        // and a hub close left it on the agent you were viewing.
        this.update();
        return { consume: true };
      }
      return undefined;
    }

    // Active — arrows navigate, Enter opens, → / Esc / Up-past-top leave the list.
    const isTab = matchesKey(data, Key.tab) || data === "\t";
    if (isTab && hasBgTasks && dockCoordinator?.enterDock) {
      this.deactivate();
      dockCoordinator.enterDock(false);
      return { consume: true };
    }

    if (matchesKey(data, "down")) {
      const max = this.roster().length - 1;
      this.selectedIndex = Math.min(max, this.selectedIndex + 1);
      this.update();
      return { consume: true };
    }
    if (matchesKey(data, "up")) {
      if (this.selectedIndex === 0) {
        this.deactivate();
        if (hasBgTasks && dockCoordinator?.enterDock) {
          dockCoordinator.enterDock(true);
        }
        return { consume: true };
      }
      this.selectedIndex -= 1;
      this.update();
      return { consume: true };
    }
    // → mirrors ←: the key that called the list dismisses it again, bar
    // included — deactivating alone would leave the rows on screen, which
    // reads as "nothing closed". ↓/← bring it back.
    if (matchesKey(data, "right")) {
      this.dismissed = true;
      this.deactivate();
      return { consume: true };
    }
    if (matchesKey(data, "escape")) { this.deactivate(); return { consume: true }; }
    if (matchesKey(data, Key.enter)) { this.openSelected(); return { consume: true }; }
    if (matchesKey(data, "p")) { this.pauseResumeSelected(); return { consume: true }; }

    // Any other key cancels navigation and flows to the editor.
    this.deactivate();
    return undefined;
  }

  /**
   * True when pi's prompt editor owns the keyboard. The editor is pluggable
   * (ui.setEditorComponent) and need not extend `Editor` (#374), so match pi-tui's
   * `EditorComponent` contract instead: `getText` + `setText`, which pi calls on
   * every editor and none of pi's dialogs, selectors or overlays implement.
   * `focusedComponent` is TUI-private (no public accessor), hence the best-effort
   * peek: unknowable focus (no tui seen yet, nothing focused) counts as the
   * editor so activation keeps working.
   */
  editorHasFocus(): boolean {
    const focused = (this.tui as { focusedComponent?: unknown } | undefined)?.focusedComponent;
    if (focused == null) return true;
    const c = focused as { getText?: unknown; setText?: unknown };
    return typeof c.getText === "function" && typeof c.setText === "function";
  }

  private deactivate(): void {
    this.active = false;
    this.selectedIndex = 0;
    this.update();
  }

  /**
   * Open the full-screen agent hub. `agentId` starts in the windowed panel on
   * that agent (the Enter-on-agent / `c`-on-row flow); `runId` starts it on
   * that run's page (**W**), with the run selected (the Enter-on-run and
   * `/agents → Workflows` flow); neither opens full-screen on the roster.
   *
   * `uiOverride` serves entry points reached before this session bound the
   * fleet's UI context (the workflow menu), so they get the same panel instead
   * of silently no-oping.
   *
   * Returns the hub's promise — resolves when the hub closes. Callers that
   * stack another dialog after this (e.g. /agents re-showing its list) MUST
   * await it: the dialog would otherwise open on top of the panel and take
   * its keys.
   *
   * Shared by the fleet list and `/agents` so both entry points drive the same
   * overlay lifecycle: while the hub is up the list keeps its keys to itself
   * (the `hubOpen` input gate), and on close the cursor returns to the viewed
   * item.
   */
  openHub(initial: { agentId?: string; runId?: string } = {}, uiOverride?: FleetUICtx): Promise<void> {
    const ui = uiOverride ?? this.ui;
    if (!ui) return Promise.resolve(undefined);
    if (initial.agentId != null) this.viewingAgentId = initial.agentId;
    if (initial.runId != null) this.viewingWorkflowId = initial.runId;
    // Hold the bar down while the hub is open, including popup ↔ full-screen
    // toggles, without changing the user's explicit dismissal.
    this.hubOpen = true;
    this.update();
    return openAgentHub(
      ui,
      {
        manager: this.manager,
        agentActivity: this.agentActivity,
        showCost: this.showCost(),
        workflows: this.workflowSource,
        workflowRun: id => this.workflowRunSource?.(id),
        stopWorkflow: id => this.stopWorkflowRun?.(id),
        workflowControls: id => this.workflowRunControls?.(id),
        notify: (message, type) => ui.notify(message, type),
        pauseAgent: id => this.lifecycleActions?.pause(id),
        resumeAgent: id => this.lifecycleActions?.resume(id) ?? false,
        scrollbarMode: this.scrollbarMode,
        backgroundAction: this.backgroundAction,
        uiStyle: this.uiStyle,
        viewerStyle: this.viewerStyle,
      },
      { agentId: initial.agentId, runId: initial.runId },
    ).finally(() => {
      this.hubOpen = false;
      // The Esc keystroke already pays for hideOverlay's immediate full
      // render; re-registering the bar here would stack a second one on the
      // same synchronous frame. Let the keystroke land first — the bar comes
      // back a tick later. A hub opened in the meantime owns the restore
      // instead (its own finally runs it); this timer stands down.
      setTimeout(() => {
        if (this.hubOpen) return;
        // Return keyboard focus to the prompt while keeping the viewed-agent
        // cursor. Leave dismissal unchanged so only an explicit → hides the
        // restored bar.
        this.active = false;
        this.previousAgentIds = new Set(this.agentRosterEntries().map(e => e.record.id));
        this.clearViewer();
      }, 0);
    });
  }

  private openSelected(): void {
    const entry = this.roster()[this.selectedIndex];
    if (!entry || entry.kind === "main") {
      // `main` = return to the prompt; the native transcript is already shown.
      this.deactivate();
      return;
    }
    if (entry.kind === "workflow") {
      // The extension owns this overlay and closes it, so there is no
      // `viewerClose` to hold — but the list still has to know one is up, and
      // still has to put the cursor back on the run when it comes down.
      this.viewingWorkflowId = entry.workflow.id;
      void Promise.resolve(this.openWorkflow?.(entry.workflow.id)).then(
        () => this.clearViewer(),
        () => this.clearViewer(),
      );
      return;
    }
    // Agents open in the hub window with their conversation in the pane —
    // Esc there closes the overlay. The hub's transcript viewer carries
    // this row's `b` handoff and scrollbar mode. A failed overlay open still
    // restores the bar in `openHub`'s finally; report the error here so the
    // rejected promise has a handler and the user sees why nothing opened.
    void this.openHub({ agentId: entry.record.id }).catch((err: unknown) => {
      this.ui?.notify(
        `Could not open agent hub: ${err instanceof Error ? err.message : String(err)}`,
        "error",
      );
    });
  }

  /** Reset overlay state and return to the list (on close, auto-close, or error). */
  private clearViewer(): void {
    // Keep the cursor on the agent we were viewing — re-resolve by id so it
    // still feels natural if the list reordered (an earlier agent finished)
    // while the overlay was open. If that agent is gone, leave the index for
    // update()'s clamp to settle.
    const viewed = this.viewingAgentId ?? this.viewingWorkflowId;
    if (viewed !== undefined) {
      const idx = this.roster().findIndex(e =>
        e.kind === "agent" ? e.record.id === viewed
        : e.kind === "workflow" ? e.workflow.id === viewed
        : false,
      );
      if (idx >= 0) this.selectedIndex = idx;
    }
    this.viewerClose = undefined;
    this.viewingAgentId = undefined;
    this.viewingWorkflowId = undefined;
    this.update();
  }

  // ---- Rendering ----

  private renderBar(width: number, theme: Theme): string[] {
    const rows = this.roster().slice(1) as (WorkflowEntry | AgentEntry)[];
    if (rows.length === 0) return [];
    // Clamp locally so a render between a roster shrink and the next update()
    // (e.g. on terminal resize) never loses the selection marker.
    const sel = Math.min(this.selectedIndex, rows.length);

    const dockCoordinator = (globalThis as any)[SHARED_DOCK_COORDINATOR_KEY];
    const hasBgTasks = !!dockCoordinator?.hasTasks?.();

    let hint: string;
    if (this.active) {
      hint = hasBgTasks
        ? "↑↓ select · enter view · tab tasks · esc prompt"
        : "↑↓ select · enter view · → close · esc back";
    } else {
      hint = hasBgTasks
        ? "tab fleet · ← for agents · enter dock (↓)"
        : "esc to interrupt · ← for agents · ↓ to manage";
    }

    const lines: string[] = [];
    if (hasBgTasks) {
      lines.push(formatFleetSectionHeader("Subagents Fleet", width, theme, hint));
    } else {
      lines.push(truncateToWidth("  " + theme.fg("dim", hint), width));
      lines.push("");
    }

    lines.push(truncateToWidth(`  ${this.bullet(0, sel, theme, hasBgTasks)} main`, width));

    // Window the rows so the selected one stays visible.
    const visible = Math.min(MAX_AGENT_ROWS, rows.length);
    const selRow = Math.max(0, sel - 1);
    const start = selRow < visible ? 0 : selRow - visible + 1;
    const hiddenBelow = rows.length - (start + visible);

    if (start > 0) lines.push(rightAlign("", theme.fg("dim", `↑ ${start} more`), width));
    for (let a = start; a < start + visible; a++) {
      const row = rows[a];
      lines.push(
        row.kind === "workflow" ?
          this.renderWorkflowRow(a + 1, sel, row.workflow, width, theme, hasBgTasks)
        : this.renderAgentRow(a + 1, sel, row, width, theme, hasBgTasks),
      );
    }
    if (hiddenBelow > 0) lines.push(rightAlign("", theme.fg("dim", `↓ ${hiddenBelow} more`), width));
    // pi stacks below-editor widgets directly on its footer with no spacer (#351).
    lines.push("");

    return lines;
  }

  private bullet(rosterIndex: number, sel: number, theme: Theme, hasBgTasks = false): string {
    if (hasBgTasks && !this.active) {
      return theme.fg("dim", "○");
    }
    return rosterIndex === sel ? theme.fg("accent", "●") : theme.fg("dim", "○");
  }

  /**
   * A run's row. Shaped like an agent's — bullet, kind, name, stats flush right
   * — so the two read as one list, with the agent count where an agent has its
   * description and the same elapsed/token tail.
   */
  private renderWorkflowRow(
    rosterIndex: number,
    sel: number,
    workflow: FleetWorkflow,
    width: number,
    theme: Theme,
    hasBgTasks = false,
  ): string {
    const selected = this.active ? rosterIndex === sel : (!hasBgTasks && rosterIndex === sel);
    const kind = theme.fg(selected ? "text" : "muted", "workflow");
    const name = selected ? theme.fg("text", workflow.name) : workflow.name;
    const left = `  ${this.bullet(rosterIndex, sel, theme, hasBgTasks)} ${kind}  ${name}`;
    // Frozen once the run settles, exactly as an agent's clock is.
    const elapsed = (workflow.completedAt ?? Date.now()) - workflow.startedAt;
    const agents = `${workflow.doneCount}/${workflow.totalCount} agent${workflow.totalCount === 1 ? "" : "s"}`;
    const stats = `${agents} · ${formatFleetElapsed(elapsed)} · ${formatFleetTokens(workflow.tokens)}`;
    return rightAlign(left, selected ? theme.fg("text", stats) : theme.fg("dim", stats), width);
  }

  private renderAgentRow(
    rosterIndex: number,
    sel: number,
    entry: AgentEntry,
    width: number,
    theme: Theme,
    hasBgTasks = false,
  ): string {
    const { record, depth = 0, isLastChild } = entry;
    // The selected row renders in the theme's primary text color so it reads as
    // one selection (#230). A configured badge survives — Claude Code's FleetView
    // keeps the agent color on the selected row too and only bolds it — which also
    // keeps the row's width fixed as the selection moves.
    const selected = this.active ? rosterIndex === sel : (!hasBgTasks && rosterIndex === sel);
    const name = renderAgentRecordName(record, theme, selected
      ? { fallbackColor: "text", bold: hasAgentBadge(record.type) }
      : { fallbackColor: "muted" });
    const description = selected ? theme.fg("text", record.description) : record.description;

    let left: string;
    if (depth > 0) {
      const indent = "  ".repeat(depth);
      const branch = isLastChild ? "└─ " : "├─ ";
      left = `  ${indent}${theme.fg("dim", branch)}${this.bullet(rosterIndex, sel, theme, hasBgTasks)} ${name}  ${description}`;
    } else {
      left = `  ${this.bullet(rosterIndex, sel, theme, hasBgTasks)} ${name}  ${description}`;
    }
    if (this.showModel()) {
      // After the description, not in the stats: rightAlign truncates only the
      // left side, so here the model is cut first and the name survives. Bare
      // level (`sonnet 4.6 · high`), matching the widget's running line.
      const { modelName, thinking } = buildInvocationTags(record.invocation);
      const model = [modelName, thinking].filter(Boolean).join(" · ");
      if (model) left += theme.fg(selected ? "text" : "dim", ` · ${model}`);
    }
    // The record, not the activity tracker: only the record outlives the agent.
    // Its OWN usage, not `lifetimeUsage` — that one folds in every descendant,
    // and the descendants have rows of their own here.
    const tokens = getLifetimeTotal(record.ownUsage);
    const elapsedMs = (record.completedAt ?? Date.now()) - record.startedAt; // freezes once finished
    const cost = this.showCost() ? formatCost(getLifetimeCost(record.ownUsage)) : "";
    const stats = `${formatFleetElapsed(elapsedMs)} · ${formatFleetTokens(tokens)}${cost ? ` · ${cost}` : ""}`;
    const right = selected ? theme.fg("text", stats) : theme.fg("dim", stats);
    return rightAlign(left, right, width);
  }
}
