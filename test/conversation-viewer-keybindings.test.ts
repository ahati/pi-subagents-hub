import { initTheme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import type { AgentRecord } from "../src/types.js";
import { ConversationViewer } from "../src/ui/conversation-viewer.js";
import type { ViewerKeybindings } from "../src/ui/viewer-keys.js";
import { createViewerKeys } from "../src/ui/viewer-keys.js";

// The transcript components read pi's global theme; only the TUI normally sets it up.
initTheme(undefined, false);

const CTRL_P = "\x10";
const CTRL_N = "\x0e";
const CTRL_O = "\x0f";
const CTRL_E = "\x05";
const ENTER = "\r";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const SHIFT_UP = "\x1b[1;2A";
const SHIFT_DOWN = "\x1b[1;2B";
const PAGE_UP = "\x1b[5~";
const PAGE_DOWN = "\x1b[6~";

function createEmacsKeybindings(): KeybindingsManager {
  return new KeybindingsManager(TUI_KEYBINDINGS, {
    "tui.select.up": ["up", "ctrl+p"],
    "tui.select.down": ["down", "ctrl+n"],
  });
}

/**
 * Manager whose definitions carry `app.tools.expand`. pi-tui's
 * `TUI_KEYBINDINGS` does not define the id — the app-level defaults live in
 * pi-coding-agent's map — so tests supply it explicitly, mirroring the
 * manager the hub receives in production. A `remap` replaces the default
 * ctrl+o, as a user's keybindings.json would.
 */
function createExpandKeybindings(remap?: string): KeybindingsManager {
  return new KeybindingsManager(
    { ...TUI_KEYBINDINGS, "app.tools.expand": { defaultKeys: "ctrl+o", description: "Toggle tool output" } },
    remap ? { "app.tools.expand": remap } : {},
  );
}

function createViewer(keybindings?: ViewerKeybindings) {
  const tui = {
    terminal: { rows: 20, columns: 80 },
    requestRender: vi.fn(),
  } as any;
  const messages = Array.from({ length: 60 }, (_, i) => ({
    role: "user",
    content: `message ${i}`,
  }));
  const session = {
    messages,
    subscribe: vi.fn(() => vi.fn()),
  } as any;
  const record = {
    id: "test-1",
    type: "general-purpose",
    description: "test agent",
    status: "completed",
    toolUses: 0,
    startedAt: Date.now(),
  } as AgentRecord;
  const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  } as any;
  const viewer = new ConversationViewer(tui, session, record, undefined, theme, vi.fn(), undefined, keybindings);
  viewer.render(80); // sets lastInnerW and scrolls to bottom (autoScroll)
  return viewer;
}

function scrollOffset(viewer: ConversationViewer): number {
  return (viewer as any).scrollOffset;
}

describe("viewer-keys", () => {
  it("honors user keybindings when a manager is provided", () => {
    const keys = createViewerKeys(createEmacsKeybindings());
    expect(keys.scrollUp(CTRL_P)).toBe(true);
    expect(keys.scrollUp(UP)).toBe(true);
    expect(keys.scrollDown(CTRL_N)).toBe(true);
    expect(keys.scrollDown(DOWN)).toBe(true);
  });

  it("falls back to hardcoded defaults without a manager", () => {
    const keys = createViewerKeys();
    expect(keys.scrollUp(UP)).toBe(true);
    expect(keys.scrollUp(CTRL_P)).toBe(false);
    expect(keys.scrollDown(DOWN)).toBe(true);
    expect(keys.scrollDown(CTRL_N)).toBe(false);
    expect(keys.pageUp(PAGE_UP)).toBe(true);
    expect(keys.pageDown(PAGE_DOWN)).toBe(true);
  });

  it("keeps the k/j and shift+arrow aliases with and without a manager", () => {
    for (const keys of [createViewerKeys(), createViewerKeys(createEmacsKeybindings())]) {
      expect(keys.scrollUp("k")).toBe(true);
      expect(keys.scrollDown("j")).toBe(true);
      expect(keys.pageUp(SHIFT_UP)).toBe(true);
      expect(keys.pageDown(SHIFT_DOWN)).toBe(true);
    }
  });

  it("manager with no user overrides behaves like the hardcoded defaults", () => {
    const keys = createViewerKeys(new KeybindingsManager(TUI_KEYBINDINGS, {}));
    expect(keys.scrollUp(UP)).toBe(true);
    expect(keys.scrollDown(DOWN)).toBe(true);
    expect(keys.pageUp(PAGE_UP)).toBe(true);
    expect(keys.pageDown(PAGE_DOWN)).toBe(true);
    expect(keys.scrollUp(CTRL_P)).toBe(false);
    expect(keys.scrollDown(CTRL_N)).toBe(false);
  });

  it("respects rebinding that removes a default key", () => {
    const manager = new KeybindingsManager(TUI_KEYBINDINGS, {
      "tui.select.up": "ctrl+p",
    });
    const keys = createViewerKeys(manager);
    expect(keys.scrollUp(CTRL_P)).toBe(true);
    expect(keys.scrollUp(UP)).toBe(false);
  });

  it("expands on ctrl+o without a manager (hardcoded fallback)", () => {
    const keys = createViewerKeys();
    expect(keys.expand(CTRL_O)).toBe(true);
    expect(keys.expand("x")).toBe(false);
  });

  it("binds plain `o` as the alias the band advertises, manager or not", () => {
    // ctrl+o stays the resolved binding; `o` is the alias the hub's band prints.
    expect(createViewerKeys().expand("o")).toBe(true);
    expect(createViewerKeys(createExpandKeybindings()).expand("o")).toBe(true);
    const remapped = createViewerKeys(createExpandKeybindings("ctrl+e"));
    expect(remapped.expand("o")).toBe(true);
    expect(remapped.expand(CTRL_E)).toBe(true);
  });

  it("resolves app.tools.expand through a manager that defines it", () => {
    const keys = createViewerKeys(createExpandKeybindings());
    expect(keys.expand(CTRL_O)).toBe(true);
    expect(keys.expand("x")).toBe(false);
  });

  it("honors a remapped app.tools.expand", () => {
    const keys = createViewerKeys(createExpandKeybindings("ctrl+e"));
    expect(keys.expand(CTRL_E)).toBe(true);
    expect(keys.expand(CTRL_O)).toBe(false);
  });
});

describe("ConversationViewer custom keybindings", () => {
  it("scrolls with ctrl+p/ctrl+n when bound to tui.select.up/down", () => {
    const viewer = createViewer(createEmacsKeybindings());
    const bottom = scrollOffset(viewer);
    expect(bottom).toBeGreaterThan(0);

    viewer.handleInput(CTRL_P);
    expect(scrollOffset(viewer)).toBe(bottom - 1);
    viewer.handleInput(CTRL_N);
    expect(scrollOffset(viewer)).toBe(bottom);
  });

  it("keeps arrows and k/j working alongside custom bindings", () => {
    const viewer = createViewer(createEmacsKeybindings());
    const bottom = scrollOffset(viewer);

    viewer.handleInput(UP);
    viewer.handleInput("k");
    expect(scrollOffset(viewer)).toBe(bottom - 2);
    viewer.handleInput(DOWN);
    viewer.handleInput("j");
    expect(scrollOffset(viewer)).toBe(bottom);
  });

  it("treats ctrl+p/ctrl+n as unbound without a keybindings manager", () => {
    const viewer = createViewer();
    const bottom = scrollOffset(viewer);

    viewer.handleInput(CTRL_P);
    viewer.handleInput(CTRL_N);
    expect(scrollOffset(viewer)).toBe(bottom);
    viewer.handleInput(UP);
    expect(scrollOffset(viewer)).toBe(bottom - 1);
  });
});

describe("ConversationViewer expand toggle (ctrl+o)", () => {
  /** Live viewer: running agent with stop/steer handlers, so composer and stop-arm interactions apply. */
  function createLiveViewer(keybindings?: ViewerKeybindings, handlers: { onStop?: () => void; onSteer?: (message: string) => void } = {}) {
    const tui = {
      terminal: { rows: 20, columns: 80 },
      requestRender: vi.fn(),
    } as any;
    const session = {
      messages: [{ role: "user", content: "go" }],
      subscribe: vi.fn(() => vi.fn()),
    } as any;
    const record = {
      id: "test-1",
      type: "general-purpose",
      description: "test agent",
      status: "running",
      toolUses: 0,
      startedAt: Date.now(),
    } as AgentRecord;
    const theme = {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    } as any;
    const viewer = new ConversationViewer(tui, session, record, undefined, theme, vi.fn(), handlers.onStop, keybindings, handlers.onSteer);
    viewer.render(80);
    return viewer;
  }

  function expanded(viewer: ConversationViewer): boolean {
    return (viewer as any).expanded;
  }

  it("toggles expanded on ctrl+o without a keybindings manager", () => {
    const viewer = createLiveViewer();
    expect(expanded(viewer)).toBe(false);
    viewer.handleInput(CTRL_O);
    expect(expanded(viewer)).toBe(true);
    viewer.handleInput(CTRL_O);
    expect(expanded(viewer)).toBe(false);
  });

  it("toggles expanded on plain `o`, the band's advertised alias", () => {
    const viewer = createLiveViewer();
    viewer.handleInput("o");
    expect(expanded(viewer)).toBe(true);
    viewer.handleInput("o");
    expect(expanded(viewer)).toBe(false);
  });

  it("honors a remapped app.tools.expand and ignores the old key", () => {
    const viewer = createLiveViewer(createExpandKeybindings("ctrl+e"));
    viewer.handleInput(CTRL_E);
    expect(expanded(viewer)).toBe(true);
    viewer.handleInput(CTRL_O);
    expect(expanded(viewer)).toBe(true);
  });

  it("is inert while the steer composer is open", () => {
    const viewer = createLiveViewer(undefined, { onSteer: vi.fn() });
    viewer.handleInput(ENTER);
    expect((viewer as any).composer).toBeTruthy();
    viewer.handleInput(CTRL_O);
    expect(expanded(viewer)).toBe(false);
    expect((viewer as any).composer).toBeTruthy();
  });

  it("disarms a pending stop", () => {
    const onStop = vi.fn();
    const viewer = createLiveViewer(undefined, { onStop });
    viewer.handleInput("x");
    expect((viewer as any).stopArmed).toBe(true);
    viewer.handleInput(CTRL_O);
    expect(expanded(viewer)).toBe(true);
    viewer.handleInput("x");
    expect(onStop).not.toHaveBeenCalled();
    // Re-armed rather than fired — proof the toggle disarmed the first press.
    expect((viewer as any).stopArmed).toBe(true);
  });
});
