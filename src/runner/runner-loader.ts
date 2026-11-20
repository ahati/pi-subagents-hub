import { resolve } from "node:path";
import {
  DefaultResourceLoader,
  type ExtensionContext,
  type LoadExtensionsResult,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { BUILTIN_TOOL_NAMES, getConfig } from "../agent-types.js";
import { runInChildSessionContext } from "../child-context.js";
import { loadRequiredExtensionPaths } from "../settings.js";
import type { AgentConfig, SubagentType } from "../types.js";
import {
  extensionCanonicalNames,
  type NestedCallGate,
  parseExtensionsSpec,
  parseExtSelectors,
  SCOPE_GATE_NAME,
  scopeGateExtension,
} from "./extension-scope.js";
import { PI_BUILTIN_EXTENSIONS, type RunOptions } from "./runner-types.js";

export interface RunnerResourceContext {
  loader: DefaultResourceLoader;
  agentDir: string;
  sessionSettingsManager: SettingsManager;
  nestedCallGate: NestedCallGate;
  extNames: Set<string>;
  narrowing: Map<string, Set<string>>;
  mcpToolPatterns: string[] | undefined;
  noExtensions: boolean;
  requiredExtensionPaths: Set<string>;
}

/**
 * Create resource loader, compute extension filters, and report misconfiguration warnings.
 */
export async function createRunnerResourceLoader(
  ctx: ExtensionContext,
  type: SubagentType,
  agentConfig: AgentConfig | undefined,
  config: ReturnType<typeof getConfig>,
  configCwd: string,
  effectiveCwd: string,
  agentDir: string,
  settingsManager: SettingsManager,
  systemPrompt: string,
  noSkills: boolean,
  options: RunOptions,
): Promise<RunnerResourceContext> {
  const isolated = agentConfig?.isolated ?? options.isolated;
  const extensions = isolated ? false : config.extensions;
  const excludeExtensions = isolated ? undefined : config.excludeExtensions;

  const { extNames, narrowing } = parseExtSelectors(
    isolated ? [] : (agentConfig?.extSelectors ?? []),
  );
  const mcpToolPatterns = agentConfig?.mcpToolPatterns;
  const noExtensions = extensions === false;

  const extensionsSpec = Array.isArray(extensions)
    ? parseExtensionsSpec(extensions, configCwd)
    : undefined;
  const keepNames = extensionsSpec?.names ?? new Set<string>();
  const excludeNames = new Set((excludeExtensions ?? []).map((n: string) => n.toLowerCase()));
  const hasExcludes = excludeNames.size > 0;
  const loadAll = extensions === true || extensionsSpec?.wildcard === true;
  // Globally required policy extensions are handler-only: loaded into every
  // session, never removable by agent frontmatter, and their tools are never
  // scoped in (see installExtensionToolScope's handlerOnlyPaths).
  const requiredExtensionPaths = new Set<string>(loadRequiredExtensionPaths(agentDir).map((entry: string) => resolve(entry)));
  const additionalExtensionPaths = [...new Set([
    ...(extensionsSpec?.paths ?? []),
    ...requiredExtensionPaths,
  ])];
  let discoveredNames: Set<string> | undefined;
  const extensionsOverride: ((base: LoadExtensionsResult) => LoadExtensionsResult) | undefined =
    requiredExtensionPaths.size === 0 && (noExtensions || (loadAll && !hasExcludes))
      ? undefined
      : (base) => {
          discoveredNames = new Set(base.extensions.flatMap((e) => extensionCanonicalNames(e.path)));
          return {
            ...base,
            extensions: base.extensions.filter((e) => {
              if (e.path === `<inline:${SCOPE_GATE_NAME}>`) return true;
              if (requiredExtensionPaths.has(resolve(e.path))) return true;
              if (noExtensions) return false;
              const canons = extensionCanonicalNames(e.path);
              if (canons.some((n: string) => excludeNames.has(n))) return false;
              return loadAll || canons.some((n: string) => keepNames.has(n));
            }),
          };
        };

  const projectTrusted = typeof ctx.isProjectTrusted === "function" ? ctx.isProjectTrusted() : true;
  const sessionSettingsManager =
    resolve(effectiveCwd) === resolve(configCwd)
      ? settingsManager
      : Object.assign(SettingsManager.create(configCwd, agentDir, { projectTrusted }), {
          isProjectTrusted: () => false,
        });
  const nestedCallGate: NestedCallGate = {};

  const loader = new DefaultResourceLoader({
    cwd: configCwd,
    agentDir,
    settingsManager,
    noExtensions: noExtensions && requiredExtensionPaths.size === 0,
    additionalExtensionPaths: additionalExtensionPaths.length ? additionalExtensionPaths : undefined,
    extensionsOverride,
    extensionFactories: [
      ...PI_BUILTIN_EXTENSIONS,
      ...(noExtensions ? [] : [scopeGateExtension(nestedCallGate)]),
    ],
    disabledBuiltinExtensions: process.argv.some((a) => a === "--no-extensions" || a === "-ne")
      ? ["codemode", "tool-search", "mcp"]
      : process.argv.includes("--no-mcp")
        ? ["mcp"]
        : undefined,
    noSkills,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => systemPrompt,
    appendSystemPromptOverride: () => [],
  });
  await runInChildSessionContext(() => loader.reload());

  const loadedExtensionPaths = new Set(loader.getExtensions().extensions.map((e) => resolve(e.path)));
  const missingRequiredExtension = [...requiredExtensionPaths].find((entry) => !loadedExtensionPaths.has(entry));
  if (missingRequiredExtension) {
    throw new Error(`Required subagent extension failed to load: ${missingRequiredExtension}`);
  }

  if (agentConfig?.builtinToolNames?.length) {
    const knownBuiltins = new Set(BUILTIN_TOOL_NAMES);
    for (const name of agentConfig.builtinToolNames) {
      if (!knownBuiltins.has(name)) {
        options.onToolActivity?.({
          type: "warning",
          toolName: `tools-error:tool "${name}" requested by agent "${type}" is not a known built-in`,
        });
      }
    }
  }

  if (hasExcludes && noExtensions) {
    options.onToolActivity?.({
      type: "warning",
      toolName: `extension-error:exclude_extensions has no effect for agent "${type}" — extensions: false loads nothing`,
    });
  }
  if (hasExcludes && discoveredNames) {
    for (const name of excludeNames) {
      if (!discoveredNames.has(name)) {
        options.onToolActivity?.({
          type: "warning",
          toolName: `extension-error:exclude_extensions: "${name}" for agent "${type}" did not match any discovered extension`,
        });
      }
    }
  }
  if (keepNames.size > 0 || extNames.size > 0) {
    const survivingNames = new Set(
      loader.getExtensions().extensions.flatMap((e) => extensionCanonicalNames(e.path)),
    );
    for (const name of keepNames) {
      if (!survivingNames.has(name)) {
        options.onToolActivity?.({
          type: "warning",
          toolName: excludeNames.has(name)
            ? `extension-error:extension "${name}" is in both extensions: and exclude_extensions: for agent "${type}" — exclude wins`
            : `extension-error:extension "${name}" requested by agent "${type}" was not loaded`,
        });
      }
    }
    for (const name of extNames) {
      if (!survivingNames.has(name)) {
        options.onToolActivity?.({
          type: "warning",
          toolName: `extension-error:ext:${name} referenced by agent "${type}" but extension "${name}" is not loaded (check extensions:/exclude_extensions:)`,
        });
      }
    }
  }
  // MCP tools come from extensions, so with none loaded these entries cannot match.
  if (mcpToolPatterns && noExtensions) {
    options.onToolActivity?.({
      type: "end",
      toolName: `tools-error:${mcpToolPatterns.join(", ")} requested by agent "${type}" need extensions, but it loads none`,
    });
  }

  return {
    loader,
    agentDir,
    sessionSettingsManager,
    nestedCallGate,
    extNames,
    narrowing,
    mcpToolPatterns,
    noExtensions,
    requiredExtensionPaths,
  };
}
