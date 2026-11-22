/**
 * hub-background.ts — The agent hub's background setting and its themed palette.
 *
 * The hub paints its window with the `toolPendingBg` theme token. A custom
 * background is applied by deriving a Theme whose `toolPendingBg` is the exact
 * hex color: every existing `theme.bg("toolPendingBg", ...)` call — including
 * the frame edges and the reset reapplication — then paints that color without
 * changing any other surface that shares the original theme.
 */

import { Theme, type ThemeBg, type ThemeColor } from "@earendil-works/pi-coding-agent";
import { type Color, colorToHex, colorToOklch, parseColor } from "@earendil-works/pi-tui";
import type { HubBackground } from "./types.js";
import type { Theme as HubTheme } from "./ui/agent-widget.js";

/** Presets named after the palette steps they use. */
export const HUB_BACKGROUND_PRESETS = {
  beige: "#d7d2c3",
  blue: "#c2e6fa",
} as const;

export const DEFAULT_HUB_BACKGROUND: HubBackground = "blue";

/** Menu sentinel: selecting it prompts for a custom hex value. */
export const CUSTOM_HUB_BACKGROUND = "custom…";

const HEX_COLOR = /^#[0-9a-f]{6}$/i;
/** Above this OKLCH lightness the hub switches to pi's dark-on-light palette. */
const LIGHT_TEXT_THRESHOLD = 0.65;

/** Accept the two presets, the theme sentinel, or a six-digit hex color. */
export function sanitizeHubBackground(value: unknown): HubBackground | undefined {
  if (typeof value !== "string") return undefined;
  if (value === "theme" || value === "beige" || value === "blue") return value;
  const hex = value.trim();
  return HEX_COLOR.test(hex) ? hex.toLowerCase() as HubBackground : undefined;
}

/** The concrete hex a setting paints, or undefined for the active theme's token. */
export function hubBackgroundHex(value: HubBackground): string | undefined {
  if (value === "theme") return undefined;
  if (value === "beige" || value === "blue") return HUB_BACKGROUND_PRESETS[value];
  return value;
}

type ThemeSource = {
  readonly colors: Record<string, Color>;
  getColorMode(): "256color" | "truecolor";
  readonly appearance?: "dark" | "light";
};

function isThemeSource(value: unknown): value is ThemeSource {
  return typeof value === "object" && value !== null
    && "colors" in value && typeof value.colors === "object" && value.colors !== null
    && "getColorMode" in value && typeof value.getColorMode === "function";
}

/**
 * Derive the theme the hub renders with. `lightTheme` is pi's bundled light
 * theme, which supplies readable dark foreground and selection colors for the
 * light presets. Dark custom colors keep the active theme's foreground instead.
 */
export function createHubTheme(base: HubTheme, background: HubBackground, lightTheme?: HubTheme): HubTheme {
  const hex = hubBackgroundHex(background);
  if (!hex || !isThemeSource(base)) return base;
  const light = isLightHubBackground(hex);
  const source = light && isThemeSource(lightTheme) && lightTheme.appearance === "light"
    ? lightTheme
    : base;
  const colors: Record<string, string> = {};
  for (const [token, color] of Object.entries(source.colors)) {
    colors[token] = colorToHex(color);
  }
  colors.toolPendingBg = hex;
  return new Theme(
    colors as Record<ThemeColor, string>,
    colors as Record<ThemeBg, string>,
    source.getColorMode(),
    { name: "hub-background", appearance: light ? "light" : base.appearance },
  );
}

function isLightHubBackground(hex: string): boolean {
  return colorToOklch(parseColor(hex)).l >= LIGHT_TEXT_THRESHOLD;
}
