import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getCacheRetention,
  installCacheRetention,
  setCacheRetention,
} from "../src/cache-retention.js";

function session() {
  const stream = vi.fn();
  return { session: { agent: { streamFunction: stream } } as never, stream };
}

afterEach(() => {
  setCacheRetention("inherit");
});

describe("installCacheRetention", () => {
  it("supplies the retention to child model calls", () => {
    const { session: s, stream } = session();
    installCacheRetention(s, "short");

    const model = { provider: "anthropic", id: "m" };
    const context = { messages: [] };
    (s as any).agent.streamFunction(model, context, { temperature: 0 });

    expect(stream).toHaveBeenCalledWith(model, context, { temperature: 0, cacheRetention: "short" });
  });

  it("installs nothing for inherit", () => {
    const { session: s, stream } = session();
    const original = (s as any).agent.streamFunction;
    installCacheRetention(s, "inherit");
    expect((s as any).agent.streamFunction).toBe(original);
    expect(stream).not.toHaveBeenCalled();
  });

  it("lets an explicit per-request retention win", () => {
    const { session: s, stream } = session();
    installCacheRetention(s, "long");

    (s as any).agent.streamFunction({ provider: "anthropic", id: "m" }, {}, { cacheRetention: "none" });

    expect(stream).toHaveBeenCalledWith({ provider: "anthropic", id: "m" }, {}, { cacheRetention: "none" });
  });
});

describe("the cacheRetention setting", () => {
  it("defaults to inherit, which installs nothing", () => {
    expect(getCacheRetention()).toBe("inherit");
  });

  it("is read when a session is created, so a change applies to later agents", () => {
    setCacheRetention("long");
    expect(getCacheRetention()).toBe("long");
    const { session: s } = session();
    installCacheRetention(s, getCacheRetention());
    expect((s as any).agent.streamFunction).not.toBe(vi.fn());
  });
});
