/**
 * boundary.ts — JSON boundary and structured serialization assertions for workflows.
 */

import { WorkflowRuntimeError } from "./runtime-types.js";

function boundaryError(what: string, path: string): WorkflowRuntimeError {
  return new WorkflowRuntimeError(
    `Cannot pass ${what} across the workflow VM boundary (at ${path}).`,
  );
}

function walk(value: unknown, path: string, seen: Set<object>): void {
  if (value === null) return;
  const kind = typeof value;
  if (kind === "string" || kind === "boolean") return;
  if (kind === "number") {
    if (!Number.isFinite(value)) throw boundaryError("a non-finite number", path);
    return;
  }
  if (kind === "undefined") {
    if (path === "args") return;
    throw boundaryError("undefined", path);
  }
  if (kind === "bigint") throw boundaryError("a BigInt", path);
  if (kind === "symbol") throw boundaryError("a symbol", path);
  if (kind === "function") throw boundaryError("a function", path);
  if (kind !== "object") throw boundaryError(`a ${kind}`, path);

  const object = value as object;
  if (seen.has(object)) throw boundaryError("a circular structure", path);
  seen.add(object);

  if (Object.getOwnPropertySymbols(object).length > 0) {
    throw boundaryError("an object with symbol keys", path);
  }

  if (Array.isArray(object)) {
    for (let i = 0; i < object.length; i++) {
      if (!Object.hasOwn(object, i)) throw boundaryError("a sparse array", `${path}[${i}]`);
      walk(object[i], `${path}[${i}]`, seen);
    }
    seen.delete(object);
    return;
  }

  const prototype = Object.getPrototypeOf(object);
  if (prototype !== null && prototype !== Object.prototype) {
    throw boundaryError("a non-plain object", path);
  }
  for (const [key, entry] of Object.entries(object)) {
    walk(entry, `${path}.${key}`, seen);
  }
  seen.delete(object);
}

/**
 * Reject anything that cannot survive the round trip to the worker and into a
 * resume journal. Structured clone would happily carry a `Map` or a cycle that
 * the journal then cannot represent, so the check is stricter than the transport.
 */
export function assertBoundarySafe(value: unknown, path: string): void {
  walk(value, path, new Set());
}
