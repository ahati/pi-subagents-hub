import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installSubagentCacheRetention } from "../src/cache-retention.js";

const dirs: string[] = [];

function project(settings: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "pi-cache-retention-"));
  dirs.push(dir);
  mkdirSync(join(dir, ".pi"), { recursive: true });
  writeFileSync(join(dir, ".pi", "subagents.json"), JSON.stringify(settings));
  return dir;
}

function session() {
  const stream = vi.fn();
  return { session: { agent: { streamFunction: stream } } as never, stream };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("installSubagentCacheRetention", () => {
  it("supplies the configured retention to child model calls", () => {
    const { session: s, stream } = session();
    installSubagentCacheRetention(s, project({ cacheRetention: "short" }));

    const model = { provider: "anthropic", id: "m" };
    const context = { messages: [] };
    (s as any).agent.streamFunction(model, context, { temperature: 0 });

    expect(stream).toHaveBeenCalledWith(model, context, { temperature: 0, cacheRetention: "short" });
  });

  it("does not wrap calls when the setting is inherit or absent", () => {
    for (const settings of [{ cacheRetention: "inherit" }, {}]) {
      const { session: s, stream } = session();
      const original = (s as any).agent.streamFunction;
      installSubagentCacheRetention(s, project(settings));
      expect((s as any).agent.streamFunction).toBe(original);
      expect(stream).not.toHaveBeenCalled();
    }
  });

  it("lets an explicit per-request retention win", () => {
    const { session: s, stream } = session();
    installSubagentCacheRetention(s, project({ cacheRetention: "long" }));

    (s as any).agent.streamFunction({ provider: "anthropic", id: "m" }, {}, { cacheRetention: "none" });

    expect(stream).toHaveBeenCalledWith({ provider: "anthropic", id: "m" }, {}, { cacheRetention: "none" });
  });
});
