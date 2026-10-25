/**
 * agent-hub.ts — the unified Agents & Workflows window, pi-subagents data.
 *
 * One window at two frame sizes — the fullscreen twin (`ctx.ui.custom` with
 * `width: "100%"`, `maxHeight: "100%"`) and the popup twin (90 % × 70 %),
 * swapped by `f`. Both draw the same pages at the same size-independent
 * layout; the popup differs in frame size only.
 */

import {
  type Component,
  Input,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import type { AgentRecord, UIStyle } from "../types.js";
import {
  buildPhaseGroups,
  currentPhaseIndex,
  displayState,
  flattenRunAgents,
  type PhaseGroup,
  type WorkflowAgentEntry,
} from "../workflow/progress.js";
import type { Theme } from "./agent-widget.js";
import { ConversationViewer } from "./conversation-viewer.js";
import type { FleetWorkflow } from "./fleet-list.js";
import {
  hubEntryIndex,
  hubRunGroups,
  hubRunIndex,
  hubScopeEntries,
  hubWorkflows,
} from "./hub/hub-data.js";
import { buildPageFooter } from "./hub/hub-footer.js";
import {
  agentHeaderLines,
  paintWindow,
} from "./hub/hub-headers.js";
import {
  type AgentHubInputHost,
  dispatchHubInput,
  moveRunItem,
  pageUnhandledKey,
  popPage,
} from "./hub/hub-input.js";
import {
  buildAgentLogPageLines,
  buildRunLogPageLines,
  type HubLogHost,
} from "./hub/hub-log-view.js";
import {
  buildActivityLines,
  buildActivityTitle,
  buildRosterLines,
  buildRunLeftLines,
  buildRunPaneLines,
  buildRunPreviewLines,
  type HubPaneHost,
  identityPane,
  noteLine,
  runGroups,
} from "./hub/hub-panes.js";
import {
  type AgentHubDeps,
  type AgentHubInitial,
  EMPTY_RUN_SOURCE,
  FULLSCREEN_OVERLAY_OPTIONS,
  HUB_CHROME_ROWS,
  HUB_FALLBACK_ROWS,
  HUB_MIN_ROWS,
  HUB_MIN_WIDTH,
  HUB_SIZE_REFUSAL,
  HUB_TITLE,
  type HubEntry,
  type HubMouseEvent,
  type HubPage,
  type HubResult,
  type HubResumeState,
  type HubUICtx,
  type HubView,
  IDENTITY_ROWS,
  isHeaderRule,
  type MouseTerminalHost,
  type PaneRow,
  POPUP_HEIGHT_PCT,
  POPUP_OVERLAY_OPTIONS,
  padLines,
  TICK_MS,
  type WorkflowRunControls,
} from "./hub/hub-types.js";
import { disableTerminalMouse, enableTerminalMouse, type TerminalMouseEvent } from "./terminal-mouse.js";
import type { ViewerKeybindings } from "./viewer-keys.js";
import {
  clampMasterListWidth,
  MASTER_LIST_WIDTH,
  masterPaneGeometry,
  type PaneBox,
  PI_PANE_BOX,
  paneBodyHeight,
  renderWindow,
  TWO_PANE_MIN_WIDTH,
  UNICODE_PANE_BOX,
  type WindowRow,
  windowInnerWidth,
} from "./window-frame.js";
import { clampLine, type WorkflowCardLine } from "./workflow-card.js";
import { agentActions, type WorkflowDialogSource } from "./workflow-view.js";

export * from "./hub/hub-headers.js";
export * from "./hub/hub-types.js";

export async function openAgentHub(ui: HubUICtx, deps: AgentHubDeps, initial?: AgentHubInitial): Promise<undefined> {
  const target = initial?.agentId;
  const runTarget = initial?.runId;
  const allAgents = deps.manager.listAgents();
  const known = target != null && allAgents.some(a => a.id === target);
  const runSource = runTarget != null ? deps.workflowRun?.(runTarget) : undefined;
  const run = runTarget != null ? hubWorkflows(deps).find(w => w.id === runTarget) : undefined;
  const scopeStack: string[] = [];
  if (known && target) {
    const targetRec = allAgents.find(a => a.id === target);
    if (targetRec?.parentAgentId) {
      const parentRec = allAgents.find(a => a.id === targetRec.parentAgentId);
      if (parentRec?.parentAgentId) {
        scopeStack.push(parentRec.id);
      }
    }
  }
  const resume: HubResumeState = {
    view: "table",
    selected: Math.max(0, known ? hubEntryIndex(deps, target, scopeStack.at(-1)) : run ? hubRunIndex(deps, run.id) : 0),
    filterText: "",
    page: runSource ? "W" : "R",
    focusId: known ? target : undefined,
    runId: runSource ? (run?.id ?? runTarget) : undefined,
    runItemSel: runSource ? currentPhaseIndex(hubRunGroups(deps, runTarget!)) : undefined,
    detailOpen: known ?? false,
    scopeStack,
  };
  let popup = initial?.popup ?? (target != null || runTarget != null);
  for (;;) {
    const result = await ui.custom<HubResult>(
      (tui, theme, keybindings, done) =>
        new AgentHub(tui, theme, keybindings, done, deps, { popup, resume, onToggle: () => done("toggle") }),
      { overlay: true, overlayOptions: popup ? POPUP_OVERLAY_OPTIONS : FULLSCREEN_OVERLAY_OPTIONS },
    );
    if (result !== "toggle") return undefined;
    popup = !popup;
  }
}

export class AgentHub implements Component, HubPaneHost, HubLogHost, AgentHubInputHost {
  view: HubView;
  selected = 0;
  private filterText = "";
  filterInput: Input | undefined;
  stopArmed = false;
  viewer: ConversationViewer | undefined;
  private viewerId: string | undefined;
  private viewerRows = 1;
  focusId: string | undefined;
  private readonly popup: boolean;
  page: HubPage = "R";
  runId: string | undefined;
  runAgentSel = 0;
  runItemSel = 0;
  detailOpen = false;
  private lastWidth: number | undefined;
  logScroll = 0;
  private logReadout: { lines: number; percent: number } | undefined;
  private refused = false;
  private readonly resume: HubResumeState;
  private readonly onToggle: () => void;
  private readonly tick: ReturnType<typeof setInterval>;
  private disposed = false;
  private mouseCaptured = false;
  scopeStack: string[] = [];
  listWidth: number;
  isDraggingDivider = false;
  private dragStartX = 0;
  private dragStartListWidth = MASTER_LIST_WIDTH;

  constructor(
    public tui: any,
    public theme: Theme,
    private keybindings: unknown,
    private done: (result: HubResult) => void,
    public deps: AgentHubDeps,
    initial: { popup: boolean; resume: HubResumeState; onToggle: () => void },
  ) {
    this.popup = initial.popup;
    this.resume = initial.resume;
    this.onToggle = initial.onToggle;
    this.view = this.resume.view;
    this.selected = this.resume.selected;
    this.filterText = this.resume.filterText;
    this.page = this.resume.page ?? "R";
    this.focusId = this.resume.focusId;
    this.runId = this.resume.runId;
    this.runAgentSel = this.resume.runAgentSel ?? 0;
    this.runItemSel = this.resume.runItemSel ?? 0;
    this.logScroll = this.resume.logScroll ?? 0;
    this.detailOpen = this.resume.detailOpen ?? false;
    this.scopeStack = this.resume.scopeStack ? [...this.resume.scopeStack] : [];
    this.listWidth = this.resume.listWidth ?? MASTER_LIST_WIDTH;
    if (this.page === "R" && this.focusId !== undefined) {
      const record = this.deps.manager.listAgents().find(a => a.id === this.focusId);
      if (record?.session) this.ensureViewer(record);
    }
    this.tick = setInterval(() => {
      if (!this.disposed) this.tui.requestRender();
    }, TICK_MS);
    this.mouseCaptured = enableTerminalMouse(this.tui as unknown as MouseTerminalHost);
  }

  invalidate(): void {}

  effectiveStyle(): UIStyle {
    return this.deps.uiStyle?.() ?? "pi";
  }

  private effectiveBox(): PaneBox {
    return this.effectiveStyle() === "pi" ? PI_PANE_BOX : UNICODE_PANE_BOX;
  }

  handleMouse(event: HubMouseEvent): { handled?: boolean; capture?: boolean } | undefined {
    if (event.type === "wheel") {
      const delta = event.wheelDelta ?? 0;
      if (delta === 0) return undefined;
      this.applyWheel(delta);
      return { handled: true };
    }

    if (this.stackedMode()) {
      if (this.isDraggingDivider) this.isDraggingDivider = false;
      return undefined;
    }

    const width = this.lastWidth ?? this.tui.terminal?.columns ?? 80;
    const panes = masterPaneGeometry(width, this.listWidth);
    const dividerCol = 1 + panes.leftCellWidth;

    if (event.type === "press") {
      if (event.button === "left" || event.button === undefined) {
        if (event.x !== undefined && Math.abs(event.x - dividerCol) <= 1) {
          this.isDraggingDivider = true;
          this.dragStartX = event.x;
          this.dragStartListWidth = panes.listWidth;
          this.requestRender();
          return { handled: true, capture: true };
        }
      }
      return undefined;
    }

    if (event.type === "drag" || event.type === "move") {
      if (!this.isDraggingDivider) return undefined;
      if (event.x !== undefined) {
        const deltaX = event.x - this.dragStartX;
        const requested = this.dragStartListWidth + deltaX;
        const clamped = clampMasterListWidth(width, requested);
        if (clamped !== this.listWidth) {
          this.listWidth = clamped;
          this.requestRender();
        }
      }
      return { handled: true };
    }

    if (event.type === "release" || event.type === "click") {
      if (this.isDraggingDivider) {
        this.isDraggingDivider = false;
        this.requestRender();
        return { handled: true };
      }
      return undefined;
    }

    return undefined;
  }

  handleTerminalMouseEvent(ev: TerminalMouseEvent): void {
    const width = this.lastWidth ?? this.tui.terminal?.columns ?? 80;
    const termWidth = this.tui.terminal?.columns ?? width;
    const overlayCol = this.popup ? Math.max(0, Math.floor((termWidth - width) / 2)) : 0;
    const localX = (ev.x - 1) - overlayCol;
    this.handleMouse({
      type: ev.type,
      button: ev.button,
      x: localX,
      y: ev.y - 1,
    });
  }

  applyWheel(delta: number): void {
    if (this.transcriptPage() && this.viewer) {
      this.viewer.scrollBy(delta);
      this.requestRender();
      return;
    }
    if (this.page === "SL" || this.page === "SAL" || this.page === "L") {
      this.scrollLog(Math.sign(delta) * Math.max(1, Math.round(Math.abs(delta))));
      return;
    }
    const steps = Math.max(1, Math.round(Math.abs(delta)));
    // The run page's list is the phases+agents walk, not the roster behind it:
    // wheeling there moves the item cursor, which is what drags the panes.
    if (this.page === "W") {
      moveRunItem(this, Math.sign(delta) * steps);
      return;
    }
    const items = this.entries();
    if (items.length > 0) {
      this.selected = Math.min(items.length - 1, Math.max(0, this.selected + Math.sign(delta) * steps));
      const entry = items[this.selected];
      this.focusId = entry?.kind === "agent" ? entry.record.id : undefined;
      this.stopArmed = false;
      this.requestRender();
    }
  }

  dispose(): void {
    this.disposed = true;
    clearInterval(this.tick);
    this.viewer?.dispose();
    this.viewer = undefined;
    this.viewerId = undefined;
    if (this.mouseCaptured) {
      disableTerminalMouse(this.tui as unknown as MouseTerminalHost);
      this.mouseCaptured = false;
    }
  }

  currentScopeId(): string | undefined {
    return this.scopeStack.at(-1);
  }

  hasScope(): boolean {
    return this.scopeStack.length > 0;
  }

  scopeRecord(): AgentRecord | undefined {
    const id = this.currentScopeId();
    return id ? this.deps.manager.listAgents().find(a => a.id === id) : undefined;
  }

  scopeParentName(): string | undefined {
    const current = this.scopeRecord();
    if (!current) return undefined;
    if (this.scopeStack.length > 1) {
      const parentId = this.scopeStack.at(-2);
      const parent = parentId ? this.deps.manager.listAgents().find(a => a.id === parentId) : undefined;
      return parent?.alias ?? parent?.handle ?? parent?.type ?? parent?.description;
    }
    const parent = current.parentAgentId
      ? this.deps.manager.listAgents().find(a => a.id === current.parentAgentId)
      : undefined;
    return parent?.alias ?? parent?.handle ?? parent?.type ?? parent?.description ?? "roster";
  }

  canDrillDown(): boolean {
    if (this.page !== "R") return false;
    if (this.stackedMode() && this.detailOpen) return false;
    const entry = this.entries()[this.selected];
    return entry?.kind === "agent" && (entry.childCount ?? 0) > 0;
  }

  drillDown(): void {
    if (!this.canDrillDown()) return;
    const entry = this.entries()[this.selected];
    if (entry?.kind !== "agent") return;
    this.scopeStack.push(entry.record.id);
    this.selected = 0;
    this.focusId = entry.record.id;
    this.stopArmed = false;
    this.requestRender();
  }

  popScope(): void {
    if (this.scopeStack.length === 0) return;
    const popped = this.scopeStack.pop();
    this.focusId = popped;
    const items = this.entries();
    const idx = items.findIndex(e => e.kind === "agent" && e.record.id === popped);
    this.selected = idx !== -1 ? idx : 0;
    this.stopArmed = false;
    this.requestRender();
  }

  private workflows(): FleetWorkflow[] {
    return hubWorkflows(this.deps);
  }

  private agentRecords(): AgentRecord[] {
    return this.entries()
      .filter((e): e is HubEntry & { kind: "agent" } => e.kind === "agent")
      .map(e => e.record);
  }

  private activeFilter(): string {
    return this.filterInput ? this.filterInput.getValue() : this.filterText;
  }

  entries(): HubEntry[] {
    const raw = hubScopeEntries(this.deps, this.currentScopeId());
    const filter = this.activeFilter().trim().toLowerCase();
    if (!filter) return raw;

    const matching = new Set<string>();
    for (const e of raw) {
      if (e.kind === "agent") {
        const hay = `${e.record.type} ${e.record.alias ?? ""} ${e.record.description}`.toLowerCase();
        if (hay.includes(filter)) {
          matching.add(e.record.id);
          if (e.parentRecord) matching.add(e.parentRecord.id);
        }
      } else if (e.kind === "workflow") {
        if (`${e.workflow.name} workflow`.toLowerCase().includes(filter)) {
          matching.add(e.workflow.id);
        }
      }
    }

    return raw.filter(e => {
      if (e.kind === "agent") return matching.has(e.record.id);
      return matching.has(e.workflow.id);
    });
  }

  handleInput(data: string): void {
    dispatchHubInput(this, data);
  }

  runAgentActionKeys(): { skip: boolean; retry: boolean } {
    const run = this.currentRun();
    if (!run || !this.deps.workflowControls?.(run.id)) return { skip: false, retry: false };
    const entry = this.runAgents()[this.clampRunAgentIndex()];
    return agentActions(entry, run.status);
  }

  pageControls(): WorkflowRunControls | undefined {
    const run = this.currentRun();
    return run === undefined ? undefined : this.deps.workflowControls?.(run.id);
  }

  requestRender(): void {
    this.tui.requestRender();
  }

  transcriptPage(): boolean {
    if (this.view === "activity") return false;
    if (this.stackedMode() && this.page === "R" && !this.detailOpen) return false;
    return this.page === "WA" || (this.page === "R" && !this.runRowSelected());
  }

  runRowSelected(): boolean {
    return this.page === "R" && this.entries()[this.selected]?.kind === "workflow";
  }

  stackedMode(): boolean {
    return (this.lastWidth ?? this.tui.terminal?.columns ?? Infinity) < TWO_PANE_MIN_WIDTH;
  }

  private syncResume(): void {
    this.resume.view = this.view;
    this.resume.selected = this.selected;
    this.resume.filterText = this.filterText;
    this.resume.page = this.page;
    this.resume.focusId = this.focusId;
    this.resume.runId = this.runId;
    this.resume.runAgentSel = this.runAgentSel;
    this.resume.runItemSel = this.runItemSel;
    this.resume.logScroll = this.logScroll;
    this.resume.detailOpen = this.detailOpen;
    this.resume.scopeStack = [...this.scopeStack];
    this.resume.listWidth = this.listWidth;
  }

  close(): void {
    this.syncResume();
    this.dispose();
    this.done(undefined);
  }

  requestToggle(): void {
    this.syncResume();
    this.onToggle();
  }

  clampSelection(): void {
    const items = this.entries();
    const max = Math.max(0, items.length - 1);
    if (this.selected > max) this.selected = max;
    if (this.selected < 0) this.selected = 0;
    const entry = items[this.selected];
    this.focusId = entry?.kind === "agent" ? entry.record.id : undefined;
  }

  openFilter(): void {
    const input = new Input();
    input.focused = true;
    input.onSubmit = () => {
      this.filterText = input.getValue();
      this.filterInput = undefined;
      this.clampSelection();
      this.requestRender();
    };
    input.onEscape = () => {
      this.filterText = "";
      this.filterInput = undefined;
      this.clampSelection();
      this.requestRender();
    };
    this.filterInput = input;
    this.requestRender();
  }

  moveRosterSelection(direction: 1 | -1): void {
    const items = this.entries();
    const next = Math.min(items.length - 1, Math.max(0, this.selected + direction));
    if (next === this.selected) return;
    this.selected = next;
    const entry = items[next];
    this.focusId = entry?.kind === "agent" ? entry.record.id : undefined;
    this.stopArmed = false;
    this.requestRender();
  }

  render(width: number): string[] {
    this.lastWidth = width;
    const terminalRows = this.tui.terminal?.rows ?? HUB_FALLBACK_ROWS;
    if (width < HUB_MIN_WIDTH || terminalRows < HUB_MIN_ROWS) {
      this.refuseSize();
      return [];
    }
    if (this.view === "activity") return this.renderActivityWindow(width, terminalRows);
    return this.renderHubPage(width, terminalRows);
  }

  private viewportPct(): number {
    return this.popup ? POPUP_HEIGHT_PCT : 100;
  }

  private refuseSize(): void {
    if (this.refused) return;
    this.refused = true;
    this.deps.notify?.(HUB_SIZE_REFUSAL, "warning");
    this.close();
  }

  private renderHubPage(width: number, terminalRows: number): string[] {
    const twoPane = width >= TWO_PANE_MIN_WIDTH;
    if (twoPane) this.detailOpen = false;
    const header: WindowRow[] = [];
    if (this.filterInput || this.filterText) {
      header.push({ kind: "full", cells: [{ text: this.filterLine(windowInnerWidth(width)) }] });
    }
    const chrome = HUB_CHROME_ROWS + (header.length > 0 ? 1 : 0);
    const bodyRows = paneBodyHeight({
      terminalRows,
      viewportPct: this.viewportPct(),
      chromeRows: chrome,
      min: 1,
      fallbackRows: HUB_FALLBACK_ROWS - HUB_CHROME_ROWS,
    });

    const body: WindowRow[] = [];
    this.logReadout = undefined;

    let panes: ReturnType<typeof masterPaneGeometry> | undefined;
    if (!twoPane) {
      body.push(...this.stackedLines(width - 4, bodyRows));
    } else {
      panes = masterPaneGeometry(width, this.listWidth);
      const left = this.leftPaneLines(panes.listWidth, bodyRows);
      const right = this.rightPaneLines(panes.detailWidth, bodyRows);
      for (let i = 0; i < bodyRows; i++) {
        const rightRow = right[i];
        body.push(isHeaderRule(rightRow)
          ? { kind: "headerRule", left: left[i] }
          : { kind: "split", left: left[i], right: rightRow ?? [] });
      }
    }

    const rows: WindowRow[] = [...header, ...body];
    rows.push({ kind: "band" }, { kind: "full", cells: [{ text: this.pageFooter(windowInnerWidth(width)) }] });

    return paintWindow(
      renderWindow({
        width,
        box: this.effectiveBox(),
        style: this.effectiveStyle(),
        panes: twoPane ? panes : undefined,
        title: this.effectiveStyle() === "pi" ? undefined : HUB_TITLE,
        rows,
        ellipsis: "…",
        dividerHandle: twoPane ? { active: this.isDraggingDivider } : undefined,
      }),
      this.theme,
      this.effectiveStyle(),
    );
  }

  private pageFooter(width: number): string {
    return buildPageFooter({
      page: this.page,
      width,
      runRowSelected: this.runRowSelected(),
      viewerBand: this.viewerBand(),
      transcriptPage: this.transcriptPage(),
      currentRun: this.currentRun(),
      hasWorkflowControls: !!(this.currentRun() && this.deps.workflowControls?.(this.currentRun()!.id)),
      runAgentActionKeys: this.runAgentActionKeys(),
      stopArmed: this.stopArmed,
      readout: this.pageReadout(),
      popup: this.popup,
      detailOpen: this.detailOpen,
      theme: this.theme,
      scopeParentName: this.scopeParentName(),
    });
  }

  private viewerBand(): { text: string; expanded: boolean; stopArmed: boolean } | undefined {
    return this.transcriptPage() ? this.viewer?.bandReadout() : undefined;
  }

  private pageReadout(): string | undefined {
    if (this.transcriptPage()) return this.viewer?.bandReadout().text || undefined;
    if (this.page === "SL" || this.page === "SAL" || this.page === "L") {
      const log = this.logReadout;
      return log ? `${log.lines} lines · ${log.percent}%` : undefined;
    }
    if (this.page === "W") {
      const run = this.currentRun();
      return run ? this.runReadout(run) : undefined;
    }
    return undefined;
  }

  private runReadout(run: FleetWorkflow): string {
    const groups = runGroups(this, run.id);
    const parts = [`${run.doneCount}/${run.totalCount} agents`];
    if (groups.length > 0) parts.push(`phase ${currentPhaseIndex(groups) + 1} of ${groups.length}`);
    return parts.join(" · ");
  }

  private renderActivityWindow(width: number, terminalRows: number): string[] {
    const rows = paneBodyHeight({
      terminalRows,
      viewportPct: this.viewportPct(),
      chromeRows: HUB_CHROME_ROWS + 2,
      min: 3,
      fallbackRows: HUB_FALLBACK_ROWS - HUB_CHROME_ROWS,
    });
    return paintWindow(
      renderWindow({
        width,
        box: this.effectiveBox(),
        style: this.effectiveStyle(),
        rows: [
          { kind: "full", cells: [{ text: buildActivityTitle(width, this.agentRecords(), this.theme) }] },
          { kind: "full", cells: [{ text: "─".repeat(width), color: "dim" }] },
          ...buildActivityLines(rows, this.entries(), this.deps.agentActivity, this.theme),
          { kind: "full", cells: [{ text: "─".repeat(width), color: "dim" }] },
          { kind: "full", cells: [{ text: `↑↓ select · Enter open · x stop · p pause · 1 agents · f ${this.popup ? "full" : "popup"} · q close` }] },
        ],
        ellipsis: "…",
      }),
      this.theme,
      this.effectiveStyle(),
    );
  }

  private filterLine(width: number): string {
    const th = this.theme;
    if (this.filterInput) {
      const field = this.filterInput.render(Math.max(1, width - 2))[0] ?? "";
      return truncateToWidth(field + th.fg("dim", "  (Enter apply · Esc clear)"), width);
    }
    const total = hubScopeEntries(this.deps, this.currentScopeId()).length;
    const shown = this.entries().length;
    return truncateToWidth(th.fg("accent", `/ ${this.filterText}`) + th.fg("dim", `  — ${shown}/${total} match${shown === 1 ? "" : "es"}`), width);
  }

  private leftPaneLines(width: number, rows: number): WorkflowCardLine[] {
    const isPi = this.effectiveStyle() === "pi";
    const scope = this.scopeRecord();
    const scopeTitle = this.hasScope()
      ? `${scope?.alias ?? scope?.handle ?? scope?.type ?? "scope"} (scope)`
      : undefined;
    if (isPi && rows >= 3) {
      const titleLine = clampLine([{ text: "Agents & Workflows", bold: true }], width);
      const sepLine = clampLine([{ text: "─".repeat(width), color: "dim" }], width);
      const innerRows = rows - 2;
      const content = this.page === "WA" || this.page === "SAL" || this.page === "L"
        ? buildRunLeftLines(width, innerRows, this)
        : buildRosterLines(width, innerRows, this.entries(), this.selected, this.activeFilter(), this.theme, scopeTitle);
      return [titleLine, sepLine, ...content];
    }
    switch (this.page) {
      case "WA":
      case "SAL":
      case "L":
        return buildRunLeftLines(width, rows, this);
      default:
        return buildRosterLines(width, rows, this.entries(), this.selected, this.activeFilter(), this.theme, scopeTitle);
    }
  }

  private rightPaneLines(width: number, rows: number): PaneRow[] {
    switch (this.page) {
      case "R": {
        const entry = this.entries()[this.selected];
        return entry?.kind === "workflow"
          ? buildRunPreviewLines(entry.workflow, width, rows, this)
          : this.transcriptLines(width, rows);
      }
      case "WA":
        return this.transcriptLines(width, rows);
      case "SL":
      case "SAL":
        return buildAgentLogPageLines(width, rows, this);
      case "W":
        return buildRunPaneLines(width, rows, this);
      case "L":
        return buildRunLogPageLines(width, rows, this);
    }
  }

  private transcriptLines(width: number, rows: number): PaneRow[] {
    const record = this.focusedRecord();
    if (!record) return [clampLine([{ text: this.theme.fg("dim", "no agent selected") }], width)];
    if (!record.session) {
      this.viewer?.dispose();
      this.viewer = undefined;
      this.viewerId = undefined;
      return identityPane(
        this.agentIdentity(record, width),
        [noteLine(`transcript unavailable — agent is ${record.status}`, width)],
      );
    }
    const viewer = this.ensureViewer(record);
    if (!viewer) return [];
    const capacity = this.bodyRows(rows, false);
    this.viewerRows = capacity;
    const body: PaneRow[] = viewer.render(width).map((text): PaneRow => [{ text }]);
    return identityPane(this.agentIdentity(record, width), padLines(body, capacity));
  }

  private stackedLines(width: number, rows: number): WindowRow[] {
    const scope = this.scopeRecord();
    const scopeTitle = this.hasScope()
      ? `${scope?.alias ?? scope?.handle ?? scope?.type ?? "scope"} (scope)`
      : undefined;
    const lines: PaneRow[] = this.page === "R"
      ? (this.detailOpen ? this.rightPaneLines(width, rows) : buildRosterLines(width, rows, this.entries(), this.selected, this.activeFilter(), this.theme, scopeTitle))
      : this.rightPaneLines(width, rows);
    const content = lines.length > 0 ? lines : this.leftPaneLines(width, rows);
    const padded = content.slice(0, rows);
    for (let i = padded.length; i < rows; i++) padded.push([]);
    return padded.map(row => (isHeaderRule(row) ? { kind: "headerRule" } : { kind: "full", cells: row }));
  }

  private ensureViewer(record: AgentRecord): ConversationViewer | undefined {
    if (this.viewer && this.viewerId === record.id) return this.viewer;
    if (!record.session) return undefined;
    this.viewer?.dispose();
    this.viewerId = record.id;
    this.viewer = new ConversationViewer(
      this.tui,
      record.session,
      record,
      this.deps.agentActivity.get(record.id),
      this.theme,
      result => this.done(result),
      () => {
        if (this.deps.manager.abort(record.id)) {
          this.deps.notify?.(`Stopped "${record.description}".`, "info");
        }
      },
      this.keybindings as ViewerKeybindings | undefined,
      message => this.deps.manager.steer(record.id, message),
      this.deps.showCost,
      this.deps.scrollbarMode?.() ?? "auto",
      this.deps.backgroundAction?.(record, message => this.deps.notify?.(message, "info")),
      {
        identity: false,
        footer: false,
        viewportRows: () => this.viewerRows,
        onBack: () => popPage(this),
        backHint: () => "↑↓ scroll · esc back · f full",
        scrollHint: () => "PgUp/PgDn · Shift+↑↓ · j/k scroll",
        frameless: () => true,
        onUnhandledKey: data => pageUnhandledKey(this, data),
        uiStyle: () => this.effectiveStyle(),
      },
    );
    return this.viewer;
  }

  scrollLog(delta: number): void {
    this.logScroll = Math.max(0, this.logScroll + delta);
    this.requestRender();
  }

  setLogScroll(offset: number): void {
    this.logScroll = offset;
  }

  setLogReadout(readout: { lines: number; percent: number } | undefined): void {
    this.logReadout = readout;
  }

  bodyRows(rows: number, note: boolean): number {
    return Math.max(1, rows - IDENTITY_ROWS - (note ? 1 : 0));
  }

  agentIdentity(record: AgentRecord, width: number): WorkflowCardLine[] {
    const parent = record.parentAgentId
      ? this.deps.manager.listAgents().find(a => a.id === record.parentAgentId)
      : undefined;
    const parentName = this.page === "WA" || this.page === "SAL"
      ? this.currentRun()?.name
      : (parent?.alias ?? parent?.handle ?? parent?.type ?? parent?.description);
    return agentHeaderLines({
      record,
      activity: this.deps.agentActivity.get(record.id),
      width,
      th: this.theme,
      parentName,
    });
  }

  focusedRecord(): AgentRecord | undefined {
    const fresh = (id: string | undefined) => (id === undefined ? undefined : this.deps.manager.listAgents().find(a => a.id === id));
    if (this.page === "R") {
      const entry = this.entries()[this.selected];
      return fresh(this.focusId) ?? (entry?.kind === "agent" ? fresh(entry.record.id) ?? entry.record : undefined);
    }
    if (this.page === "SL") return fresh(this.focusId);
    if (this.page === "WA" || this.page === "SAL") return this.selectedRunRecord();
    const source = this.runSource() ?? EMPTY_RUN_SOURCE;
    const entries = flattenRunAgents(source.progress, source.meta?.phases);
    const live = entries.filter(e => {
      const state = displayState(e, source.task.status);
      return state === "running" || state === "paused";
    });
    return fresh((live.at(-1) ?? entries.at(-1))?.recordId);
  }

  rosterRecordForCurrent(): AgentRecord | undefined {
    const entry = this.entries()[this.selected];
    if (entry?.kind !== "agent") return undefined;
    return this.deps.manager.listAgents().find(a => a.id === entry.record.id) ?? entry.record;
  }

  currentRun(): FleetWorkflow | undefined {
    if (this.runId === undefined) return undefined;
    const roster = this.workflows().find(w => w.id === this.runId);
    if (roster) return roster;
    const source = this.runSource();
    if (!source) return undefined;
    const agents = flattenRunAgents(source.progress, source.meta?.phases);
    return {
      id: this.runId,
      name: source.task.workflowName ?? this.runId,
      status: source.task.status,
      doneCount: agents.filter(a => a.state === "done").length,
      totalCount: source.agentCount ?? agents.length,
      startedAt: source.task.startTime,
      completedAt: source.task.endTime,
      tokens: 0,
    };
  }

  runSource(id?: string): WorkflowDialogSource | undefined {
    const runId = id ?? this.runId;
    return runId === undefined ? undefined : this.deps.workflowRun?.(runId);
  }

  clampRunAgentIndex(): number {
    const max = Math.max(0, this.runAgents().length - 1);
    this.runAgentSel = Math.min(Math.max(0, this.runAgentSel), max);
    return this.runAgentSel;
  }

  pageGroups(): PhaseGroup[] {
    const source = this.runSource() ?? EMPTY_RUN_SOURCE;
    return buildPhaseGroups(source.progress, source.meta?.phases);
  }

  clampRunItemIndex(
    groups: readonly PhaseGroup[] = this.pageGroups(),
    entries: readonly WorkflowAgentEntry[] = this.runAgents(),
  ): number {
    const max = Math.max(0, groups.length + entries.length - 1);
    this.runItemSel = Math.min(Math.max(0, this.runItemSel), max);
    return this.runItemSel;
  }

  itemAgentIndex(): number | undefined {
    const groups = this.pageGroups();
    const entries = this.runAgents();
    const item = this.clampRunItemIndex(groups, entries);
    if (item >= groups.length) return item - groups.length < entries.length ? item - groups.length : undefined;
    if (groups[item].agents.length === 0) return undefined;
    let offset = 0;
    for (let i = 0; i < item; i++) offset += groups[i].agents.length;
    return offset;
  }

  selectedItemRecord(): AgentRecord | undefined {
    const index = this.itemAgentIndex();
    const recordId = index === undefined ? undefined : this.runAgents()[index]?.recordId;
    return recordId === undefined ? undefined : this.deps.manager.listAgents().find(a => a.id === recordId);
  }

  runAgents(): readonly WorkflowAgentEntry[] {
    const source = this.runSource() ?? EMPTY_RUN_SOURCE;
    return flattenRunAgents(source.progress, source.meta?.phases);
  }

  private selectedRunRecord(): AgentRecord | undefined {
    const recordId = this.runAgents()[this.clampRunAgentIndex()]?.recordId;
    return recordId === undefined ? undefined : this.deps.manager.listAgents().find(a => a.id === recordId);
  }
}
