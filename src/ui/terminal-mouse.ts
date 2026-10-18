/**
 * terminal-mouse.ts — wheel support for regular (non-alt-screen) TUI mode.
 *
 * pi only enables mouse reporting in `tuiMode: "fullscreen"` (the alt-screen
 * renderer parses SGR mouse input and dispatches it to overlay components). In
 * regular mode `TuiMainScreen` has no mouse code at all: the terminal keeps the
 * wheel for its own scrollback, and components never see an event.
 *
 * The terminal's write handle is public, so the panel can opt in for its own
 * lifetime: enable reporting while it is open, parse the wheel out of the input
 * stream (the focused overlay component receives it), and restore the terminal
 * when the panel closes. While captured, the terminal's native wheel scrollback
 * and mouse text-selection (Shift+drag in most terminals) belong to the panel.
 *
 * The sequences mirror pi-tui's alt-screen setup so the terminal state is the
 * one pi itself would have set.
 */

/** SGR mouse reporting: button+wheel events, focus reporting, SGR coordinates. */
export const ENABLE_TERMINAL_MOUSE = "\x1b[?1000h\x1b[?1002h\x1b[?1004h\x1b[?1006h";
/** Exact reverse of the enable sequence (every mode it turns on). */
export const DISABLE_TERMINAL_MOUSE = "\x1b[?1006l\x1b[?1004l\x1b[?1003l\x1b[?1002l\x1b[?1000l";

/** SGR mouse report: `CSI < Cb ; Cx ; Cy M|m`. */
const SGR_MOUSE_RE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;

/** Logical lines scrolled per wheel notch (matches pi-tui's default). */
const WHEEL_LINES_PER_NOTCH = 3;

export interface ParsedMouseInput {
  /**
   * Summed wheel movement in logical lines; negative scrolls up. Zero when the
   * chunk carried mouse data but no wheel motion (clicks, moves, releases).
   */
  wheelDelta: number;
  /** Whether the chunk contained any mouse report — the bytes must be consumed. */
  sawMouse: boolean;
}

/**
 * Extract mouse-wheel movement from a raw input chunk.
 *
 * The chunk may mix key data and several reports (terminals batch), and may
 * carry non-wheel mouse events; callers consume the whole chunk whenever
 * `sawMouse` is true so no escape bytes leak into the editor.
 */
export function parseMouseInput(data: string): ParsedMouseInput {
  if (!data.includes("\x1b[<")) return { wheelDelta: 0, sawMouse: false };
  let wheelDelta = 0;
  let sawMouse = false;
  SGR_MOUSE_RE.lastIndex = 0;
  for (let match = SGR_MOUSE_RE.exec(data); match !== null; match = SGR_MOUSE_RE.exec(data)) {
    sawMouse = true;
    const button = Number(match[1]);
    // Wheel buttons carry bit 6 (64); the low two bits pick the direction.
    if ((button & 64) === 0) continue;
    const direction = button & 3;
    if (direction === 0) wheelDelta -= WHEEL_LINES_PER_NOTCH; // wheel up
    else if (direction === 1) wheelDelta += WHEEL_LINES_PER_NOTCH; // wheel down
    // 2/3 are horizontal wheels — no vertical motion to report.
  }
  return { wheelDelta, sawMouse };
}

export interface TerminalMouseEvent {
  type: "press" | "drag" | "release" | "move" | "wheel";
  button: "left" | "middle" | "right" | "none";
  x: number;
  y: number;
  wheelDelta?: number;
}

/**
 * Extract structured pointer events from raw SGR mouse reports.
 */
export function parseTerminalMouseEvents(data: string): TerminalMouseEvent[] {
  if (!data.includes("\x1b[<")) return [];
  const events: TerminalMouseEvent[] = [];
  SGR_MOUSE_RE.lastIndex = 0;
  for (let match = SGR_MOUSE_RE.exec(data); match !== null; match = SGR_MOUSE_RE.exec(data)) {
    const rawButton = Number(match[1]);
    const x = Number(match[2]);
    const y = Number(match[3]);
    const isRelease = match[4] === "m";

    if ((rawButton & 64) !== 0) {
      const direction = rawButton & 3;
      let wheelDelta = 0;
      if (direction === 0) wheelDelta = -WHEEL_LINES_PER_NOTCH;
      else if (direction === 1) wheelDelta = WHEEL_LINES_PER_NOTCH;
      events.push({ type: "wheel", button: "none", x, y, wheelDelta });
      continue;
    }

    if (isRelease) {
      events.push({ type: "release", button: "left", x, y });
      continue;
    }

    const isMotion = (rawButton & 32) !== 0;
    const btnCode = rawButton & 3;
    const button = btnCode === 0 ? "left" : btnCode === 1 ? "middle" : btnCode === 2 ? "right" : "none";

    if (isMotion) {
      events.push({ type: button === "none" ? "move" : "drag", button, x, y });
    } else {
      events.push({ type: "press", button, x, y });
    }
  }
  return events;
}

/** The terminal handle the panel writes mouse-mode sequences to. */
interface WritableTerminal {
  write?(data: string): void;
}

/** The TUI surface the panel was handed, as far as mouse capture cares. */
interface MouseHost {
  mode?: string;
  terminal?: WritableTerminal;
}

/**
 * Turn on wheel reporting for a panel hosted in regular TUI mode.
 *
 * Fullscreen mode returns false: pi already parses mouse input there and
 * dispatches wheel events to the overlay component directly, so writing the
 * sequences again would be redundant. Failures (no write handle, exotic host)
 * are swallowed — the panel simply keeps keyboard-only scrolling.
 */
export function enableTerminalMouse(tui: MouseHost | undefined): boolean {
  if (!tui || tui.mode === "fullscreen") return false;
  try {
    if (typeof tui.terminal?.write !== "function") return false;
    tui.terminal.write(ENABLE_TERMINAL_MOUSE);
    return true;
  } catch {
    return false;
  }
}

/** Restore the terminal after a panel that had mouse capture closes. */
export function disableTerminalMouse(tui: MouseHost | undefined): void {
  try {
    if (typeof tui?.terminal?.write === "function") tui.terminal.write(DISABLE_TERMINAL_MOUSE);
  } catch {
    // Best-effort: a failed restore must not mask the panel's own teardown.
  }
}
