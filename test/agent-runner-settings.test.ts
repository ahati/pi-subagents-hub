import { beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_UNCUT_PROMPT_PROVIDERS,
  getDefaultMaxTurns,
  getGraceTurns,
  getUncutPromptProviders,
  isUncutPromptProvider,
  normalizeMaxTurns,
  setDefaultMaxTurns,
  setGraceTurns,
  setUncutPromptProviders,
} from "../src/agent-runner.js";

describe("setDefaultMaxTurns / getDefaultMaxTurns", () => {
  beforeEach(() => {
    setDefaultMaxTurns(undefined);
  });

  it("defaults to undefined (unlimited)", () => {
    expect(getDefaultMaxTurns()).toBeUndefined();
  });

  it("stores a positive integer", () => {
    setDefaultMaxTurns(30);
    expect(getDefaultMaxTurns()).toBe(30);
  });

  it("accepts boundary value 1", () => {
    setDefaultMaxTurns(1);
    expect(getDefaultMaxTurns()).toBe(1);
  });

  it("treats 0 as unlimited", () => {
    setDefaultMaxTurns(0);
    expect(getDefaultMaxTurns()).toBeUndefined();
  });

  it("clamps negative values to 1", () => {
    setDefaultMaxTurns(-10);
    expect(getDefaultMaxTurns()).toBe(1);
  });

  it("undefined resets to unlimited after being set", () => {
    setDefaultMaxTurns(50);
    expect(getDefaultMaxTurns()).toBe(50);
    setDefaultMaxTurns(undefined);
    expect(getDefaultMaxTurns()).toBeUndefined();
  });
});

describe("normalizeMaxTurns", () => {
  it("treats undefined as unlimited", () => {
    expect(normalizeMaxTurns(undefined)).toBeUndefined();
  });

  it("treats 0 as unlimited", () => {
    expect(normalizeMaxTurns(0)).toBeUndefined();
  });

  it("keeps positive values", () => {
    expect(normalizeMaxTurns(7)).toBe(7);
  });

  it("clamps negative values to 1", () => {
    expect(normalizeMaxTurns(-3)).toBe(1);
  });
});

describe("setGraceTurns / getGraceTurns", () => {
  beforeEach(() => {
    setGraceTurns(5);
  });

  it("round-trips the value this suite set up", () => {
    // NOT a default assertion — the beforeEach above sets 5, so this only
    // proves the setter/getter pair agree. The real module default is asserted
    // against a freshly-imported module in test/documented-defaults.test.ts.
    expect(getGraceTurns()).toBe(5);
  });

  it("stores a positive integer", () => {
    setGraceTurns(10);
    expect(getGraceTurns()).toBe(10);
  });

  it("accepts boundary value 1", () => {
    setGraceTurns(1);
    expect(getGraceTurns()).toBe(1);
  });

  it("clamps 0 to 1", () => {
    setGraceTurns(0);
    expect(getGraceTurns()).toBe(1);
  });

  it("clamps negative values to 1", () => {
    setGraceTurns(-5);
    expect(getGraceTurns()).toBe(1);
  });
});

describe("uncutPromptProviders", () => {
  beforeEach(() => {
    setUncutPromptProviders(DEFAULT_UNCUT_PROMPT_PROVIDERS);
  });

  it("defaults to claude-bridge", () => {
    expect(DEFAULT_UNCUT_PROMPT_PROVIDERS).toEqual(["claude-bridge"]);
    expect(isUncutPromptProvider("claude-bridge")).toBe(true);
    expect(isUncutPromptProvider("CLAUDE-BRIDGE")).toBe(true);
    expect(isUncutPromptProvider("anthropic")).toBe(false);
    expect(isUncutPromptProvider(undefined)).toBe(false);
  });

  it("updates and trims provider list via setUncutPromptProviders", () => {
    setUncutPromptProviders([" custom-bridge ", "other-bridge"]);
    expect(getUncutPromptProviders().has("custom-bridge")).toBe(true);
    expect(isUncutPromptProvider("custom-bridge")).toBe(true);
    expect(isUncutPromptProvider("claude-bridge")).toBe(false);

    setUncutPromptProviders([]);
    expect(isUncutPromptProvider("claude-bridge")).toBe(false);
    expect(getUncutPromptProviders().size).toBe(0);
  });
});
