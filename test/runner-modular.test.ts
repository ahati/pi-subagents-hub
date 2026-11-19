import type { ExtensionContext, SettingsManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
  buildSessionToolLoadout,
  resolveRunModel,
} from "../src/runner/runner-tools.js";

describe("runner-tools", () => {
  const dummyModel = { id: "test-model", provider: "test" } as any;

  function makeMockContext(overrides: Partial<ExtensionContext> = {}): ExtensionContext {
    return {
      model: dummyModel,
      modelRegistry: {
        find: vi.fn((_provider: string, id: string) => ({ id, provider: "mock" })),
      } as any,
      cwd: "/mock/cwd",
      ...overrides,
    } as any;
  }

  function makeMockSettingsManager(overrides: Partial<SettingsManager> = {}): SettingsManager {
    return {
      getDefaultModel: vi.fn(() => undefined),
      getDefaultProvider: vi.fn(() => undefined),
      ...overrides,
    } as any;
  }

  describe("resolveRunModel", () => {
    it("returns options.model when resuming", () => {
      const ctx = makeMockContext();
      const settings = makeMockSettingsManager();
      const resumeModel = { id: "resumed", provider: "mock" } as any;
      const result = resolveRunModel(
        ctx,
        "general-purpose",
        undefined,
        settings,
        { pi: {} as any, resumeSessionFile: "/path/to/file", model: resumeModel },
      );
      expect(result).toBe(resumeModel);
    });

    it("returns explicit options.model when provided", () => {
      const ctx = makeMockContext();
      const settings = makeMockSettingsManager();
      const customModel = { id: "custom", provider: "mock" } as any;
      const result = resolveRunModel(
        ctx,
        "general-purpose",
        undefined,
        settings,
        { pi: {} as any, model: customModel },
      );
      expect(result).toBe(customModel);
    });

    it("falls back to settings manager default model if neither options nor agent config specifies a model", () => {
      const ctx = makeMockContext({ model: undefined });
      const settings = makeMockSettingsManager({
        getDefaultModel: vi.fn(() => "default-model-id"),
        getDefaultProvider: vi.fn(() => "mock-provider"),
      });
      const result = resolveRunModel(
        ctx,
        "general-purpose",
        undefined,
        settings,
        { pi: {} as any },
      );
      expect(result).toEqual({ id: "default-model-id", provider: "mock" });
    });
  });

  describe("buildSessionToolLoadout", () => {
    it("filters disallowed tools and includes structured output tool when provided", () => {
      const ctx = makeMockContext();
      const loader = {
        getExtensions: () => ({ extensions: [] }),
      } as any;
      const nested = {
        tools: [],
        disallowedSet: new Set(["disallowed_tool"]),
      };

      const loadout = buildSessionToolLoadout(
        ctx,
        "general-purpose",
        undefined,
        loader,
        ["allowed_tool", "disallowed_tool"],
        new Set(),
        undefined,
        true, // noExtensions
        nested,
        dummyModel,
        {
          pi: {} as any,
          structuredOutput: {
            schema: { type: "object" },
          },
        },
      );

      expect(loadout.sessionTools).toContain("allowed_tool");
      expect(loadout.sessionTools).not.toContain("disallowed_tool");
      expect(loadout.sessionTools).toContain("StructuredOutput");
      expect(loadout.structuredCapture).toBeDefined();
    });

    it("throws when tools list resolves to zero tools for an unrecognized or unmatched tool specification", () => {
      const ctx = makeMockContext();
      const loader = {
        getExtensions: () => ({ extensions: [] }),
      } as any;
      const nested = {
        tools: [],
        disallowedSet: undefined,
      };

      expect(() =>
        buildSessionToolLoadout(
          ctx,
          "custom-empty",
          { name: "custom-empty", description: "", builtinToolNames: ["unknown_tool"] } as any,
          loader,
          [],
          new Set(),
          undefined,
          false,
          nested,
          dummyModel,
          { pi: {} as any },
        ),
      ).toThrow("refusing. Its tools list resolved to nothing");
    });
  });
});
