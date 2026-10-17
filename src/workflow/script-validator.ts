/**
 * script-validator.ts — script validation rules before workflow compilation.
 */

import { extractMeta, type WorkflowMeta } from "./meta.js";
import {
  CONTROL_CHARACTERS,
  MAX_SCRIPT_LENGTH,
  WorkflowRuntimeError,
} from "./runtime-types.js";

/**
 * Everything a script must satisfy before it is compiled.
 *
 * Extracted so a nested `workflow()` is held to exactly the same standard as a
 * top-level run: same size limit, same character rules, same `meta` contract.
 * The host resolves a reference to source; deciding whether that source is a
 * workflow stays here, where the rules live.
 */
export function validateScript(script: string): { meta: WorkflowMeta; body: string } {
  if (script.length > MAX_SCRIPT_LENGTH) {
    throw new WorkflowRuntimeError(
      `Workflow script is ${script.length} characters, over the limit of ${MAX_SCRIPT_LENGTH}.`,
    );
  }
  if (CONTROL_CHARACTERS.test(script)) {
    throw new WorkflowRuntimeError(
      "Workflow script contains control characters. Only tab, carriage return and newline are allowed.",
    );
  }
  return extractMeta(script);
}
