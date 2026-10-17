/**
 * extension-scope.ts — extension allowlist parsing, canonical names, and dynamic tool scoping.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type {
  AgentSession,
  AgentSessionEvent,
  DefaultResourceLoader,
  InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { EXCLUDED_TOOL_NAMES } from "./runner-types.js";

/**
 * Canonical name of an extension for `extensions: [...]` allowlist matching.
 * Lowercased — extension names match case-insensitively so `extensions: [Mcp]`
 * resolves the same as `[mcp]`. Tool names within `ext:foo/bar` are not affected.
 * Directory extensions (`foo/index.ts`) resolve to the parent directory name;
 * single-file extensions to the basename minus `.ts`/`.js`.
 */
export function extensionCanonicalName(extPath: string): string {
  // pi's built-ins are synthetic paths (`builtin:codemode`), not files.
  if (extPath.startsWith("builtin:")) return extPath.slice("builtin:".length).toLowerCase();
  const base = basename(extPath);
  const name = base === "index.ts" || base === "index.js"
    ? basename(dirname(extPath))
    : base.replace(/\.(ts|js)$/, "");
  return name.toLowerCase();
}

/**
 * The unscoped, lowercased npm short name of the pi package that DECLARES
 * `extPath` as an extension entry — or undefined if the entry doesn't belong to
 * such a package.
 */
function extensionPackageName(extPath: string): string | undefined {
  // `builtin:<name>` names no file; climbing from it would read the process cwd's manifest.
  if (extPath.startsWith("builtin:")) return undefined;
  const entry = resolve(extPath);
  let dir = dirname(extPath);
  for (;;) {
    // Climbing into node_modules means we've left the owning package's tree.
    if (basename(dir) === "node_modules") return undefined;
    let pkg: { name?: unknown; pi?: { extensions?: unknown } };
    try {
      pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
    } catch {
      const parent = dirname(dir);
      if (parent === dir) return undefined; // walked to the filesystem root
      dir = parent;
      continue;
    }
    // First package.json wins — it's the package root; decide here.
    const entries = pkg.pi?.extensions;
    if (
      typeof pkg.name === "string" &&
      Array.isArray(entries) &&
      entries.some((e) => typeof e === "string" && resolve(dir, e) === entry)
    ) {
      const short = pkg.name.startsWith("@") ? pkg.name.slice(pkg.name.indexOf("/") + 1) : pkg.name;
      return short.toLowerCase();
    }
    return undefined;
  }
}

/**
 * All names an extension answers to for allowlist matching (lowercased): its
 * path-derived {@link extensionCanonicalName} plus, when a pi package manifest
 * declares this entry, that package's unscoped short name (`@scope/foo` → `foo`).
 */
export function extensionCanonicalNames(extPath: string): string[] {
  const canonical = extensionCanonicalName(extPath);
  const pkg = extensionPackageName(extPath);
  const names = pkg && pkg !== canonical ? [canonical, pkg] : [canonical];
  // Upstream's spelling: the synthetic `builtin:<name>` path itself is a valid
  // alias in `extensions:` / `exclude_extensions:` / `ext:` — the real loader
  // presents the entry under exactly this path. The canonical name above stays
  // the fork's bare name, so `mcp` and `builtin:mcp` both match.
  const raw = extPath.toLowerCase();
  if (extPath.startsWith("builtin:") && !names.includes(raw)) names.push(raw);
  return names;
}

/**
 * Classify `extensions: string[]` frontmatter entries for the loader-level filter.
 *
 * An entry is a PATH iff it contains a path separator or starts with `~`; otherwise
 * it is a NAME. `"*"` sets the wildcard flag (keep all default-discovered extensions).
 */
export function parseExtensionsSpec(
  entries: string[],
  cwd: string,
): { names: Set<string>; paths: string[]; wildcard: boolean } {
  const names = new Set<string>();
  const paths: string[] = [];
  let wildcard = false;
  for (const entry of entries) {
    if (!entry) continue;
    if (entry === "*") {
      wildcard = true;
      continue;
    }
    const isPathEntry = entry.includes("/") || entry.includes("\\") || entry.startsWith("~");
    if (!isPathEntry) {
      names.add(entry.toLowerCase());
      continue;
    }
    let p = entry;
    if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) {
      p = homedir() + p.slice(1);
    }
    const abs = isAbsolute(p) ? p : resolve(cwd, p);
    paths.push(abs);
    names.add(extensionCanonicalName(abs));
  }
  return { names, paths, wildcard };
}

/**
 * Parse raw `ext:` selector strings (from the `tools:` CSV) into the set of
 * extension names to keep loaded and a per-extension tool-narrowing map.
 */
export function parseExtSelectors(entries: string[]): {
  extNames: Set<string>;
  narrowing: Map<string, Set<string>>;
} {
  const extNames = new Set<string>();
  const narrowing = new Map<string, Set<string>>();
  for (const raw of entries) {
    if (!raw) continue;
    const body = raw.slice("ext:".length);
    const slash = body.indexOf("/");
    const name = (slash === -1 ? body : body.slice(0, slash)).trim().toLowerCase();
    if (!name) continue;
    extNames.add(name);
    if (slash === -1) continue;
    const tool = body.slice(slash + 1).trim();
    if (!tool) continue;
    let set = narrowing.get(name);
    if (!set) {
      set = new Set();
      narrowing.set(name, set);
    }
    set.add(tool);
  }
  return { extNames, narrowing };
}

/** Set once the child's tool scope is installed; until then the gate admits everything. */
export type NestedCallGate = { allows?: (name: string) => boolean };

/**
 * Inline extension that applies the subagent's tool scope to calls a tool makes
 * through `ctx.executeTool()` — codemode scripts calling MCP tools.
 */
export const SCOPE_GATE_NAME = "pi-subagents-scope";

export function scopeGateExtension(gate: NestedCallGate): InlineExtension {
  return {
    name: SCOPE_GATE_NAME,
    hidden: true,
    factory: (ext) => {
      ext.on("tool_call", (event) =>
        gate.allows?.(event.toolName) === false
          ? { block: true, reason: `Tool "${event.toolName}" is not available to this subagent.` }
          : undefined,
      );
    },
  };
}

/**
 * Keep a subagent's tool scope correct as extensions register tools over time.
 */
export function installExtensionToolScope(
  session: AgentSession,
  ctx: {
    loader: DefaultResourceLoader;
    toolNames: string[];
    disallowedSet: Set<string> | undefined;
    extNames: Set<string>;
    narrowing: Map<string, Set<string>>;
    readmitToolNames: Set<string>;
    nestedCallGate: NestedCallGate;
  },
): void {
  const { loader, toolNames, disallowedSet, extNames, narrowing, readmitToolNames, nestedCallGate } = ctx;

  const inScope = (): Set<string> => {
    const keep = new Set(toolNames.filter((t) => !disallowedSet?.has(t)));
    const optInActive = extNames.size > 0;
    for (const extension of loader.getExtensions().extensions) {
      const canons = extensionCanonicalNames(extension.path);
      if (optInActive && !canons.some((c) => extNames.has(c))) continue;
      const narrowed = canons.map((c) => narrowing.get(c)).find(Boolean);
      for (const name of extension.tools.keys()) {
        if (narrowed && !narrowed.has(name)) continue;
        if (disallowedSet?.has(name)) continue;
        keep.add(name);
      }
    }
    for (const name of EXCLUDED_TOOL_NAMES) keep.delete(name);
    for (const name of readmitToolNames) keep.add(name);
    return keep;
  };

  const named = new Set([...toolNames, ...readmitToolNames, ...[...narrowing.values()].flatMap((s) => [...s])]);

  const renarrow = () => {
    const allowed = inScope();
    const current = session.getActiveToolNames();
    const active = new Set(current);
    const next = session.getAllTools()
      .filter((t) => allowed.has(t.name) && (
        named.has(t.name)
        || active.has(t.name)
        || ((t.exposure === "direct" || t.exposure === "model-only")
          && session.getToolDefinition(t.name)?.defaultActive !== false)
      ))
      .map((t) => t.name);
    if (next.length !== current.length || next.some((n, i) => n !== current[i])) {
      session.setActiveToolsByName(next);
    }
  };

  renarrow();

  session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "turn_end") renarrow();
  });

  nestedCallGate.allows = (name) => inScope().has(name);

  const priorBeforeToolCall = session.agent.beforeToolCall;
  session.agent.beforeToolCall = async (context, signal) => {
    if (!inScope().has(context.toolCall.name)) {
      return {
        block: true,
        reason: `Tool "${context.toolCall.name}" is not available to this subagent.`,
      };
    }
    return priorBeforeToolCall?.(context, signal);
  };
}
