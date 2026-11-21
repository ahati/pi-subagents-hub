/**
 * notification-preview.test.ts — the collapsed notification card's one-line
 * result preview.
 *
 * Pretty-printed JSON opens with a bare `{`/`[` line, so previewing the first
 * line alone rendered as just that brace. The collapsed branch collapses
 * whitespace for those instead; every other result still previews its first
 * line. The text the model reads is the notification content, covered by the
 * wiring tests — nothing here touches it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<typeof import("../src/agent-runner.js")>("../src/agent-runner.js");
  return { ...actual, runAgent: vi.fn() };
});

import { buildNotificationDetails } from "../src/entry/renderers.js";
import subagentsExtension from "../src/index.js";
import { type Hermetic, hermeticDir, makePi } from "./helpers/boot-extension.js";

describe("the notification card's collapsed result preview", () => {
  let hermetic: Hermetic | undefined;

  afterEach(() => {
    hermetic?.restore();
  });

  /** Render one notification through the extension's registered renderer. */
  function render(resultPreview: string, expanded = false): string {
    hermetic = hermeticDir();
    const { pi } = makePi();
    subagentsExtension(pi);
    const [, renderer] = pi.registerMessageRenderer.mock.calls[0];
    const theme = { fg: (_c: string, s: string) => s, bold: (s: string) => s };
    const details = {
      id: "scout", description: "scout", status: "completed", toolUses: 1,
      turnCount: 1, totalTokens: 1000, totalCost: 0, durationMs: 1000, resultPreview,
    };
    return renderer({ details }, { expanded }, theme).render(80).join("\n");
  }

  it("collapses pretty-printed JSON to one line instead of a bare `{`", () => {
    const out = render('{\n  "agents": [\n    {\n      "ok": true\n    }\n  ]\n}');
    expect(out).toContain('⎿  { "agents": [ { "ok": true } ] }');
  });

  it("collapses a top-level array the same way", () => {
    const out = render("[\n  1,\n  2\n]");
    expect(out).toContain("⎿  [ 1, 2 ]");
  });

  it("still previews the first line of plain text", () => {
    const out = render("first line\nsecond line");
    expect(out).toContain("⎿  first line");
    expect(out).not.toContain("second line");
  });

  it("caps the collapsed JSON preview at 80 characters", () => {
    const out = render(JSON.stringify({ key: "x".repeat(200) }, null, 2));
    const line = out.split("\n").find((l) => l.includes("⎿"))!;
    expect(line.length).toBeLessThanOrEqual("  ⎿  ".length + 80);
  });

  it("keeps the expanded view multi-line", () => {
    const out = render('{\n  "a": 1,\n  "b": 2\n}', true);
    expect(out).toContain('"a": 1,');
    expect(out).toContain('"b": 2');
  });
});

describe("notification details carry the whole report", () => {
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
  const record = (over: Record<string, unknown>) => ({
    id: "a", description: "a", status: "completed", toolUses: 0,
    startedAt: 0, completedAt: 1, lifetimeUsage: usage, ...over,
  }) as any;

  it("falls back to the error body when a failed agent wrote no report", () => {
    const details = buildNotificationDetails(record({ status: "error", error: "429 rate_limit_error" }));
    expect(details.resultPreview).toBe("429 rate_limit_error");
  });

  it("keeps a long report whole so expanding can show it", () => {
    const report = `${"line\n".repeat(500)}last line`;
    const details = buildNotificationDetails(record({ result: report }));
    expect(details.resultPreview).toBe(report);
  });

  it("still prefers a real report over the error on a partial failure", () => {
    const details = buildNotificationDetails(record({ status: "error", error: "wrap-up", result: "partial work" }));
    expect(details.resultPreview).toBe("partial work");
  });
});
