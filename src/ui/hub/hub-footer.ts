/**
 * hub-footer.ts — Footer band building for AgentHub.
 */

import type { Theme } from "../agent-widget.js";
import type { FleetWorkflow } from "../fleet-list.js";
import { type FooterHint, footerBand } from "../window-frame.js";
import {
  type HubPage,
  PAGE_KEYS,
  R_RUN_KEYS,
  TD_ACTIONS,
  TD_DROPPED_HINT,
  TD_REPLACED_ACTION,
} from "./hub-types.js";

export interface PageFooterInput {
  page: HubPage;
  width: number;
  runRowSelected: boolean;
  viewerBand: { text: string; expanded: boolean; stopArmed: boolean } | undefined;
  transcriptPage: boolean;
  currentRun: FleetWorkflow | undefined;
  hasWorkflowControls: boolean;
  runAgentActionKeys: { skip: boolean; retry: boolean };
  stopArmed: boolean;
  readout: string | undefined;
  popup: boolean;
  detailOpen: boolean;
  theme: Theme;
  scopeParentName?: string;
}

export function buildPageFooter(input: PageFooterInput): string {
  const {
    page,
    width,
    runRowSelected,
    viewerBand,
    transcriptPage,
    currentRun,
    hasWorkflowControls,
    runAgentActionKeys,
    stopArmed,
    readout,
    popup,
    detailOpen,
    theme,
  } = input;

  const keys = page === "R" && runRowSelected ? R_RUN_KEYS : PAGE_KEYS[page];
  const expanded = transcriptPage && (viewerBand?.expanded ?? false);
  const actions = expanded
    ? [...keys.actions.filter(action => action !== TD_REPLACED_ACTION), ...TD_ACTIONS]
    : [...keys.actions];

  if (page === "W" && currentRun && hasWorkflowControls) {
    if (currentRun.status === "paused") actions.push("p resume run");
    else if (currentRun.status === "running") actions.push("p pause run");
  }
  if (page === "WA") {
    if (runAgentActionKeys.skip) actions.push("s skip");
    if (runAgentActionKeys.retry) actions.push("r retry");
  }

  const hints = expanded ? keys.hints.filter(hint => hint !== TD_DROPPED_HINT) : [...keys.hints];
  const armed = stopArmed || (viewerBand?.stopArmed ?? false);

  const left: FooterHint[] = [];
  if (readout) left.push({ text: readout, group: "readout" });
  if (armed) left.push({ text: "x again to STOP", group: "action" });
  for (const action of actions) {
    if (armed && action === "x stop") continue;
    left.push({ text: action, group: "action" });
  }

  const right: FooterHint[] = [
    ...hints.map((text): FooterHint => ({ text, group: "hint" })),
    { text: `f ${popup ? "full" : "popup"}`, group: "hint" },
    { text: `Esc ${detailOpen ? "roster" : (input.scopeParentName ?? keys.esc)}`, group: "hint", pinned: true },
  ];

  const band = footerBand({ width, left, right });
  return armed ? theme.fg("error", band) : band;
}
