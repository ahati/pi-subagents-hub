/** Pure behavior of the hub background setting and the theme it derives. */

import { parseColor } from "@earendil-works/pi-tui";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The real Theme needs the full pi token set; these tests only care which
// token values createHubTheme hands to its constructor.
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  Theme: class {
    constructor(
      public fgColors: Record<string, string>,
      public bgColors: Record<string, string>,
      public mode: string,
      public options: { appearance?: string },
    ) {}
  },
}));

import {
  createHubTheme,
  DEFAULT_HUB_BACKGROUND,
  hubBackgroundHex,
  sanitizeHubBackground,
} from "../src/hub-background.js";

function fakeTheme(colors: Record<string, string>, appearance: "dark" | "light") {
  return {
    colors: Object.fromEntries(Object.entries(colors).map(([token, hex]) => [token, parseColor(hex)])),
    getColorMode: () => "truecolor",
    appearance,
    fg: (_token: string, text: string) => text,
    bold: (text: string) => text,
  };
}

describe("hub background setting", () => {
  it("defaults to Blue 200", () => {
    expect(DEFAULT_HUB_BACKGROUND).toBe("blue");
    expect(hubBackgroundHex(DEFAULT_HUB_BACKGROUND)).toBe("#c2e6fa");
    expect(hubBackgroundHex("beige")).toBe("#d7d2c3");
    expect(hubBackgroundHex("theme")).toBeUndefined();
  });

  it("accepts presets and six-digit hex, rejects anything else", () => {
    expect(sanitizeHubBackground("theme")).toBe("theme");
    expect(sanitizeHubBackground("beige")).toBe("beige");
    expect(sanitizeHubBackground(" #ABCDEF ")).toBe("#abcdef");
    expect(sanitizeHubBackground("#abc")).toBeUndefined();
    expect(sanitizeHubBackground("chartreuse")).toBeUndefined();
    expect(sanitizeHubBackground(42)).toBeUndefined();
  });
});

describe("createHubTheme", () => {
  const dark = fakeTheme({ text: "#ffffff", muted: "#aaaaaa", toolPendingBg: "#333333" }, "dark");
  const light = fakeTheme({ text: "#222222", muted: "#555555", toolPendingBg: "#eeeeee" }, "light");

  beforeEach(() => vi.clearAllMocks());

  it("leaves the base theme alone when the setting is `theme`", () => {
    expect(createHubTheme(dark, "theme", light)).toBe(dark);
  });

  it("uses the light palette and exact preset hex for a light background", () => {
    const derived = createHubTheme(dark, "beige", light) as unknown as {
      fgColors: Record<string, string>;
      bgColors: Record<string, string>;
      options: { appearance?: string };
    };
    expect(derived.bgColors.toolPendingBg).toBe("#d7d2c3");
    expect(derived.fgColors.text).toBe("#222222");
    expect(derived.options.appearance).toBe("light");
  });

  it("keeps the active palette for a dark custom hex", () => {
    const derived = createHubTheme(dark, "#101010", light) as unknown as {
      fgColors: Record<string, string>;
      bgColors: Record<string, string>;
      options: { appearance?: string };
    };
    expect(derived.bgColors.toolPendingBg).toBe("#101010");
    expect(derived.fgColors.text).toBe("#ffffff");
    expect(derived.options.appearance).toBe("dark");
  });
});
