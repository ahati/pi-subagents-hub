import { describe, expect, it, vi } from "vitest";
import {
  DISABLE_TERMINAL_MOUSE,
  disableTerminalMouse,
  ENABLE_TERMINAL_MOUSE,
  enableTerminalMouse,
  parseMouseInput,
  parseTerminalMouseEvents,
} from "../src/ui/terminal-mouse.js";

/** SGR mouse report helper. */
const mouse = (button: number, release = false, x = 10, y = 5) => `\x1b[<${button};${x};${y}${release ? "m" : "M"}`;

describe("parseMouseInput", () => {
  it("reads wheel up and down as signed logical lines", () => {
    expect(parseMouseInput(mouse(64)).wheelDelta).toBeLessThan(0); // up
    expect(parseMouseInput(mouse(65)).wheelDelta).toBeGreaterThan(0); // down
  });

  it("keeps the direction when modifiers are set", () => {
    // wheel up + shift (4) / wheel down + ctrl (16)
    expect(parseMouseInput(mouse(68)).wheelDelta).toBeLessThan(0);
    expect(parseMouseInput(mouse(81)).wheelDelta).toBeGreaterThan(0);
  });

  it("ignores horizontal wheels (no vertical motion)", () => {
    expect(parseMouseInput(mouse(66)).wheelDelta).toBe(0);
    expect(parseMouseInput(mouse(67)).wheelDelta).toBe(0);
    expect(parseMouseInput(mouse(66)).sawMouse).toBe(true);
  });

  it("flags clicks and releases as mouse input without wheel motion", () => {
    expect(parseMouseInput(mouse(0))).toEqual({ wheelDelta: 0, sawMouse: true });
    expect(parseMouseInput(mouse(0, true))).toEqual({ wheelDelta: 0, sawMouse: true });
  });

  it("sums several reports in one chunk (terminals batch)", () => {
    const two = parseMouseInput(mouse(65) + mouse(65)).wheelDelta;
    const one = parseMouseInput(mouse(65)).wheelDelta;
    expect(two).toBe(one * 2);
    // Mixed directions cancel.
    expect(parseMouseInput(mouse(65) + mouse(64)).wheelDelta).toBe(0);
  });

  it("leaves ordinary input alone", () => {
    for (const data of ["", "a", "\r", "\x1b[A", "\x1b[1;5B", "hello world"]) {
      expect(parseMouseInput(data)).toEqual({ wheelDelta: 0, sawMouse: false });
    }
  });

  it("ignores malformed lookalikes", () => {
    expect(parseMouseInput("\x1b[<abc;1;1M")).toEqual({ wheelDelta: 0, sawMouse: false });
    expect(parseMouseInput("\x1b[<64;1;1")).toEqual({ wheelDelta: 0, sawMouse: false });
  });

  it("finds a report embedded in other input", () => {
    const parsed = parseMouseInput(`ab${mouse(65)}cd`);
    expect(parsed.sawMouse).toBe(true);
    expect(parsed.wheelDelta).toBeGreaterThan(0);
  });
});

describe("enable/disableTerminalMouse", () => {
  const regular = () => ({ mode: "regular", terminal: { write: vi.fn() } });

  it("captures in regular mode by writing the reporting sequences", () => {
    const tui = regular();
    expect(enableTerminalMouse(tui)).toBe(true);
    expect(tui.terminal.write).toHaveBeenCalledWith(ENABLE_TERMINAL_MOUSE);
  });

  it("does nothing in fullscreen mode (pi already dispatches wheel events)", () => {
    const tui = { mode: "fullscreen", terminal: { write: vi.fn() } };
    expect(enableTerminalMouse(tui)).toBe(false);
    expect(tui.terminal.write).not.toHaveBeenCalled();
  });

  it("degrades when the host cannot write", () => {
    expect(enableTerminalMouse(undefined)).toBe(false);
    expect(enableTerminalMouse({ mode: "regular" })).toBe(false);
    expect(enableTerminalMouse({ mode: "regular", terminal: {} })).toBe(false);
    expect(enableTerminalMouse({ mode: "regular", terminal: { write: () => { throw new Error("closed"); } } })).toBe(false);
  });

  it("restores the terminal, tolerating a missing or failing handle", () => {
    const tui = regular();
    disableTerminalMouse(tui);
    expect(tui.terminal.write).toHaveBeenCalledWith(DISABLE_TERMINAL_MOUSE);
    expect(() => disableTerminalMouse(undefined)).not.toThrow();
    expect(() => disableTerminalMouse({ terminal: { write: () => { throw new Error("closed"); } } })).not.toThrow();
  });
});

describe("parseTerminalMouseEvents", () => {
  it("parses press, drag, and release events with coordinates", () => {
    const press = parseTerminalMouseEvents(mouse(0, false, 22, 10));
    expect(press).toEqual([{ type: "press", button: "left", x: 22, y: 10 }]);

    const drag = parseTerminalMouseEvents(mouse(32, false, 28, 10));
    expect(drag).toEqual([{ type: "drag", button: "left", x: 28, y: 10 }]);

    const release = parseTerminalMouseEvents(mouse(0, true, 28, 10));
    expect(release).toEqual([{ type: "release", button: "left", x: 28, y: 10 }]);
  });

  it("parses wheel events", () => {
    const up = parseTerminalMouseEvents(mouse(64, false, 15, 8));
    expect(up).toEqual([{ type: "wheel", button: "none", x: 15, y: 8, wheelDelta: -3 }]);

    const down = parseTerminalMouseEvents(mouse(65, false, 15, 8));
    expect(down).toEqual([{ type: "wheel", button: "none", x: 15, y: 8, wheelDelta: 3 }]);
  });

  it("returns empty array for non-mouse input", () => {
    expect(parseTerminalMouseEvents("hello")).toEqual([]);
    expect(parseTerminalMouseEvents("")).toEqual([]);
  });
});
