/**
 * settings-menu-wiring.test.ts — `/agents` → Settings through the real
 * extension: the list filter and the numeric-row Enter handler.
 *
 * The page runs on pi-tui's `SettingsList` with its own search (`enableSearch`).
 * Typing narrows the rows and the list resets its cursor to the first match, so
 * Enter must read the list's selection rather than an index the menu tracked
 * before the filter existed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The real page component renders through pi's theme, which a test process
// never initializes. Plain-text styling is enough to read the rows.
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getSettingsListTheme: () => ({
    label: (text: string) => text,
    value: (text: string) => text,
    description: (text: string) => text,
    cursor: "> ",
    hint: (text: string) => text,
  }),
}));

import subagentsExtension from "../src/index.js";
import { type Hermetic, hermeticDir, ctx as makeCtx, makePi } from "./helpers/boot-extension.js";

const KEYS: Record<string, string> = {
  "tui.input.tab": "\t",
  "tui.input.submit": "\r",
  "tui.select.confirm": "\r",
  "tui.select.cancel": "\x1b",
  "tui.select.up": "\x1b[A",
  "tui.select.down": "\x1b[B",
  "tui.editor.deleteCharForward": "\x1b[3~",
  "tui.editor.deleteCharBackward": "\x7f",
};
const ENTER = "\r";
const DOWN = "\x1b[B";

/**
 * Boot the real extension and answer `/agents` with Settings once, then close
 * the menu. Records the keys sent to the page, what it rendered, and every
 * numeric editor the page opens.
 */
function driveSettings(keys: string[], inputValues: string[] = []) {
  const page = { screen: "", lines: [] as string[], closed: false };
  let inputIndex = 0;
  const input = vi.fn(async () => inputValues[inputIndex++] as string | undefined);
  let menusAnswered = 0;
  const custom = vi.fn((factory: (...args: any[]) => any) => new Promise<any>((resolve) => {
    const kb = {
      matches: (data: string, id: string) => KEYS[id] === data,
      getKeys: (id: string) => (id === "tui.input.tab" ? ["tab"] : id in KEYS ? ["enter"] : []),
    };
    const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
    const done = (value: string | undefined) => {
      page.closed = true;
      resolve(value);
    };
    const component = factory({ requestRender: vi.fn(), terminal: { columns: 120, rows: 60 } }, theme, kb, done);
    for (const key of keys) {
      if (page.closed) break;
      component.handleInput(key);
    }
    const lines: string[] = component.render(120);
    page.lines = lines;
    page.screen = lines.join("\n");
    resolve(undefined);
  }));

  const context = makeCtx({
    hasUI: true,
    ui: {
      notify: vi.fn(),
      select: vi.fn(async (_title: string, options: string[]) => {
        menusAnswered++;
        return menusAnswered === 1 ? options.find(o => o === "Settings") : undefined;
      }),
      custom,
      input,
      setStatus: vi.fn(),
      setWidget: vi.fn(),
    },
  });

  const booted = makePi();
  subagentsExtension(booted.pi);
  const command = booted.commands.get("agents");
  if (!command) throw new Error("the extension did not register /agents");

  return { context, command, input, page };
}

describe("/agents → Settings filter", () => {
  let hermetic: Hermetic;

  beforeEach(() => {
    hermetic = hermeticDir({});
  });
  afterEach(() => {
    hermetic.restore();
    delete (globalThis as any)[Symbol.for("pi-subagents:manager")];
  });

  it("narrows the rows by label as the user types", async () => {
    const { context, command, page } = driveSettings([..."grace"]);

    await command.handler("", context);

    expect(page.screen).toMatch(/Grace turns +5\b/);
    expect(page.screen).not.toContain("Max concurrency");
    expect(page.screen).not.toContain("Join mode");
  });

  it("Enter on a filtered numeric row opens that row's editor", async () => {
    const { context, command, input } = driveSettings([..."grace", ENTER]);

    await command.handler("", context);

    expect(input).toHaveBeenCalledWith("Grace turns (1+)", "5");
    expect(input).not.toHaveBeenCalledWith("Max concurrency (1+)", "10");
  });

  it("custom hub background opens a hex prompt and applies the value", async () => {
    const { context, command, input } = driveSettings([..."hub", ENTER], ["#112233"]);

    await command.handler("", context);

    expect(input).toHaveBeenCalledWith("Hub background (#RRGGBB):", "blue");
    expect(context.ui.notify).toHaveBeenCalledWith(
      "Hub background set to #112233",
      expect.any(String),
    );
  });

  it("Enter after moving down a filtered list opens the row under the cursor", async () => {
    // "turn" matches Grace turns first, then Default max turns, then Output
    // transcript. One Down lands on Default max turns, which is item 2 of the
    // unfiltered list — not the row an externally tracked index would name.
    const { context, command, input } = driveSettings([..."turn", DOWN, ENTER]);

    await command.handler("", context);

    expect(input).toHaveBeenCalledWith("Default max turns (0 = unlimited)", "0");
    expect(input).not.toHaveBeenCalledWith("Max foreground concurrency (0 = unlimited)", "0");
  });
});
