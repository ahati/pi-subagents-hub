/**
 * hub-input.ts — Keyboard and mouse input dispatch and navigation for AgentHub.
 */

import { type Input, matchesKey } from "@earendil-works/pi-tui";
import type { AgentRecord } from "../../types.js";
import { currentPhaseIndex, type PhaseGroup, type WorkflowAgentEntry } from "../../workflow/progress.js";
import type { ConversationViewer } from "../conversation-viewer.js";
import { copyRecordResult } from "../copy-result.js";
import type { FleetWorkflow } from "../fleet-list.js";
import { parseMouseInput } from "../terminal-mouse.js";
import { runGroups } from "./hub-panes.js";
import {
  type AgentHubDeps,
  type HubEntry,
  type HubPage,
  type HubView,
  LOG_TAIL,
  PAGE_PARENT,
  type WorkflowRunControls,
} from "./hub-types.js";

export interface AgentHubInputHost {
  filterInput: Input | undefined;
  page: HubPage;
  detailOpen: boolean;
  selected: number;
  view: HubView;
  stopArmed: boolean;
  viewer?: ConversationViewer;
  runAgentSel: number;
  runItemSel: number;
  logScroll: number;
  tui: any;
  deps: AgentHubDeps;
  runId?: string;
  focusId?: string;

  applyWheel(delta: number): void;
  runRowSelected(): boolean;
  stackedMode(): boolean;
  transcriptPage(): boolean;
  moveRosterSelection(direction: 1 | -1): void;
  clampSelection(): void;
  requestRender(): void;
  openFilter(): void;
  requestToggle(): void;
  close(): void;
  entries(): HubEntry[];
  runAgentActionKeys(): { skip: boolean; retry: boolean };
  pageControls(): WorkflowRunControls | undefined;
  clampRunAgentIndex(): number;
  runAgents(): readonly WorkflowAgentEntry[];
  currentRun(): FleetWorkflow | undefined;
  focusedRecord(): AgentRecord | undefined;
  pageGroups(): PhaseGroup[];
  clampRunItemIndex(groups?: readonly PhaseGroup[], entries?: readonly WorkflowAgentEntry[]): number;
  itemAgentIndex(): number | undefined;
  selectedItemRecord(): AgentRecord | undefined;
  rosterRecordForCurrent(): AgentRecord | undefined;
  scrollLog(delta: number): void;
}

export function dispatchHubInput(host: AgentHubInputHost, data: string): void {
  const mouse = parseMouseInput(data);
  if (mouse.sawMouse) {
    if (mouse.wheelDelta !== 0) host.applyWheel(mouse.wheelDelta);
    return;
  }

  if (host.filterInput) {
    host.filterInput.handleInput(data);
    host.tui.requestRender();
    return;
  }

  if (matchesKey(data, "left")) {
    if (host.page !== "R" || host.detailOpen) {
      popPage(host);
      return;
    }
  }
  if (matchesKey(data, "right") && (host.page === "W" || (host.page === "R" && (host.runRowSelected() || host.stackedMode())))) {
    enterPage(host, host.entries());
    return;
  }

  if (host.transcriptPage()) {
    if (host.viewer?.composing) {
      host.viewer.handleInput(data);
      host.tui.requestRender();
      return;
    }
    if (matchesKey(data, "down") || matchesKey(data, "up")) {
      const direction = matchesKey(data, "down") ? 1 : -1;
      if (host.page === "WA") moveRunSelection(host, direction);
      else host.moveRosterSelection(direction);
      return;
    }
    if (host.page === "R") {
      if (matchesKey(data, "escape") || matchesKey(data, "q") || matchesKey(data, "ctrl+c")) { popPage(host); return; }
      if (matchesKey(data, "1")) { host.view = "table"; host.clampSelection(); host.requestRender(); return; }
      if (matchesKey(data, "2")) { host.view = "activity"; host.requestRender(); return; }
      if (matchesKey(data, "tab")) {
        host.view = host.view === "table" ? "activity" : "table";
        host.clampSelection();
        host.requestRender();
        return;
      }
      if (matchesKey(data, "/")) { host.stopArmed = false; host.openFilter(); return; }
      if (matchesKey(data, "enter") && host.stackedMode()) { enterPage(host, host.entries()); return; }
    }
    if (host.viewer) {
      host.viewer.handleInput(data);
      host.tui.requestRender();
      return;
    }
    if (host.page === "WA") {
      if (matchesKey(data, "escape") || matchesKey(data, "q") || matchesKey(data, "ctrl+c")) {
        popPage(host);
        return;
      }
      if (matchesKey(data, "s")) { runAgentKey(host, "skip"); return; }
      if (matchesKey(data, "r")) { runAgentKey(host, "retry"); return; }
    }
  }

  if ((host.page === "SL" || host.page === "SAL" || host.page === "L") && handleLogKey(host, data)) return;

  if (host.page === "W") {
    if (matchesKey(data, "down")) { moveRunItem(host, 1); return; }
    if (matchesKey(data, "up")) { moveRunItem(host, -1); return; }
    if (matchesKey(data, "enter")) { enterPage(host, host.entries()); return; }
    if (matchesKey(data, "l")) { pushLogPage(host); return; }
    if (matchesKey(data, "s")) { stopRun(host); return; }
    if (matchesKey(data, "p")) { pauseResumeRun(host); return; }
    if (matchesKey(data, "c")) { copyFocusedResult(host); return; }
    if (matchesKey(data, "escape") || matchesKey(data, "q") || matchesKey(data, "ctrl+c")) { popPage(host); return; }
    if (matchesKey(data, "f")) { host.requestToggle(); return; }
    return;
  }

  if (matchesKey(data, "escape") || matchesKey(data, "ctrl+c") || matchesKey(data, "q")) {
    host.close();
    return;
  }
  if (matchesKey(data, "1")) { host.view = "table"; host.clampSelection(); host.requestRender(); return; }
  if (matchesKey(data, "2")) { host.view = "activity"; host.requestRender(); return; }
  if (matchesKey(data, "tab")) {
    host.view = host.view === "table" ? "activity" : "table";
    host.clampSelection();
    host.requestRender();
    return;
  }
  if (matchesKey(data, "f")) {
    host.requestToggle();
    return;
  }
  if (matchesKey(data, "/")) {
    host.stopArmed = false;
    host.openFilter();
    return;
  }

  const items = host.entries();
  host.clampSelection();
  const row = items[host.selected];

  if (matchesKey(data, "down")) {
    host.selected = Math.min(items.length - 1, host.selected + 1);
    host.stopArmed = false;
    host.requestRender();
    return;
  }
  if (matchesKey(data, "up")) {
    host.selected = Math.max(0, host.selected - 1);
    host.stopArmed = false;
    host.requestRender();
    return;
  }
  if (matchesKey(data, "home")) { host.selected = 0; host.stopArmed = false; host.requestRender(); return; }
  if (matchesKey(data, "end")) { host.selected = Math.max(0, items.length - 1); host.stopArmed = false; host.requestRender(); return; }

  if (matchesKey(data, "enter")) {
    enterPage(host, items);
    return;
  }

  if (matchesKey(data, "l")) { pushLogPage(host); return; }
  if (matchesKey(data, "c") && row?.kind === "workflow") { copyFocusedResult(host); return; }
  if (matchesKey(data, "s") && row?.kind === "workflow") { stopRun(host); return; }

  if (matchesKey(data, "x") || matchesKey(data, "k")) {
    stopSelected(host, items);
    return;
  }
  if (matchesKey(data, "p")) {
    pauseResumeSelected(host, items);
    return;
  }
  if (matchesKey(data, "c")) {
    const entry = items[host.selected];
    if (entry?.kind === "agent") {
      const record = host.deps.manager.listAgents().find(a => a.id === entry.record.id) ?? entry.record;
      copyRecordResult(record, (message, type) => host.deps.notify?.(message, type));
    }
    return;
  }

  if (host.stopArmed) host.stopArmed = false;
  host.requestRender();
}

export function handleLogKey(host: AgentHubInputHost, data: string): boolean {
  const down = matchesKey(data, "down") || matchesKey(data, "j");
  const up = matchesKey(data, "up") || matchesKey(data, "k");
  if (down || up) { host.stopArmed = false; host.scrollLog(down ? 1 : -1); return true; }
  if (matchesKey(data, "c")) { host.stopArmed = false; copyFocusedResult(host); return true; }
  if (matchesKey(data, "p")) { host.stopArmed = false; pauseResumeFocused(host); return true; }
  if (matchesKey(data, "s") && host.page === "L") { host.stopArmed = false; stopRun(host); return true; }
  if (matchesKey(data, "x") && (host.page === "SL" || host.page === "SAL")) { stopFocused(host); return true; }
  if (matchesKey(data, "f")) { host.stopArmed = false; host.requestToggle(); return true; }
  if (matchesKey(data, "escape") || matchesKey(data, "q")) { host.stopArmed = false; popPage(host); return true; }
  return false;
}

export function enterPage(host: AgentHubInputHost, items: HubEntry[]): void {
  host.stopArmed = false;
  if (host.page === "R") {
    const entry = items[host.selected];
    if (entry?.kind === "workflow") {
      host.runId = entry.workflow.id;
      host.runAgentSel = 0;
      host.runItemSel = currentPhaseIndex(runGroups(host as any, entry.workflow.id));
      host.page = "W";
      host.requestRender();
      return;
    }
    if (host.stackedMode() && (entry?.kind === "agent" || host.focusedRecord())) {
      host.detailOpen = true;
      host.requestRender();
    }
    return;
  }
  if (host.page === "W") {
    const record = host.selectedItemRecord();
    if (!record?.session) {
      host.deps.notify?.("That agent has no conversation to open.", "info");
      return;
    }
    const index = host.itemAgentIndex();
    if (index !== undefined) host.runAgentSel = index;
    host.page = "WA";
    host.requestRender();
  }
}

export function popPage(host: AgentHubInputHost): void {
  if (host.page === "R" && host.detailOpen) {
    host.detailOpen = false;
    host.stopArmed = false;
    host.requestRender();
    return;
  }
  if (host.page === "R") { host.close(); return; }
  const from = host.page;
  host.page = PAGE_PARENT[from]!;
  host.logScroll = 0;
  host.stopArmed = false;
  if (host.page === "R") {
    host.focusId = host.rosterRecordForCurrent()?.id;
  }
  if (host.page === "W") {
    host.runItemSel = host.pageGroups().length + host.clampRunAgentIndex();
  }
  host.requestRender();
}

export function pageUnhandledKey(host: AgentHubInputHost, data: string): boolean {
  if (!matchesKey(data, "k") && !matchesKey(data, "x") && host.stopArmed) host.stopArmed = false;
  if (matchesKey(data, "l")) { pushLogPage(host); return true; }
  if (matchesKey(data, "f")) { host.requestToggle(); return true; }
  if (matchesKey(data, "c")) { copyFocusedResult(host); return true; }
  if (matchesKey(data, "p")) { pauseResumeFocused(host); return true; }
  if (host.page === "WA" && matchesKey(data, "s")) { runAgentKey(host, "skip"); return true; }
  if (host.page === "WA" && matchesKey(data, "r")) { runAgentKey(host, "retry"); return true; }
  if (matchesKey(data, "k") || matchesKey(data, "x")) { stopFocused(host); return true; }
  return false;
}

export function runAgentKey(host: AgentHubInputHost, kind: "skip" | "retry"): void {
  const actions = host.runAgentActionKeys();
  if (kind === "skip" ? actions.skip : actions.retry) {
    if (kind === "skip") skipRunAgent(host);
    else retryRunAgent(host);
  }
}

export function moveRunSelection(host: AgentHubInputHost, delta: 1 | -1): void {
  if (host.runAgents().length === 0) return;
  const next = Math.min(host.runAgents().length - 1, Math.max(0, host.clampRunAgentIndex() + delta));
  if (next === host.runAgentSel) return;
  host.runAgentSel = next;
  host.stopArmed = false;
  if (host.page === "WA") host.focusId = undefined;
  host.requestRender();
}

export function moveRunItem(host: AgentHubInputHost, delta: 1 | -1): void {
  const groups = host.pageGroups();
  const entries = host.runAgents();
  const length = groups.length + entries.length;
  if (length === 0) return;
  const next = Math.min(length - 1, Math.max(0, host.clampRunItemIndex(groups, entries) + delta));
  if (next === host.runItemSel) return;
  host.runItemSel = next;
  if (next >= groups.length) host.runAgentSel = next - groups.length;
  host.stopArmed = false;
  host.requestRender();
}

export function stopRun(host: AgentHubInputHost): void {
  const run = host.page === "W" || host.page === "L" ? host.currentRun() : host.entries()[host.selected]?.kind === "workflow" ? (host.entries()[host.selected] as { workflow: FleetWorkflow }).workflow : undefined;
  if (!run || (run.status !== "running" && run.status !== "paused")) return;
  host.runId = run.id;
  if (host.deps.stopWorkflow?.(run.id)) {
    host.deps.notify?.(`Stopped workflow "${run.name}".`, "info");
  }
  host.requestRender();
}

export function pauseResumeRun(host: AgentHubInputHost): void {
  const run = host.currentRun();
  const controls = host.pageControls();
  if (!run || !controls) return;
  if (run.status === "paused") {
    if (controls.resume()) host.deps.notify?.("Resumed.", "info");
  } else if (run.status === "running") {
    if (controls.pause()) host.deps.notify?.("Paused — running agents finish, no new ones start.", "info");
  }
  host.requestRender();
}

export function skipRunAgent(host: AgentHubInputHost): void {
  const controls = host.pageControls();
  const entry = host.runAgents()[host.clampRunAgentIndex()];
  if (!controls || !entry) return;
  if (!controls.skip(entry.index)) {
    host.deps.notify?.("Nothing to skip — that agent has already finished.", "info");
  }
  host.requestRender();
}

export function retryRunAgent(host: AgentHubInputHost): void {
  const controls = host.pageControls();
  const entry = host.runAgents()[host.clampRunAgentIndex()];
  if (!controls || !entry) return;
  if (!controls.retry(entry.index)) {
    host.deps.notify?.("Only a running agent can be retried.", "info");
  }
  host.requestRender();
}

export function stopSelected(host: AgentHubInputHost, items: HubEntry[]): void {
  const entry = items[host.selected];
  if (!entry || entry.kind !== "agent") return;
  const record = entry.record;
  const active = record.status === "running" || record.status === "queued";
  if (!active) return;
  if (host.stopArmed) {
    host.stopArmed = false;
    if (host.deps.manager.abort(record.id)) {
      host.deps.notify?.(`Stopped "${record.description}".`, "info");
    }
  } else {
    host.stopArmed = true;
  }
  host.requestRender();
}

export function pauseResumeAgent(host: AgentHubInputHost, record: AgentRecord): void {
  if (record.status === "running" || record.status === "queued") {
    const why = host.deps.pauseAgent?.(record.id);
    host.deps.notify?.(
      why ? `Cannot pause "${record.description}" — ${why}.` : `Paused "${record.description}".`,
      why ? "warning" : "info",
    );
  } else if (record.status === "paused") {
    const started = host.deps.resumeAgent?.(record.id);
    host.deps.notify?.(
      started ? `Resuming "${record.description}".` : `Cannot resume "${record.description}".`,
      started ? "info" : "warning",
    );
  }
  host.requestRender();
}

export function pauseResumeSelected(host: AgentHubInputHost, items: HubEntry[]): void {
  const entry = items[host.selected];
  if (entry?.kind !== "agent") return;
  pauseResumeAgent(host, entry.record);
}

export function copyFocusedResult(host: AgentHubInputHost): void {
  const record = host.focusedRecord();
  if (record) copyRecordResult(record, (message, type) => host.deps.notify?.(message, type));
}

export function pauseResumeFocused(host: AgentHubInputHost): void {
  const record = host.focusedRecord();
  if (record) pauseResumeAgent(host, record);
}

export function stopFocused(host: AgentHubInputHost): void {
  const record = host.focusedRecord();
  if (!record || (record.status !== "running" && record.status !== "queued")) return;
  if (!host.stopArmed) {
    host.stopArmed = true;
    host.requestRender();
    return;
  }
  host.stopArmed = false;
  if (host.deps.manager.abort(record.id)) {
    host.deps.notify?.(`Stopped "${record.description}".`, "info");
  }
  host.requestRender();
}

export function pushLogPage(host: AgentHubInputHost): void {
  if (host.page === "R") {
    if (!host.transcriptPage()) return;
    const record = host.focusedRecord();
    if (!record) return;
    host.focusId = record.id;
    host.page = "SL";
  } else if (host.page === "WA") {
    host.page = "SAL";
  } else if (host.page === "W") {
    host.page = "L";
  } else {
    return;
  }
  host.stopArmed = false;
  host.logScroll = LOG_TAIL;
  host.requestRender();
}
